import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { KitchenModel, allowedActions, journalKey, parsePending } from '../dist/model.js';
import { ApiError } from '../dist/api.js';
import { streamIndicators, sourceBadge, streamLabel } from '../dist/components/StreamStatus.js';
const id = () => randomUUID();
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
function order(c, prep, assembly, number, channel, minutesAgo) {
  const at = new Date(Date.now() - minutesAgo * 60000).toISOString();
  return {
    orderId: id(),
    branchId: c.branch_id,
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
/** Two fake upstreams behind one renderer transport, like the portal routes. */
function fixture() {
  const c = {
    session_id: id(),
    staff_id: id(),
    terminal_id: id(),
    branch_id: id(),
    role: 'kitchen',
    token: 'a'.repeat(64),
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  };
  const prep = id(),
    assembly = id();
  const edgeOrder = order(c, prep, assembly, '12', 'pos', 5);
  const cloudOrder = order(c, prep, assembly, '301', 'kiosk', 3);
  const down = { edge: false, cloud: false };
  const calls = [];
  const servers = {
    edge: { orders: [edgeOrder], numbers: [{ number: '12', state: 'preparing' }] },
    cloud: { orders: [cloudOrder], numbers: [{ number: '301', state: 'ready' }] },
  };
  let fault = null;
  const transport = async (path, actor, body, key) => {
    const owner = path.startsWith('/cloud/') ? 'cloud' : 'edge';
    calls.push({ owner, path, body: globalThis.structuredClone(body), key });
    if (down[owner])
      throw new ApiError(
        owner === 'cloud' ? 'SERVICE_UNAVAILABLE' : 'CONNECTION_UNKNOWN',
        owner === 'cloud' ? 503 : 0,
        owner === 'cloud',
      );
    const server = servers[owner];
    if (path.endsWith('/config')) return { enabled: true, wholeTicketActions: false };
    if (path.endsWith('/stations'))
      return {
        branchId: c.branch_id,
        items: [
          { id: prep, kind: 'prep', name: 'Горячий цех' },
          { id: assembly, kind: 'assembly', name: 'Сборка' },
        ],
      };
    if (path.includes('/kitchen?'))
      return { items: globalThis.structuredClone(server.orders), nextAfterOrderId: null };
    if (path.includes('/display?')) return { items: server.numbers, nextAfterNumber: null };
    if (body) {
      if (fault) await fault(owner);
      const target = server.orders.find((o) => path.includes(o.orderId));
      if (!target) throw new ApiError('NOT_FOUND', 404, true);
      target.version++;
      target.state = 'in_production';
      target.tasks[0].state = 'in_progress';
      target.tasks[0].version++;
      return globalThis.structuredClone(target);
    }
    const target = server.orders.find((o) => path.includes(o.orderId));
    return globalThis.structuredClone(target);
  };
  const session = new Store(),
    durable = new Store();
  const make = (cloud = true) => {
    const m = new KitchenModel(transport, session, durable, async () => () => {});
    if (cloud) m.enableCloud();
    return m;
  };
  return {
    c,
    prep,
    assembly,
    edgeOrder,
    cloudOrder,
    servers,
    down,
    calls,
    durable,
    make,
    setFault: (v) => (fault = v),
  };
}
const login = async (f, m) => m.importCredential(JSON.stringify(f.c));

test('cloud flag off: renderer never calls the cloud stream and behaves as edge-only', async () => {
  const f = fixture(),
    m = f.make(false);
  await login(f, m);
  assert.equal(m.state.error, null);
  assert.equal(m.state.cloud, false);
  assert.ok(f.calls.every((call) => call.owner === 'edge'));
  assert.deepEqual(
    m.state.orders.map((o) => o.orderId),
    [f.edgeOrder.orderId],
  );
  assert.equal(m.state.orders[0].fulfillmentOwner, undefined);
});

test('both streams up: one queue, no duplicate orderId, cloud copy owns the ticket, numbers merged', async () => {
  const f = fixture();
  // A mistaken duplicate of the cloud order in the edge feed must not appear twice.
  f.servers.edge.orders.push(globalThis.structuredClone(f.cloudOrder));
  f.servers.edge.numbers.push({ number: '301', state: 'preparing' });
  const m = f.make();
  await login(f, m);
  assert.equal(m.state.error, null);
  assert.deepEqual(m.state.streams, { edge: 'online', cloud: 'online' });
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
});

test('cashier off: sign-in, cloud orders visible and actionable; command goes to the cloud only', async () => {
  const f = fixture();
  f.down.edge = true;
  const m = f.make();
  await login(f, m);
  assert.equal(m.state.error, null);
  assert.deepEqual(m.state.streams, { edge: 'offline', cloud: 'online' });
  assert.equal(m.state.stations.length, 2);
  assert.equal(m.state.wholeTicketActions, true);
  await m.selectStation(f.prep);
  const ticket = m.state.orders.find((o) => o.orderId === f.cloudOrder.orderId);
  assert.equal(ticket.fulfillmentOwner, 'cloud');
  const before = f.calls.length;
  await m.command(ticket, allowedActions(ticket, f.prep, m.state.wholeTicketActions)[0]);
  assert.equal(m.state.error, null);
  const posts = f.calls.slice(before).filter((call) => call.body);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].owner, 'cloud');
  assert.equal(posts[0].path, `/cloud/v1/fulfillment/orders/${ticket.orderId}/actions`);
  assert.equal(f.servers.cloud.orders[0].version, 2);
});

