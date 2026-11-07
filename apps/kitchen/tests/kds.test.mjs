// Cutover KDS-5 (contracts section 5.4): the kitchen client with the edge KDS layout. With the
// layout off (or an edge without the route) the screen, its requests after the layout probe and
// its commands are exactly today's; with it on, the terminal's screens are tabs, station 6 reads
// the breading view, screens 2 and 3 read the open courier incidents and a delivery ticket is
// handed over only with the three marks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { KitchenModel, LAYOUT_TTL_MS, allowedActions, journalKey } from '../dist/model.js';
import { ApiError } from '../dist/api.js';
import {
  action,
  breading,
  delivery,
  incidents,
  kdsLayout,
  order as parseOrder,
  taskKds,
} from '../dist/types.js';
import { incidentBanner, kdsScreen, kdsVisible, plural, toastTotals } from '../dist/kds-view.js';
import { looksLikePhone } from '../dist/courier.js';

const id = () => randomUUID();
const MARKS = { numberMatched: true, courierAccepted: true, photoTaken: true };
class Store {
  map = new Map();
  getItem(k) {
    return this.map.get(k) ?? null;
  }
  setItem(k, v) {
    this.map.set(k, v);
  }
  removeItem(k) {
    this.map.delete(k);
  }
}
const stationIds = {
  oldPrep: id(),
  oldAssembly: id(),
  breading: id(),
  toasts: id(),
  table1: id(),
  table2: id(),
  issue: id(),
  counter: id(),
};
const KDS = [
  ['breading', 'breading', 'prep', 'Панировка (6)'],
  ['toasts', 'toasts', 'prep', 'Тосты и бургеры (5)'],
  ['table1', 'assembly_hall', 'assembly', 'Сборка - зал (стол 1)'],
  ['table2', 'assembly_delivery', 'assembly', 'Сборка - доставка (стол 2)'],
  ['issue', 'issue', 'assembly', 'Выдача (2)'],
  ['counter', 'delivery_handover', 'assembly', 'Выдача доставки (3)'],
];
const layoutOn = (screens) => ({
  enabled: true,
  layoutVersion: 3,
  mode: 'normal',
  stations: KDS.map(([key, fn, kind, name]) => ({ id: stationIds[key], function: fn, name, kind })),
  screens: screens.map((key) => stationIds[key]),
});
const task = (station, details = {}, extra = {}) => ({
  taskId: id(),
  stationId: station,
  version: 1,
  state: 'queued',
  kind: 'assembly_item',
  details: {
    lineId: details.lineId ?? id(),
    productId: details.productId ?? 'burger',
    title: details.title ?? 'Пик бургер',
    parentTitle: '',
    description: '',
    quantity: details.quantity ?? 1,
    modifiers: [],
    ...(details.kds ? { kds: details.kds } : {}),
  },
  ...extra,
});

