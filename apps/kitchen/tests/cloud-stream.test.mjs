import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  KitchenModel,
  allowedActions,
  journalKey,
  screenJournalKey,
  screenScope,
  parsePending,
} from '../dist/model.js';
import { ApiError } from '../dist/api.js';
import { streamIndicators, sourceBadge, streamLabel } from '../dist/components/StreamStatus.js';
import { startRuntime } from '../dist/runtime.js';
const id = () => randomUUID();
const clone = (v) => globalThis.structuredClone(v);
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
function order(branch, prep, assembly, number, channel, minutesAgo) {
  const at = new Date(Date.now() - minutesAgo * 60000).toISOString();
  return {
    orderId: id(),
    branchId: branch,
    version: 1,
    state: 'accepted',
    displayNumber: number,
    routingVersion: 1,
    createdAt: at,
    updatedAt: at,
    assemblyStationId: assembly,
    channel,
    serviceMode: 'takeaway',
    tasks: [
      {
        taskId: id(),
        stationId: prep,
        version: 1,
        state: 'queued',
        kind: 'prep',
        details: {
          lineId: id(),
          productId: 'burger',
          title: 'Чикен бургер',
          parentTitle: 'Чикен бургер',
          description: '',
          quantity: 1,
          modifiers: [],
        },
      },
    ],
  };
}
/**
 * Fake portal: edge routes need the cook credential; cloud routes are authorised only by the
 * (HttpOnly) screen cookie, modelled as `paired`/`revoked` flags - no actor is ever sent.
 */
function fixture() {
  const branch = id(),
    prep = id(),
    assembly = id(),
    screenId = id();
  const c = {
    session_id: id(),
    staff_id: id(),
    terminal_id: id(),
    branch_id: branch,
    role: 'kitchen',
    token: 'a'.repeat(64),
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  };
  const edgeOrder = order(branch, prep, assembly, '12', 'pos', 5);
  const cloudOrder = order(branch, prep, assembly, '301', 'kiosk', 3);
  const world = {
    down: { edge: false, cloud: false },
    paired: false,
    revoked: false,
    code: 'AB12-CD34EF',
    role: 'prep',
    calls: [],
    servers: {
      edge: { orders: [edgeOrder], numbers: [{ number: '12', state: 'preparing' }] },
      cloud: { orders: [cloudOrder], numbers: [{ number: '301', state: 'ready' }] },
    },
    fault: null,
  };
  const screenInfo = () => ({ screenId, branchId: branch, role: world.role, stationIds: [prep] });
  const unauthorized = () => new ApiError('UNAUTHORIZED', 401, true);
  const transport = async (path, actor, body, key) => {
    const owner = path.startsWith('/cloud/') ? 'cloud' : 'edge';
    world.calls.push({ owner, path, actor, body: clone(body), key });
    if (owner === 'cloud') {
      assert.equal(actor, null, 'cloud routes never carry a cook credential');
      if (world.down.cloud) throw new ApiError('SERVICE_UNAVAILABLE', 503, true);
      if (path === '/cloud/pair') {
        if (body.code !== world.code) throw unauthorized();
        world.paired = true;
        world.revoked = false;
        return screenInfo();
      }
      if (!world.paired || world.revoked) throw unauthorized();
      if (path === '/cloud/session') return screenInfo();
    } else {
      if (world.down.edge) throw new ApiError('CONNECTION_UNKNOWN');
      if (path.endsWith('/config')) return { enabled: true, wholeTicketActions: true };
      if (!actor) throw unauthorized();
    }
    const server = world.servers[owner];
    if (path.endsWith('/stations'))
      return {
        branchId: branch,
        items:
          owner === 'edge'
            ? [
                { id: prep, kind: 'prep', name: 'Горячий цех' },
                { id: assembly, kind: 'assembly', name: 'Сборка' },
              ]
            : [{ id: prep, kind: 'prep', name: 'Горячий цех' }],
      };
    if (path.includes('/kitchen?')) return { items: clone(server.orders), nextAfterOrderId: null };
    if (path.includes('/display?')) return { items: server.numbers, nextAfterNumber: null };
    const target = server.orders.find((o) => path.includes(o.orderId));
    if (!target) throw new ApiError('NOT_FOUND', 404, true);
    if (body) {
      if (world.fault) await world.fault(owner);
      target.version++;
      target.state = 'in_production';
      target.tasks[0].state = 'done';
      target.tasks[0].version++;
    }
    return clone(target);
  };
  const session = new Store(),
    durable = new Store();
  const make = ({ cloud = true, paired = false } = {}) => {
    const m = new KitchenModel(transport, session, durable, async () => () => {});
    if (cloud) m.enableCloud(paired);
    return m;
  };
  return { c, branch, prep, assembly, screenId, edgeOrder, cloudOrder, world, durable, make };
}
const cookLogin = (f, m) => m.importCredential(JSON.stringify(f.c));
const ticket = (m, o) => m.state.orders.find((x) => x.orderId === o.orderId);
const act = (m, t) =>
  m.command(t, allowedActions(t, m.state.stationId, m.state.wholeTicketActions)[0]);
