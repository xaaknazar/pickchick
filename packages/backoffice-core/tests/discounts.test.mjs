import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '@pickchick/database';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { backofficeGrants } from '../../../infra/staging/backoffice-grants.mjs';
import { backofficeP1Grants } from '../../../infra/staging/backoffice-p1-grants.mjs';
import { Backoffice, BackofficeError } from '../dist/index.js';
import { people } from './consumption-fixture.mjs';
import { discountCatalog, publishDiscountCatalog as publish } from './discounts-fixture.mjs';

/**
 * Discount editor of lane bo-ui step 7 (discounts.ts; design-bo-ui.md 3, 4, 5.8) on PostgreSQL:
 * flag off = no view, no command, no key; validation; create, edit, switch on and off, archive
 * with revisions, history and audit; the scope by the head catalog; manager only; nothing is
 * published to the edge or the menu; the API role with exactly the P1 helper rights. Synthetic.
 */
const ON = Object.freeze({ discountsEnabled: true, rolesEnabled: true });
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
const is = (code, reason) => (error) =>
  error instanceof BackofficeError && error.code === code && error.reason === reason;
const request = (command, reason = 'Синтетическая скидка для проверки') => ({
  request_id: randomUUID(),
  reason,
  command,
});
const percent = (extra = {}) => ({
  name: 'Синтетическая скидка 10',
  kind: 'percent',
  percent_bp: 1000,
  value_minor: null,
  scope: { categories: [], products: [], channels: ['hall'] },
  schedule: { start_at: null, end_at: null, weekdays: ALL_DAYS, hours: [] },
  requires_manager_pin: true,
  combinable: false,
  ...extra,
});
const save = (id, revision, payload) => ({
  type: 'discount_save',
  id,
  expected_revision: revision,
  payload,
});
const state = (id, revision, value) => ({
  type: 'discount_state',
  id,
  state: value,
  expected_revision: revision,
});
const rows = async (c, sql, args = [c.branch]) => (await c.cloud.pool.query(sql, args)).rows;
const count = async (c, table) =>
  (await c.cloud.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
/** The read of GET branches/:id without the fields that follow the clock. */
const stable = (s) => {
  const copy = { ...s };
  for (const key of ['as_of', 'period_start', 'period_end']) delete copy[key];
  return copy;
};

test('flag off: no ops/discounts, no discount commands, no capability, no permission', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const id = randomUUID();
    for (const options of [{}, { rolesEnabled: true }, { staffPositionsEnabled: true }]) {
      const off = new Backoffice(c.cloud.pool, true, options);
      await assert.rejects(off.ops(manager.token, c.branch, 'discounts', {}), is('NOT_FOUND'));
      for (const command of [save(id, 0, percent()), state(id, 1, 'active')])
        await assert.rejects(
          off.command(manager.token, c.branch, request(command)),
          is('INVALID_REQUEST'),
        );
      const s = await off.read(manager.token, c.branch);
      assert.equal('discounts' in s.capabilities, false);
      assert.equal((s.permissions ?? []).includes('discounts.write'), false);
    }
    assert.equal(await count(c, 'bo_discounts'), 0);
    assert.equal(await count(c, 'bo_audit'), 0);
    // A stored discount changes nothing in the cloud lane read.
    const off = new Backoffice(c.cloud.pool, true, { rolesEnabled: true });
    const before = stable(await off.read(manager.token, c.branch));
    await c.cloud.pool.query(
      `INSERT INTO bo_discounts(id,branch_id,name,kind,percent_bp,scope,schedule,revision,created_by,updated_by)
       VALUES($1,$2,'Синтетическая',$3,1000,$4,$5,1,$6,$6)`,
      [
        id,
        c.branch,
        'percent',
        JSON.stringify(percent().scope),
        JSON.stringify(percent().schedule),
        manager.actor_id,
      ],
    );
    assert.deepEqual(stable(await off.read(manager.token, c.branch)), before);
    await assert.rejects(off.ops(manager.token, c.branch, 'discounts', {}), is('NOT_FOUND'));
  }));