function edge({ layout = { enabled: false }, role = 'kitchen' } = {}) {
  const c = {
    session_id: id(),
    staff_id: id(),
    terminal_id: id(),
    branch_id: id(),
    role,
    token: 'a'.repeat(64),
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  };
  const now = new Date().toISOString();
  const base = {
    branchId: c.branch_id,
    version: 4,
    state: 'ready',
    routingVersion: 1,
    createdAt: now,
    updatedAt: now,
    channel: 'pos',
    serviceMode: 'takeaway',
  };
  const line = id();
  const deliveryOrder = {
    ...base,
    orderId: id(),
    displayNumber: '27',
    assemblyStationId: stationIds.counter,
    delivery: { provider: 'glovo', externalNumber: 'G-456' },
    tasks: [
      task(
        stationIds.table2,
        { lineId: line, kds: { function: 'assembly_delivery' } },
        { state: 'done' },
      ),
      task(stationIds.issue, { title: 'Кола', kds: { function: 'issue' } }, { state: 'done' }),
    ],
  };
  const hallOrder = {
    ...base,
    orderId: id(),
    displayNumber: '28',
    state: 'in_production',
    serviceMode: 'dine_in',
    assemblyStationId: stationIds.issue,
    tasks: [task(stationIds.table1, { kds: { function: 'assembly_hall' } })],
  };
  const state = {
    layout,
    orders: [deliveryOrder, hallOrder],
    fault: null,
    live: [],
    stationsFault: null,
  };
  const session = new Store(),
    durable = new Store(),
    calls = [];
  const transport = async (path, actor, body, key) => {
    calls.push({ path, body: globalThis.structuredClone(body), key });
    if (path.endsWith('/fulfillment/config')) return { enabled: true, wholeTicketActions: true };
    // The edge lists the KDS stations only while the layout is on; after disable, only those
    // with unfinished orders (state.live).
    if (path.endsWith('/stations')) {
      if (state.stationsFault) throw state.stationsFault;
      const on = state.layout?.enabled === true;
      return {
        branchId: c.branch_id,
        items: [
          { id: stationIds.oldPrep, kind: 'prep', name: 'Приготовление' },
          { id: stationIds.oldAssembly, kind: 'assembly', name: 'Сборка' },
          ...KDS.filter(([key]) => on || state.live.includes(key)).map(([key, , kind, name]) => ({
            id: stationIds[key],
            kind,
            name,
          })),
        ],
      };
    }
    if (path.endsWith('/layout')) {
      if (state.layout instanceof Error) throw state.layout;
      return globalThis.structuredClone(state.layout);
    }
    if (path.includes('/kds/breading'))
      return {
        orders: [
          {
            orderId: hallOrder.orderId,
            displayNumber: '28',
            serviceMode: 'dine_in',
            lines: [{ title: 'Фингерсы', quantity: 2, fingers: 6 }],
            fingers: 6,
          },
        ],
        totalFingers: 6,
      };
    if (path.includes('/incidents?scope=open'))
      return {
        items: [
          {
            incidentId: id(),
            provider: 'glovo',
            claimedNumber: 'G-456',
            kind: 'no_photo',
            description: 'Курьер не сфотографировал заказ',
            recordedAt: new Date(Date.now() - 180000).toISOString(),
            displayNumber: '27',
          },
        ],
      };
    if (path.includes('/kitchen?')) {
      const station = new URL(path, 'http://local').searchParams.get('stationId');
      return {
        items: globalThis.structuredClone(
          state.orders.filter(
            (o) => o.assemblyStationId === station || o.tasks.some((t) => t.stationId === station),
          ),
        ),
        nextAfterOrderId: null,
      };
    }
    if (body) {
      if (state.fault) await state.fault(body);
      const o = state.orders.find((x) => path.includes(x.orderId));
      o.version++;
      o.state = 'handed_over';
      return o;
    }
    throw new Error('UNEXPECTED ' + path);
  };
  const make = () => new KitchenModel(transport, session, durable, async () => () => {});
  return { c, state, calls, durable, transport, make, deliveryOrder, hallOrder };
}
const login = async (f, m) => {
  await m.importCredential(JSON.stringify(f.c));
  assert.equal(m.state.error, null);
};
const paths = (f) => f.calls.map((c) => c.path.replace(/\?.*$/, ''));

