// Audit F10 remainder in the cabinet (lane bo-ui, capabilities.pos_day): the order registry is
// searched, sorted, paged and totalled on the server (GET .../ops/orders). The allowlists of the
// cabinet and the operator proxy and the pure words of the screen. No PostgreSQL. Synthetic data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { allowedPath } from '../../apps/backoffice/dist/api.js';
import { allowed } from '../../apps/backoffice/server.mjs';
import {
  deskLabel,
  ordersSearch,
  ordersTotalsText,
  ordersView,
  pagerText,
  periodDays,
  searchAllowed,
} from '../../apps/backoffice/dist/orders-model.js';

const branch = randomUUID();
const desk = { one: randomUUID(), two: randomUUID() };
const LONG_DASHES = /[—–]/;

test('allowlists: a date window and the filters, each key at most once, nothing else', () => {
  const cabinet = (q) => allowedPath(`operations/branches/${branch}/ops/orders?${q}`);
  const proxy = (q, method = 'GET') =>
    allowed(method, `/v1/admin/backoffice/branches/${branch}/ops/orders?${q}`);
  const window = 'start_date=2026-11-19&end_date=2026-11-19';
  for (const q of [
    window,
    `${window}&q=117`,
    `${window}&q=%E2%84%96117`,
    `${window}&q=ab12cd`,
    `${window}&channel=pos&terminal_id=${desk.one}`,
    `${window}&sort=amount&page=3`,
    `${window}&channel=mobile&sort=number&page=1`,
  ]) {
    assert.equal(cabinet(q), true, q);
    assert.equal(proxy(q), true, q);
  }
  for (const q of [
    '',
    'start_date=2026-11-19',
    `${window}&q=burger`,
    `${window}&q=1%27%20OR%201%3D1`,
    `${window}&channel=yandex`,
    `${window}&terminal_id=desk-1`,
    `${window}&sort=random`,
    `${window}&page=0`,
    `${window}&page=10000`,
    `${window}&page=1&page=2`,
    `${window}&format=csv`,
  ]) {
    assert.equal(cabinet(q), false, q);
    assert.equal(proxy(q), false, q);
  }
  assert.equal(proxy(window, 'POST'), false);
  assert.equal(allowedPath(`operations/branches/${branch}/ops/orders`), false);
});

test('query: the Almaty days of the period, empty filters and defaults left out', () => {
  // GET branches/:id of «Месяц» in November 2026 (Almaty, UTC+5).
  assert.deepEqual(periodDays('2026-10-31T19:00:00.000Z', '2026-11-30T19:00:00.000Z'), {
    start_date: '2026-11-01',
    end_date: '2026-11-30',
  });
  const base = {
    start_date: '2026-11-19',
    end_date: '2026-11-19',
    q: '',
    channel: '',
    terminal_id: '',
    sort: 'new',
    page: 1,
  };
  assert.equal(ordersSearch(base), 'start_date=2026-11-19&end_date=2026-11-19');
  assert.equal(
    ordersSearch({
      ...base,
      q: ' №117 ',
      channel: 'pos',
      terminal_id: desk.one,
      sort: 'amount',
      page: 2,
    }),
    `start_date=2026-11-19&end_date=2026-11-19&q=%E2%84%96117&channel=pos&terminal_id=${desk.one}&sort=amount&page=2`,
  );
  for (const ok of ['117', '№117', '№ 117', 'ab12cd34', ''])
    assert.equal(searchAllowed(ok), true, ok);
  for (const bad of ['бургер', 'Касса 1', "1' or 1", 'x'.repeat(41)])
    assert.equal(searchAllowed(bad), false, bad);
});

test('totals in words: the whole selection, by cash desk, in tenge; the pager', () => {
  const view = ordersView(
    {
      schema_version: 1,
      branch_id: branch,
      page: 2,
      pages: 3,
      page_size: 100,
      rows: [],
      totals: {
        orders: 217,
        live_orders: 210,
        live_total_minor: '123450000',
        // The server orders them by id; the words follow the desk names.
        by_terminal: [
          { terminal_id: desk.two, live_orders: 90, live_total_minor: '53450050' },
          { terminal_id: null, live_orders: 0, live_total_minor: '0' },
          { terminal_id: desk.one, live_orders: 120, live_total_minor: '60000000' },
        ],
      },
      terminals: [
        { terminal_id: desk.one, label: 'Касса 1', first_seen_at: null },
        { terminal_id: desk.two, label: 'Касса 2', first_seen_at: null },
      ],
    },
    branch,
  );
  const text = ordersTotalsText(view);
  assert.equal(
    text,
    'Итого за период: заказов 217, без отменённых 210 на 1 234 500 ₸. Касса 1: 120, 600 000 ₸ · Касса 2: 90, 534 500,50 ₸.',
  );
  assert.equal(pagerText(view), 'Страница 2 из 3: заказы 101-200 из 217');
  assert.equal(deskLabel(view, desk.two), 'Касса 2');
  assert.equal(deskLabel(view, null), 'Касса не известна');
  assert.match(deskLabel(view, randomUUID()), /^Касса [0-9a-f]{4}$/);
  for (const t of [text, pagerText(view)]) assert.doesNotMatch(t, LONG_DASHES);
  assert.throws(() => ordersView({ schema_version: 1, branch_id: randomUUID(), rows: [] }, branch));
  const empty = ordersView({ schema_version: 1, branch_id: branch, rows: [], totals: {} }, branch);
  assert.equal(pagerText(empty), 'Заказов нет.');
  assert.equal(ordersTotalsText(empty), 'Итого за период: заказов 0, без отменённых 0 на 0 ₸.');
});
