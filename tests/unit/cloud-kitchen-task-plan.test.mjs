import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { taskPlan as edgePlan } from '@pickchick/edge-fulfillment';
import { taskPlan as cloudPlan, digest as cloudDigest } from '@pickchick/cloud-kitchen';
import { digest as edgeDigest } from '@pickchick/edge-fulfillment';

// ADR-0014 S2: the cloud kitchen ports the edge task planning rules unchanged. Both planners
// must return the same tasks or fail with the same code on every vector.
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const outcome = (plan, snapshot, routing) => {
  try {
    return { ok: plan(snapshot, routing) };
  } catch (error) {
    return { code: error.code ?? error.message };
  }
};

test('cloud taskPlan equals edge taskPlan on random snapshots and routings', () => {
  const next = random(20261010);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const chance = (p) => next() < p;
  const prep = randomUUID(),
    assembly = randomUUID();
  const products = ['burger', 'fries', 'drink', 'combo', 'sauce', 'wrap'];
  const tally = {};
  for (let i = 0; i < 600; i++) {
    const routes = products
      .filter(() => chance(0.85))
      .map((productId) => ({
        productId,
        stationId: chance(0.5) ? prep : assembly,
        kind: chance(0.6) ? 'prep' : 'assembly_item',
        ...(productId === 'combo' && chance(0.5) ? { unexpandedCombo: 'whole_product' } : {}),
      }));
    if (chance(0.03) && routes.length) routes.push({ ...routes[0] }); // duplicate route
    const routing = { version: 1, assemblyStationId: assembly, routes };
    const lineIds = Array.from({ length: 3 }, () => randomUUID());
    const lines = Array.from({ length: 1 + Math.floor(next() * 3) }, () => {
      const productId = pick(products);
      const kind = chance(0.3) ? undefined : pick(['item', 'combo', 'set']);
      const components = chance(0.5)
        ? Array.from({ length: Math.floor(next() * 3) }, () => ({
            productId: pick(products),
            quantity: 1 + Math.floor(next() * 3),
            name: { ru: 'Компонент', kk: '' },
            description: { ru: 'Описание', kk: '' },
          }))
        : [];
      const modifiers = chance(0.4)
        ? [
            {
              groupId: 'g',
              groupTitle: { ru: 'Группа', kk: '' },
              optionId: 'o',
              label: { ru: 'Опция', kk: '' },
              quantity: 1,
              linkedProductId: chance(0.5) ? pick([...products, 'unknown']) : null,
            },
          ]
        : [];
      return {
        lineId: chance(0.04) ? lineIds[0] : randomUUID(), // occasional duplicate line id
        productId,
        title: 'Позиция',
        description: chance(0.5) ? 'Без лука' : '',
        quantity: chance(0.01) ? 1000 : 1 + Math.floor(next() * 4),
        ...(kind ? { selectedDetails: { kind, components, modifiers } } : {}),
      };
    });
    const snapshot = { lines };
    const edge = outcome(edgePlan, snapshot, routing);
    const cloud = outcome(cloudPlan, snapshot, routing);
    assert.deepEqual(cloud, edge, JSON.stringify({ snapshot, routing }));
    const key = edge.ok ? 'ok' : edge.code;
    tally[key] = (tally[key] ?? 0) + 1;
  }
  // Every outcome family must be exercised.
  for (const key of ['ok', 'ROUTING_MISSING', 'INVALID']) assert.ok(tally[key] > 0, key);
});

test('cloud digest is the same canonical hash as edge and commerce', () => {
  for (const value of [{ b: 1, a: [true, null, 'x'] }, { lines: [{ q: 2 }] }, 'x', 0])
    assert.equal(cloudDigest(value), edgeDigest(value));
  for (const value of [undefined, NaN, new Date(), { x: undefined }, 'x'.repeat(1_100_001)]) {
    assert.throws(() => cloudDigest(value), { code: 'INVALID' });
    assert.throws(() => edgeDigest(value), { code: 'INVALID' });
  }
});
