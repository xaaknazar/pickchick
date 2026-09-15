import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StaffSetupSchema, UuidSchema } from '@pickchick/contracts';
import { hashJson } from '@pickchick/menu-sync';
import { prepareLocalCatalogUpgrade, upgradedCatalogSha256 } from './local-pos-catalog-upgrade.mjs';
import { previewId } from './local-pos-draft.mjs';
import { localPosServiceInput } from './local-pos-service.mjs';
import { assertPrivateStaffPath } from './staff-file-permissions.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exactKeys = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const idKeys = [
  'manager_staff_id',
  'kitchen_staff_id',
  'kitchen_terminal_id',
  'prep_station_id',
  'assembly_station_id',
];
const planName = 'local-pos-operator-plan.json';
const encode = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

/** Pure plan generation. No pool, environment loader, password or provisioning call. */
export function prepareLocalPosOperatorPlan(input, sources, identity = {}) {
  if (
    !exactKeys(input, [
      'format',
      'confirmation',
      'branch_id',
      'cashier_staff_id',
      'cashier_terminal_id',
      'organization_id',
      'device_id',
      'cloud_producer_id',
      'expected_ordering_version',
    ]) ||
    input.format !== 'pickchick-local-pos-operator-input-v1' ||
    input.confirmation !== 'generate_private_unpaid_service_plan'
  )
    throw new Error('Explicit bounded operator plan input required');
  for (const key of [
    'branch_id',
    'cashier_staff_id',
    'cashier_terminal_id',
    'organization_id',
    'device_id',
    'cloud_producer_id',
  ])
    UuidSchema.parse(input[key]);
  if (
    !Number.isInteger(input.expected_ordering_version) ||
    input.expected_ordering_version < 1 ||
    input.expected_ordering_version >= 2147483647
  )
    throw new Error('Expected closed ordering version required');
  const { draftRecordBytes, upgradeRecordBytes, previousCatalogBytes, catalogBytes } = sources;
  const previous = JSON.parse(draftRecordBytes.toString('utf8'));
  const upgrade = JSON.parse(upgradeRecordBytes.toString('utf8'));
  const expectedUpgradeInput = {
    format: 'pickchick-local-pos-upgrade-v2',
    confirmation: 'upgrade_local_display_only',
    branch_id: input.branch_id,
    previous_release_id: previous.release_id,
    expected_menu_checksum: previous.menu_checksum,
    release_id: upgrade.release_id,
  };
  const prepared = prepareLocalCatalogUpgrade(
    expectedUpgradeInput,
    draftRecordBytes,
    previousCatalogBytes,
    catalogBytes,
    input.branch_id,
    new Date(upgrade.created_at),
  );
  if (
    prepared.staff.staff_id !== input.cashier_staff_id ||
    prepared.staff.terminal_id !== input.cashier_terminal_id ||
    upgrade.format !== 'pickchick-local-pos-upgrade-record-v2' ||
    upgrade.state !== 'local_preview_upgraded' ||
    upgrade.branch_id !== input.branch_id ||
    upgrade.previous_release_id !== previous.release_id ||
    upgrade.previous_menu_checksum !== previous.menu_checksum ||
    upgrade.previous_record_sha256 !== sha(draftRecordBytes) ||
    upgrade.input_sha256 !== hashJson(expectedUpgradeInput) ||
    upgrade.menu_checksum !== hashJson(prepared.menu) ||
    upgrade.catalog_sha256 !== upgradedCatalogSha256 ||
    hashJson(upgrade.source) !== hashJson(previous.source) ||
    upgrade.products !== 24 ||
    upgrade.images_in_pos !== prepared.menu.items.filter((i) => i.image_url).length ||
    upgrade.modifier_groups !==
      prepared.menu.items.reduce((n, item) => n + (item.modifier_groups?.length ?? 0), 0)
  )
    throw new Error('Completed catalog records or preserved cashier binding differ');
  UuidSchema.parse(upgrade.audit_id);
  for (const flag of [
    'ordering_enabled',
    'content_reviewed',
    'cloud_registered',
    'cloud_published',
    'payments_enabled',
  ])
    if (upgrade[flag] !== false)
      throw new Error('Expected completed closed preview upgrade record');
  const ids = identity.ids ?? Object.fromEntries(idKeys.map((key) => [key, randomUUID()]));
  if (!exactKeys(ids, idKeys)) throw new Error('Exact persisted identities required');
  const reserved = new Set([
    input.branch_id,
    input.cashier_staff_id,
    input.cashier_terminal_id,
    input.organization_id,
    input.device_id,
    input.cloud_producer_id,
  ]);
  for (const id of Object.values(ids)) {
    UuidSchema.parse(id);
    if (reserved.has(id)) throw new Error('New identities must not reuse an existing identity');
    reserved.add(id);
  }
  const createdAt = identity.createdAt ?? new Date().toISOString();
  if (new Date(createdAt).toISOString() !== createdAt)
    throw new Error('Canonical plan time required');
  const catalog = JSON.parse(catalogBytes.toString('utf8'));
  const categories = new Set(['Комбо', 'На двоих', 'На компанию', 'Допы', 'Напитки']);
  const packed = new Set(['sauce', 'sauce-hot', 'coleslaw']);
  const routing = catalog.products.map((product) => {
    if (
      !categories.has(product.category) ||
      (packed.has(product.source_id) && product.category !== 'Допы')
    )
      throw new Error('Unrecognized source routing category');
    const assembly = product.category === 'Напитки' || packed.has(product.source_id);
    return {
      source_id: product.source_id,
      category: product.category,
      name: product.name_ru,
      product_id: previewId(input.branch_id, 'product', product.source_id),
      station_id: assembly ? ids.assembly_station_id : ids.prep_station_id,
      kind: assembly ? 'assembly_item' : 'prep',
    };
  });
  if (
    routing.length !== 24 ||
    new Set(routing.map((r) => r.product_id)).size !== 24 ||
    routing.filter((r) => r.kind === 'assembly_item').length !== 9
  )
    throw new Error('Expected exact 24-product first-station plan');
  const manager = StaffSetupSchema.parse({
    staff_id: ids.manager_staff_id,
    terminal_id: input.cashier_terminal_id,
    name: 'Управляющий смены',
    role: 'shift_manager',
  });
  const kitchen = StaffSetupSchema.parse({
    staff_id: ids.kitchen_staff_id,
    terminal_id: ids.kitchen_terminal_id,
    name: 'Кухня и сборка',
    role: 'kitchen',
  });
  const service = localPosServiceInput({
    format: 'pickchick-local-pos-service-v1',
    confirmation: 'owner_authorized_unpaid_service',
    branch_id: input.branch_id,
    menu_release_id: prepared.menu.release_id,
    operator_staff_id: ids.manager_staff_id,
    expected_ordering_version: input.expected_ordering_version,
    fulfillment: {
      organizationId: input.organization_id,
      branchId: input.branch_id,
      deviceId: input.device_id,
      producerId: input.cloud_producer_id,
      stations: [
        { id: ids.prep_station_id, kind: 'prep', name: 'Кухня' },
        { id: ids.assembly_station_id, kind: 'assembly', name: 'Сборка' },
      ],
      routing: {
        version: 1,
        assemblyStationId: ids.assembly_station_id,
        routes: routing.map((r) => ({
          productId: r.product_id,
          stationId: r.station_id,
          kind: r.kind,
        })),
      },
    },
    station_grants: [ids.prep_station_id, ids.assembly_station_id].map((station_id) => ({
      staff_id: ids.kitchen_staff_id,
      station_id,
    })),
  });
  return {
    format: 'pickchick-local-pos-operator-plan-v1',
    state: 'plan_only_no_database_changes',
    created_at: createdAt,
    input_sha256: hashJson(input),
    draft_record_sha256: sha(draftRecordBytes),
    upgrade_record_sha256: sha(upgradeRecordBytes),
    catalog_sha256: upgradedCatalogSha256,
    menu_checksum: hashJson(prepared.menu),
    branch_id: input.branch_id,
    cashier_staff_id: input.cashier_staff_id,
    cashier_terminal_id: input.cashier_terminal_id,
    required_migration: '013_pos_kitchen_sync.sql',
    ids,
    routing,
    artifacts: {
      'staff-cashier.json': prepared.staff,
      'staff-manager.json': manager,
      'staff-kitchen.json': kitchen,
      'local-pos-service.json': service,
      // The local POS producer is obtained from the actual edge setup result, never invented here.
      'edge-pos-sync.json': {
        organizationId: input.organization_id,
        branchId: input.branch_id,
        deviceId: input.device_id,
      },
    },
  };
}