const cloudPosts = (f) =>
  f.world.calls.filter((call) => call.body && call.owner === 'cloud' && call.key);

test('cloud flag off: renderer never calls the cloud and behaves as edge-only', async () => {
  const f = fixture(),
    m = f.make({ cloud: false });
  await cookLogin(f, m);
  assert.equal(m.state.error, null);
  assert.ok(f.world.calls.every((call) => call.owner === 'edge'));
  assert.deepEqual(
    m.state.orders.map((o) => o.orderId),
    [f.edgeOrder.orderId],
  );
  assert.equal(m.state.orders[0].fulfillmentOwner, undefined);
});

test('cashier down, fresh browser: code binds the screen; cloud orders visible and actionable without a cook', async () => {
  const f = fixture();
  f.world.down.edge = true;
  const m = f.make();
  assert.equal(m.active, false);
  await m.pairScreen('ZZ12-CD34EF', 'prep');
  assert.equal(m.state.error, 'PAIRING_REJECTED');
  await m.pairScreen(f.world.code, 'prep');
  assert.equal(m.state.error, null);
  assert.equal(m.active, true);
  assert.equal(m.state.actor, null);
  assert.equal(m.state.screen.screenId, f.screenId);
  assert.deepEqual(m.state.streams, { edge: 'signed_out', cloud: 'online' });
  assert.ok(!f.world.calls.some((call) => call.owner === 'edge'), 'cashier not needed');
  const t = ticket(m, f.cloudOrder);
  assert.equal(t.fulfillmentOwner, 'cloud');
  await act(m, t);
  assert.equal(m.state.error, null);
  const posts = cloudPosts(f);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, `/cloud/v1/fulfillment/orders/${t.orderId}/actions`);
  assert.equal(f.world.servers.cloud.orders[0].version, 2);
  // Same browser after a reload or portal restart: cookie -> session, no code, no cook.
  const n = f.make({ paired: true });
  await n.restoreScreen();
  assert.equal(n.state.error, null);
  assert.equal(n.state.screen.screenId, f.screenId);
});

test('revoked screen: 401 returns the page to the code screen, cook session untouched', async () => {
  const f = fixture(),
    m = f.make();
  await m.pairScreen(f.world.code, 'prep');
  await cookLogin(f, m);
  assert.deepEqual(m.state.streams, { edge: 'online', cloud: 'online' });
  f.world.revoked = true;
  await m.refresh();
  assert.equal(m.state.error, 'SCREEN_REVOKED');
  assert.equal(m.state.screenPaired, false);
  assert.equal(m.state.screen, null);
  assert.ok(m.state.actor, 'cook stays signed in for the cashier');
  const before = f.world.calls.filter((call) => call.owner === 'cloud').length;
  await m.refresh();
  assert.equal(f.world.calls.filter((call) => call.owner === 'cloud').length, before);
  assert.deepEqual(m.state.streams, { edge: 'online', cloud: 'signed_out' });
});

test('cashier orders still require a cook login; with it both streams merge without duplicates', async () => {
  const f = fixture(),
    m = f.make();
  await m.pairScreen(f.world.code, 'prep');
  assert.equal(ticket(m, f.edgeOrder), undefined, 'no cashier orders without a cook');
  f.world.servers.edge.orders.push(clone(f.cloudOrder));
  f.world.servers.edge.numbers.push({ number: '301', state: 'preparing' });
  await cookLogin(f, m);
  assert.deepEqual(
    m.state.orders.map((o) => [o.displayNumber, o.fulfillmentOwner ?? 'edge']),
    [
      ['12', 'edge'],
      ['301', 'cloud'],
    ],
  );
  await m.selectMode('display');
  assert.deepEqual(
    m.state.display.map((i) => i.number),
    ['12', '301'],
  );
  await m.selectMode('kitchen');
  m.logout();
  await m.refresh();
  assert.deepEqual(
    m.state.orders.map((o) => o.orderId),
    [f.cloudOrder.orderId],
  );
  assert.equal(m.state.streams.edge, 'signed_out');
});