test('parsers: layout, breading, incidents, delivery, details.kds and the handover marks', () => {
  assert.equal(kdsLayout({ enabled: false }), null);
  const on = kdsLayout(layoutOn(['table2', 'counter']));
  assert.deepEqual(on.screens, [stationIds.table2, stationIds.counter]);
  for (const bad of [
    { ...layoutOn([]), screens: [id()] },
    { ...layoutOn(['table1', 'issue']), screens: [stationIds.table1, stationIds.table1] },
    { ...layoutOn([]), screens: [stationIds.table1, stationIds.issue, stationIds.counter] },
    { ...layoutOn([]), stations: [] },
    { ...layoutOn([]), mode: 'night' },
    { enabled: 'yes' },
  ])
    assert.throws(() => kdsLayout(bad), /INVALID_RESPONSE/);
  assert.deepEqual(delivery({ provider: 'yandex_eda', externalNumber: 'Y-123' }), {
    provider: 'yandex_eda',
    externalNumber: 'Y-123',
  });
  assert.throws(() => delivery({ provider: 'yandex_eda', externalNumber: 'y-123' }));
  assert.throws(() => delivery({ provider: 'chocofood', externalNumber: 'Y-123' }));
  assert.deepEqual(
    taskKds({ function: 'toasts', upstreamOf: stationIds.table1, units: 2, unit: 'burger' }),
    {
      function: 'toasts',
      upstreamOf: stationIds.table1,
      units: 2,
      unit: 'burger',
    },
  );
  assert.throws(() => taskKds({ function: 'toasts', unmapped: false }));
  assert.throws(() => taskKds({ function: 'kitchen' }));
  const b = breading({
    orders: [
      {
        orderId: id(),
        displayNumber: null,
        serviceMode: 'takeaway',
        delivery: { provider: 'glovo', externalNumber: 'G-1' + '00' },
        lines: [{ title: 'Фингерсы', quantity: 1 }],
      },
    ],
    totalFingers: 0,
  });
  assert.equal(b.totalFingers, 0);
  assert.throws(() => breading({ orders: [], totalFingers: -1 }));
  assert.equal(incidents({ items: [] }).length, 0);
  assert.throws(() =>
    incidents({
      items: [
        {
          incidentId: id(),
          provider: 'glovo',
          claimedNumber: null,
          kind: 'phone_call',
          description: 'xyz',
          recordedAt: new Date().toISOString(),
        },
      ],
    }),
  );
  const handoff = { action: 'handoff', expectedVersion: 2, handover: MARKS };
  assert.deepEqual(action(handoff), handoff);
  assert.deepEqual(action({ action: 'handoff', expectedVersion: 2 }), {
    action: 'handoff',
    expectedVersion: 2,
  });
  for (const handover of [
    { numberMatched: true, courierAccepted: true },
    { ...MARKS, photoTaken: false },
    { ...MARKS, extra: true },
  ])
    assert.throws(() => action({ action: 'handoff', expectedVersion: 2, handover }));
  // A ticket keeps delivery and details.kds; without them it parses exactly as before.
  const f = edge();
  const parsed = parseOrder(globalThis.structuredClone(f.deliveryOrder), f.c.branch_id);
  assert.deepEqual(parsed.delivery, f.deliveryOrder.delivery);
  assert.equal(parsed.tasks[0].details.kds.function, 'assembly_delivery');
  const plain = globalThis.structuredClone(f.hallOrder);
  plain.tasks.forEach((t) => delete t.details.kds);
  const legacy = parseOrder(plain, f.c.branch_id);
  assert.ok(!('delivery' in legacy) && legacy.tasks.every((t) => !('kds' in t.details)));
});

test('layout off or missing: today’s stations, switcher and requests (only the layout probe added)', async () => {
  for (const layout of [
    { enabled: false },
    new ApiError('NOT_FOUND', 404, true),
    new ApiError('INVALID_RESPONSE'),
    new ApiError('CONNECTION_UNKNOWN'),
  ]) {
    const f = edge({ layout }),
      m = f.make();
    await login(f, m);
    assert.equal(m.state.kds, null);
    assert.deepEqual(m.tabs, []);
    assert.equal(m.state.stationId, stationIds.oldPrep, 'the first prep station as today');
    assert.equal(m.kdsFunction(), null);
    assert.deepEqual(paths(f), [
      '/edge/v1/fulfillment/config',
      '/edge/v1/fulfillment/stations',
      '/edge/v1/fulfillment/layout',
      '/edge/v1/fulfillment/kitchen',
    ]);
    f.calls.length = 0;
    await m.selectStation(stationIds.oldAssembly);
    await m.refresh();
    assert.deepEqual(paths(f), ['/edge/v1/fulfillment/kitchen', '/edge/v1/fulfillment/kitchen']);
    assert.equal(m.state.error, null);
  }
});

