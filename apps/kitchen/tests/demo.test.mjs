import test from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createDemo, memoryStorage } from '../dist/demo.js';
import { KitchenModel, allowedActions } from '../dist/model.js';
import { prefix } from '../dist/types.js';

test('demo uses the real kitchen model: preparation, assembly, ready board, handoff and reset', async () => {
  const d = createDemo();
  const m = new KitchenModel(d.transport, memoryStorage(), memoryStorage(), async () => () => {});
  await m.importCredential(JSON.stringify(d.credential));
  assert.equal(m.state.error, null);
  assert.equal(m.state.orders.length, 4);
  const target = m.state.orders.find((o) => o.state === 'accepted');
  const number = target.displayNumber;
  for (const station of d.stations) {
    await m.selectStation(station.id);
    while (true) {
      const order = m.state.orders.find((o) => o.orderId === target.orderId);
      const action = order && allowedActions(order, station.id).find((a) => 'taskId' in a);
      if (!action) break;
      await m.command(order, action);
      assert.equal(m.state.error, null);
      assert.equal(m.state.pending, null);
    }
  }
  let o = m.state.orders.find((o) => o.orderId === target.orderId);
  await m.command(
    o,
    allowedActions(o, d.stations[1].id).find((a) => a.action === 'ready'),
  );
  await m.selectMode('display');
  assert.equal(m.state.display.find((o) => o.number === number).state, 'ready');
  await m.selectMode('kitchen');
  o = m.state.orders.find((o) => o.orderId === target.orderId);
  await m.command(
    o,
    allowedActions(o, d.stations[1].id).find((a) => a.action === 'handoff'),
  );
  await m.selectMode('display');
  assert.equal(
    m.state.display.some((o) => o.number === number),
    false,
  );
  d.reset();
  await m.refresh();
  assert.equal(m.state.display.length, 6);
  d.add();
  await m.refresh();
  assert.equal(m.state.display.length, 7);
});

test('demo is isolated, bounded, rejects unsupported routes and cannot mark unfinished orders ready', async () => {
  const a = createDemo(),
    b = createDemo();
  a.add();
  const list = (d) => d.transport(prefix + '/display', null);
  assert.equal((await list(a)).items.length, 7);
  assert.equal((await list(b)).items.length, 6);
  const page = await a.transport(prefix + '/kitchen?stationId=' + a.stations[0].id, null);
  const o = page.items[0];
  await assert.rejects(
    a.transport(
      prefix + '/orders/' + o.orderId + '/actions',
      null,
      { action: 'ready', expectedVersion: o.version },
      randomUUID(),
    ),
    /ACTION_UNAVAILABLE/,
  );
  await assert.rejects(a.transport('/edge/v1/staff/login', null, {}), /DEMO_ROUTE_NOT_SUPPORTED/);
  for (let i = 0; i < 100; i++) a.add();
  assert.equal((await list(a)).items.length, 60);
  assert.equal(a.add(), false);
});