test('cashier drops after sign-in: last edge tickets stay visible but blocked, no edge POST', async () => {
  const f = fixture(),
    m = f.make();
  await login(f, m);
  await m.selectStation(f.prep);
  f.down.edge = true;
  await m.refresh();
  assert.equal(m.state.error, null);
  assert.equal(m.state.streams.edge, 'offline');
  const edgeTicket = m.state.orders.find((o) => o.orderId === f.edgeOrder.orderId);
  assert.ok(edgeTicket, 'last known cashier ticket kept');
  assert.equal(m.ownerOffline(edgeTicket), true);
  const before = f.calls.length;
  await m.command(edgeTicket, allowedActions(edgeTicket, f.prep, m.state.wholeTicketActions)[0]);
  assert.equal(m.state.error, 'EDGE_OFFLINE');
  assert.equal(f.calls.slice(before).filter((call) => call.body).length, 0);
  assert.equal(m.state.pending, null);
});

test('server off: cashier queue unchanged, cloud indicator offline; both off is an error', async () => {
  const f = fixture();
  f.down.cloud = true;
  const m = f.make();
  await login(f, m);
  assert.equal(m.state.error, null);
  assert.deepEqual(m.state.streams, { edge: 'online', cloud: 'offline' });
  assert.deepEqual(
    m.state.orders.map((o) => o.orderId),
    [f.edgeOrder.orderId],
  );
  f.down.edge = true;
  await m.refresh();
  assert.equal(m.state.error, 'CONNECTION_UNKNOWN');
  assert.deepEqual(m.state.streams, { edge: 'offline', cloud: 'offline' });
});

test('separate journals: unknown cashier command never blocks cloud work; cloud replay is exact', async () => {
  const f = fixture(),
    m = f.make();
  await login(f, m);
  await m.selectStation(f.prep);
  f.setFault(async () => {
    throw new ApiError('CONNECTION_UNKNOWN');
  });
  const edgeTicket = m.state.orders.find((o) => o.orderId === f.edgeOrder.orderId);
  await m.command(edgeTicket, allowedActions(edgeTicket, f.prep, m.state.wholeTicketActions)[0]);
  assert.ok(m.state.pending);
  assert.equal(m.state.cloudPending, null);
  assert.ok(f.durable.getItem(journalKey(f.c)));
  // Cloud command also loses its response: its own journal, its own key.
  const cloudTicket = m.state.orders.find((o) => o.orderId === f.cloudOrder.orderId);
  await m.command(cloudTicket, allowedActions(cloudTicket, f.prep, m.state.wholeTicketActions)[0]);
  assert.ok(m.state.cloudPending);
  assert.equal(m.state.cloudPending.owner, 'cloud');
  assert.ok(f.durable.getItem(journalKey(f.c, 'cloud')));
  const sent = f.calls.filter((call) => call.body && call.owner === 'cloud');
  // Restart: both journals restored, nothing sent automatically.
  const n = f.make();
  await n.restore();
  assert.deepEqual(n.state.cloudPending, m.state.cloudPending);
  assert.deepEqual(n.state.pending, m.state.pending);
  assert.equal(f.calls.filter((call) => call.body && call.owner === 'cloud').length, sent.length);
  f.setFault(null);
  await n.retry('cloud');
  const replay = f.calls.filter((call) => call.body && call.owner === 'cloud').at(-1);
  assert.deepEqual(
    [replay.path, replay.body, replay.key],
    [sent[0].path, sent[0].body, sent[0].key],
  );
  assert.equal(n.state.cloudPending, null);
  assert.ok(n.state.pending, 'cashier journal untouched by cloud retry');
  assert.ok(f.durable.getItem(journalKey(f.c)));
  // A cloud journal entry cannot be read as an edge one or vice versa.
  const edgeEntry = JSON.parse(f.durable.getItem(journalKey(f.c)));
  assert.throws(() => parsePending(edgeEntry, f.c, 'cloud'), /JOURNAL_INVALID/);
  assert.throws(
    () => parsePending({ ...edgeEntry, owner: 'cloud' }, f.c, 'edge'),
    /JOURNAL_INVALID/,
  );
});

test('validated session revocation from the cloud route signs out like the cashier', async () => {
  const f = fixture();
  const revoked = new KitchenModel(
    async (path) => {
      if (path.startsWith('/cloud/') && path.includes('/kitchen?'))
        throw new ApiError('UNAUTHORIZED', 401, true);
      if (path.startsWith('/edge/')) throw new ApiError('CONNECTION_UNKNOWN');
      return { branchId: f.c.branch_id, items: [{ id: f.prep, kind: 'prep', name: 'Цех' }] };
    },
    new Store(),
    new Store(),
    async () => () => {},
  );
  revoked.enableCloud();
  await login(f, revoked);
  assert.equal(revoked.state.actor, null);
  assert.equal(revoked.state.error, 'UNAUTHORIZED');
});

test('indicators and source badge carry state in text', () => {
  assert.equal(streamLabel('edge', 'offline'), 'Касса: нет связи');
  assert.equal(streamLabel('cloud', 'online'), 'Сервер: на связи');
  const html = streamIndicators({ edge: 'offline', cloud: 'online' });
  assert.match(html, /role="status"/);
  assert.match(html, /Касса: нет связи/);
  assert.match(html, /Сервер: на связи/);
  assert.match(sourceBadge('cloud', false), /Сервер/);
  assert.match(sourceBadge('edge', true), /Касса · нет связи/);
});