test('validation: a bad discount is refused and writes nothing', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const bad = [
      percent({ percent_bp: 99 }),
      percent({ percent_bp: 10001 }),
      percent({ value_minor: '1000' }),
      percent({ kind: 'amount', percent_bp: null, value_minor: '0' }),
      percent({ kind: 'amount', percent_bp: null, value_minor: '100000001' }),
      percent({ name: '' }),
      percent({ name: 'а'.repeat(81) }),
      percent({ scope: { categories: [], products: [], channels: [] } }),
      percent({ scope: { categories: [], products: [], channels: ['pos'] } }),
      percent({
        schedule: {
          start_at: '2026-11-30T00:00:00Z',
          end_at: '2026-11-20T00:00:00Z',
          weekdays: ALL_DAYS,
          hours: [],
        },
      }),
      percent({ schedule: { start_at: null, end_at: null, weekdays: [], hours: [] } }),
      percent({
        schedule: {
          start_at: null,
          end_at: null,
          weekdays: ALL_DAYS,
          hours: [
            { from: '11:00', to: '14:00' },
            { from: '13:00', to: '15:00' },
          ],
        },
      }),
    ];
    for (const payload of bad)
      await assert.rejects(
        bo.command(manager.token, c.branch, request(save(randomUUID(), 0, payload))),
        is('INVALID_REQUEST'),
        JSON.stringify(payload),
      );
    // The command reason of the envelope (3..500 characters) is required as for every command.
    await assert.rejects(
      bo.command(manager.token, c.branch, request(save(randomUUID(), 0, percent()), 'ок')),
      is('INVALID_REQUEST'),
    );
    assert.equal(await count(c, 'bo_discounts'), 0);
    assert.equal(await count(c, 'bo_audit'), 0);
  }));

