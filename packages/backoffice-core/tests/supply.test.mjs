import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '@pickchick/database';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { backofficeGrants } from '../../../infra/staging/backoffice-grants.mjs';
import { backofficeSupplyGrants } from '../../../infra/staging/backoffice-supply-grants.mjs';
import { Backoffice, BackofficeError } from '../dist/index.js';
import { balances, people } from './consumption-fixture.mjs';

/**
 * Suppliers, prices and supply requests of lane bo-ui2 step 2 (supply.ts; design-bo-ui.md §9) on
 * PostgreSQL: flag off = no view, no command, no key; suppliers and prices with revisions and the
 * audit; drafts, submission with the balance and the hint of that moment, cancellation with a
 * reason, a partial receipt that posts exactly one stock v2 receipt linked once; idempotency,
 * revisions, concurrency; the role matrix; the API role with exactly the 076 helper rights.
 * Synthetic names and amounts only.
 */
const ON = Object.freeze({ rolesEnabled: true, stockV2Enabled: true, supplyEnabled: true });
const is = (code, reason) => (error) =>
  error instanceof BackofficeError && error.code === code && error.reason === reason;
const request = (command, reason = 'Синтетическая заявка для проверки') => ({
  request_id: randomUUID(),
  reason,
  command,
});
const count = async (c, table) =>
  (await c.cloud.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
const rows = async (c, sql, args = [c.branch]) => (await c.cloud.pool.query(sql, args)).rows;
const almaty = (offsetDays = 0) => {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Almaty',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};
const supplierSave = (id, revision, payload) => ({
  type: 'supplier_save',
  id,
  expected_revision: revision,
  payload,
});
const priceSave = (supplier, ingredient, unit, validFrom, price, revision = 0) => ({
  type: 'supplier_price_save',
  supplier_id: supplier,
  ingredient_id: ingredient,
  unit,
  valid_from: validFrom,
  price_minor: price,
  expected_revision: revision,
});
const requestSave = (id, revision, payload) => ({
  type: 'supply_request_save',
  id,
  expected_revision: revision,
  payload: { supplier_id: null, needed_by: almaty(1), note: null, ...payload },
});
const submit = (id, revision) => ({
  type: 'supply_request_submit',
  id,
  expected_revision: revision,
});
const cancel = (id, revision) => ({
  type: 'supply_request_cancel',
  id,
  expected_revision: revision,
});
const receive = (id, revision, lines, extra = {}) => ({
  type: 'supply_request_receive',
  id,
  expected_revision: revision,
  reference: 'НАК-7',
  document_date: almaty(),
  lines,
  ...extra,
});
/** Ingredients of the tests and an opening receipt of the bun (balance 4). */
async function stock(bo, token, c) {
  const save = async (name, unit, minimum, active = true) => {
    const id = randomUUID();
    await bo.command(
      token,
      c.branch,
      request(
        {
          type: 'save',
          kind: 'ingredient',
          id,
          expected_revision: 0,
          payload: { name, unit, minimum, active },
        },
        'Синтетическая позиция',
      ),
    );
    return id;
  };
  const s = {
    bun: await save('Синтетическая булка', 'pcs', '10'),
    fillet: await save('Синтетическое филе', 'g', '1000'),
    salt: await save('Синтетическая соль', 'g', '0'),
    old: await save('Синтетическая старая позиция', 'pcs', '0', false),
  };
  await receiptOf(bo, token, c, [[s.bun, '4', '4000']]);
  return s;
}
async function receiptOf(bo, token, c, lines) {
  const now = await balances(c);
  return bo.command(
    token,
    c.branch,
    request(
      {
        type: 'stock',
        kind: 'receipt',
        reference: 'СИН-П',
        meta: { supplier_kind: 'household', document_date: almaty() },
        lines: lines.map(([ingredient_id, quantity, value_minor]) => ({
          ingredient_id,
          quantity,
          value_minor,
          expected_revision: now[ingredient_id].revision,
        })),
      },
      'Синтетическая поставка',
    ),
  );
}
const receiveLines = async (c, lines) => {
  const now = await balances(c);
  return lines.map(([ingredient_id, quantity, value_minor]) => ({
    ingredient_id,
    quantity,
    value_minor,
    expected_revision: now[ingredient_id].revision,
  }));
};
/** All six command bodies (for the flag and role checks). */
const bodies = (s, supplier, id) => [
  supplierSave(supplier, 0, { name: 'Поставщик 1', kind: 'supplier', active: true }),
  priceSave(supplier, s.fillet, 'kg', almaty(), '250000'),
  requestSave(id, 0, { kind: 'bakery', lines: [{ ingredient_id: s.bun, qty: '30' }] }),
  submit(id, 1),
  cancel(id, 1),
  receive(id, 2, [
    { ingredient_id: s.bun, quantity: '30', value_minor: '30000', expected_revision: 1 },
  ]),
];
const SUPPLY_TABLES = [
  'bo_suppliers',
  'bo_supplier_prices',
  'bo_supplier_price_imports',
  'bo_supply_requests',
];

test('flag off: no supplier or request views, no supply commands, no key, no permission', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const s = await stock(
      new Backoffice(c.cloud.pool, true, { stockV2Enabled: true }),
      manager.token,
      c,
    );
    const audit = await count(c, 'bo_audit');
    for (const options of [
      {},
      { rolesEnabled: true, stockV2Enabled: true },
      // Another second-wave flag parses its own commands only.
      { rolesEnabled: true, stockV2Enabled: true, stockReportsEnabled: true },
    ]) {
      const off = new Backoffice(c.cloud.pool, true, options);
      for (const view of ['suppliers', 'supply-requests'])
        await assert.rejects(
          off.ops(manager.token, c.branch, view, { start_date: almaty(), end_date: almaty() }),
          is('NOT_FOUND'),
          view,
        );
      for (const body of bodies(s, randomUUID(), randomUUID()))
        await assert.rejects(
          off.command(manager.token, c.branch, request(body)),
          is('INVALID_REQUEST'),
          body.type,
        );
      const read = await off.read(manager.token, c.branch);
      assert.equal('supply' in read.capabilities, false);
      for (const p of ['suppliers.write', 'supply.write', 'supply.close'])
        assert.equal((read.permissions ?? []).includes(p), false, p);
    }
    // The flag without stock v2 (loadConfig refuses it): the key is false and nothing runs.
    const alone = new Backoffice(c.cloud.pool, true, { rolesEnabled: true, supplyEnabled: true });
    assert.equal((await alone.read(manager.token, c.branch)).capabilities.supply, false);
    await assert.rejects(alone.ops(manager.token, c.branch, 'suppliers', {}), is('NOT_READY'));
    for (const body of bodies(s, randomUUID(), randomUUID()))
      await assert.rejects(
        alone.command(manager.token, c.branch, request(body)),
        is('INVALID_REQUEST'),
      );
    for (const table of SUPPLY_TABLES) assert.equal(await count(c, table), 0, table);
    assert.equal(await count(c, 'bo_audit'), audit);
  }));

