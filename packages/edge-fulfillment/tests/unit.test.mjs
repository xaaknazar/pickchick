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

test('whole-product combo routing is explicit per product and retains all kitchen selections', () => {
  const station = randomUUID();
  const line = {
    lineId: randomUUID(),
    productId: 'reviewed-combo',
    title: 'Combo',
    description: 'Chicken, potatoes and a drink',
    quantity: 2,
    selectedDetails: {
      kind: 'combo',
      components: [],
      modifiers: [
        {
          groupId: 'drink',
          optionId: 'tea',
          quantity: 1,
          label: { ru: 'Tea 0.5 l', kk: '' },
          linkedProductId: null,
        },
      ],
    },
  };
  const route = { productId: line.productId, stationId: station, kind: 'prep' };
  const routing = { version: 2, assemblyStationId: randomUUID(), routes: [route] };
  const plan = (value = line, routes = routing.routes) =>
    taskPlan({ lines: [value] }, { ...routing, routes });
  assert.throws(() => plan(), { code: 'ROUTING_MISSING' });
  routing.routes = [{ ...route, unexpandedCombo: 'whole_product' }];
  const tasks = plan();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].details.productId, line.productId);
  assert.equal(tasks[0].details.quantity, 2);
  assert.equal(tasks[0].details.description, line.description);
  assert.deepEqual(tasks[0].details.modifiers, line.selectedDetails.modifiers);
  assert.throws(() => plan({ ...line, productId: 'unreviewed-combo' }), {
    code: 'ROUTING_MISSING',
  });
  // A linked addition cannot disappear merely because its parent has a route.
  assert.throws(
    () =>
      plan(
        {
          ...line,
          selectedDetails: {
            ...line.selectedDetails,
            modifiers: [{ ...line.selectedDetails.modifiers[0], linkedProductId: 'tea' }],
          },
        },
        [...routing.routes, { productId: 'tea', stationId: station, kind: 'assembly_item' }],
      ),
    { code: 'ROUTING_MISSING' },
  );
  // Once a BOM is present, keep the existing component routing with no duplicate parent.
  const expanded = plan(
    {
      ...line,
      selectedDetails: {
        ...line.selectedDetails,
        components: [
          { productId: 'chicken', quantity: 3, name: { ru: 'Chicken' }, description: { ru: '' } },
        ],
      },
    },
    [...routing.routes, { productId: 'chicken', stationId: station, kind: 'prep' }],
  );
  assert.equal(expanded.length, 1);
  assert.equal(expanded[0].details.productId, 'chicken');
  assert.equal(expanded[0].details.quantity, 6);
});
