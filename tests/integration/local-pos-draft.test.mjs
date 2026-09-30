import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createPool, migrate } from '@pickchick/database';
import { createEdge } from '@pickchick/edge';
import { provisionStaff } from '@pickchick/local-orders';
import { prepareLocalDraft, provisionLocalDraft } from '../../scripts/local-pos-draft.mjs';
import { applyEdgeRuntimeGrants } from '../../infra/windows/edge-runtime-grants.mjs';

const catalog = await readFile(
  new URL('../../infra/windows/local-pos-draft-catalog.json', import.meta.url),
);
function input() {
  return {
    format: 'pickchick-local-pos-draft-v1',
    confirmation: 'prepare_local_display_only',
    branch: {
      id: randomUUID(),
      code: 'PREVIEW-TEST',
      name: 'Isolated preview test',
      timezone: 'Asia/Almaty',
      ordering_enabled: false,
    },
    staff: {
      staff_id: randomUUID(),
      terminal_id: randomUUID(),
      name: 'Test commissioning cashier',
      role: 'cashier',
    },
    release_id: randomUUID(),
  };
}

test('draft preserves pinned owner menu fields without adopting test identity or approving content', () => {
  const setup = input();
  const prepared = prepareLocalDraft(setup, catalog, setup.branch.id);
  const original = JSON.parse(catalog).products;
  assert.equal(prepared.menu.items.length, 24);
  assert.deepEqual(
    prepared.menu.items.map((i) => i.name.ru),
    original.map((i) => i.name_ru),
  );
  assert.deepEqual(
    prepared.menu.items.map((i) => i.price_minor),
    original.map((i) => i.price_minor),
  );
  assert.ok(prepared.menu.items.every((i) => i.name.kk === '-'));
  assert.match(prepared.posConfig.branchLabel, /ЧЕРНОВИК, НЕ ДЛЯ ПРОДАЖ/);
  assert.notEqual(prepared.menu.branch_id, '10000000-0000-4000-8000-000000000003');
  const repeat = prepareLocalDraft(setup, catalog, setup.branch.id);
  assert.deepEqual(prepared.menu.items, repeat.menu.items);
  assert.throws(() => prepareLocalDraft(setup, Buffer.from('modified'), setup.branch.id), /hash/);
  assert.throws(() => prepareLocalDraft(setup, catalog, randomUUID()), /exact local branch/);
  assert.throws(() =>
    prepareLocalDraft(
      { ...setup, branch: { ...setup.branch, ordering_enabled: true } },
      catalog,
      setup.branch.id,
    ),
  );
  assert.throws(() =>
    prepareLocalDraft(
      { ...setup, staff: { ...setup.staff, role: 'shift_manager' } },
      catalog,
      setup.branch.id,
    ),
  );
});

test('fresh local draft serves real restricted POS login/menu with ordering closed and no cloud or order effects', async () => {
  const connection =
    process.env.LOCAL_POS_DRAFT_TEST_DATABASE_URL ??
    'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55433/pickchick_edge';
  const checked = new URL(connection);
  assert.ok(['postgres:', 'postgresql:'].includes(checked.protocol));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(checked.hostname));
  assert.ok(['/pickchick_edge', '/pickchick_test'].includes(checked.pathname));
  assert.equal(checked.search, '');
  const schema = 'draft_' + randomUUID().replaceAll('-', '');
  const role = 'draft_runtime_' + randomUUID().replaceAll('-', '');
  const admin = createPool(connection),
    password = randomBytes(32).toString('hex');
  let owner, app;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    const url = new URL(connection);
    url.searchParams.set('options', `-c search_path=${schema}`);
    owner = createPool(url.toString());
    await migrate(
      owner,
      fileURLToPath(new URL('../../db/edge/migrations/', import.meta.url)),
      'edge',
    );
    const setup = input(),
      prepared = prepareLocalDraft(setup, catalog, setup.branch.id);
    // Fail at the final audit INSERT and verify that the earlier branch/menu/staff
    // writes roll back as one unit, rather than leaving a partly prepared point.
    await assert.rejects(
      provisionLocalDraft(owner, { ...prepared, auditId: 'invalid-final-audit-id' }),
    );
    for (const table of [
      'branch_config',
      'menu_snapshots',
      'active_menu',
      'local_staff',
      'local_terminals',
      'local_audit',
    ])
      assert.equal((await owner.query(`SELECT count(*) FROM ${table}`)).rows[0].count, '0');
    const result = await provisionLocalDraft(owner, prepared);
    assert.equal(result.content_reviewed, false);
    assert.equal(result.session_issued, false);
    assert.equal(result.cloud_published, false);
    assert.equal((await owner.query('SELECT count(*) FROM staff_sessions')).rows[0].count, '0');
    const different = input();
    await assert.rejects(
      provisionLocalDraft(owner, prepareLocalDraft(different, catalog, different.branch.id)),
      /already exists/,
    );
    await assert.rejects(provisionLocalDraft(owner, prepared), /already exists/);
    assert.equal((await owner.query('SELECT count(*) FROM menu_snapshots')).rows[0].count, '1');
    assert.equal(
      (
        await owner.query(
          "SELECT count(*) FROM local_audit WHERE action='local.preview_prepared_unreviewed'",
        )
      ).rows[0].count,
      '1',
    );
    for (const table of [
      'local_orders',
      'checkout_quotes',
      'outbox_events',
      'inbox_messages',
      'menu_sync_state',
    ])
      assert.equal((await owner.query(`SELECT count(*) FROM ${table}`)).rows[0].count, '0');
    const credential = await provisionStaff(owner, setup.branch.id, setup.staff);
    await applyEdgeRuntimeGrants(owner, role, { schema });
    url.username = role;
    url.password = password;
    app = await createEdge({
      service: 'edge',
      environment: 'local',
      branchId: setup.branch.id,
      databaseUrl: url.toString(),
      port: 0,
    });
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const headers = {
      Authorization: `Bearer ${credential.token}`,
      'X-Staff-Session-Id': credential.session_id,
    };
    assert.equal((await fetch(origin + '/health/ready')).status, 200);
    const session = await fetch(origin + '/edge/v1/session', { headers });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).role, 'cashier');
    const menu = await fetch(origin + '/edge/v1/menu', { headers });
    assert.equal(menu.status, 200);
    assert.equal((await menu.json()).items.length, 24);
    const ordering = await fetch(origin + '/edge/v1/ordering', { headers });
    assert.equal((await ordering.json()).ordering_enabled, false);
    const quote = await fetch(origin + '/edge/v1/checkout/quotes', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        release_id: setup.release_id,
        service_mode: 'takeaway',
        items: [{ variant_id: prepared.menu.items[0].variant_id, quantity: 1 }],
      }),
    });
    assert.equal((await quote.json()).code, 'BRANCH_UNAVAILABLE');
    const open = await fetch(origin + '/edge/v1/ordering/open', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ expected_version: 1 }),
    });
    assert.equal(open.status, 403);
    assert.equal(
      (await owner.query('SELECT ordering_enabled FROM branch_config')).rows[0].ordering_enabled,
      false,
    );
    assert.equal((await owner.query('SELECT count(*) FROM local_orders')).rows[0].count, '0');
  } finally {
    await app?.close();
    await owner?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`DROP OWNED BY ${role}`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  }
});
