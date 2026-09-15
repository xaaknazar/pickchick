import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { hashJson } from '@pickchick/menu-sync';
import { prepareLocalDraft } from '../../scripts/local-pos-draft.mjs';
import { prepareLocalCatalogUpgrade } from '../../scripts/local-pos-catalog-upgrade.mjs';
import {
  prepareLocalPosOperatorPlan,
  saveLocalPosOperatorPlan,
} from '../../scripts/local-pos-operator-plan.mjs';

const previousCatalogBytes = await readFile(
  new URL('../../infra/windows/local-pos-draft-catalog.json', import.meta.url),
);
const catalogBytes = await readFile(
  new URL('../../infra/windows/local-pos-draft-catalog-v2.json', import.meta.url),
);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const encode = (value) => Buffer.from(JSON.stringify(value));
function fixture() {
  const branch = randomUUID();
  const draft = prepareLocalDraft(
    {
      format: 'pickchick-local-pos-draft-v1',
      confirmation: 'prepare_local_display_only',
      branch: {
        id: branch,
        code: 'OPERATOR-TEST',
        name: 'Synthetic operator plan',
        timezone: 'Asia/Almaty',
        ordering_enabled: false,
      },
      staff: {
        staff_id: randomUUID(),
        terminal_id: randomUUID(),
        name: 'Synthetic cashier',
        role: 'cashier',
      },
      release_id: randomUUID(),
    },
    previousCatalogBytes,
    branch,
  );
  const draftRecordBytes = encode({
    format: 'pickchick-local-pos-draft-record-v1',
    state: 'local_preview_prepared',
    branch_id: branch,
    release_id: draft.menu.release_id,
    created_at: draft.menu.published_at,
    menu_checksum: hashJson(draft.menu),
    catalog_sha256: draft.catalogSha256,
    source: draft.source,
    products: 24,
    ordering_enabled: false,
    content_reviewed: false,
    cloud_registered: false,
    cloud_published: false,
    payments_enabled: false,
    images_in_pos: false,
    modifiers_in_pos: false,
    audit_id: draft.auditId,
    staff_setup: draft.staff,
  });
  const upgradeInput = {
    format: 'pickchick-local-pos-upgrade-v2',
    confirmation: 'upgrade_local_display_only',
    branch_id: branch,
    previous_release_id: draft.menu.release_id,
    expected_menu_checksum: hashJson(draft.menu),
    release_id: randomUUID(),
  };
  const upgrade = prepareLocalCatalogUpgrade(
    upgradeInput,
    draftRecordBytes,
    previousCatalogBytes,
    catalogBytes,
    branch,
  );
  const upgradeRecordBytes = encode({
    format: 'pickchick-local-pos-upgrade-record-v2',
    state: 'local_preview_upgraded',
    branch_id: branch,
    release_id: upgrade.menu.release_id,
    previous_release_id: draft.menu.release_id,
    previous_menu_checksum: hashJson(draft.menu),
    created_at: upgrade.menu.published_at,
    menu_checksum: hashJson(upgrade.menu),
    input_sha256: hashJson(upgradeInput),
    previous_record_sha256: sha(draftRecordBytes),
    catalog_sha256: upgrade.catalogSha256,
    source: draft.source,
    products: 24,
    images_in_pos: 23,
    modifier_groups: 31,
    ordering_enabled: false,
    content_reviewed: false,
    cloud_registered: false,
    cloud_published: false,
    payments_enabled: false,
    audit_id: upgrade.auditId,
  });
  const input = {
    format: 'pickchick-local-pos-operator-input-v1',
    confirmation: 'generate_private_unpaid_service_plan',
    branch_id: branch,
    cashier_staff_id: draft.staff.staff_id,
    cashier_terminal_id: draft.staff.terminal_id,
    organization_id: randomUUID(),
    device_id: randomUUID(),
    cloud_producer_id: randomUUID(),
    expected_ordering_version: 1,
  };
  return {
    input,
    sources: { draftRecordBytes, upgradeRecordBytes, previousCatalogBytes, catalogBytes },
    draft,
    upgrade,
  };
}
test('operator plan reconstructs all source routes, preserves cashier and distinguishes cloud/local producers without provisioning', () => {
  const { input, sources, draft, upgrade } = fixture();
  const plan = prepareLocalPosOperatorPlan(input, sources);
  assert.equal(plan.state, 'plan_only_no_database_changes');
  assert.equal(plan.required_migration, '013_pos_kitchen_sync.sql');
  assert.deepEqual(plan.artifacts['staff-cashier.json'], draft.staff);
  assert.equal(plan.artifacts['staff-manager.json'].terminal_id, draft.staff.terminal_id);
  assert.equal(plan.artifacts['staff-manager.json'].role, 'shift_manager');
  assert.equal(plan.artifacts['staff-kitchen.json'].terminal_id, plan.ids.kitchen_terminal_id);
  assert.equal(new Set(Object.values(plan.ids)).size, 5);
  const service = plan.artifacts['local-pos-service.json'];
  assert.equal(service.menu_release_id, upgrade.menu.release_id);
  assert.equal(service.fulfillment.producerId, input.cloud_producer_id);
  assert.deepEqual(plan.artifacts['edge-pos-sync.json'], {
    organizationId: input.organization_id,
    branchId: input.branch_id,
    deviceId: input.device_id,
  });
  assert.deepEqual(
    service.fulfillment.stations.map((s) => s.name),
    ['Кухня', 'Сборка'],
  );
  assert.equal(service.station_grants.length, 2);
  assert.deepEqual(
    new Set(service.fulfillment.routing.routes.map((r) => r.productId)),
    new Set(upgrade.menu.items.map((i) => i.product_id)),
  );
  assert.equal(plan.routing.filter((r) => r.kind === 'prep').length, 15);
  assert.deepEqual(
    plan.routing
      .filter((r) => r.kind === 'assembly_item')
      .map((r) => r.source_id)
      .sort(),
    [
      'sauce',
      'sauce-hot',
      'coleslaw',
      'lemonade',
      'cola',
      'fuse-peach',
      'iced-tea',
      'water',
      'piko',
    ].sort(),
  );
  assert.deepEqual(
    prepareLocalPosOperatorPlan(input, sources, { ids: plan.ids, createdAt: plan.created_at }),
    plan,
  );
  for (const alter of [
    (p) => {
      p.cashier_staff_id = randomUUID();
    },
    (p) => {
      p.cashier_terminal_id = randomUUID();
    },
    (p) => {
      p.branch_id = randomUUID();
    },
    (p) => {
      p.password = 'synthetic-secret';
    },
    (p) => {
      p.expected_ordering_version = 0;
    },
  ]) {
    const candidate = globalThis.structuredClone(input);
    alter(candidate);
    assert.throws(() => prepareLocalPosOperatorPlan(candidate, sources));
  }
  for (const change of [
    (p) => {
      p.state = 'prepared_not_committed';
    },
    (p) => {
      p.menu_checksum = 'f'.repeat(64);
    },
    (p) => {
      p.previous_record_sha256 = '0'.repeat(64);
    },
    (p) => {
      p.ordering_enabled = true;
    },
    (p) => {
      p.release_id = randomUUID();
    },
  ]) {
    const candidate = JSON.parse(sources.upgradeRecordBytes);
    change(candidate);
    assert.throws(() =>
      prepareLocalPosOperatorPlan(input, { ...sources, upgradeRecordBytes: encode(candidate) }),
    );
  }
  assert.throws(() =>
    prepareLocalPosOperatorPlan(input, {
      ...sources,
      catalogBytes: Buffer.concat([catalogBytes, Buffer.from(' ')]),
    }),
  );
  assert.throws(() =>
    prepareLocalPosOperatorPlan(input, sources, {
      ids: { ...plan.ids, manager_staff_id: input.cashier_staff_id },
    }),
  );
});

