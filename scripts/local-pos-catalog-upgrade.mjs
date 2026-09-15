import { createHash, randomUUID } from 'node:crypto';
import { readFile, open, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MenuSnapshotSchema, StaffSetupSchema, UuidSchema } from '@pickchick/contracts';
import { createPool, transaction } from '@pickchick/database';
import { canonicalJson, hashJson } from '@pickchick/menu-sync';
import { loadConfig } from '@pickchick/platform';
import { draftCatalogSha256, previewId } from './local-pos-draft.mjs';
import { assertPrivateStaffPath } from './staff-file-permissions.mjs';

export const upgradedCatalogSha256 =
  '7467e8f04cedfe88a7ff23d5c72b1167acbf64a41e72d5230b9df720923093a8';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ownKeys = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === keys.slice().sort().join(',');

export function prepareLocalCatalogUpgrade(
  input,
  previousRecordBytes,
  previousCatalogBytes,
  catalogBytes,
  branchId,
  now = new Date(),
) {
  if (
    !ownKeys(input, [
      'format',
      'confirmation',
      'branch_id',
      'previous_release_id',
      'expected_menu_checksum',
      'release_id',
    ]) ||
    input.format !== 'pickchick-local-pos-upgrade-v2' ||
    input.confirmation !== 'upgrade_local_display_only'
  )
    throw new Error('Explicit local display upgrade input required');
  UuidSchema.parse(input.branch_id);
  UuidSchema.parse(input.previous_release_id);
  UuidSchema.parse(input.release_id);
  if (
    input.branch_id !== branchId ||
    input.previous_release_id === input.release_id ||
    !/^[a-f0-9]{64}$/.test(input.expected_menu_checksum)
  )
    throw new Error('Upgrade branch/release/checksum binding differs');
  if (
    digest(previousCatalogBytes) !== draftCatalogSha256 ||
    digest(catalogBytes) !== upgradedCatalogSha256
  )
    throw new Error('Pinned catalog bytes differ');
  const previous = JSON.parse(previousRecordBytes.toString('utf8'));
  const oldCatalog = JSON.parse(previousCatalogBytes.toString('utf8'));
  const catalog = JSON.parse(catalogBytes.toString('utf8'));
  if (
    previous.format !== 'pickchick-local-pos-draft-record-v1' ||
    previous.state !== 'local_preview_prepared' ||
    previous.branch_id !== branchId ||
    previous.release_id !== input.previous_release_id ||
    previous.menu_checksum !== input.expected_menu_checksum ||
    previous.catalog_sha256 !== draftCatalogSha256 ||
    previous.products !== 24 ||
    hashJson(previous.source) !== hashJson(oldCatalog.source)
  )
    throw new Error('Original private preview-v1 record differs');
  for (const flag of [
    'ordering_enabled',
    'content_reviewed',
    'cloud_registered',
    'cloud_published',
    'payments_enabled',
    'images_in_pos',
    'modifiers_in_pos',
  ])
    if (previous[flag] !== false)
      throw new Error('Only the original unreviewed local display may be upgraded');
  UuidSchema.parse(previous.audit_id);
  const staff = StaffSetupSchema.parse(previous.staff_setup);
  if (
    staff.role !== 'cashier' ||
    catalog.format !== 'pickchick-local-pos-draft-catalog-v2' ||
    catalog.content_reviewed !== false ||
    catalog.products.length !== 24 ||
    hashJson(catalog.source) !== hashJson(oldCatalog.source)
  )
    throw new Error('Expected the pinned owner-source display projection');
  const oldItems = oldCatalog.products.map((item) => ({
    product_id: previewId(branchId, 'product', item.source_id),
    variant_id: previewId(branchId, 'base-preview', item.source_id),
    category_id: previewId(branchId, 'category', item.category),
    name: { ru: item.name_ru, kk: '-' },
    price_minor: item.price_minor,
    currency: 'KZT',
  }));
  const previousMenu = MenuSnapshotSchema.parse({
    schema_version: 1,
    release_id: previous.release_id,
    branch_id: branchId,
    version: 1,
    published_at: previous.created_at,
    items: oldItems,
  });
  if (hashJson(previousMenu) !== previous.menu_checksum)
    throw new Error('Original preview payload cannot be reconstructed from its pinned source');
  const menu = MenuSnapshotSchema.parse({
    schema_version: 1,
    release_id: input.release_id,
    branch_id: branchId,
    version: 2,
    published_at: now.toISOString(),
    items: catalog.products.map((product, index) => {
      const original = oldCatalog.products[index];
      if (
        product.source_id !== original.source_id ||
        product.name_ru !== original.name_ru ||
        product.category !== original.category ||
        product.price_minor !== original.price_minor ||
        product.image_asset_key !== original.image_asset_key
      )
        throw new Error('Upgrade changed a base item identity or price');
      return {
        ...oldItems[index],
        ...(product.image_url ? { image_url: product.image_url } : {}),
        ...(product.modifier_groups.length
          ? {
              modifier_groups: product.modifier_groups.map((group) => ({
                id: previewId(
                  branchId,
                  'modifier-group',
                  `${product.source_id}:${group.source_id}`,
                ),
                name: { ru: group.name_ru, kk: '-' },
                min_selected: group.min_selected,
                max_selected: group.max_selected,
                options: group.options.map((option) => ({
                  id: previewId(
                    branchId,
                    'modifier-option',
                    `${product.source_id}:${group.source_id}:${option.source_id}`,
                  ),
                  name: { ru: option.name_ru, kk: '-' },
                  price_minor: option.price_minor,
                  max_quantity: option.max_quantity,
                  default_quantity: option.default_quantity,
                  available: option.available,
                })),
              })),
            }
          : {}),
      };
    }),
  });
  return {
    menu,
    previousMenu,
    previous,
    staff,
    auditId: randomUUID(),
    inputHash: hashJson(input),
    previousRecordSha256: digest(previousRecordBytes),
    catalogSha256: upgradedCatalogSha256,
  };
}