test('layout on: terminal screens are tabs, station 6 reads breading, 2 and 3 read incidents', async () => {
  const f = edge({ layout: layoutOn(['breading', 'toasts']) }),
    m = f.make();
  await login(f, m);
  assert.deepEqual(
    m.tabs.map((s) => s.id),
    [stationIds.breading, stationIds.toasts],
  );
  assert.equal(m.state.stationId, stationIds.breading);
  assert.equal(m.kdsFunction(), 'breading');
  assert.equal(m.state.breading.totalFingers, 6);
  assert.ok(!paths(f).includes('/edge/v1/fulfillment/kitchen'), 'station 6 has no tasks');
  f.calls.length = 0;
  await m.selectStation(stationIds.toasts);
  assert.equal(m.state.breading, null);
  assert.deepEqual(paths(f), ['/edge/v1/fulfillment/kitchen']);

  const g = edge({ layout: layoutOn(['table2', 'counter']) }),
    n = g.make();
  await login(g, n);
  assert.equal(n.state.stationId, stationIds.table2);
  assert.deepEqual(n.state.incidents, []);
  g.calls.length = 0;
  await n.selectStation(stationIds.counter);
  assert.deepEqual(paths(g), ['/edge/v1/fulfillment/kitchen', '/edge/v1/fulfillment/incidents']);
  assert.equal(n.state.incidents[0].claimedNumber, 'G-456');
  assert.equal(n.state.orders[0].delivery.externalNumber, 'G-456');

  // Sign-in opens the first screen of the layout even when the edge lists the second one first.
  const k = edge({ layout: layoutOn(['table2', 'counter']) });
  const reordered = new KitchenModel(
    async (path, ...rest) => {
      const value = await k.transport(path, ...rest);
      if (!path.endsWith('/stations')) return value;
      const pick = (sid) => value.items.find((s) => s.id === sid);
      return { ...value, items: [pick(stationIds.counter), pick(stationIds.table2)] };
    },
    new Store(),
    new Store(),
    async () => () => {},
  );
  await login(k, reordered);
  assert.equal(reordered.state.stationId, stationIds.table2);
  assert.deepEqual(
    reordered.tabs.map((s) => s.id),
    [stationIds.table2, stationIds.counter],
  );
  await reordered.selectStation(stationIds.counter);
  await reordered.refresh();
  assert.equal(reordered.state.stationId, stationIds.counter, 'a poll keeps the open tab');

  // A shift manager keeps the full station switcher; KDS views still apply per station.
  const h = edge({ layout: layoutOn(['table1', 'issue']), role: 'shift_manager' }),
    manager = h.make();
  await login(h, manager);
  assert.deepEqual(manager.tabs, []);
  assert.equal(manager.state.stationId, stationIds.oldPrep);
  await manager.selectStation(stationIds.issue);
  assert.equal(manager.kdsFunction(), 'issue');
});

test('kds-switch disable during the shift: the old screen comes back with a notice', async () => {
  const f = edge({ layout: layoutOn(['table1', 'issue']) }),
    m = f.make();
  await login(f, m);
  assert.equal(m.state.stationId, stationIds.table1);
  f.state.layout = { enabled: false };
  await m.refresh();
  assert.ok(m.state.kds, 'within the TTL the layout is not re-read');
  const realNow = Date.now;
  try {
    const later = realNow() + LAYOUT_TTL_MS + 1000;
    Date.now = () => later;
    // A doubtful answer keeps the last layout.
    f.state.layout = new ApiError('CONNECTION_UNKNOWN');
    await m.refresh();
    assert.ok(m.state.kds);
    Date.now = () => later + LAYOUT_TTL_MS + 1000;
    f.state.layout = { enabled: false };
    // Orders admitted with the layout keep table 1 and issue listed until they are finished.
    f.state.live = ['table1', 'issue'];
    f.calls.length = 0;
    await m.refresh();
  } finally {
    Date.now = realNow;
  }
  assert.equal(m.state.kds, null);
  assert.equal(m.state.kdsNotice, 'KDS_LAYOUT_OFF');
  assert.deepEqual(m.tabs, []);
  assert.equal(m.kdsFunction(), null);
  assert.deepEqual(paths(f), [
    '/edge/v1/fulfillment/layout',
    '/edge/v1/fulfillment/stations',
    '/edge/v1/fulfillment/kitchen',
  ]);
  assert.deepEqual(
    m.state.stations.map((s) => s.id),
    [stationIds.oldPrep, stationIds.oldAssembly, stationIds.table1, stationIds.issue],
  );
  assert.equal(m.state.stationId, stationIds.table1, 'the cook finishes the started orders');
});