test('private file plan is repeatable, restores a missing artifact and refuses changed identities/content or public inputs', async () => {
  const { input, sources } = fixture();
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-operator-plan-'));
  try {
    const paths = {
      inputPath: join(directory, 'input.json'),
      draftRecordPath: join(directory, 'original.json'),
      upgradeRecordPath: join(directory, 'upgraded.json'),
    };
    for (const [path, bytes] of [
      [paths.inputPath, encode(input)],
      [paths.draftRecordPath, sources.draftRecordBytes],
      [paths.upgradeRecordPath, sources.upgradeRecordBytes],
    ])
      await writeFile(path, bytes, { mode: 0o600 });
    const args = { ...paths, directory, previousCatalogBytes, catalogBytes };
    assert.equal((await saveLocalPosOperatorPlan(args)).replayed, false);
    const recordPath = join(directory, 'local-pos-operator-plan.json'),
      original = await readFile(recordPath);
    assert.equal((await saveLocalPosOperatorPlan(args)).replayed, true);
    const kitchen = await readFile(join(directory, 'staff-kitchen.json'));
    await rm(join(directory, 'staff-kitchen.json'));
    assert.equal((await saveLocalPosOperatorPlan(args)).replayed, true);
    assert.deepEqual(await readFile(join(directory, 'staff-kitchen.json')), kitchen);
    assert.deepEqual(await readFile(recordPath), original);
    await writeFile(join(directory, 'staff-manager.json'), '{}');
    await assert.rejects(saveLocalPosOperatorPlan(args), /no overwrite/);
    assert.equal(await readFile(join(directory, 'staff-manager.json'), 'utf8'), '{}');
    await writeFile(paths.inputPath, encode({ ...input, device_id: randomUUID() }));
    await assert.rejects(saveLocalPosOperatorPlan(args), /Saved plan differs/);
    assert.deepEqual(await readFile(recordPath), original);
    if (process.platform !== 'win32') {
      await chmod(paths.inputPath, 0o644);
      await assert.rejects(saveLocalPosOperatorPlan(args), /Private credential file required/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('actual CLI writes only private artifacts without database configuration or secret-bearing output', async () => {
  const { input, sources } = fixture();
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-operator-cli-'));
  try {
    const files = ['input.json', 'original.json', 'upgraded.json'].map((name) =>
      join(directory, name),
    );
    for (const [index, bytes] of [
      encode(input),
      sources.draftRecordBytes,
      sources.upgradeRecordBytes,
    ].entries())
      await writeFile(files[index], bytes, { mode: 0o600 });
    const env = {
      ...process.env,
      EDGE_DATABASE_URL: 'invalid-and-unreachable',
      CLOUD_DATABASE_URL: 'invalid-and-unreachable',
    };
    const cli = fileURLToPath(
      new URL('../../scripts/local-pos-operator-plan.mjs', import.meta.url),
    );
    const first = spawnSync(process.execPath, [cli, ...files, directory], {
      env,
      encoding: 'utf8',
    });
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), {
      event: 'local_pos_operator_plan_saved',
      replayed: false,
      database_changed: false,
      products: 24,
      prep_products: 15,
      assembly_products: 9,
    });
    assert.equal(first.stderr, '');
    const second = spawnSync(process.execPath, [cli, ...files, directory], {
      env,
      encoding: 'utf8',
    });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).replayed, true);
    await writeFile(files[0], encode({ ...input, password: 'synthetic-secret-never-print' }));
    const rejected = spawnSync(process.execPath, [cli, ...files, directory], {
      env,
      encoding: 'utf8',
    });
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, '');
    assert.equal(rejected.stderr.includes('synthetic-secret-never-print'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