test('suppliers: create, edit, archive; name and kind rules; revisions; idempotency; audit', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const run = (body, reason) => bo.command(manager.token, c.branch, request(body, reason));
    const id = randomUUID();
    const first = request(
      supplierSave(id, 0, { name: '  Поставщик \t 1 ', kind: 'supplier', active: true }),
      'Новый синтетический поставщик',
    );
    const created = await bo.command(manager.token, c.branch, first);
    assert.equal(created.name, 'Поставщик 1');
    assert.equal(created.kind, 'supplier');
    assert.equal(created.active, true);
    assert.equal(created.revision, 1);
    assert.equal(created.prices, 0);
    assert.equal(created.created_by_name, 'Синтетический управляющий');
    // The same request again: the same answer, nothing new; another body under it: CONFLICT.
    assert.deepEqual(await bo.command(manager.token, c.branch, first), created);
    await assert.rejects(
      bo.command(manager.token, c.branch, {
        ...first,
        command: supplierSave(id, 0, { name: 'Поставщик 2', kind: 'supplier', active: true }),
      }),
      is('CONFLICT'),
    );
    assert.equal(await count(c, 'bo_suppliers'), 1);
    // A taken name, whatever the case and the spaces, also for a new supplier of another kind.
    await assert.rejects(
      run(supplierSave(randomUUID(), 0, { name: 'поставщик  1', kind: 'bakery', active: true })),
      is('CONFLICT', 'SUPPLIER_NAME_TAKEN'),
    );
    // Bad payloads.
    for (const payload of [
      { name: '', kind: 'supplier', active: true },
      { name: '   ', kind: 'supplier', active: true },
      { name: 'а'.repeat(121), kind: 'supplier', active: true },
      { name: 'Поставщик\u00073', kind: 'supplier', active: true },
      { name: 'Поставщик 3', kind: 'household', active: true },
      { name: 'Поставщик 3', kind: 'supplier' },
      { name: 'Поставщик 3', kind: 'supplier', active: true, bin: '0' },
    ])
      await assert.rejects(run(supplierSave(randomUUID(), 0, payload)), is('INVALID_REQUEST'));
    // The kind never changes; a stale revision is a CONFLICT.
    await assert.rejects(
      run(supplierSave(id, 1, { name: 'Поставщик 1', kind: 'bakery', active: true })),
      is('INVALID_REQUEST'),
    );
    await assert.rejects(
      run(supplierSave(id, 0, { name: 'Поставщик 1', kind: 'supplier', active: true })),
      is('CONFLICT'),
    );
    // The same values: no new revision.
    const same = await run(
      supplierSave(id, 1, { name: 'Поставщик 1', kind: 'supplier', active: true }),
    );
    assert.equal(same.revision, 1);
    const renamed = await run(
      supplierSave(id, 1, { name: 'Поставщик 1А', kind: 'supplier', active: true }),
      'Синтетическое переименование',
    );
    assert.equal(renamed.revision, 2);
    const archived = await run(
      supplierSave(id, 2, { name: 'Поставщик 1А', kind: 'supplier', active: false }),
      'Синтетический архив',
    );
    assert.equal(archived.active, false);
    assert.equal(archived.revision, 3);
    const bakery = await run(
      supplierSave(randomUUID(), 0, { name: 'Пекарня 1', kind: 'bakery', active: true }),
    );
    // The list: active first, by name.
    const view = await bo.ops(manager.token, c.branch, 'suppliers', {});
    assert.equal(view.view, 'suppliers');
    assert.deepEqual(
      view.suppliers.map((s) => [s.name, s.active, s.revision]),
      [
        ['Пекарня 1', true, 1],
        ['Поставщик 1А', false, 3],
      ],
    );
    assert.equal(view.truncated.suppliers, false);
    assert.equal(view.suppliers[0].id, bakery.id);
    // The audit keeps every change with the values before and after.
    const audit = await rows(
      c,
      "SELECT action,entity_id,reason,before_value,after_value FROM bo_audit WHERE branch_id=$1 AND action='supplier_save' ORDER BY created_at,id",
    );
    assert.deepEqual(
      audit.map((a) => [a.reason, a.before_value?.name ?? null, a.after_value.name]),
      [
        ['Новый синтетический поставщик', null, 'Поставщик 1'],
        ['Синтетическая заявка для проверки', 'Поставщик 1', 'Поставщик 1'],
        ['Синтетическое переименование', 'Поставщик 1', 'Поставщик 1А'],
        ['Синтетический архив', 'Поставщик 1А', 'Поставщик 1А'],
        ['Синтетическая заявка для проверки', null, 'Пекарня 1'],
      ],
    );
    assert.equal(audit[3].after_value.active, false);
    assert.equal(audit[0].entity_id, id);
    // The database refuses a kind change and a delete even from the owner.
    await assert.rejects(
      c.cloud.pool.query("UPDATE bo_suppliers SET kind='bakery',revision=revision+1 WHERE id=$1", [
        id,
      ]),
      (e) => e.code === '23514',
    );
    await assert.rejects(
      c.cloud.pool.query('DELETE FROM bo_suppliers WHERE id=$1', [id]),
      (e) => e.code === '23514',
    );
  }));