test('kds-switch enable and disable during the shift: the station list is read again', async () => {
  const f = edge(),
    m = f.make();
  await login(f, m);
  assert.deepEqual(
    m.state.stations.map((s) => s.id),
    [stationIds.oldPrep, stationIds.oldAssembly],
  );
  assert.equal(m.state.stationId, stationIds.oldPrep);
  const realNow = Date.now;
  let now = realNow();
  const tick = () => {
    now += LAYOUT_TTL_MS + 1000;
  };
  try {
    Date.now = () => now;
    // Enable mid-shift: the KDS stations appear and the terminal opens its first screen.
    f.state.layout = layoutOn(['table1', 'issue']);
    f.state.stationsFault = new ApiError('CONNECTION_UNKNOWN');
    tick();
    await m.refresh();
    assert.equal(m.state.error, null, 'a failed station read is not an error of the queue');
    assert.equal(m.state.kds, null, 'without the station list nothing changes');
    assert.equal(m.state.stationId, stationIds.oldPrep);
    f.state.stationsFault = null;
    f.calls.length = 0;
    await m.refresh();
    assert.deepEqual(
      paths(f).slice(0, 2),
      ['/edge/v1/fulfillment/layout', '/edge/v1/fulfillment/stations'],
      'the next poll retries at once',
    );
    assert.ok(m.state.kds);
    assert.deepEqual(
      m.tabs.map((s) => s.id),
      [stationIds.table1, stationIds.issue],
    );
    assert.equal(m.state.stationId, stationIds.table1);
    // A later read with the same switch reads no stations.
    tick();
    f.calls.length = 0;
    await m.refresh();
    assert.deepEqual(paths(f), ['/edge/v1/fulfillment/layout', '/edge/v1/fulfillment/kitchen']);
    // Disable with nothing left on the KDS stations: back to the first prep station, as at sign-in.
    f.state.layout = { enabled: false };
    tick();
    await m.refresh();
  } finally {
    Date.now = realNow;
  }
  assert.equal(m.state.kds, null);
  assert.equal(m.state.kdsNotice, 'KDS_LAYOUT_OFF');
  assert.deepEqual(
    m.state.stations.map((s) => s.id),
    [stationIds.oldPrep, stationIds.oldAssembly],
  );
  assert.equal(m.state.stationId, stationIds.oldPrep);
  assert.equal(m.state.error, null);
});

test('courier handover: a delivery ticket needs the three marks, and only it may carry them', async () => {
  const f = edge({ layout: layoutOn(['table2', 'counter']) }),
    m = f.make();
  await login(f, m);
  await m.selectStation(stationIds.counter);
  const o = m.state.orders.find((x) => x.orderId === f.deliveryOrder.orderId);
  const plain = allowedActions(o, stationIds.counter, true).find((a) => a.action === 'handoff');
  assert.deepEqual(plain, { action: 'handoff', expectedVersion: 4 });
  f.calls.length = 0;
  await m.command(o, plain);
  assert.equal(m.state.error, 'HANDOVER_MARKS_REQUIRED');
  assert.ok(!f.calls.some((c) => c.body), 'nothing sent without the marks');
  assert.equal(f.durable.getItem(journalKey(f.c)), null);

  // A lost answer keeps the exact body with the marks and the key in the journal.
  let lose = true;
  f.state.fault = async () => {
    if (lose) {
      lose = false;
      throw new ApiError('CONNECTION_UNKNOWN');
    }
  };
  await m.command(o, { ...plain, handover: MARKS });
  const sent = f.calls.find((c) => c.body);
  assert.deepEqual(sent.body, { action: 'handoff', expectedVersion: 4, handover: MARKS });
  assert.deepEqual(JSON.parse(f.durable.getItem(journalKey(f.c))).body, sent.body);
  await m.retry();
  const retried = f.calls.filter((c) => c.body);
  assert.equal(retried.length, 2);
  assert.deepEqual(retried[1], sent);
  assert.equal(m.state.pending, null);

  // Marks on a hall ticket are refused by the client.
  await m.selectStation(stationIds.counter);
  const hall = { ...f.hallOrder, state: 'ready', assemblyStationId: stationIds.counter };
  f.state.orders = [hall];
  await m.refresh();
  const before = f.calls.filter((c) => c.body).length;
  await m.command(m.state.orders[0], {
    action: 'handoff',
    expectedVersion: hall.version,
    handover: MARKS,
  });
  assert.equal(m.state.error, 'ACTION_UNAVAILABLE');
  assert.equal(f.calls.filter((c) => c.body).length, before);
});

