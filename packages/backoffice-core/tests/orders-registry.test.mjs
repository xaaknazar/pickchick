import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import {
  Backoffice,
  BackofficeError,
  ORDERS_PAGE_SIZE,
  OrdersQuery,
  grantBackoffice,
} from '../dist/index.js';
import { DAY, SHIFT, STAFF, TERMINAL, at, cashierShift } from './pos-day-fixture.mjs';

/**
 * The order registry on the server (audit F10 remainder; orders-registry.ts, behind
 * BACKOFFICE_POS_DAY_ENABLED): every order of an Almaty date window, searched, sorted and paged
 * on the server, with the totals of the whole selection by cash desk. Synthetic data only.
 */
const is = (code, reason) => (error) =>
  error instanceof BackofficeError && error.code === code && error.reason === reason;
const on = (c) => new Backoffice(c.cloud.pool, true, { posDayEnabled: true });
async function people(c) {
  const person = async (name, role) => {
    const m = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name,
      branch_ids: [c.branch],
    });
    await grantBackoffice(c.cloud.pool, m.actor_id, c.branch, role);
    return m;
  };
  return {
    manager: await person('Синтетический управляющий', 'manager'),
    analyst: await person('Синтетический аналитик', 'analyst'),
  };
}
let sequence = 5000;
/** A cashier report order of one desk (cloud033), paid unless said otherwise. */
async function cashierOrder(c, { shift, number, time, total, state = 'paid', day = DAY }) {
  const id = randomUUID();
  const created = at(day, time);
  await c.cloud.pool.query(
    `INSERT INTO cloud_cashier_orders(id,branch_id,device_id,cash_shift_id,created_at,sequence,payload)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      c.branch,
      c.device,
      shift,
      created,
      ++sequence,
      {
        order_id: id,
        cash_shift_id: shift,
        created_at: created.toISOString(),
        total_minor: total,
        state,
        version: 1,
        execution_mode: state === 'awaiting_payment' ? 'unpaid_service' : 'pos_sale',
        kitchen_state: 'accepted',
        display_number: String(number),
        lines: [],
      },
    ],
  );
  return id;
}
/** A paid app or kiosk order (commerce, triggers off on one owner connection). */
async function cloudOrder(c, { channel, time, total, number, day = DAY }) {
  const db = await c.cloud.pool.connect();
  const id = randomUUID();
  try {
    await db.query('SET session_replication_role = replica');
    await db.query(
      `INSERT INTO commerce_orders(id,organization_id,branch_id,principal_id,quote_id,fiscal_account_id,
        snapshot,total_minor,currency,quote_digest,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'KZT',$9,$10)`,
      [
        id,
        c.org,
        c.branch,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        JSON.stringify({ channel, lines: [] }),
        total,
        'a'.repeat(64),
        at(day, time),
      ],
    );
    await db.query(
      `INSERT INTO cloud_fulfillment_projection(order_id,branch_id,organization_id,device_id,reservation_id,
        quote_id,quote_hash,owner_hash,version,state,display_number,routing_version,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$7,1,'handed_over',$8,1,'{}')`,
      [id, c.branch, c.org, c.device, randomUUID(), randomUUID(), 'a'.repeat(64), number],
    );
  } finally {
    await db.query('SET session_replication_role = DEFAULT');
    db.release();
  }
  return id;
}
async function seed(c) {
  for (const [shift, terminal, time] of [
    [SHIFT.one, TERMINAL.one, '09:00:00'],
    [SHIFT.two, TERMINAL.two, '10:00:00'],
  ])
    await cashierShift(c, {
      shift,
      terminal,
      staff: STAFF.cashier,
      opened: at(DAY, time),
      opening: '2000000',
      expected: '2000000',
    });
  // Both desks number their orders from 1: №1 and №2 exist twice.
  const ids = {
    one1: await cashierOrder(c, { shift: SHIFT.one, number: 1, time: '09:10:00', total: '120000' }),
    one2: await cashierOrder(c, { shift: SHIFT.one, number: 2, time: '09:20:00', total: '80000' }),
    two1: await cashierOrder(c, { shift: SHIFT.two, number: 1, time: '10:10:00', total: '250000' }),
    two2: await cashierOrder(c, {
      shift: SHIFT.two,
      number: 2,
      time: '10:20:00',
      total: '50000',
      state: 'cancelled',
    }),
    app: await cloudOrder(c, { channel: 'mobile', time: '11:00:00', total: 300000, number: 117 }),
    kiosk: await cloudOrder(c, { channel: 'kiosk', time: '11:30:00', total: 70000, number: 118 }),
  };
  // The day after: outside a one-day window.
  await cloudOrder(c, {
    channel: 'mobile',
    time: '12:00:00',
    total: 990000,
    number: 5,
    day: '2026-11-20',
  });
  return ids;
}
const window = { start_date: DAY, end_date: DAY };

test('query: an Almaty window of at most a year and the filters, strings as the HTTP query sends them', () => {
  assert.deepEqual(OrdersQuery.parse(window), { ...window, sort: 'new', page: 1 });
  assert.equal(OrdersQuery.parse({ ...window, page: '3' }).page, 3);
  for (const bad of [
    {},
    { ...window, end_date: '2026-11-18' },
    { start_date: '2025-11-19', end_date: '2026-11-20' },
    { ...window, page: '0' },
    { ...window, page: '2.5' },
    { ...window, sort: 'random' },
    { ...window, channel: 'yandex' },
    { ...window, q: "1' OR 1=1" },
    { ...window, terminal_id: 'desk-1' },
    { ...window, extra: '1' },
  ])
    assert.equal(OrdersQuery.safeParse(bad).success, false, JSON.stringify(bad));
});

test('the registry on the server: every order of the window, desks apart, search, sort, totals', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    const ids = await seed(c);
    const bo = on(c);
    const all = await bo.ops(p.manager.token, c.branch, 'orders', window);
    assert.equal(all.schema_version, 1);
    assert.deepEqual(
      all.rows.map((r) => r.id),
      [ids.kiosk, ids.app, ids.two2, ids.two1, ids.one2, ids.one1],
    );
    assert.deepEqual(
      all.terminals.map((t) => [t.terminal_id, t.label]),
      [
        [TERMINAL.one, 'Касса 1'],
        [TERMINAL.two, 'Касса 2'],
      ],
    );
    const row = all.rows.find((r) => r.id === ids.two1);
    assert.deepEqual(row, {
      id: ids.two1,
      created_at: at(DAY, '10:10:00').toISOString(),
      channel: 'pos',
      display_number: '1',
      total_minor: '250000',
      state: 'paid',
      payment_state: 'captured',
      kitchen_state: 'accepted',
      terminal_id: TERMINAL.two,
      source: 'cashier_report',
    });
    // Totals of the whole selection; the cancelled order is listed, not summed.
    assert.deepEqual(all.totals, {
      orders: 6,
      live_orders: 5,
      live_total_minor: '820000',
      by_terminal: [
        { terminal_id: TERMINAL.one, live_orders: 2, live_total_minor: '200000' },
        { terminal_id: TERMINAL.two, live_orders: 1, live_total_minor: '250000' },
      ].sort((a, b) => (a.terminal_id < b.terminal_id ? -1 : 1)),
    });
    assert.equal(all.pages, 1);
    // «№1» is the number 1: the first orders of both desks, nothing else (audit F10: «117» gave
    // 6 rows because it matched pieces of ids); the start of an id finds that order.
    const first = await bo.ops(p.manager.token, c.branch, 'orders', { ...window, q: '№1' });
    assert.deepEqual(first.rows.map((r) => r.id).sort(), [ids.one1, ids.two1].sort());
    assert.equal(first.totals.live_total_minor, '370000');
    const app117 = await bo.ops(p.manager.token, c.branch, 'orders', { ...window, q: '117' });
    assert.deepEqual(
      app117.rows.map((r) => r.id),
      [ids.app],
    );
    const byId = await bo.ops(p.manager.token, c.branch, 'orders', {
      ...window,
      q: ids.one2.slice(0, 8).toUpperCase(),
    });
    assert.deepEqual(
      byId.rows.map((r) => r.id),
      [ids.one2],
    );
    // One desk, one channel; sort by amount and by number (desk apart).
    const desk = await bo.ops(p.manager.token, c.branch, 'orders', {
      ...window,
      terminal_id: TERMINAL.one,
    });
    assert.deepEqual(
      desk.rows.map((r) => r.id),
      [ids.one2, ids.one1],
    );
    assert.equal(desk.totals.live_total_minor, '200000');
    const app = await bo.ops(p.manager.token, c.branch, 'orders', { ...window, channel: 'mobile' });
    assert.deepEqual(
      app.rows.map((r) => r.id),
      [ids.app],
    );
    assert.equal(app.rows[0].payment_state, null);
    const amount = await bo.ops(p.manager.token, c.branch, 'orders', { ...window, sort: 'amount' });
    assert.deepEqual(
      amount.rows.map((r) => r.total_minor),
      ['300000', '250000', '120000', '80000', '70000', '50000'],
    );
    const number = await bo.ops(p.manager.token, c.branch, 'orders', { ...window, sort: 'number' });
    assert.deepEqual(
      number.rows.slice(0, 4).map((r) => [r.display_number, r.terminal_id]),
      [
        ['1', [TERMINAL.one, TERMINAL.two].sort()[0]],
        ['1', [TERMINAL.one, TERMINAL.two].sort()[1]],
        ['2', [TERMINAL.one, TERMINAL.two].sort()[0]],
        ['2', [TERMINAL.one, TERMINAL.two].sort()[1]],
      ],
    );
    // Two days: the next day's order is there.
    const two = await bo.ops(p.manager.token, c.branch, 'orders', {
      start_date: DAY,
      end_date: '2026-11-20',
    });
    assert.equal(two.totals.orders, 7);
    assert.equal(two.totals.live_total_minor, '1810000');
    // Every reading role sees the registry.
    assert.deepEqual(
      (await bo.ops(p.analyst.token, c.branch, 'orders', window)).totals,
      all.totals,
    );
  }));

test('pages of 100 over more than 200 orders of one desk: nothing is cut, the totals are exact', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    await cashierShift(c, {
      shift: SHIFT.one,
      terminal: TERMINAL.one,
      staff: STAFF.cashier,
      opened: at(DAY, '08:00:00'),
      opening: '0',
      expected: '0',
    });
    const n = 230;
    for (let i = 0; i < n; i++) {
      const seconds = String(i % 60).padStart(2, '0');
      const minutes = String(Math.floor(i / 60)).padStart(2, '0');
      await cashierOrder(c, {
        shift: SHIFT.one,
        number: i + 1,
        time: `09:${minutes}:${seconds}`,
        total: '10000',
      });
    }
    const bo = on(c);
    // GET branches/:id stops at 200 for this source.
    const read = await bo.read(p.manager.token, c.branch, {
      period: 'custom',
      start_date: DAY,
      end_date: DAY,
    });
    assert.equal(read.cashier_orders.length, 200);
    assert.equal(read.truncated.cashier_orders, true);
    const pages = [];
    for (let page = 1; page <= 3; page++)
      pages.push(
        await bo.ops(p.manager.token, c.branch, 'orders', { ...window, page: String(page) }),
      );
    assert.deepEqual(
      pages.map((v) => v.rows.length),
      [ORDERS_PAGE_SIZE, ORDERS_PAGE_SIZE, n - 2 * ORDERS_PAGE_SIZE],
    );
    assert.equal(new Set(pages.flatMap((v) => v.rows.map((r) => r.id))).size, n);
    assert.ok(pages.every((v) => v.pages === 3 && v.totals.orders === n));
    assert.equal(pages[0].totals.live_total_minor, String(n * 10000));
    // Newest first: №230 opens page 1, №1 closes page 3.
    assert.equal(pages[0].rows[0].display_number, String(n));
    assert.equal(pages[2].rows.at(-1).display_number, '1');
    // A page after the last one is empty, never an error.
    assert.deepEqual(
      (await bo.ops(p.manager.token, c.branch, 'orders', { ...window, page: '9' })).rows,
      [],
    );
  }));

test('flag off: exactly the 404 of an unknown view; a bad query is INVALID_REQUEST', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    for (const options of [{}, { posDayEnabled: false }, { rolesEnabled: true }])
      await assert.rejects(
        new Backoffice(c.cloud.pool, true, options).ops(
          p.manager.token,
          c.branch,
          'orders',
          window,
        ),
        is('NOT_FOUND', undefined),
      );
    await assert.rejects(
      on(c).ops(p.manager.token, c.branch, 'orders', { ...window, page: '0' }),
      is('INVALID_REQUEST', undefined),
    );
    await assert.rejects(
      on(c).ops('f'.repeat(64), c.branch, 'orders', window),
      is('UNAUTHORIZED', undefined),
    );
  }));