test('the manager creates, edits, switches on and off and archives: revisions, history, audit, replay', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const id = randomUUID();
    const first = request(save(id, 0, percent({ name: '  Синтетическая скидка 10  ' })));
    const created = await bo.command(manager.token, c.branch, first);
    assert.equal(created.id, id);
    assert.equal(created.name, 'Синтетическая скидка 10');
    assert.equal(created.state, 'draft');
    assert.equal(created.revision, 1);
    assert.equal(created.percent_bp, 1000);
    assert.equal(created.value_minor, null);
    assert.equal(created.requires_manager_pin, true);
    assert.equal(created.combinable, false);
    assert.equal(created.created_by_name, 'Синтетический управляющий');
    assert.equal(created.updated_by_name, 'Синтетический управляющий');
    // Exact replay answers the first result; the same request_id with another body is refused.
    assert.deepEqual(await bo.command(manager.token, c.branch, first), created);
    await assert.rejects(
      bo.command(manager.token, c.branch, {
        ...first,
        command: save(id, 0, percent({ percent_bp: 1500 })),
      }),
      is('CONFLICT'),
    );
    // A second create of the same id, a stale revision: CONFLICT.
    await assert.rejects(
      bo.command(manager.token, c.branch, request(save(id, 0, percent()))),
      is('CONFLICT'),
    );
    await assert.rejects(
      bo.command(manager.token, c.branch, request(state(id, 2, 'active'))),
      is('CONFLICT'),
    );
    // Switch on; the same state again is no change.
    const active = await bo.command(manager.token, c.branch, request(state(id, 1, 'active')));
    assert.deepEqual([active.state, active.revision], ['active', 2]);
    await assert.rejects(
      bo.command(manager.token, c.branch, request(state(id, 2, 'active'))),
      is('INVALID_REQUEST'),
    );
    // A save that changes nothing keeps the live discount and its revision.
    const same = await bo.command(
      manager.token,
      c.branch,
      request(
        save(id, 2, percent({ scope: { categories: [], products: [], channels: ['hall'] } })),
      ),
    );
    assert.deepEqual([same.state, same.revision], ['active', 2]);
    // An edit returns it to draft: a live discount is never changed silently.
    const amount = percent({
      name: 'Синтетическая скидка 500',
      kind: 'amount',
      percent_bp: null,
      value_minor: '50000',
      scope: { categories: [], products: [], channels: ['yandex_eda', 'hall', 'chocofood'] },
      schedule: {
        start_at: '2026-11-19T19:00:00Z',
        end_at: '2099-11-30T19:00:00Z',
        weekdays: [6, 7],
        hours: [{ from: '12:00', to: '16:00' }],
      },
      requires_manager_pin: false,
      combinable: true,
    });
    const edited = await bo.command(manager.token, c.branch, request(save(id, 2, amount)));
    assert.deepEqual([edited.state, edited.revision, edited.kind], ['draft', 3, 'amount']);
    assert.deepEqual(edited.scope.channels, ['hall', 'yandex_eda', 'chocofood']);
    assert.equal(edited.value_minor, '50000');
    assert.equal(edited.percent_bp, null);
    assert.equal(edited.schedule.start_at, '2026-11-19T19:00:00.000Z');
    const on = await bo.command(manager.token, c.branch, request(state(id, 3, 'active')));
    const off = await bo.command(manager.token, c.branch, request(state(id, 4, 'draft')));
    assert.deepEqual([on.state, off.state, off.revision], ['active', 'draft', 5]);
    // The archive is final; the name is free again afterwards.
    const archived = await bo.command(manager.token, c.branch, request(state(id, 5, 'archived')));
    assert.deepEqual([archived.state, archived.revision], ['archived', 6]);
    for (const command of [
      save(id, 6, percent()),
      state(id, 6, 'active'),
      state(id, 6, 'draft'),
      state(id, 6, 'archived'),
    ])
      await assert.rejects(
        bo.command(manager.token, c.branch, request(command)),
        is('CONFLICT', 'DISCOUNT_ARCHIVED'),
      );
    const again = await bo.command(
      manager.token,
      c.branch,
      request(save(randomUUID(), 0, percent({ name: 'синтетическая СКИДКА 500' }))),
    );
    assert.equal(again.revision, 1);
    await assert.rejects(
      bo.command(manager.token, c.branch, request(state(randomUUID(), 1, 'active'))),
      is('NOT_FOUND'),
    );

    // History: every stored revision, newest first, with the author; the owner trigger wrote it.
    const view = await bo.ops(manager.token, c.branch, 'discounts', { id });
    assert.equal(view.id, id);
    assert.deepEqual(
      view.history.map((r) => [r.revision, r.state, r.kind]),
      [
        [6, 'archived', 'amount'],
        [5, 'draft', 'amount'],
        [4, 'active', 'amount'],
        [3, 'draft', 'amount'],
        [2, 'active', 'percent'],
        [1, 'draft', 'percent'],
      ],
    );
    assert.equal(view.history[3].value_minor, '50000');
    assert.equal(view.history[5].percent_bp, 1000);
    assert.equal(view.history[0].changed_by_name, 'Синтетический управляющий');
    assert.equal(view.history_truncated, false);
    await assert.rejects(
      bo.ops(manager.token, c.branch, 'discounts', { id: randomUUID() }),
      is('NOT_FOUND'),
    );
    await assert.rejects(
      bo.ops(manager.token, c.branch, 'discounts', { id: 'x' }),
      is('INVALID_REQUEST'),
    );
    await assert.rejects(
      bo.ops(manager.token, c.branch, 'discounts', { state: 'active' }),
      is('INVALID_REQUEST'),
    );
    // Audit: one row per command that went through (the replay and the refusals add none).
    const audit = await rows(
      c,
      'SELECT action,entity_id,reason,before_value,after_value FROM bo_audit WHERE branch_id=$1 ORDER BY created_at,id',
    );
    assert.deepEqual(
      audit.map((a) => a.action),
      [
        'discount_save',
        'discount_state',
        'discount_save',
        'discount_save',
        'discount_state',
        'discount_state',
        'discount_state',
        'discount_save',
      ],
    );
    assert.equal(audit[0].entity_id, id);
    assert.equal(audit[0].before_value, null);
    assert.equal(audit[0].reason, 'Синтетическая скидка для проверки');
    assert.equal(audit[1].before_value.state, 'draft');
    assert.equal(audit[1].after_value.state, 'active');
    // The no-change save is audited with the same before and after.
    assert.deepEqual(audit[2].before_value, audit[2].after_value);
  }));

