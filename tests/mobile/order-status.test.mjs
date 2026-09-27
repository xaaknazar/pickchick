import test from 'node:test';
import assert from 'node:assert/strict';
import { orderStage, orderTimeLabel, orderScene } from '../../apps/mobile/src/order-status.ts';
const order = {
  state: 'preparing',
  created_at: '2026-09-27T10:00:00Z',
  updated_at: '2026-09-27T10:06:00Z',
  tasks: [
    { station: 'prep', state: 'pending' },
    { station: 'assembly', state: 'pending' },
  ],
};
test('status follows server tasks and does not declare an empty task list assembled', () => {
  assert.equal(orderStage(order), 'Готовится');
  assert.equal(orderStage({ ...order, tasks: [] }), 'Готовится');
  assert.equal(
    orderStage({
      ...order,
      tasks: [
        { station: 'prep', state: 'done' },
        { station: 'assembly', state: 'pending' },
      ],
    }),
    'На сборке',
  );
  assert.equal(orderStage({ ...order, state: 'ready' }), 'Можно забирать');
  assert.equal(orderStage({ ...order, state: 'cancelled' }), 'Отменён');
});
test('time is elapsed, clamps clock skew, and stops ticking on terminal server states', () => {
  assert.equal(
    orderTimeLabel(order, Date.parse(order.created_at) - 1000),
    'Заказ только что принят',
  );
  assert.equal(
    orderTimeLabel(order, Date.parse('2026-09-27T10:03:59Z')),
    'С момента заказа: 3 мин',
  );
  const ready = { ...order, state: 'ready' };
  assert.equal(orderTimeLabel(ready, 0), 'Готов к выдаче в 15:06');
  assert.equal(orderTimeLabel(ready, Date.now()), orderTimeLabel(ready, 0));
  assert.equal(orderTimeLabel({ ...order, state: 'cancelled' }, 0), 'Заказ отменён');
});

test('chef scenes follow kitchen, assembly and ready with no client-side simulation', () => {
  assert.equal(orderScene(order), 'cooking');
  assert.equal(
    orderScene({
      ...order,
      tasks: [
        { station: 'prep', state: 'done' },
        { station: 'assembly', state: 'pending' },
      ],
    }),
    'assembly',
  );
  assert.equal(orderScene({ ...order, state: 'ready' }), 'ready');
  assert.equal(orderScene({ ...order, state: 'fulfilled' }), 'ready');
});