test('prices: manual entry, unit rules, the price in force, corrections with revisions and audit', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const run = (body, reason) => bo.command(manager.token, c.branch, request(body, reason));
    const s = await stock(bo, manager.token, c);
    const supplier = randomUUID();
    await run(supplierSave(supplier, 0, { name: 'Поставщик 1', kind: 'supplier', active: true }));
    const today = await run(priceSave(supplier, s.fillet, 'kg', almaty(), '250000'));
    assert.deepEqual(
      [
        today.unit,
        today.price_minor,
        today.valid_from,
        today.in_force,
        today.source,
        today.revision,
      ],
      ['kg', '250000', almaty(), true, 'manual', 1],
    );
    assert.equal(today.ingredient_name, 'Синтетическое филе');
    await run(priceSave(supplier, s.fillet, 'kg', almaty(-10), '240000'));
    await run(priceSave(supplier, s.fillet, 'kg', almaty(5), '260000'));
    await run(priceSave(supplier, s.bun, 'pcs', almaty(-1), '1500'));
    // The unit must measure the ingredient; unknown supplier or ingredient; bad values.
    await assert.rejects(
      run(priceSave(supplier, s.bun, 'kg', almaty(), '100')),
      is('INVALID_REQUEST', 'PRICE_UNIT_MISMATCH'),
    );
    await assert.rejects(
      run(priceSave(supplier, s.fillet, 'ml', almaty(), '100')),
      is('INVALID_REQUEST', 'PRICE_UNIT_MISMATCH'),
    );
    await assert.rejects(
      run(priceSave(randomUUID(), s.fillet, 'kg', almaty(), '100')),
      is('NOT_FOUND'),
    );
    await assert.rejects(
      run(priceSave(supplier, randomUUID(), 'kg', almaty(), '100')),
      is('NOT_FOUND'),
    );
    for (const bad of [
      priceSave(supplier, s.fillet, 'kg', almaty(), '0'),
      priceSave(supplier, s.fillet, 'kg', almaty(), '-1'),
      priceSave(supplier, s.fillet, 'kg', almaty(), '12.5'),
      priceSave(supplier, s.fillet, 'kg', almaty(), '1'.repeat(16)),
      priceSave(supplier, s.fillet, 'kg', '2023-12-31', '100'),
      priceSave(supplier, s.fillet, 'kg', '2026-02-30', '100'),
      priceSave(supplier, s.fillet, 'box', almaty(), '100'),
    ])
      await assert.rejects(run(bad), is('INVALID_REQUEST'));
    // A correction raises the revision; a stale one is a CONFLICT; the same price is no change.
    await assert.rejects(
      run(priceSave(supplier, s.fillet, 'kg', almaty(), '255000', 0)),
      is('CONFLICT'),
    );
    const fixed = await run(
      priceSave(supplier, s.fillet, 'kg', almaty(), '255000', 1),
      'Синтетическая поправка цены',
    );
    assert.deepEqual([fixed.price_minor, fixed.revision], ['255000', 2]);
    assert.equal(
      (await run(priceSave(supplier, s.fillet, 'kg', almaty(), '255000', 2))).revision,
      2,
    );
    const audit = await rows(
      c,
      "SELECT reason,before_value,after_value,entity_id FROM bo_audit WHERE branch_id=$1 AND action='supplier_price_save' AND reason='Синтетическая поправка цены'",
    );
    assert.equal(audit.length, 1);
    assert.equal(audit[0].before_value.price_minor, '250000');
    assert.equal(audit[0].after_value.price_minor, '255000');
    assert.equal(audit[0].entity_id, supplier);
    // The history per ingredient and the price in force today.
    const view = await bo.ops(manager.token, c.branch, 'suppliers', { id: supplier });
    assert.deepEqual(
      view.prices.map((p) => [p.ingredient_name, p.unit, p.valid_from, p.price_minor, p.in_force]),
      [
        ['Синтетическая булка', 'pcs', almaty(-1), '1500', true],
        ['Синтетическое филе', 'kg', almaty(5), '260000', false],
        ['Синтетическое филе', 'kg', almaty(), '255000', true],
        ['Синтетическое филе', 'kg', almaty(-10), '240000', false],
      ],
    );
    assert.deepEqual(view.imports, []);
    assert.equal(view.suppliers[0].prices, 4);
    assert.equal(view.suppliers[0].last_valid_from, almaty(5));
    await assert.rejects(
      bo.ops(manager.token, c.branch, 'suppliers', { id: randomUUID() }),
      is('NOT_FOUND'),
    );
    await assert.rejects(
      bo.ops(manager.token, c.branch, 'suppliers', { id: 'x' }),
      is('INVALID_REQUEST'),
    );
    // An archived supplier takes no new price; its prices stay.
    await run(supplierSave(supplier, 1, { name: 'Поставщик 1', kind: 'supplier', active: false }));
    await assert.rejects(
      run(priceSave(supplier, s.fillet, 'kg', almaty(1), '1')),
      is('CONFLICT', 'SUPPLIER_INACTIVE'),
    );
    assert.equal(await count(c, 'bo_supplier_prices'), 4);
  }));

