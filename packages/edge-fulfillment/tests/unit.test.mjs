import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { digest, taskPlan, CloudCommandSchema } from '../dist/index.js';

test('canonical hashes preserve exact JSON and reject unsafe/unbounded values', () => {
  assert.equal(
    digest({ b: 1, a: [true, null, 'x'] }),
    createHash('sha256').update('{"a":[true,null,"x"],"b":1}').digest('hex'),
  );
  assert.equal(digest({ b: 1, a: 2 }), digest({ a: 2, b: 1 }));
  for (const v of [undefined, NaN, new Date(), { x: undefined }, 'x'.repeat(1_100_001)])
    assert.throws(() => digest(v));
});
test('item base and selected addition are both routed; missing routes fail closed', () => {
  const station = randomUUID();
  const line = {
    lineId: randomUUID(),
    productId: 'burger',
    title: 'Burger',
    description: 'No onions',
    quantity: 2,
    selectedDetails: {
      kind: 'item',
      modifiers: [{ linkedProductId: 'drink' }],
      components: [
        { productId: 'drink', quantity: 3, name: { ru: 'Drink' }, description: { ru: 'Cold' } },
      ],
    },
  };
  const route = {
    version: 1,
    assemblyStationId: station,
    routes: [
      { productId: 'burger', stationId: station, kind: 'prep' },
      { productId: 'drink', stationId: station, kind: 'assembly_item' },
    ],
  };
  const plan = taskPlan({ lines: [line] }, route);
  assert.deepEqual(
    plan.map((p) => [p.details.productId, p.details.quantity]),
    [
      ['burger', 2],
      ['drink', 6],
    ],
  );
  assert.equal(plan[0].details.description, 'No onions');
  assert.throws(() => taskPlan({ lines: [line] }, { ...route, routes: route.routes.slice(0, 1) }), {
    code: 'ROUTING_MISSING',
  });
  assert.throws(() => taskPlan({ lines: [line, line] }, route), { code: 'INVALID' });
  assert.throws(
    () =>
      taskPlan(
        {
          lines: [
            {
              ...line,
              selectedDetails: { ...line.selectedDetails, kind: 'combo', components: [] },
            },
          ],
        },
        route,
      ),
    { code: 'ROUTING_MISSING' },
  );
});
test('there is no public paid=true or client-role authorization schema', () => {
  assert.equal(
    CloudCommandSchema.safeParse({
      eventId: randomUUID(),
      type: 'edge.kitchen_admission_requested',
      paid: true,
    }).success,
    false,
  );
});
