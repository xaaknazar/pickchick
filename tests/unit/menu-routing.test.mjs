/* global structuredClone */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  deriveRouting,
  hashJson,
  isWebp,
  menuImageShas,
  menuMediaPath,
  MenuRoutingError,
  projectCatalogMenu,
} from '@pickchick/menu-sync';
import { RoutingSchema, taskPlan, digest } from '@pickchick/edge-fulfillment';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';

const branch = randomUUID();
const prep = randomUUID();
const assembly = randomUUID();
const stations = [
  { id: prep, kind: 'prep' },
  { id: assembly, kind: 'assembly' },
];
const unresolved = (error) =>
  error instanceof MenuRoutingError && error.code === 'ROUTING_UNRESOLVED';
const menu = () => projectCatalogMenu(mockupCatalogDraft, branch, 3, new Date().toISOString());
/** Installed routing shape: every POS hashed id, explicit station, no slug routes yet. */
const installed = (snapshot) => ({
  version: 2,
  assemblyStationId: assembly,
  routes: snapshot.items.map((item) => ({
    productId: item.product_id,
    stationId: item.kitchen.route === 'prep' ? prep : assembly,
    kind: item.kitchen.route,
  })),
});
const planFor = (snapshot, routing) => {
  for (const item of snapshot.items) {
    const line = (productId, kind) => ({
      lineId: randomUUID(),
      productId,
      title: item.name.ru,
      description: '',
      quantity: 1,
      selectedDetails: { kind, modifiers: [], components: [] },
    });
    const common = {
      organizationId: randomUUID(),
      branchId: branch,
      serviceMode: 'takeaway',
      currency: 'KZT',
      totalMinor: '1000',
    };
    taskPlan({ ...common, channel: 'pos', lines: [line(item.product_id, 'item')] }, routing);
    taskPlan({ ...common, channel: 'mobile', lines: [line(item.source_id, item.kind)] }, routing);
  }
};

test('seed catalog publication derives slug routes from the installed POS routes and plans every item', () => {
  const snapshot = menu();
  const active = installed(snapshot);
  const before = structuredClone(active);
  const next = deriveRouting(snapshot, active, stations);
  assert.deepEqual(active, before, 'input routing is never mutated');
  const parsed = RoutingSchema.parse(next);
  assert.equal(parsed.version, 3);
  assert.equal(digest(parsed), hashJson(next));
  assert.deepEqual(parsed.routes.slice(0, active.routes.length), active.routes);
  const routes = new Map(parsed.routes.map((route) => [route.productId, route]));
  for (const item of snapshot.items) {
    assert.equal(routes.get(item.source_id).stationId, routes.get(item.product_id).stationId);
    assert.equal(
      routes.get(item.source_id).unexpandedCombo,
      item.kitchen.unexpanded_combo,
      item.source_id,
    );
  }
  planFor(snapshot, parsed);
  assert.equal(deriveRouting(snapshot, parsed, stations), null, 'a covered menu needs no version');
});

test('existing stations win over a changed kitchen field; routes of removed products are kept', () => {
  const snapshot = menu();
  const active = installed(snapshot);
  const first = deriveRouting(snapshot, active, stations);
  const changed = structuredClone(snapshot);
  changed.items[0].kitchen = {
    route: changed.items[0].kitchen.route === 'prep' ? 'assembly_item' : 'prep',
  };
  const removed = changed.items.pop();
  assert.equal(deriveRouting(changed, first, stations), null);
  assert.ok(first.routes.some((route) => route.productId === removed.source_id));
});