test('requests: drafts with the balance and the hint, submission freezes the lines of that moment', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const run = (body, reason) => bo.command(manager.token, c.branch, request(body, reason));
    const s = await stock(bo, manager.token, c);
    const id = randomUUID();
    const draft = await run(
      requestSave(id, 0, {
        kind: 'bakery',
        note: '  К утру  ',
        lines: [
          { ingredient_id: s.bun, qty: '30' },
          { ingredient_id: s.salt, qty: '500' },
        ],
      }),
    );
    assert.deepEqual(
      [draft.number, draft.kind, draft.state, draft.revision, draft.note, draft.supplier],
      [1, 'bakery', 'draft', 1, 'К утру', null],
    );
    assert.deepEqual(
      draft.lines.map((l) => [l.name, l.unit, l.qty, l.balance_at_request, l.hint, l.price_minor]),
      [
        ['Синтетическая булка', 'pcs', '30', '4', '6', null],
        // No minimum, no hint.
        ['Синтетическая соль', 'g', '500', '0', null, null],
      ],
    );
    assert.equal(draft.total_minor, null);
    assert.equal(draft.unpriced_lines, null);
    // An edit raises the revision; the same body is no change; a stale revision is a CONFLICT.
    const lines = [{ ingredient_id: s.bun, qty: '40' }];
    const edited = await run(requestSave(id, 1, { kind: 'bakery', note: 'К утру', lines }));
    assert.equal(edited.revision, 2);
    assert.equal(
      (await run(requestSave(id, 2, { kind: 'bakery', note: 'К утру', lines }))).revision,
      2,
    );
    await assert.rejects(run(requestSave(id, 1, { kind: 'bakery', lines })), is('CONFLICT'));
    // The kind is fixed at creation; unknown, inactive or repeated positions are refused.
    await assert.rejects(
      run(requestSave(id, 2, { kind: 'household', lines })),
      is('INVALID_REQUEST'),
    );
    for (const bad of [
      [{ ingredient_id: randomUUID(), qty: '1' }],
      [{ ingredient_id: s.old, qty: '1' }],
      [{ ingredient_id: s.bun, qty: '0' }],
      [{ ingredient_id: s.bun, qty: '1.5' }],
      [
        { ingredient_id: s.bun, qty: '1' },
        { ingredient_id: s.bun.toUpperCase(), qty: '2' },
      ],
      Array.from({ length: 101 }, () => ({ ingredient_id: randomUUID(), qty: '1' })),
    ])
      await assert.rejects(
        run(requestSave(randomUUID(), 0, { kind: 'bakery', lines: bad })),
        is('INVALID_REQUEST'),
      );
    // The balance grows before the submission: the submitted line has the balance of that moment.
    await receiptOf(bo, manager.token, c, [[s.bun, '10', '10000']]);
    const submitted = await run(submit(id, 2), 'Синтетическая подача');
    assert.equal(submitted.state, 'submitted');
    assert.equal(submitted.revision, 3);
    assert.equal(submitted.submitted_by_name, 'Синтетический управляющий');
    assert.deepEqual(
      submitted.lines.map((l) => [l.qty, l.balance_at_request, l.hint]),
      [['40', '14', '0']],
    );
    // After the submission nothing changes but the state.
    await assert.rejects(
      run(requestSave(id, 3, { kind: 'bakery', lines })),
      is('CONFLICT', 'REQUEST_LOCKED'),
    );
    await assert.rejects(run(submit(id, 3)), is('CONFLICT', 'REQUEST_LOCKED'));
    await assert.rejects(run(submit(randomUUID(), 1)), is('NOT_FOUND'));
    await assert.rejects(
      c.cloud.pool.query(
        "UPDATE bo_supply_requests SET lines='[]'::jsonb,revision=revision+1 WHERE id=$1",
        [id],
      ),
      (e) => e.code === '23514',
    );
    // What a submission needs.
    const incomplete = async (payload) => {
      const other = randomUUID();
      await run(requestSave(other, 0, payload));
      await assert.rejects(run(submit(other, 1)), is('INVALID_REQUEST', 'REQUEST_INCOMPLETE'));
    };
    await incomplete({ kind: 'household', lines: [] });
    await incomplete({ kind: 'household', needed_by: null, lines });
    await incomplete({ kind: 'household', needed_by: almaty(-1), lines });
    await incomplete({ kind: 'supplier', lines });
    // Numbers grow per branch.
    const numbers = await rows(
      c,
      'SELECT number FROM bo_supply_requests WHERE branch_id=$1 ORDER BY number',
    );
    assert.deepEqual(
      numbers.map((r) => r.number),
      [1, 2, 3, 4, 5],
    );
  }));