test('live names are unique without regard to case; a concurrent second create loses', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const a = randomUUID();
    await bo.command(manager.token, c.branch, request(save(a, 0, percent({ name: 'Обед' }))));
    await assert.rejects(
      bo.command(
        manager.token,
        c.branch,
        request(save(randomUUID(), 0, percent({ name: 'ОБЕД' }))),
      ),
      is('CONFLICT', 'DISCOUNT_NAME_TAKEN'),
    );
    // Renaming another discount to a live name is refused too; its own name may change case.
    const b = randomUUID();
    await bo.command(manager.token, c.branch, request(save(b, 0, percent({ name: 'Ужин' }))));
    await assert.rejects(
      bo.command(manager.token, c.branch, request(save(b, 1, percent({ name: 'обед' })))),
      is('CONFLICT', 'DISCOUNT_NAME_TAKEN'),
    );
    const renamed = await bo.command(
      manager.token,
      c.branch,
      request(save(a, 1, percent({ name: 'ОБЕД' }))),
    );
    assert.equal(renamed.name, 'ОБЕД');
    const results = await Promise.allSettled(
      [randomUUID(), randomUUID()].map((id) =>
        bo.command(manager.token, c.branch, request(save(id, 0, percent({ name: 'Завтрак' })))),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.ok(is('CONFLICT', 'DISCOUNT_NAME_TAKEN')(results.find((r) => r.reason).reason));
    assert.equal(
      (
        await rows(
          c,
          "SELECT count(*)::int n FROM bo_discounts WHERE branch_id=$1 AND name='Завтрак'",
        )
      )[0].n,
      1,
    );
  }));

test('scope by the head catalog: known categories and products only; the period of a switch-on', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const byItems = percent({
      name: 'Синтетическая скидка на курицу',
      scope: { categories: ['chicken'], products: ['cola'], channels: ['hall', 'glovo'] },
    });
    // No catalog yet: a scope by items cannot be checked; the whole menu can.
    await assert.rejects(
      bo.command(manager.token, c.branch, request(save(randomUUID(), 0, byItems))),
      is('NOT_READY', 'CATALOG_NOT_PUBLISHED'),
    );
    const whole = randomUUID();
    await bo.command(manager.token, c.branch, request(save(whole, 0, percent())));
    let view = await bo.ops(manager.token, c.branch, 'discounts', {});
    assert.equal(view.catalog, null);
    await publish(c);
    view = await bo.ops(manager.token, c.branch, 'discounts', {});
    assert.deepEqual(view.catalog, {
      version: 1,
      categories: [
        { id: 'chicken', name: 'Синтетическая курица' },
        { id: 'drinks', name: 'Синтетические напитки' },
      ],
      products: [
        { id: 'wings', name: 'Синтетические крылья', category_id: 'chicken' },
        { id: 'strips', name: 'Синтетические стрипсы', category_id: 'chicken' },
        { id: 'cola', name: 'Синтетическая кола', category_id: 'drinks' },
      ],
    });
    for (const scope of [
      { categories: ['burgers'], products: [], channels: ['hall'] },
      { categories: [], products: ['wings', 'pizza'], channels: ['hall'] },
    ])
      await assert.rejects(
        bo.command(
          manager.token,
          c.branch,
          request(save(randomUUID(), 0, percent({ name: 'Неизвестная', scope }))),
        ),
        is('NOT_FOUND', 'CATALOG_ITEM_NOT_FOUND'),
      );
    const items = randomUUID();
    const saved = await bo.command(manager.token, c.branch, request(save(items, 0, byItems)));
    assert.deepEqual(saved.scope, {
      categories: ['chicken'],
      products: ['cola'],
      channels: ['hall', 'glovo'],
    });
    // A product that leaves the catalog is reported, and the discount cannot be switched on.
    const next = discountCatalog();
    next.products = next.products.filter((p) => p.id !== 'cola');
    next.categories = next.categories.filter((p) => p.id !== 'drinks');
    await publish(c, 2, next);
    view = await bo.ops(manager.token, c.branch, 'discounts', {});
    const listed = view.discounts.find((d) => d.id === items);
    assert.deepEqual(listed.unknown_items, { categories: [], products: ['cola'] });
    assert.equal(listed.valid, true);
    await assert.rejects(
      bo.command(manager.token, c.branch, request(state(items, 1, 'active'))),
      is('NOT_FOUND', 'CATALOG_ITEM_NOT_FOUND'),
    );
    // An ended period cannot be switched on; one in the future can.
    const ended = randomUUID();
    const window = (start_at, end_at) => ({ start_at, end_at, weekdays: ALL_DAYS, hours: [] });
    await bo.command(
      manager.token,
      c.branch,
      request(
        save(
          ended,
          0,
          percent({
            name: 'Прошлая',
            schedule: window('2026-01-01T00:00:00Z', '2026-01-31T19:00:00Z'),
          }),
        ),
      ),
    );
    await assert.rejects(
      bo.command(manager.token, c.branch, request(state(ended, 1, 'active'))),
      is('INVALID_REQUEST', 'DISCOUNT_PERIOD_ENDED'),
    );
    const future = randomUUID();
    await bo.command(
      manager.token,
      c.branch,
      request(
        save(
          future,
          0,
          percent({ name: 'Будущая', schedule: window('2099-01-01T00:00:00Z', null) }),
        ),
      ),
    );
    await bo.command(manager.token, c.branch, request(state(future, 1, 'active')));
    await bo.command(manager.token, c.branch, request(state(whole, 1, 'active')));
    view = await bo.ops(manager.token, c.branch, 'discounts', {});
    // Live first (active, then drafts, by name); the period state per discount.
    assert.deepEqual(
      view.discounts.map((d) => [d.name, d.state, d.period]),
      [
        ['Будущая', 'active', 'not_started'],
        ['Синтетическая скидка 10', 'active', 'always'],
        ['Прошлая', 'draft', 'ended'],
        ['Синтетическая скидка на курицу', 'draft', 'always'],
      ],
    );
    assert.equal(view.applied_at_pos, false);
    assert.equal(view.published_to_edge, false);
    assert.deepEqual(view.channels, [
      'hall',
      'yandex_eda',
      'glovo',
      'chocofood',
      'mobile',
      'kiosk',
    ]);
    assert.equal(view.truncated, false);
    assert.equal('history' in view, false);
  }));