test('a validated 400 to a handoff closes the journal: the protocol changed around kds-switch', async () => {
  for (const [code, shown] of [
    ['HANDOVER_MARKS_REQUIRED', 'HANDOVER_MARKS_REQUIRED'],
    ['INVALID_REQUEST', 'HANDOVER_REFUSED'],
  ]) {
    const f = edge({ layout: layoutOn(['table2', 'counter']) }),
      m = f.make();
    await login(f, m);
    await m.selectStation(stationIds.counter);
    f.state.fault = async () => {
      throw new ApiError(code, 400, true);
    };
    const o = m.state.orders.find((x) => x.delivery);
    await m.command(o, { action: 'handoff', expectedVersion: o.version, handover: MARKS });
    assert.equal(m.state.error, shown);
    assert.equal(m.state.pending, null);
    assert.equal(f.durable.getItem(journalKey(f.c)), null);
  }
  // Any other refusal keeps today's journal semantics (exact retry or review).
  const f = edge({ layout: layoutOn(['table2', 'counter']) }),
    m = f.make();
  await login(f, m);
  await m.selectStation(stationIds.counter);
  f.state.fault = async () => {
    throw new ApiError('SERVICE_UNAVAILABLE', 503, true);
  };
  const o = m.state.orders.find((x) => x.delivery);
  await m.command(o, { action: 'handoff', expectedVersion: o.version, handover: MARKS });
  assert.ok(m.state.pending);
  assert.ok(f.durable.getItem(journalKey(f.c)));
});

const view = (fn, stationId, orders, extra = {}) =>
  kdsScreen({
    fn,
    stationId,
    stations: KDS.map(([key, , kind, name]) => ({ id: stationIds[key], kind, name })),
    orders,
    breading: null,
    incidents: [],
    now: Date.now(),
    courierNumber: '',
    actions: (o) => allowedActions(o, stationId, true),
    blocked: () => false,
    ticket: (o) => `<article data-legacy="${o.orderId}"></article>`,
    ...extra,
  });