test('requests to a supplier: the supplier of the kind, the price in force and the expected amount', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const run = (body, reason) => bo.command(manager.token, c.branch, request(body, reason));
    const s = await stock(bo, manager.token, c);
    const supplier = randomUUID();
    const bakery = randomUUID();
    await run(supplierSave(supplier, 0, { name: 'Поставщик 1', kind: 'supplier', active: true }));
    await run(supplierSave(bakery, 0, { name: 'Пекарня 1', kind: 'bakery', active: true }));
    await run(priceSave(supplier, s.fillet, 'kg', almaty(-3), '250000'));
    // A future price is not in force yet; the bun has no price.
    await run(priceSave(supplier, s.fillet, 'kg', almaty(3), '999999'));
    await run(priceSave(supplier, s.salt, 'kg', almaty(), '333'));
    const id = randomUUID();
    const draft = await run(
      requestSave(id, 0, {
        kind: 'supplier',
        supplier_id: supplier,
        lines: [
          { ingredient_id: s.fillet, qty: '1500' },
          { ingredient_id: s.bun, qty: '20' },
          // 1,5 kg at 3,33 ₸ = 4,995 ₸: half up, 500 tiyn.
          { ingredient_id: s.salt, qty: '1500' },
        ],
      }),
    );
    assert.deepEqual(draft.supplier, {
      id: supplier,
      name: 'Поставщик 1',
      kind: 'supplier',
      active: true,
    });
    assert.deepEqual(
      draft.lines.map((l) => [l.qty, l.price_minor]),
      [
        ['1500', '375000'],
        ['20', null],
        ['1500', '500'],
      ],
    );
    assert.equal(draft.total_minor, '375500');
    assert.equal(draft.unpriced_lines, 1);
    // The supplier must deliver this kind and be active.
    await assert.rejects(
      run(requestSave(randomUUID(), 0, { kind: 'supplier', supplier_id: bakery, lines: [] })),
      is('INVALID_REQUEST'),
    );
    await assert.rejects(
      run(
        requestSave(randomUUID(), 0, { kind: 'central_kitchen', supplier_id: bakery, lines: [] }),
      ),
      is('INVALID_REQUEST'),
    );
    await assert.rejects(
      run(requestSave(randomUUID(), 0, { kind: 'bakery', supplier_id: randomUUID(), lines: [] })),
      is('NOT_FOUND'),
    );
    const own = await run(
      requestSave(randomUUID(), 0, { kind: 'bakery', supplier_id: bakery, lines: [] }),
    );
    assert.equal(own.supplier.name, 'Пекарня 1');
    // Household goods may come from a supplier too.
    const household = await run(
      requestSave(randomUUID(), 0, {
        kind: 'household',
        supplier_id: supplier,
        lines: [{ ingredient_id: s.salt, qty: '1000' }],
      }),
    );
    assert.equal(household.lines[0].price_minor, '333');
    // An archived supplier takes no new request and no submission.
    await run(supplierSave(supplier, 1, { name: 'Поставщик 1', kind: 'supplier', active: false }));
    await assert.rejects(
      run(requestSave(randomUUID(), 0, { kind: 'supplier', supplier_id: supplier, lines: [] })),
      is('CONFLICT', 'SUPPLIER_INACTIVE'),
    );
    await assert.rejects(run(submit(id, 1)), is('CONFLICT', 'SUPPLIER_INACTIVE'));
  }));

test('receive: a partial delivery posts one stock v2 receipt, linked exactly once, with the difference', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const run = (body, reason) => bo.command(manager.token, c.branch, request(body, reason));
    const s = await stock(bo, manager.token, c);
    const supplier = randomUUID();
    await run(supplierSave(supplier, 0, { name: 'Поставщик 1', kind: 'supplier', active: true }));
    const id = randomUUID();
    await run(
      requestSave(id, 0, {
        kind: 'supplier',
        supplier_id: supplier,
        lines: [
          { ingredient_id: s.fillet, qty: '1500' },
          { ingredient_id: s.bun, qty: '20' },
        ],
      }),
    );
    await assert.rejects(
      run(receive(id, 1, await receiveLines(c, [[s.fillet, '1000', '250000']]))),
      is('CONFLICT', 'REQUEST_LOCKED'),
    );
    await run(submit(id, 1));
    const before = await balances(c);
    // Less fillet, no bun, an extra salt.
    const body = receive(
      id,
      2,
      await receiveLines(c, [
        [s.fillet, '1000', '250000'],
        [s.salt, '200', '1000'],
      ]),
    );
    const envelope = request(body, 'Синтетическая поставка по заявке');
    const received = await bo.command(manager.token, c.branch, envelope);
    assert.equal(received.state, 'received');
    assert.equal(received.revision, 3);
    assert.equal(received.closed_by_name, 'Синтетический управляющий');
    assert.deepEqual(
      received.difference.map((d) => [d.name, d.requested, d.received, d.difference]),
      [
        ['Синтетическое филе', '1500', '1000', '-500'],
        ['Синтетическая булка', '20', '0', '-20'],
        [null, '0', '200', '200'],
      ],
    );
    const documents = await rows(
      c,
      "SELECT id,kind,reference,reason,meta,actor_id FROM bo_stock_documents WHERE branch_id=$1 AND reference='НАК-7'",
    );
    assert.equal(documents.length, 1);
    assert.equal(received.receipt_document_id, documents[0].id);
    assert.deepEqual(
      [documents[0].kind, documents[0].reason, documents[0].actor_id],
      ['receipt', 'Синтетическая поставка по заявке', manager.actor_id],
    );
    assert.deepEqual(documents[0].meta, {
      supplier_kind: 'supplier',
      supplier_name: 'Поставщик 1',
      document_date: almaty(),
    });
    const after = await balances(c);
    assert.equal(after[s.fillet].quantity, String(BigInt(before[s.fillet].quantity) + 1000n));
    assert.equal(
      after[s.fillet].value_minor,
      String(BigInt(before[s.fillet].value_minor) + 250000n),
    );
    assert.equal(after[s.salt].quantity, '200');
    assert.equal(after[s.bun].quantity, before[s.bun].quantity);
    // The same request again: the same answer, still one receipt.
    assert.deepEqual(await bo.command(manager.token, c.branch, envelope), received);
    // A second receipt or a cancellation of a received request is refused; nothing is posted.
    await assert.rejects(
      run(receive(id, 3, await receiveLines(c, [[s.fillet, '500', '1']]))),
      is('CONFLICT', 'REQUEST_LOCKED'),
    );
    await assert.rejects(run(cancel(id, 3)), is('CONFLICT', 'REQUEST_LOCKED'));
    // The opening receipt of the bun and the receipt of the request.
    assert.equal(
      (
        await rows(
          c,
          "SELECT count(*)::int n FROM bo_stock_documents WHERE branch_id=$1 AND kind='receipt'",
        )
      )[0].n,
      2,
    );
    // The database keeps the link once: no other document, no way back.
    const other = (await receiptOf(bo, manager.token, c, [[s.bun, '1', '100']])).id;
    for (const sql of [
      'UPDATE bo_supply_requests SET receipt_document_id=$2,revision=revision+1 WHERE id=$1',
      "UPDATE bo_supply_requests SET state='submitted',receipt_document_id=NULL,closed_at=NULL,closed_by=NULL,revision=revision+1 WHERE id=$1 AND $2::uuid IS NOT NULL",
    ])
      await assert.rejects(c.cloud.pool.query(sql, [id, other]), (e) => e.code === '23514');
    // The view: the request, its text, its receipt and the difference.
    const view = await bo.ops(manager.token, c.branch, 'supply-requests', {
      start_date: almaty(),
      end_date: almaty(),
      id,
    });
    assert.equal(view.request.state, 'received');
    assert.equal(view.receipt.id, received.receipt_document_id);
    assert.equal(view.receipt.reference, 'НАК-7');
    assert.equal(view.receipt.document_date, almaty());
    assert.equal(view.receipt.supplier_name, 'Поставщик 1');
    assert.equal(view.receipt.total_minor, '251000');
    assert.deepEqual(
      view.receipt.lines.map((l) => [l.name, l.quantity, l.value_minor]),
      [
        ['Синтетическая соль', '200', '1000'],
        ['Синтетическое филе', '1000', '250000'],
      ],
    );
    assert.deepEqual(
      view.difference.map((d) => [d.name, d.difference]),
      [
        ['Синтетическое филе', '-500'],
        ['Синтетическая булка', '-20'],
        ['Синтетическая соль', '200'],
      ],
    );
    assert.match(view.text, /^Заявка № 1 от \d{2}\.\d{2}\.\d{4} поставщику\n/);
    assert.match(view.text, /\n1\. Синтетическое филе - 1,5 кг\n2\. Синтетическая булка - 20 шт\n/);
    assert.match(view.text, /Поставщик: Поставщик 1/);
  }));

