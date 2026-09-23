import test from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createDemo, memoryStorage, demoTicketAction } from '../dist/demo.js';
import { KitchenModel } from '../dist/model.js';
import { prefix } from '../dist/types.js';
import { demoTicket } from '../dist/ticket-view.js';

test('one receipt confirmation at prep, one at assembly: readiness and comments persist through handoff', async () => {
  const d = createDemo();
  const m = new KitchenModel(d.transport, memoryStorage(), memoryStorage(), async () => () => {});
  await m.importCredential(JSON.stringify(d.credential));
  assert.equal(m.state.error, null);
  const target = m.state.orders.find((o) => o.displayNumber === '101');
  const originalComment = d.details(target.orderId).customerComment;
  assert.equal(d.completeTicket(target.orderId, d.stations[1].id, target.version), false);
  await m.selectStation(d.stations[1].id);
  assert.equal(
    m.state.orders.some((o) => o.orderId === target.orderId),
    false,
  );
  assert.equal(d.completeTicket(target.orderId, d.stations[0].id, target.version), true);
  assert.equal(d.completeTicket(target.orderId, d.stations[0].id, target.version), false);
  await m.refresh();
  const assembly = m.state.orders.find((o) => o.orderId === target.orderId);
  assert.equal(
    assembly.tasks.filter((t) => t.kind === 'prep').every((t) => t.state === 'done'),
    true,
  );
  assert.equal(demoTicketAction(assembly, d.stations[1].id), 'assembly');
  assert.equal(d.details(assembly.orderId).customerComment, originalComment);
  assert.equal(d.completeTicket(assembly.orderId, d.stations[1].id, assembly.version), true);
  await m.selectMode('display');
  assert.equal(m.state.display.find((o) => o.number === '101').state, 'ready');
  await m.selectMode('kitchen');
  const ready = m.state.orders.find((o) => o.orderId === target.orderId);
  assert.equal(d.completeTicket(ready.orderId, d.stations[1].id, ready.version), true);
  await m.selectMode('display');
  assert.equal(
    m.state.display.some((o) => o.number === '101'),
    false,
  );
  d.reset();
  await m.refresh();
  assert.equal(m.state.display.length, 6);
  d.add();
  await m.refresh();
  assert.equal(m.state.display.length, 7);
});

test('receipt UI has one action, numbered quantities, escaped customer notes and distinct source/delivery labels', async () => {
  const d = createDemo();
  const page = await d.transport(prefix + '/kitchen?stationId=' + d.stations[1].id, null);
  const o = page.items.find((o) => o.displayNumber === '103');
  const html = demoTicket(
    o,
    d.stations,
    d.stations[1].id,
    { ...d.details(o.orderId), customerComment: '<script>bad</script>' },
    false,
  );
  assert.equal((html.match(/<button /g) ?? []).length, 1);
  for (const text of [
    'Яндекс Еда',
    'ДОСТАВКА',
    '✓ Готово',
    'Добавить при сборке',
    'Позиция 1',
    'Приборы на 2 персоны',
  ])
    assert.ok(html.includes(text), text);
  assert.ok(html.includes('&lt;script&gt;bad&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('data-command='));
});

test('demo remains bounded and isolated; wrong station, premature ready and unsupported routes fail closed', async () => {
  const a = createDemo(),
    b = createDemo();
  a.add();
  const list = (d) => d.transport(prefix + '/display', null);
  assert.equal((await list(a)).items.length, 7);
  assert.equal((await list(b)).items.length, 6);
  const page = await a.transport(prefix + '/kitchen?stationId=' + a.stations[0].id, null);
  const o = page.items[0];
  assert.equal(a.completeTicket(o.orderId, randomUUID(), o.version), false);
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
