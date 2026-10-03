import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { KitchenModel, allowedActions, journalKey, displayWindow } from '../dist/model.js';
import { ApiError } from '../dist/api.js';
import { displayPage } from '../dist/types.js';
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
function fixture() {
  const c = {
      session_id: id(),
      staff_id: id(),
      terminal_id: id(),
      branch_id: id(),
      role: 'kitchen',
      token: 'a'.repeat(64),
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    },
    station = id(),
    other = id();
  const o = {
    orderId: id(),
    branchId: c.branch_id,
    version: 1,
    state: 'accepted',
    displayNumber: '148',
    routingVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    assemblyStationId: other,
    channel: 'mobile',
    serviceMode: 'takeaway',
    tasks: [
      {
        taskId: id(),
        stationId: station,
        version: 1,
        state: 'queued',
        kind: 'prep',
        details: {
          lineId: id(),
          productId: 'burger',
          title: 'Pick Combo',
          parentTitle: 'Pick Combo',
          description: '',
          quantity: 1,
          modifiers: [],
        },
      },
    ],
  };
  const session = new Store(),
    durable = new Store(),
    calls = [];
  let fault = null,
    serverOrder = globalThis.structuredClone(o),
    posted = 0;
  const transport = async (path, actor, body, key) => {
    calls.push({ path, body: globalThis.structuredClone(body), key });
    if (path.endsWith('/config')) return { enabled: true };
    if (path.endsWith('/stations'))
      return {
        branchId: c.branch_id,
        items: [
          { id: station, kind: 'prep', name: 'Фритюр' },
          { id: other, kind: 'assembly', name: 'Сборка' },
        ],
      };
    if (path.includes('/kitchen?'))
      return { items: [globalThis.structuredClone(serverOrder)], nextAfterOrderId: null };
    if (path.includes('/display?'))
      return { items: [{ number: '148', state: 'preparing' }], nextAfterNumber: null };
    if (body) {
      assert.ok(durable.getItem(journalKey(c)), 'journal exists before HTTP');
      posted++;
      if (fault) await fault();
      if (serverOrder.version === 1) {
        serverOrder.version++;
        serverOrder.state = 'in_production';
        serverOrder.tasks[0].state = 'in_progress';
        serverOrder.tasks[0].version++;
      }
      return serverOrder;
    }
    return { ...serverOrder, cancellationReason: null, inventoryDisposition: null };
  };
  const make = () => new KitchenModel(transport, session, durable, async () => () => {});
  return {
    c,
    station,
    other,
    o,
    session,
    durable,
    calls,
    make,
    transport,
    setFault: (v) => (fault = v),
    get posted() {
      return posted;
    },
    get serverOrder() {
      return serverOrder;
    },
  };
}
const login = async (f, m) => {
  await m.importCredential(JSON.stringify(f.c));
  assert.equal(m.state.error, null);
};
test('unknown POST keeps durable exact body/key; restart never sends automatically and retry observes one effect', async () => {
  const f = fixture(),
    m = f.make();
  await login(f, m);
  f.setFault(() => {
    throw new ApiError('CONNECTION_UNKNOWN');
  });
  await m.command(m.state.orders[0], allowedActions(m.state.orders[0], f.station)[0]);
  assert.ok(m.state.pending);
  assert.equal(m.state.orders[0].version, 1);
  const before = f.calls.find((c) => c.body);
  const n = f.make();
  await n.restore();
  assert.equal(f.posted, 1);
  assert.deepEqual(n.state.pending, m.state.pending);
  f.setFault(null);
  await n.retry();
  const after = f.calls.filter((c) => c.body).at(-1);
  assert.deepEqual(after, before);
  assert.equal(n.state.pending, null);
  assert.equal(n.state.orders[0].version, 2);
});
test('committed response lost retries receipt without repeating state transition', async () => {
  const f = fixture();
  let first = true;
  const transport = async (...args) => {
    const result = await f.transport(...args);
    if (args[2] && first) {
      first = false;
      throw new ApiError('CONNECTION_UNKNOWN');
    }
    return result;
  };
  const n = new KitchenModel(transport, f.session, f.durable, async () => () => {});
  await login(f, n);
  await n.command(n.state.orders[0], allowedActions(n.state.orders[0], f.station)[0]);
  assert.equal(f.serverOrder.version, 2);
  assert.ok(n.state.pending);
  await n.retry();
  assert.equal(f.serverOrder.version, 2);
  assert.equal(n.state.orders[0].version, 2);
});
test('409 reads actual version, never blindly retries and requires explicit acknowledgement', async () => {
  const f = fixture(),
    m = f.make();
  await login(f, m);
  f.setFault(() => {
    throw new ApiError('CONFLICT', 409, true);
  });
  await m.command(m.state.orders[0], allowedActions(m.state.orders[0], f.station)[0]);
  assert.equal(m.state.conflict, true);
  assert.equal(m.state.reviewed.version, 1);
  await m.retry();
  assert.equal(f.posted, 1);
  await m.acknowledgeConflict();
  assert.equal(m.state.pending, null);
  assert.equal(f.posted, 1);
});
test('storage failure prevents any mutation', async () => {
  const f = fixture(),
    m = f.make();
  await login(f, m);
  f.durable.setItem = () => {
    throw new Error('disk');
  };
  await m.command(m.state.orders[0], allowedActions(m.state.orders[0], f.station)[0]);
  assert.equal(f.posted, 0);
  assert.equal(m.state.storageBlocked, true);
});
test('validated revocation retains pending and hides authenticated UI', async () => {
  const f = fixture(),
    m = f.make();
  await login(f, m);
  f.setFault(() => {
    throw new ApiError('UNAUTHORIZED', 401, true);
  });
  await m.command(m.state.orders[0], allowedActions(m.state.orders[0], f.station)[0]);
  assert.equal(m.state.actor, null);
  assert.deepEqual(m.state.orders, []);
  assert.ok(f.durable.getItem(journalKey(f.c)));
});
test('immediate logout invalidates delayed GET and permits a new session without resurrection', async () => {
  const f = fixture();
  let unblock,
    slow = false;
  const m = new KitchenModel(
    async (...args) => {
      if (slow && args[0].includes('/kitchen?')) await new Promise((r) => (unblock = r));
      return f.transport(...args);
    },
    f.session,
    f.durable,
    async () => () => {},
  );
  await login(f, m);
  slow = true;
  const pending = m.refresh();
  await Promise.resolve();
  m.logout();
  assert.equal(m.state.actor, null);
  assert.equal(m.state.busy, false);
  slow = false;
  await login(f, m);
  const current = m.state.orders;
  unblock();
  await pending;
  assert.equal(m.state.actor.session_id, f.c.session_id);
  assert.deepEqual(m.state.orders, current);
  assert.equal(m.state.error, null);
});
test('logout during pending POST keeps journal; late successful response cannot clear it or revive session', async () => {
  const f = fixture();
  let unblock;
  const m = new KitchenModel(
    async (...args) => {
      if (args[2]) await new Promise((r) => (unblock = r));
      return f.transport(...args);
    },
    f.session,
    f.durable,
    async () => () => {},
  );
  await login(f, m);
  const running = m.command(m.state.orders[0], allowedActions(m.state.orders[0], f.station)[0]);
  await Promise.resolve();
  assert.ok(m.state.pending);
  m.logout();
  assert.equal(m.state.actor, null);
  unblock();
  await running;
  assert.equal(m.state.actor, null);
  assert.equal(m.state.orders.length, 0);
  assert.ok(f.durable.getItem(journalKey(f.c)));
  assert.equal(f.serverOrder.version, 2);
  const n = f.make();
  await n.restore();
  assert.equal(n.state.actor, null);
  await login(f, n);
  assert.ok(n.state.pending);
  await n.retry();
  assert.equal(n.state.pending, null);
  assert.equal(n.state.orders[0].version, 2);
});
test('all cursor pages loaded; refresh restarts from head and publishes no incomplete list', async () => {
  const f = fixture(),
    orders = Array.from({ length: 105 }, (_, i) => ({
      ...f.o,
      orderId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      displayNumber: String(i + 1),
    }));
  const cursors = [];
  let bad = false;
  const m = new KitchenModel(
    async (...args) => {
      if (args[0].includes('/kitchen?')) {
        const q = new URL(args[0], 'http://local').searchParams;
        const cursor = q.get('afterOrderId');
        cursors.push(cursor);
        if (bad && cursor) throw new ApiError('CONNECTION_UNKNOWN');
        return cursor
          ? { items: orders.slice(100), nextAfterOrderId: null }
          : { items: orders.slice(0, 100), nextAfterOrderId: orders[99].orderId };
      }
      return f.transport(...args);
    },
    f.session,
    f.durable,
    async () => () => {},
  );
  await login(f, m);
  assert.equal(m.state.orders.length, 50);
  await m.page();
  assert.equal(m.state.orders[0].displayNumber, '51');
  await m.page();
  assert.equal(m.state.orders.length, 5);
  const old = m.state.orders;
  bad = true;
  await m.refresh();
  assert.deepEqual(cursors, [null, orders[99].orderId, null, orders[99].orderId]);
  assert.deepEqual(m.state.orders, old);
  assert.equal(m.state.error, 'CONNECTION_UNKNOWN');
});
test('foreign-station actions and premature assembly-ready unavailable; cancel stop only', () => {
  const f = fixture();
  assert.equal(allowedActions(f.o, f.other).length, 0);
  const ready = {
    ...f.o,
    state: 'in_production',
    tasks: f.o.tasks.map((t) => ({ ...t, state: 'done' })),
  };
  assert.equal(allowedActions(ready, f.station).length, 0);
  assert.equal(allowedActions(ready, f.other)[0].action, 'ready');
  assert.equal(allowedActions({ ...ready, state: 'ready' }, f.other)[0].action, 'handoff');
  assert.equal(
    allowedActions(
      {
        ...f.o,
        state: 'cancel_requested',
        tasks: f.o.tasks.map((t) => ({ ...t, state: 'cancel_requested' })),
      },
      f.station,
    )[0].action,
    'confirm_stop',
  );
});
test('LED accepts number, state and optional short guest name, never private fields or kitchen fetches', async () => {
  const named = { items: [{ number: '1', state: 'ready', name: 'Әлия' }], nextAfterNumber: null };
  assert.deepEqual(displayPage(named), { items: named.items, next: null });
  assert.throws(() =>
    displayPage({
      items: [{ number: '1', state: 'ready', name: 'x'.repeat(15) }],
      nextAfterNumber: null,
    }),
  );
  assert.throws(() =>
    displayPage({
      items: [{ number: '1', state: 'ready', phone: 'PRIVATE' }],
      nextAfterNumber: null,
    }),
  );
  const f = fixture(),
    m = f.make();
  await login(f, m);
  f.calls.length = 0;
  await m.selectMode('display');
  assert.equal(m.state.orders.length, 0);
  assert.ok(f.calls.every((c) => c.path.includes('/display?')));
  assert.deepEqual(m.state.display, [{ number: '148', state: 'preparing' }]);
});