test('receive: a changed balance is a CONFLICT that posts nothing; two receipts at once give one', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const run = (body, reason) => bo.command(manager.token, c.branch, request(body, reason));
    const s = await stock(bo, manager.token, c);
    const id = randomUUID();
    await run(requestSave(id, 0, { kind: 'bakery', lines: [{ ingredient_id: s.bun, qty: '30' }] }));
    await run(submit(id, 1));
    const stale = await receiveLines(c, [[s.bun, '30', '30000']]);
    await receiptOf(bo, manager.token, c, [[s.bun, '1', '1000']]);
    const documents = await count(c, 'bo_stock_documents');
    const audit = await count(c, 'bo_audit');
    await assert.rejects(run(receive(id, 2, stale)), is('CONFLICT'));
    assert.equal(await count(c, 'bo_stock_documents'), documents);
    assert.equal(await count(c, 'bo_audit'), audit);
    assert.equal(
      (await rows(c, 'SELECT state,revision FROM bo_supply_requests WHERE id=$1', [id]))[0].state,
      'submitted',
    );
    // A quantity that would overflow, a zero quantity, an unknown position: nothing is posted.
    for (const lines of [
      await receiveLines(c, [[s.bun, '999999999999999', '0']]),
      [{ ingredient_id: s.bun, quantity: '0', value_minor: '0', expected_revision: 0 }],
      [{ ingredient_id: randomUUID(), quantity: '1', value_minor: '0', expected_revision: 0 }],
    ])
      await assert.rejects(run(receive(id, 2, lines)), (e) => e instanceof BackofficeError);
    assert.equal(await count(c, 'bo_stock_documents'), documents);
    // Two managers receive the same request at the same moment: one receipt.
    const fresh = await receiveLines(c, [[s.bun, '30', '30000']]);
    const results = await Promise.allSettled([
      run(receive(id, 2, fresh, { reference: 'НАК-А' })),
      run(receive(id, 2, fresh, { reference: 'НАК-Б' })),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'CONFLICT');
    assert.equal(await count(c, 'bo_stock_documents'), documents + 1);
    const linked = await rows(c, 'SELECT receipt_document_id FROM bo_supply_requests WHERE id=$1', [
      id,
    ]);
    assert.equal(
      (
        await rows(c, 'SELECT count(*)::int n FROM bo_stock_documents WHERE id=$1', [
          linked[0].receipt_document_id,
        ])
      )[0].n,
      1,
    );
  }));

test('cancel: with a reason, final; drafts and submitted requests only', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const run = (body, reason) => bo.command(manager.token, c.branch, request(body, reason));
    const s = await stock(bo, manager.token, c);
    const draft = randomUUID();
    const sent = randomUUID();
    const lines = [{ ingredient_id: s.bun, qty: '5' }];
    await run(requestSave(draft, 0, { kind: 'central_kitchen', lines }));
    await run(requestSave(sent, 0, { kind: 'central_kitchen', lines }));
    await run(submit(sent, 1));
    const cancelled = await run(cancel(draft, 1), 'Синтетическая отмена: заказали по телефону');
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.cancel_reason, 'Синтетическая отмена: заказали по телефону');
    assert.equal(cancelled.closed_by_name, 'Синтетический управляющий');
    await assert.rejects(run(cancel(draft, 2)), is('CONFLICT', 'REQUEST_LOCKED'));
    await assert.rejects(run(submit(draft, 2)), is('CONFLICT', 'REQUEST_LOCKED'));
    await assert.rejects(
      run(requestSave(draft, 2, { kind: 'central_kitchen', lines })),
      is('CONFLICT', 'REQUEST_LOCKED'),
    );
    await assert.rejects(run(cancel(sent, 1)), is('CONFLICT'));
    await run(cancel(sent, 2), 'Синтетическая отмена после подачи');
    // A short reason is refused by the envelope.
    await assert.rejects(
      bo.command(manager.token, c.branch, {
        request_id: randomUUID(),
        reason: 'no',
        command: cancel(randomUUID(), 1),
      }),
      is('INVALID_REQUEST'),
    );
    const view = await bo.ops(manager.token, c.branch, 'supply-requests', {
      start_date: almaty(),
      end_date: almaty(),
      state: 'cancelled',
    });
    assert.deepEqual(
      view.requests.map((r) => [r.number, r.cancel_reason]),
      [
        [2, 'Синтетическая отмена после подачи'],
        [1, 'Синтетическая отмена: заказали по телефону'],
      ],
    );
    assert.deepEqual(view.counts, { draft: 0, submitted: 0, received: 0, cancelled: 2 });
  }));