async function readPrivate(path, maximum) {
  await assertPrivateStaffPath(path, 'file');
  if ((await stat(path)).size > maximum) throw new Error('Private input exceeds its bound');
  return readFile(path);
}
async function saveExclusive(path, bytes) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await assertPrivateStaffPath(path, 'file');
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function existing(path) {
  try {
    return await readPrivate(path, 65536);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Identities are saved first. A later run can recreate missing artifacts, never replace differing bytes. */
export async function saveLocalPosOperatorPlan({
  inputPath,
  draftRecordPath,
  upgradeRecordPath,
  directory,
  previousCatalogBytes,
  catalogBytes,
}) {
  await assertPrivateStaffPath(directory, 'directory');
  const input = JSON.parse((await readPrivate(inputPath, 4096)).toString('utf8'));
  const sources = {
    draftRecordBytes: await readPrivate(draftRecordPath, 25000),
    upgradeRecordBytes: await readPrivate(upgradeRecordPath, 25000),
    previousCatalogBytes,
    catalogBytes,
  };
  const path = join(directory, planName);
  let saved = await existing(path),
    replayed = Boolean(saved),
    plan;
  if (!saved) {
    plan = prepareLocalPosOperatorPlan(input, sources);
    try {
      await saveExclusive(path, encode(plan));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      saved = await existing(path);
      replayed = true;
    }
  }
  if (saved) {
    const record = JSON.parse(saved.toString('utf8'));
    plan = prepareLocalPosOperatorPlan(input, sources, {
      ids: record.ids,
      createdAt: record.created_at,
    });
    if (!encode(plan).equals(saved))
      throw new Error('Saved plan differs; preserve and review, do not replace identities');
  }
  for (const [name, value] of Object.entries(plan.artifacts)) {
    const target = join(directory, name),
      bytes = encode(value);
    let old = await existing(target);
    if (!old) {
      try {
        await saveExclusive(target, bytes);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        old = await existing(target);
      }
    }
    if (old && !bytes.equals(old)) throw new Error('Existing operator input differs; no overwrite');
  }
  return {
    event: 'local_pos_operator_plan_saved',
    replayed,
    database_changed: false,
    products: plan.routing.length,
    prep_products: 15,
    assembly_products: 9,
  };
}

async function main() {
  try {
    if (process.argv.length !== 6)
      throw new Error(
        'Expected input, original record, upgrade record and existing private output directory',
      );
    const [inputPath, draftRecordPath, upgradeRecordPath, directory] = process.argv
      .slice(2)
      .map((value) => resolve(value));
    const result = await saveLocalPosOperatorPlan({
      inputPath,
      draftRecordPath,
      upgradeRecordPath,
      directory,
      previousCatalogBytes: await readFile(
        new URL('../infra/windows/local-pos-draft-catalog.json', import.meta.url),
      ),
      catalogBytes: await readFile(
        new URL('../infra/windows/local-pos-draft-catalog-v2.json', import.meta.url),
      ),
    });
    console.log(JSON.stringify(result));
  } catch {
    console.error(
      'LOCAL_POS_OPERATOR_PLAN_FAILED: verify private records, bindings and existing files. No database changes were attempted; retained files are never overwritten.',
    );
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