export async function upgradeLocalCatalog(pool, prepared) {
  const { menu, previousMenu, previous, staff, auditId } = prepared;
  return transaction(pool, async (client) => {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('LOCK TABLE branch_config IN EXCLUSIVE MODE');
    await client.query(
      'LOCK TABLE menu_sync_state,inbox_messages,fulfillment_config,pos_order_sync_state IN SHARE MODE',
    );
    const branches = (await client.query('SELECT id,ordering_enabled FROM branch_config')).rows;
    if (branches.length !== 1 || branches[0].id !== menu.branch_id || branches[0].ordering_enabled)
      throw new Error('Assigned local preview must remain closed');
    const migration = await client.query(
      "SELECT 1 FROM schema_migrations WHERE scope='edge' AND version='010_edge_cash_shifts.sql'",
    );
    if (migration.rowCount !== 1)
      throw new Error('Reviewed cashier runtime/migration 010 required before catalog upgrade');
    for (const table of [
      'menu_sync_state',
      'inbox_messages',
      'fulfillment_config',
      'pos_order_sync_state',
    ])
      if ((await client.query(`SELECT 1 FROM ${table} LIMIT 1`)).rowCount)
        throw new Error('Cloud/sync/fulfillment binding prevents local preview upgrade');
    const audit = await client.query(
      "SELECT 1 FROM local_audit a JOIN local_staff s ON s.id=a.staff_id AND s.branch_id=a.branch_id WHERE a.id=$1 AND a.branch_id=$2 AND a.staff_id=$3 AND a.action='local.preview_prepared_unreviewed' AND a.resource_id=$4 AND s.role='cashier'",
      [previous.audit_id, menu.branch_id, staff.staff_id, previousMenu.release_id],
    );
    if (audit.rowCount !== 1) throw new Error('Original commissioning audit/staff binding differs');
    const active = (
      await client.query(
        'SELECT m.id,m.version,m.payload,m.checksum FROM active_menu a JOIN menu_snapshots m ON m.id=a.release_id AND m.branch_id=a.branch_id WHERE a.branch_id=$1 FOR UPDATE OF a',
        [menu.branch_id],
      )
    ).rows[0];
    if (
      !active ||
      active.id !== previousMenu.release_id ||
      active.version !== 1 ||
      active.checksum !== hashJson(previousMenu) ||
      hashJson(active.payload) !== hashJson(previousMenu)
    )
      throw new Error('Active snapshot is not the exact recorded preview-v1');
    if (
      (
        await client.query(
          'SELECT 1 FROM menu_snapshots WHERE branch_id=$1 AND version<>1 LIMIT 1',
          [menu.branch_id],
        )
      ).rowCount
    )
      throw new Error('A subsequent snapshot already exists; no retry or overwrite');
    await client.query(
      'INSERT INTO menu_snapshots(id,branch_id,version,schema_version,payload,checksum,published_at) VALUES($1,$2,2,1,$3,$4,$5)',
      [menu.release_id, menu.branch_id, canonicalJson(menu), hashJson(menu), menu.published_at],
    );
    const switched = await client.query(
      'UPDATE active_menu SET release_id=$1 WHERE branch_id=$2 AND release_id=$3',
      [menu.release_id, menu.branch_id, previousMenu.release_id],
    );
    if (switched.rowCount !== 1) throw new Error('Active preview pointer was not switched');
    await client.query(
      'INSERT INTO local_audit(id,branch_id,staff_id,action,resource_id) VALUES($1,$2,$3,$4,$5)',
      [
        auditId,
        menu.branch_id,
        staff.staff_id,
        'local.preview_catalog_upgraded_unreviewed',
        menu.release_id,
      ],
    );
    return {
      format: 'pickchick-local-pos-upgrade-record-v2',
      state: 'local_preview_upgraded',
      created_at: menu.published_at,
      branch_id: menu.branch_id,
      release_id: menu.release_id,
      previous_release_id: previousMenu.release_id,
      previous_menu_checksum: hashJson(previousMenu),
      menu_checksum: hashJson(menu),
      audit_id: auditId,
      input_sha256: prepared.inputHash,
      previous_record_sha256: prepared.previousRecordSha256,
      catalog_sha256: prepared.catalogSha256,
      source: previous.source,
      products: menu.items.length,
      images_in_pos: menu.items.filter((item) => item.image_url).length,
      modifier_groups: menu.items.reduce(
        (count, item) => count + (item.modifier_groups?.length ?? 0),
        0,
      ),
      ordering_enabled: false,
      content_reviewed: false,
      cloud_registered: false,
      cloud_published: false,
      payments_enabled: false,
      kk_translation: 'untranslated_placeholder',
    };
  });
}