test('the list: an Almaty window of at most 92 days, state and kind filters, counts and open requests', () =>
  withSyncDatabases(async (c) => {
    const { manager, analyst } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const run = (body) => bo.command(manager.token, c.branch, request(body));
    const s = await stock(bo, manager.token, c);
    const lines = [{ ingredient_id: s.bun, qty: '5' }];
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await run(requestSave(ids[0], 0, { kind: 'bakery', lines }));
    await run(requestSave(ids[1], 0, { kind: 'household', lines }));
    await run(submit(ids[1], 1));
    await run(requestSave(ids[2], 0, { kind: 'bakery', lines }));
    // An old request (moved back by the owner, triggers off): out of the window, still open.
    const owner = await c.cloud.pool.connect();
    try {
      await owner.query('SET session_replication_role = replica');
      await owner.query(
        "UPDATE bo_supply_requests SET created_at=created_at - interval '40 days' WHERE id=$1",
        [ids[2]],
      );
    } finally {
      await owner.query('SET session_replication_role = DEFAULT');
      owner.release();
    }
    const window = { start_date: almaty(-7), end_date: almaty() };
    const all = await bo.ops(analyst.token, c.branch, 'supply-requests', window);
    assert.deepEqual(
      all.requests.map((r) => r.number),
      [2, 1],
    );
    assert.deepEqual(all.counts, { draft: 1, submitted: 1, received: 0, cancelled: 0 });
    assert.deepEqual(all.open, { draft: 2, submitted: 1 });
    assert.equal('request' in all, false);
    assert.equal(all.limits.requests, 200);
    const bakery = await bo.ops(manager.token, c.branch, 'supply-requests', {
      ...window,
      kind: 'bakery',
    });
    assert.deepEqual(
      bakery.requests.map((r) => r.number),
      [1],
    );
    const submitted = await bo.ops(manager.token, c.branch, 'supply-requests', {
      ...window,
      state: 'submitted',
    });
    assert.deepEqual(
      submitted.requests.map((r) => r.number),
      [2],
    );
    // One request outside the window is still shown with id.
    const one = await bo.ops(manager.token, c.branch, 'supply-requests', { ...window, id: ids[2] });
    assert.equal(one.request.number, 3);
    assert.match(one.text, /\(черновик\)/);
    assert.equal(one.receipt, null);
    assert.equal(one.difference, null);
    for (const bad of [
      { start_date: almaty(-92), end_date: almaty() },
      { start_date: almaty(), end_date: almaty(-1) },
      { start_date: almaty() },
      { ...window, state: 'open' },
      { ...window, kind: 'kitchen' },
      { ...window, extra: '1' },
    ])
      await assert.rejects(
        bo.ops(manager.token, c.branch, 'supply-requests', bad),
        is('INVALID_REQUEST'),
      );
    await assert.rejects(
      bo.ops(manager.token, c.branch, 'supply-requests', { ...window, id: randomUUID() }),
      is('NOT_FOUND'),
    );
  }));