test('roles: only the manager writes; every role reads; permissions[] lists discounts.write for the manager', () =>
  withSyncDatabases(async (c) => {
    const { manager, shift, accountant, analyst } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const id = randomUUID();
    await bo.command(manager.token, c.branch, request(save(id, 0, percent())));
    for (const p of [shift, accountant]) {
      await assert.rejects(
        bo.command(p.token, c.branch, request(save(randomUUID(), 0, percent({ name: 'Чужая' })))),
        is('FORBIDDEN', 'ROLE_FORBIDDEN'),
      );
      await assert.rejects(
        bo.command(p.token, c.branch, request(state(id, 1, 'active'))),
        is('FORBIDDEN', 'ROLE_FORBIDDEN'),
      );
    }
    await assert.rejects(
      bo.command(analyst.token, c.branch, request(state(id, 1, 'archived'))),
      is('FORBIDDEN'),
    );
    for (const p of [manager, shift, accountant, analyst]) {
      const view = await bo.ops(p.token, c.branch, 'discounts', {});
      assert.deepEqual(
        view.discounts.map((d) => d.id),
        [id],
      );
      const s = await bo.read(p.token, c.branch);
      assert.equal(s.capabilities.discounts, true);
      assert.equal(s.permissions.includes('discounts.write'), p === manager, p.actor_id);
    }
    assert.deepEqual((await bo.read(manager.token, c.branch)).permissions.slice(-1), [
      'discounts.write',
    ]);
    // Without BACKOFFICE_ROLES_ENABLED the grant decides: the manager writes, the analyst reads.
    const plain = new Backoffice(c.cloud.pool, true, { discountsEnabled: true });
    const live = await plain.command(manager.token, c.branch, request(state(id, 1, 'active')));
    assert.equal(live.state, 'active');
    for (const p of [shift, analyst])
      await assert.rejects(
        plain.command(p.token, c.branch, request(state(id, 2, 'draft'))),
        is('FORBIDDEN'),
      );
    assert.equal((await plain.ops(analyst.token, c.branch, 'discounts', {})).discounts.length, 1);
    assert.equal('permissions' in (await plain.read(manager.token, c.branch)), false);
  }));

test('never published: no publication, no edge outbox, the menu and the public content unchanged', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    await publish(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const tables = [
      'bo_publications',
      'bo_delivery_outbox',
      'catalog_publications',
      'catalog_draft_versions',
      'catalog_branch_heads',
      'menu_releases',
      'menu_streams',
      'branch_menu_activations',
      'catalog_menu_deliveries',
      'commerce_outbox',
    ];
    const before = Object.fromEntries(
      await Promise.all(tables.map(async (t) => [t, await count(c, t)])),
    );
    const head = await rows(c, 'SELECT payload_hash FROM catalog_publications WHERE branch_id=$1');
    const content = await Promise.all(
      ['mobile', 'kiosk', 'display'].map((ch) => bo.content(c.branch, ch)),
    );
    const id = randomUUID();
    await bo.command(
      manager.token,
      c.branch,
      request(
        save(
          id,
          0,
          percent({
            scope: {
              categories: ['chicken'],
              products: [],
              channels: [...['hall', 'mobile', 'kiosk']],
            },
          }),
        ),
      ),
    );
    await bo.command(manager.token, c.branch, request(state(id, 1, 'active')));
    for (const t of tables) assert.equal(await count(c, t), before[t], t);
    assert.deepEqual(
      await rows(c, 'SELECT payload_hash FROM catalog_publications WHERE branch_id=$1'),
      head,
    );
    assert.deepEqual(
      await Promise.all(['mobile', 'kiosk', 'display'].map((ch) => bo.content(c.branch, ch))),
      content,
    );
    assert.equal(before.bo_publications + before.bo_delivery_outbox, 0);
  }));