test('new products follow the published kitchen field and the single prep station only', () => {
  const snapshot = menu();
  const active = installed(snapshot);
  const extra = {
    ...structuredClone(snapshot.items[0]),
    product_id: randomUUID(),
    variant_id: randomUUID(),
    source_id: 'new-item',
    kind: 'item',
    kitchen: { route: 'prep' },
  };
  const withExtra = { items: [...snapshot.items, extra] };
  const next = deriveRouting(withExtra, active, stations);
  const routes = new Map(next.routes.map((route) => [route.productId, route]));
  assert.deepEqual(routes.get('new-item'), {
    productId: 'new-item',
    stationId: prep,
    kind: 'prep',
  });
  assert.equal(routes.get(extra.product_id).stationId, prep);
  const second = [...stations, { id: randomUUID(), kind: 'prep' }];
  assert.throws(() => deriveRouting(withExtra, active, second), unresolved);
  // An assembly item never needs the prep station, even when there are two.
  const assemblyOnly = {
    items: [...snapshot.items, { ...extra, kitchen: { route: 'assembly_item' } }],
  };
  const resolved = deriveRouting(assemblyOnly, active, second);
  assert.equal(resolved.routes.find((route) => route.productId === 'new-item').stationId, assembly);
  const bare = structuredClone(extra);
  delete bare.kitchen;
  assert.throws(
    () => deriveRouting({ items: [...snapshot.items, bare] }, active, stations),
    unresolved,
  );
  const noPrep = stations.filter((station) => station.kind !== 'prep');
  assert.throws(
    () =>
      deriveRouting(
        withExtra,
        { ...active, routes: active.routes.filter((r) => r.kind !== 'prep') },
        noPrep,
      ),
    unresolved,
  );
});

test('an unexpanded combo gains the explicit whole-product flag on its slug route only', () => {
  const combo = {
    product_id: randomUUID(),
    variant_id: randomUUID(),
    category_id: randomUUID(),
    name: { ru: 'Бокс', kk: 'Бокс' },
    price_minor: '100000',
    currency: 'KZT',
    source_id: 'box',
    kind: 'combo',
    kitchen: { route: 'assembly_item', unexpanded_combo: 'whole_product' },
  };
  const active = {
    version: 4,
    assemblyStationId: assembly,
    routes: [
      { productId: combo.product_id, stationId: assembly, kind: 'assembly_item' },
      { productId: 'box', stationId: assembly, kind: 'assembly_item' },
    ],
  };
  const next = RoutingSchema.parse(deriveRouting({ items: [combo] }, active, stations));
  assert.deepEqual(next.routes, [
    active.routes[0],
    { ...active.routes[1], unexpandedCombo: 'whole_product' },
  ]);
  planFor({ items: [combo] }, next);
});

test('invalid installed routing or station sets are never repaired by inference', () => {
  const snapshot = menu();
  const active = installed(snapshot);
  for (const broken of [
    { ...active, assemblyStationId: prep },
    { ...active, routes: [...active.routes, active.routes[0]] },
    { ...active, routes: [{ ...active.routes[0], stationId: randomUUID() }] },
    {
      ...active,
      routes: [{ ...active.routes[0], kind: 'assembly_item', stationId: prep }],
    },
    { ...active, routes: [] },
    null,
  ])
    assert.throws(() => deriveRouting(snapshot, broken, stations), unresolved);
  assert.throws(() => deriveRouting(snapshot, active, [...stations, stations[0]]), unresolved);
  const many = {
    ...active,
    routes: Array.from({ length: 2000 }, (_, index) => ({
      productId: `legacy-${index}`,
      stationId: prep,
      kind: 'prep',
    })),
  };
  assert.throws(() => deriveRouting(snapshot, many, stations), unresolved);
});

test('menu media helpers name the card variant and accept only WebP containers', () => {
  const sha = 'a'.repeat(64);
  assert.equal(menuMediaPath(sha), `/internal/v1/edge/media/${sha}.card.webp`);
  assert.deepEqual(
    menuImageShas({
      items: [
        { image: { sha256: sha } },
        {},
        { image: { sha256: sha } },
        { image: { sha256: 'b'.repeat(64) } },
      ],
    }),
    [sha, 'b'.repeat(64)],
  );
  const header = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  assert.equal(isWebp(header), true);
  assert.equal(isWebp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), false);
  assert.equal(
    isWebp(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')])),
    false,
  );
});
