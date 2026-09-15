import { createHash, randomUUID } from 'node:crypto';
import { readFile, open, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BranchSchema,
  StaffSetupSchema,
  MenuSnapshotSchema,
  UuidSchema,
} from '@pickchick/contracts';
import { createPool, transaction } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { canonicalJson, hashJson } from '@pickchick/menu-sync';
import { assertPrivateStaffPath } from './staff-file-permissions.mjs';

export const draftCatalogSha256 =
  'cad27d8912e86789f99abdb646c412693f73fad29523cbf5c66a9317dc6a76a5';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ownKeys = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === keys.slice().sort().join(',');

export function previewId(branchId, kind, key) {
  const hash = digest(`pickchick-local-draft-v1:${branchId}:${kind}:${key}`).slice(0, 32).split('');
  hash[12] = '8';
  hash[16] = (8 | (parseInt(hash[16], 16) & 3)).toString(16);
  const hex = hash.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function prepareLocalDraft(input, catalogBytes, branchId, now = new Date()) {
  if (
    !ownKeys(input, ['format', 'branch', 'staff', 'release_id', 'confirmation']) ||
    input.format !== 'pickchick-local-pos-draft-v1' ||
    input.confirmation !== 'prepare_local_display_only'
  )
    throw new Error('Invalid explicit draft setup input');
  const branch = BranchSchema.parse(input.branch);
  const staff = StaffSetupSchema.parse(input.staff);
  const releaseId = UuidSchema.parse(input.release_id);
  if (branch.id !== branchId || branch.ordering_enabled !== false || staff.role !== 'cashier')
    throw new Error(
      'Draft setup requires its exact local branch, closed ordering and cashier-only access',
    );
  if (digest(catalogBytes) !== draftCatalogSha256)
    throw new Error('Draft source file hash mismatch');
  const catalog = JSON.parse(catalogBytes.toString('utf8'));
  if (
    catalog.format !== 'pickchick-local-pos-draft-catalog-v1' ||
    catalog.content_reviewed !== false ||
    catalog.products.length !== 24
  )
    throw new Error('Expected the pinned unreviewed source catalog');
  const categoryNames = [...new Set(catalog.products.map((item) => item.category))];
  const categories = Object.fromEntries(
    categoryNames.map((name) => [previewId(branch.id, 'category', name), name]),
  );
  const menu = MenuSnapshotSchema.parse({
    schema_version: 1,
    release_id: releaseId,
    branch_id: branch.id,
    version: 1,
    // Foundation calls this field published_at; it is only the local draft creation
    // time here. No cloud publication, menu event or business approval is claimed.
    published_at: now.toISOString(),
    items: catalog.products.map((item) => ({
      product_id: previewId(branch.id, 'product', item.source_id),
      variant_id: previewId(branch.id, 'base-preview', item.source_id),
      category_id: previewId(branch.id, 'category', item.category),
      name: { ru: item.name_ru, kk: '-' }, // Untranslated; do not invent KK content.
      price_minor: item.price_minor,
      currency: 'KZT',
    })),
  });
  return {
    branch,
    staff,
    menu,
    auditId: randomUUID(),
    inputHash: hashJson(input),
    catalogSha256: draftCatalogSha256,
    source: catalog.source,
    posConfig: {
      edgePort: 3101,
      branchLabel: `${branch.name.slice(0, 90)} - ЧЕРНОВИК, НЕ ДЛЯ ПРОДАЖ`,
      categories,
    },
  };
}

export async function provisionLocalDraft(pool, prepared) {
  const { branch, staff, menu, auditId } = prepared;
  return transaction(pool, async (client) => {
    // Fresh-only and transactional. All table names are fixed, never input-derived.
    await client.query('LOCK TABLE branch_config IN EXCLUSIVE MODE');
    if ((await client.query('SELECT id FROM branch_config LIMIT 1')).rowCount)
      throw new Error('A local branch already exists; no existing binding or menu is replaced');
    for (const table of [
      'menu_snapshots',
      'active_menu',
      'local_staff',
      'local_terminals',
      'local_orders',
      'staff_sessions',
    ]) {
      if ((await client.query(`SELECT 1 FROM ${table} LIMIT 1`)).rowCount)
        throw new Error('Fresh local preview requires empty serving tables');
    }
    await client.query(
      'INSERT INTO branch_config(id,code,name,timezone,ordering_enabled) VALUES($1,$2,$3,$4,false)',
      [branch.id, branch.code, branch.name, branch.timezone],
    );
    // An identified commissioning cashier anchors the audit; no token or usable
    // session is created here. The existing private staff CLI issues the 8h session.
    await client.query(
      "INSERT INTO local_staff(id,branch_id,name,role,access_expires_at) VALUES($1,$2,$3,'cashier',clock_timestamp())",
      [staff.staff_id, branch.id, staff.name],
    );
    await client.query('INSERT INTO local_terminals(id,branch_id) VALUES($1,$2)', [
      staff.terminal_id,
      branch.id,
    ]);
    await client.query(
      'INSERT INTO menu_snapshots(id,branch_id,version,schema_version,payload,checksum,published_at) VALUES($1,$2,1,1,$3,$4,$5)',
      [menu.release_id, branch.id, canonicalJson(menu), hashJson(menu), menu.published_at],
    );
    await client.query('INSERT INTO active_menu(branch_id,release_id) VALUES($1,$2)', [
      branch.id,
      menu.release_id,
    ]);
    await client.query(
      'INSERT INTO local_audit(id,branch_id,staff_id,action,resource_id) VALUES($1,$2,$3,$4,$5)',
      [auditId, branch.id, staff.staff_id, 'local.preview_prepared_unreviewed', menu.release_id],
    );
    return {
      format: 'pickchick-local-pos-draft-record-v1',
      state: 'local_preview_prepared',
      created_at: menu.published_at,
      branch_id: branch.id,
      release_id: menu.release_id,
      audit_id: auditId,
      input_sha256: prepared.inputHash,
      catalog_sha256: prepared.catalogSha256,
      source: prepared.source,
      menu_checksum: hashJson(menu),
      products: menu.items.length,
      ordering_enabled: false,
      content_reviewed: false,
      cloud_registered: false,
      cloud_published: false,
      session_issued: false,
      payments_enabled: false,
      kk_translation: 'untranslated_placeholder',
      images_in_pos: false,
      modifiers_in_pos: false,
      staff_setup: staff,
      pos_config: prepared.posConfig,
      next_menu: 'Explicit replacement/bootstrap review required before cloud sync or sales',
    };
  });
}

async function main() {
  let pool, record;
  let wroteDatabase = false;
  try {
    const config = loadConfig('edge');
    if (
      config.environment !== 'local' ||
      config.edgeFulfillmentEnabled ||
      config.fulfillmentTransportEnabled ||
      config.posOrderSyncEnabled
    )
      throw new Error('Local preview only; transport and fulfillment must remain disabled');
    const database = new URL(config.databaseUrl);
    if (database.search || database.hash || !database.username || !database.password)
      throw new Error('Dedicated private owner URL required');
    if (process.argv.length !== 3 || (await stat(process.argv[2])).size > 10000)
      throw new Error('Supply one bounded JSON setup file');
    const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
    const prepared = prepareLocalDraft(
      input,
      await readFile(new URL('../infra/windows/local-pos-draft-catalog.json', import.meta.url)),
      config.branchId,
    );
    const directory = new URL('../.local/', import.meta.url);
    await assertPrivateStaffPath(directory, 'directory');
    const recordPath = new URL('local-pos-draft-record.json', directory);
    record = await open(recordPath, 'wx', 0o600);
    await assertPrivateStaffPath(recordPath, 'file');
    await record.writeFile(
      JSON.stringify({
        state: 'prepared_not_committed',
        audit_id: prepared.auditId,
        branch_id: config.branchId,
        input_sha256: prepared.inputHash,
      }) + '\n',
    );
    await record.sync();
    pool = createPool(config.databaseUrl);
    const result = await provisionLocalDraft(pool, prepared);
    wroteDatabase = true;
    const recordBytes = Buffer.from(JSON.stringify(result, null, 2) + '\n');
    await record.truncate(0);
    let offset = 0;
    while (offset < recordBytes.length) {
      const { bytesWritten } = await record.write(
        recordBytes,
        offset,
        recordBytes.length - offset,
        offset,
      );
      if (!bytesWritten) throw new Error('Private record write made no progress');
      offset += bytesWritten;
    }
    await record.sync();
    console.log(
      JSON.stringify({
        event: 'local_draft_prepared',
        branch_id: config.branchId,
        products: result.products,
        ordering_enabled: false,
        content_reviewed: false,
        audit_id: result.audit_id,
        record: fileURLToPath(recordPath),
      }),
    );
  } catch {
    console.error(
      wroteDatabase
        ? 'Local draft committed but record update failed. Inspect the private record and database audit; do not rerun or replace the branch.'
        : 'Draft setup did not complete or commit outcome is unknown. Check private input, file permissions and existing branch/audit before recovery; no automatic retry.',
    );
    process.exitCode = 1;
  } finally {
    await record?.close();
    await pool?.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