test('cashier drops: last tickets stay visible but blocked; stored cook is retried on refresh', async () => {
  const f = fixture(),
    m = f.make();
  await m.pairScreen(f.world.code, 'prep');
  await cookLogin(f, m);
  f.world.down.edge = true;
  await m.refresh();
  assert.equal(m.state.error, null);
  assert.equal(m.state.streams.edge, 'offline');
  const edgeTicket = ticket(m, f.edgeOrder);
  assert.ok(edgeTicket);
  assert.equal(m.ownerOffline(edgeTicket), true);
  const before = f.world.calls.length;
  await act(m, edgeTicket);
  assert.equal(m.state.error, 'EDGE_OFFLINE');
  assert.equal(f.world.calls.slice(before).filter((call) => call.body).length, 0);
  const n = f.make({ paired: true });
  await n.restoreScreen();
  await n.restore();
  assert.equal(n.state.error, null);
  assert.equal(n.state.actor, null);
  assert.equal(n.state.streams.edge, 'offline');
  f.world.down.edge = false;
  await n.refresh();
  assert.ok(n.state.actor, 'cook session resumed once the cashier answers');
});

test('separate journals per owner: stuck cashier command never blocks cloud; cloud replay exact', async () => {
  const f = fixture(),
    m = f.make();
  await m.pairScreen(f.world.code, 'prep');
  await cookLogin(f, m);
  f.world.fault = async () => {
    throw new ApiError('CONNECTION_UNKNOWN');
  };
  await act(m, ticket(m, f.edgeOrder));
  assert.ok(m.state.pending);
  assert.equal(m.state.cloudPending, null);
  await act(m, ticket(m, f.cloudOrder));
  assert.ok(m.state.cloudPending);
  const scr = { branchId: f.branch, screenId: f.screenId };
  assert.equal(m.state.cloudPending.scope, screenScope(scr));
  assert.ok(f.durable.getItem(screenJournalKey(scr)));
  assert.ok(f.durable.getItem(journalKey(f.c)));
  const sent = cloudPosts(f);
  const n = f.make({ paired: true });
  await n.restoreScreen();
  await n.restore();
  assert.deepEqual(n.state.cloudPending, m.state.cloudPending);
  assert.deepEqual(n.state.pending, m.state.pending);
  assert.equal(cloudPosts(f).length, sent.length, 'nothing sent automatically');
  f.world.fault = null;
  await n.retry('cloud');
  const replay = cloudPosts(f).at(-1);
  assert.deepEqual(
    [replay.path, replay.body, replay.key],
    [sent[0].path, sent[0].body, sent[0].key],
  );
  assert.equal(n.state.cloudPending, null);
  assert.ok(n.state.pending, 'cashier journal untouched');
  const edgeEntry = JSON.parse(f.durable.getItem(journalKey(f.c)));
  assert.throws(() => parsePending(edgeEntry, screenScope(scr), 'cloud'), /JOURNAL_INVALID/);
});

test('pairing errors: wrong role refused, malformed code local, server down is not a rejection', async () => {
  const f = fixture();
  f.world.role = 'assembly';
  const m = f.make();
  await m.pairScreen(f.world.code, 'prep');
  assert.equal(m.state.error, 'PAIRING_WRONG_SCREEN');
  assert.equal(m.state.screen, null);
  const calls = f.world.calls.length;
  await m.pairScreen('short', 'prep');
  assert.equal(m.state.error, 'INVALID_PAIRING_CODE');
  assert.equal(f.world.calls.length, calls);
  f.world.down.cloud = true;
  f.world.role = 'prep';
  await m.pairScreen(f.world.code, 'prep');
  assert.equal(m.state.error, 'SERVICE_UNAVAILABLE');
  assert.equal(m.state.screenPaired, false);
});

test('server down with a paired cookie: page stays on the queue and retries the binding', async () => {
  const f = fixture();
  f.world.paired = true;
  f.world.down.cloud = true;
  const m = f.make({ paired: true });
  await m.restoreScreen();
  assert.equal(m.state.screenPaired, true, 'not sent back to the code screen');
  assert.equal(m.active, true);
  f.world.down.cloud = false;
  await m.refresh();
  assert.equal(m.state.screen.screenId, f.screenId);
  assert.equal(m.state.streams.cloud, 'online');
  let polls = 0;
  const stop = startRuntime(
    { state: m.state, refresh: async () => void polls++ },
    () => {},
    (fn) => {
      fn();
      return () => {};
    },
  );
  stop();
  assert.equal(polls, 1, 'runtime polls a screen-only page');
});

test('indicators and source badge carry state in text', () => {
  assert.equal(streamLabel('edge', 'offline'), 'Касса: нет связи');
  assert.equal(streamLabel('cloud', 'online'), 'Сервер: на связи');
  assert.equal(streamLabel('edge', 'signed_out'), 'Касса: нужен вход повара');
  assert.equal(streamLabel('cloud', 'signed_out'), 'Сервер: экран не подключён');
  assert.match(streamIndicators({ edge: 'offline', cloud: 'online' }), /role="status"/);
  assert.match(sourceBadge('cloud', false), /Сервер/);
  assert.match(sourceBadge('edge', true), /Касса · нет связи/);
});