/** A NOLOGIN role like pickchick_app with backofficeGrants, and a pool that acts as it. */
async function withRole(c, run) {
  const schema = c.cloud.schema;
  const role = 'bo_dc_' + randomUUID().replaceAll('-', '');
  let pool;
  await c.cloud.admin.query(
    `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
  );
  try {
    await c.cloud.pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await c.cloud.pool.query(backofficeGrants(role, true));
    // infra/staging/catalog-admin-grants.mjs gives the shared API role this read in any case.
    await c.cloud.pool.query(`GRANT SELECT ON catalog_publications TO ${role}`);
    const url = new URL(c.cloud.config.databaseUrl);
    url.searchParams.set('options', `-c search_path=${schema} -c role=${role}`);
    pool = createPool(url.toString());
    await run({ role, schema, pool });
  } finally {
    await pool?.end();
    await c.cloud.admin.query(`DROP OWNED BY ${role}`);
    await c.cloud.admin.query(`DROP ROLE ${role}`);
  }
}
const P1 = {
  backoffice: true,
  posDay: false,
  stockV2: false,
  autoconsume: false,
  managerShifts: false,
  discounts: false,
};

test('API role: NOT_READY without the P1 helper rights, the whole editor with exactly them', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    await publish(c);
    await withRole(c, async ({ role, schema, pool }) => {
      const bo = new Backoffice(pool, true, ON);
      assert.equal((await bo.read(manager.token, c.branch)).capabilities.discounts, false);
      assert.equal(
        (await bo.read(manager.token, c.branch)).permissions.includes('discounts.write'),
        false,
      );
      await assert.rejects(bo.ops(manager.token, c.branch, 'discounts', {}), is('NOT_READY'));
      const id = randomUUID();
      await assert.rejects(
        bo.command(manager.token, c.branch, request(save(id, 0, percent()))),
        is('NOT_READY'),
      );
      await c.cloud.pool.query(backofficeP1Grants(role, { ...P1, discounts: true }, schema));
      const s = await bo.read(manager.token, c.branch);
      assert.equal(s.capabilities.discounts, true);
      assert.deepEqual(s.permissions.slice(-1), ['discounts.write']);
      const created = await bo.command(
        manager.token,
        c.branch,
        request(
          save(
            id,
            0,
            percent({ scope: { categories: ['chicken'], products: ['cola'], channels: ['hall'] } }),
          ),
        ),
      );
      await bo.command(manager.token, c.branch, request(state(id, 1, 'active')));
      await bo.command(manager.token, c.branch, request(state(id, 2, 'archived')));
      const view = await bo.ops(manager.token, c.branch, 'discounts', { id });
      assert.equal(view.catalog.version, 1);
      assert.deepEqual(
        view.history.map((r) => r.revision),
        [3, 2, 1],
      );
      assert.equal(created.created_by_name, 'Синтетический управляющий');
      // The role never writes the history itself and never deletes.
      const denied = (error) => error?.code === '42501';
      await assert.rejects(
        pool.query(
          `INSERT INTO bo_discount_revisions(discount_id,branch_id,revision,snapshot,changed_by,changed_at)
           VALUES($1,$2,9,'{}',$3,now())`,
          [id, c.branch, manager.actor_id],
        ),
        denied,
      );
      await assert.rejects(pool.query('DELETE FROM bo_discounts'), denied);
      // Switched off again by the helper: NOT_READY, the rows stay.
      await c.cloud.pool.query(backofficeP1Grants(role, P1, schema));
      await assert.rejects(bo.ops(manager.token, c.branch, 'discounts', {}), is('NOT_READY'));
      assert.equal(await count(c, 'bo_discounts'), 1);
    });
  }));