test('cyclic/over-budget pagination fails without publishing partial orders', async () => {
  const f = fixture();
  let count = 0;
  const m = new KitchenModel(
    async (...args) => {
      if (args[0].includes('/kitchen?')) {
        count++;
        return { items: [], nextAfterOrderId: randomUUID() };
      }
      return f.transport(...args);
    },
    f.session,
    f.durable,
    async () => () => {},
  );
  await m.importCredential(JSON.stringify(f.c));
  assert.equal(count, 100);
  assert.equal(m.state.error, 'QUEUE_BOUND_EXCEEDED');
  assert.deepEqual(m.state.orders, []);
  assert.equal(m.state.lastSync, null);
});
test('FIFO projection uses creation time, independently from transport UUID sort', async () => {
  const f = fixture(),
    early = {
      ...f.o,
      orderId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    late = {
      ...f.o,
      orderId: '00000000-0000-4000-8000-000000000001',
      createdAt: '2026-01-02T00:00:00.000Z',
    };
  const m = new KitchenModel(
    async (...args) =>
      args[0].includes('/kitchen?')
        ? { items: [late, early], nextAfterOrderId: null }
        : f.transport(...args),
    f.session,
    f.durable,
    async () => () => {},
  );
  await login(f, m);
  assert.deepEqual(
    m.state.orders.map((o) => o.orderId),
    [early.orderId, late.orderId],
  );
});

test('LED rotation covers 1000 numbers with 6/4 bounds; shorter column remains visible', () => {
  const items = Array.from({ length: 1000 }, (_, i) => ({
    number: String(i + 1),
    state: i < 2 ? 'preparing' : 'ready',
  }));
  const pages = displayWindow(items, 0).pages,
    seen = new Set();
  for (let page = 0; page < pages; page++) {
    const v = displayWindow(items, page);
    assert.equal(v.preparing.length, 2);
    assert.ok(v.ready.length <= 4);
    for (const item of [...v.preparing, ...v.ready]) seen.add(item.number);
  }
  assert.equal(seen.size, 1000);
});

test('failed station switch cannot publish previous station snapshot through pagination', async () => {
  const f = fixture(),
    rows = Array.from({ length: 101 }, (_, i) => ({
      ...f.o,
      orderId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      displayNumber: String(i + 1),
    }));
  const m = new KitchenModel(
    async (...args) => {
      if (args[0].includes('/kitchen?')) {
        const q = new URL(args[0], 'http://local').searchParams;
        if (q.get('stationId') === f.other) throw new ApiError('SERVICE_UNAVAILABLE', 503, true);
        return q.has('afterOrderId')
          ? { items: rows.slice(100), nextAfterOrderId: null }
          : { items: rows.slice(0, 100), nextAfterOrderId: rows[99].orderId };
      }
      return f.transport(...args);
    },
    f.session,
    f.durable,
    async () => () => {},
  );
  await login(f, m);
  assert.equal(m.state.orders.length, 50);
  assert.ok(m.state.next);
  await m.selectStation(f.other);
  assert.equal(m.state.error, 'SERVICE_UNAVAILABLE');
  assert.equal(m.state.orders.length, 0);
  assert.equal(m.state.next, null);
  assert.equal(m.state.lastSync, null);
  await m.page();
  assert.equal(m.state.orders.length, 0);
  assert.equal(m.state.next, null);
  await m.selectStation(f.station);
  assert.equal(m.state.orders.length, 50);
  assert.equal(m.state.error, null);
});
test('failed mode switch and logout clear snapshot cursor without clearing pending journal', async () => {
  const f = fixture(),
    m = new KitchenModel(
      async (...args) => {
        if (args[0].includes('/display?')) throw new ApiError('SERVICE_UNAVAILABLE', 503, true);
        return f.transport(...args);
      },
      f.session,
      f.durable,
      async () => () => {},
    );
  await login(f, m);
  await m.selectMode('display');
  await m.page();
  assert.deepEqual(m.state.orders, []);
  assert.deepEqual(m.state.display, []);
  assert.equal(m.state.lastSync, null);
  await m.selectMode('kitchen');
  f.setFault(() => {
    throw new ApiError('CONNECTION_UNKNOWN');
  });
  await m.command(m.state.orders[0], allowedActions(m.state.orders[0], f.station)[0]);
  const saved = f.durable.getItem(journalKey(f.c));
  m.logout();
  await m.page();
  assert.equal(m.state.actor, null);
  assert.equal(m.state.next, null);
  assert.deepEqual(m.state.orders, []);
  assert.equal(f.durable.getItem(journalKey(f.c)), saved);
});

test('whole-ticket capability offers one station action, gates assembly and leaves legacy nodes unchanged', () => {
  const f = fixture();
  const current = globalThis.structuredClone(f.o);
  assert.equal(allowedActions(current, f.station)[0].action, 'start_task');
  assert.deepEqual(allowedActions(current, f.station, true), [
    { action: 'complete_station', expectedVersion: current.version, stationId: f.station },
  ]);
  assert.deepEqual(allowedActions(current, f.other, true), []);
  current.state = 'in_production';
  current.tasks[0].state = 'done';
  assert.deepEqual(allowedActions(current, f.station, true), []);
  assert.deepEqual(allowedActions(current, f.other, true), [
    { action: 'complete_station', expectedVersion: current.version, stationId: f.other },
  ]);
});

test('fresh multi-station login starts at preparation even when assembly is returned first', async () => {
  const f = fixture();
  const transport = async (...args) => {
    const result = await f.transport(...args);
    return args[0].endsWith('/stations')
      ? { ...result, items: [...result.items].reverse() }
      : result;
  };
  const model = new KitchenModel(transport, f.session, f.durable, async () => () => {});
  await model.importCredential(JSON.stringify(f.c));
  assert.equal(model.state.stationId, f.station);
});

test('kitchen accepts explicit kiosk source and rejects unrecognized channels', async () => {
  const { order } = await import('../dist/types.js');
  const f = fixture();
  const original = f.o;
  assert.ok(original);
  assert.equal(order({ ...original, channel: 'kiosk' }, original.branchId).channel, 'kiosk');
  assert.throws(() => order({ ...original, channel: 'other' }, original.branchId));
});