test('views: tables show toasts state and unmapped, 5 counts units, 2 has two columns, 3 tiles', () => {
  const f = edge();
  const now = new Date().toISOString();
  const line = id();
  const hall = {
    ...f.hallOrder,
    tasks: [
      task(stationIds.table1, {
        lineId: line,
        title: '<b>Пик бургер</b>',
        kds: { function: 'assembly_hall', fingers: 4 },
      }),
      task(stationIds.table1, {
        title: 'Новинка',
        productId: 'new',
        kds: { function: 'assembly_hall', unmapped: true },
      }),
      task(
        stationIds.toasts,
        {
          lineId: line,
          title: '<b>Пик бургер</b>',
          quantity: 2,
          kds: { function: 'toasts', upstreamOf: stationIds.table1, units: 2, unit: 'burger' },
        },
        { kind: 'prep', state: 'in_progress' },
      ),
      task(
        stationIds.toasts,
        {
          title: 'Тост',
          kds: { function: 'toasts', upstreamOf: stationIds.table1, units: 3, unit: 'toast' },
        },
        { kind: 'prep' },
      ),
      task(stationIds.issue, { title: 'Кола', kds: { function: 'issue' } }),
    ],
    createdAt: now,
  };
  const table = view('assembly_hall', stationIds.table1, [hall]);
  assert.ok(!table.includes('<b>'), 'titles are escaped');
  assert.match(table, /Бургер: в работе/);
  assert.match(table, /Нет в раскладке - сообщите менеджеру/);
  assert.match(table, /Напитки и соусы - на выдаче/);
  assert.match(table, /Фингерсов: 4/);
  assert.match(table, />Собран</);

  const totals = toastTotals([hall], stationIds.toasts);
  assert.deepEqual(totals.units, { toast: 3, burger: 2, other: 0 });
  const toasts = view('toasts', stationIds.toasts, [hall]);
  assert.match(toasts, /Тосты <strong>3<\/strong> · Бургеры <strong>2<\/strong>/);
  assert.match(toasts, /Отдать: Сборка - зал \(стол 1\)/);

  const ready = {
    ...hall,
    orderId: id(),
    state: 'ready',
    tasks: hall.tasks.map((t) => ({ ...t, state: 'done' })),
  };
  const drinks = {
    ...f.deliveryOrder,
    state: 'in_production',
    tasks: [task(stationIds.issue, { title: 'Кола', kds: { function: 'issue' } })],
  };
  const issue = view('issue', stationIds.issue, [hall, ready, drinks]);
  assert.match(issue, /data-column="preparing"><h2>Собирается <span>2<\/span>/);
  assert.match(issue, /data-column="ready"><h2>Готов к выдаче <span>1<\/span>/);
  assert.match(issue, /Ждём сборку со стола/);
  assert.match(issue, />Выдан</);
  assert.match(issue, />Напитки переданы</);
  assert.match(issue, /ДОСТАВКА · Glovo G-456/);

  const counter = view('delivery_handover', stationIds.counter, [f.deliveryOrder], {
    courierNumber: 'g-45',
  });
  assert.match(counter, /data-handover="/);
  assert.match(counter, /data-incident="/);
  assert.match(counter, /Номер из приложения курьера/);
  assert.ok(
    !view('delivery_handover', stationIds.counter, [f.deliveryOrder], {
      courierNumber: 'X-1',
    }).includes('data-handover'),
  );
  assert.match(
    view('delivery_handover', stationIds.counter, [f.deliveryOrder], { courierNumber: 'G-456' }),
    /courier-match/,
  );
  // Stopping orders keep today's ticket.
  const stop = { ...hall, state: 'cancel_requested' };
  assert.match(view('assembly_hall', stationIds.table1, [stop]), /data-legacy=/);
  assert.deepEqual(
    kdsVisible('delivery_handover', stationIds.counter, [hall, f.deliveryOrder]).map(
      (o) => o.orderId,
    ),
    [f.deliveryOrder.orderId],
  );
  // UI texts use the plain hyphen only.
  for (const html of [table, toasts, issue, counter])
    assert.doesNotMatch(html, /[\u2012-\u2015\u2212]/);
});

test('breading view, incident banner, plural and the phone guard of the refusal form', () => {
  const html = view('breading', stationIds.breading, [], {
    breading: {
      orders: [
        {
          orderId: id(),
          displayNumber: '31',
          serviceMode: 'takeaway',
          delivery: { provider: 'yandex_eda', externalNumber: 'Y-777' },
          lines: [{ title: 'Фингерсы', quantity: 2, fingers: 6 }],
          fingers: 6,
        },
      ],
      totalFingers: 6,
    },
  });
  assert.match(html, /1 заказ/);
  assert.match(html, /data-testid="total-fingers">6</);
  assert.match(html, /ДОСТАВКА · Яндекс Еда Y-777/);
  assert.ok(!html.includes('data-command'), 'station 6 has no buttons');
  const banner = incidentBanner(
    [
      {
        incidentId: id(),
        provider: 'glovo',
        claimedNumber: null,
        kind: 'courier_refused',
        description: 'x'.repeat(5),
        recordedAt: new Date(Date.now() - 3 * 60000).toISOString(),
        displayNumber: '27',
      },
    ],
    Date.now(),
  );
  assert.match(banner, /Менеджер вызван<\/strong> · №27 · 3 мин · Курьер отказался забирать/);
  assert.equal(incidentBanner([], Date.now()), '');
  assert.deepEqual(
    [1, 2, 5, 11, 21, 104].map((n) => plural(n, ['заказ', 'заказа', 'заказов'])),
    ['1 заказ', '2 заказа', '5 заказов', '11 заказов', '21 заказ', '104 заказа'],
  );
  for (const text of ['Курьер +7 700 000 00 00', 'звонил 8(700)0000000', 'номер 87000000000'])
    assert.equal(looksLikePhone(text), true, text);
  for (const text of ['Заказ 211105-123456 не совпал', 'Glovo G-456', 'ждал 10 минут'])
    assert.equal(looksLikePhone(text), false, text);
});