async function main() {
  let pool, record;
  let committed = false;
  try {
    const config = loadConfig('edge');
    const database = new URL(config.databaseUrl);
    if (
      config.environment !== 'local' ||
      config.edgeFulfillmentEnabled ||
      config.fulfillmentTransportEnabled ||
      config.posOrderSyncEnabled ||
      database.search ||
      database.hash ||
      database.username !== 'pickchick_edge_owner' ||
      !database.password ||
      database.hostname !== '127.0.0.1' ||
      database.port !== '55433' ||
      database.pathname !== '/pickchick_edge'
    )
      throw new Error('Private native owner connection with local deployment flags required');
    if (process.argv.length !== 3 || (await stat(process.argv[2])).size > 10000)
      throw new Error('Supply one bounded private upgrade JSON input');
    await assertPrivateStaffPath(pathToFileURL(resolve(process.argv[2])), 'file');
    const directory = new URL('../.local/', import.meta.url);
    await assertPrivateStaffPath(directory, 'directory');
    const previousPath = new URL('local-pos-draft-record.json', directory);
    await assertPrivateStaffPath(previousPath, 'file');
    if ((await stat(previousPath)).size > 25000)
      throw new Error('Original private preview record is too large');
    const prepared = prepareLocalCatalogUpgrade(
      JSON.parse(await readFile(process.argv[2], 'utf8')),
      await readFile(previousPath),
      await readFile(new URL('../infra/windows/local-pos-draft-catalog.json', import.meta.url)),
      await readFile(new URL('../infra/windows/local-pos-draft-catalog-v2.json', import.meta.url)),
      config.branchId,
    );
    const recordPath = new URL('local-pos-catalog-upgrade-v2-record.json', directory);
    record = await open(recordPath, 'wx', 0o600);
    await assertPrivateStaffPath(recordPath, 'file');
    await record.writeFile(
      JSON.stringify({
        state: 'prepared_not_committed',
        branch_id: config.branchId,
        audit_id: prepared.auditId,
        previous_record_sha256: prepared.previousRecordSha256,
        input_sha256: prepared.inputHash,
      }) + '\n',
    );
    await record.sync();
    pool = createPool(config.databaseUrl);
    const result = await upgradeLocalCatalog(pool, prepared);
    committed = true;
    const bytes = Buffer.from(JSON.stringify(result, null, 2) + '\n');
    await record.truncate(0);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await record.write(bytes, offset, bytes.length - offset, offset);
      if (!bytesWritten) throw new Error('Private upgrade record write made no progress');
      offset += bytesWritten;
    }
    await record.sync();
    console.log(
      JSON.stringify({
        event: 'local_preview_catalog_upgraded',
        products: result.products,
        images: result.images_in_pos,
        modifier_groups: result.modifier_groups,
        ordering_enabled: false,
        content_reviewed: false,
        audit_id: result.audit_id,
      }),
    );
  } catch {
    console.error(
      committed
        ? 'Catalog upgrade committed but private record update failed. Inspect audit and record; no automatic retry.'
        : 'Catalog upgrade incomplete or commit outcome unknown. Inspect private records, active snapshot and audit; no automatic retry.',
    );
    process.exitCode = 1;
  } finally {
    await record?.close();
    await pool?.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