test('roles: manager and shift manager create and submit, the manager receives and cancels, the others read', () =>
  withSyncDatabases(async (c) => {
    const { manager, shift, accountant, analyst } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const as = (who, body) => bo.command(who.token, c.branch, request(body));
    const s = await stock(bo, manager.token, c);
    const supplier = randomUUID();
    // The accountant keeps the suppliers and prices; the shift manager does not.
    await assert.rejects(
      as(shift, supplierSave(supplier, 0, { name: 'Поставщик 1', kind: 'supplier', active: true })),
      is('FORBIDDEN', 'ROLE_FORBIDDEN'),
    );
    await as(
      accountant,
      supplierSave(supplier, 0, { name: 'Поставщик 1', kind: 'supplier', active: true }),
    );
    await as(accountant, priceSave(supplier, s.fillet, 'kg', almaty(), '250000'));
    await assert.rejects(
      as(shift, priceSave(supplier, s.bun, 'pcs', almaty(), '100')),
      is('FORBIDDEN', 'ROLE_FORBIDDEN'),
    );
    // The shift manager creates and submits.
    const id = randomUUID();
    await as(
      shift,
      requestSave(id, 0, {
        kind: 'supplier',
        supplier_id: supplier,
        lines: [{ ingredient_id: s.fillet, qty: '1000' }],
      }),
    );
    await as(shift, submit(id, 1));
    await assert.rejects(
      as(accountant, requestSave(randomUUID(), 0, { kind: 'bakery', lines: [] })),
      is('FORBIDDEN', 'ROLE_FORBIDDEN'),
    );
    // Only the manager receives and cancels.
    const lines = await receiveLines(c, [[s.fillet, '1000', '250000']]);
    for (const who of [shift, accountant])
      for (const body of [receive(id, 2, lines), cancel(id, 2)])
        await assert.rejects(as(who, body), is('FORBIDDEN', 'ROLE_FORBIDDEN'));
    for (const body of bodies(s, randomUUID(), id))
      await assert.rejects(as(analyst, body), is('FORBIDDEN', undefined));
    const received = await as(manager, receive(id, 2, lines));
    assert.equal(received.state, 'received');
    assert.equal(received.created_by_name, 'Синтетический начальник смены');
    // Everyone reads both views.
    for (const who of [manager, shift, accountant, analyst]) {
      assert.equal(
        (await bo.ops(who.token, c.branch, 'suppliers', { id: supplier })).prices.length,
        1,
      );
      assert.equal(
        (
          await bo.ops(who.token, c.branch, 'supply-requests', {
            start_date: almaty(),
            end_date: almaty(),
          })
        ).requests.length,
        1,
      );
    }
    // permissions[] lists the second-wave rights after every P1 one, only the role's own.
    const tail = async (who) => {
      const p = (await bo.read(who.token, c.branch)).permissions;
      return p.filter((x) => ['suppliers.write', 'supply.write', 'supply.close'].includes(x));
    };
    assert.deepEqual(await tail(manager), ['suppliers.write', 'supply.write', 'supply.close']);
    assert.deepEqual(await tail(shift), ['supply.write']);
    assert.deepEqual(await tail(accountant), ['suppliers.write']);
    assert.deepEqual(await tail(analyst), []);
    const managerPermissions = (await bo.read(manager.token, c.branch)).permissions;
    assert.deepEqual(managerPermissions.slice(-3), [
      'suppliers.write',
      'supply.write',
      'supply.close',
    ]);
    assert.equal((await bo.read(manager.token, c.branch)).capabilities.supply, true);
    // Without BACKOFFICE_ROLES_ENABLED the grant decides: the manager writes, an analyst reads.
    const plain = new Backoffice(c.cloud.pool, true, { stockV2Enabled: true, supplyEnabled: true });
    await plain.command(
      manager.token,
      c.branch,
      request(requestSave(randomUUID(), 0, { kind: 'bakery', lines: [] })),
    );
    await assert.rejects(
      plain.command(
        shift.token,
        c.branch,
        request(requestSave(randomUUID(), 0, { kind: 'bakery', lines: [] })),
      ),
      is('FORBIDDEN', undefined),
    );
    assert.equal('permissions' in (await plain.read(manager.token, c.branch)), false);
  }));

/** A NOLOGIN role like pickchick_app with backofficeGrants, and a pool that acts as it. */
async function withRole(c, run) {
  const schema = c.cloud.schema;
  const role = 'bo_sp_' + randomUUID().replaceAll('-', '');
  let pool;
  await c.cloud.admin.query(
    `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
  );
  try {
    await c.cloud.pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await c.cloud.pool.query(backofficeGrants(role, true));
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
const SUPPLY_OFF = { backoffice: true, supply: false, stockReports: false, staffAssignment: false };

test('API role: NOT_READY without the 076 helper rights, requests to the receipt with exactly them', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const s = await stock(new Backoffice(c.cloud.pool, true, ON), manager.token, c);
    await withRole(c, async ({ role, schema, pool }) => {
      const bo = new Backoffice(pool, true, ON);
      const run = (body) => bo.command(manager.token, c.branch, request(body));
      assert.equal((await bo.read(manager.token, c.branch)).capabilities.supply, false);
      assert.equal(
        (await bo.read(manager.token, c.branch)).permissions.includes('supply.write'),
        false,
      );
      await assert.rejects(bo.ops(manager.token, c.branch, 'suppliers', {}), is('NOT_READY'));
      const id = randomUUID();
      await assert.rejects(run(requestSave(id, 0, { kind: 'bakery', lines: [] })), is('NOT_READY'));
      await c.cloud.pool.query(
        backofficeSupplyGrants(role, { ...SUPPLY_OFF, supply: true }, schema),
      );
      const read = await bo.read(manager.token, c.branch);
      assert.equal(read.capabilities.supply, true);
      assert.deepEqual(read.permissions.slice(-3), [
        'suppliers.write',
        'supply.write',
        'supply.close',
      ]);
      const supplier = randomUUID();
      await run(supplierSave(supplier, 0, { name: 'Пекарня 1', kind: 'bakery', active: true }));
      await run(priceSave(supplier, s.bun, 'pcs', almaty(), '1000'));
      await run(
        requestSave(id, 0, {
          kind: 'bakery',
          supplier_id: supplier,
          lines: [{ ingredient_id: s.bun, qty: '10' }],
        }),
      );
      await run(submit(id, 1));
      const now = (
        await c.cloud.pool.query('SELECT revision FROM bo_stock_balances WHERE ingredient_id=$1', [
          s.bun,
        ])
      ).rows[0].revision;
      const done = await run(
        receive(id, 2, [
          { ingredient_id: s.bun, quantity: '10', value_minor: '10000', expected_revision: now },
        ]),
      );
      assert.equal(done.state, 'received');
      assert.equal(
        (
          await bo.ops(manager.token, c.branch, 'supply-requests', {
            start_date: almaty(),
            end_date: almaty(),
            id,
          })
        ).receipt.supplier_kind,
        'bakery',
      );
      // The role never deletes; the helper off again: NOT_READY, the rows stay.
      await assert.rejects(
        pool.query('DELETE FROM bo_supply_requests'),
        (e) => e?.code === '42501',
      );
      await c.cloud.pool.query(backofficeSupplyGrants(role, SUPPLY_OFF, schema));
      await assert.rejects(
        bo.ops(manager.token, c.branch, 'supply-requests', {
          start_date: almaty(),
          end_date: almaty(),
        }),
        is('NOT_READY'),
      );
      assert.equal(await count(c, 'bo_supply_requests'), 1);
    });
  }));
