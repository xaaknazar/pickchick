/* global structuredClone */
// Cutover lane kds, KDS-2 (contracts sections 2.2, 5.2, 5.4, 9 q.16): the kitchen plan of both
// admission paths. Pure: no PostgreSQL. The seam is driven through a scripted database client.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  FulfillmentTaskKdsSchema,
  FulfillmentTaskSchema,
  KdsLayoutSchema,
} from '@pickchick/contracts';
import {
  buildKitchenPlan,
  cloudKdsSlugs,
  kdsStationId,
  kdsTaskPlan,
  menuKdsSlugs,
  noKdsSlugs,
  parseKdsLayout,
  SnapshotSchema,
  taskPlan,
} from '../dist/index.js';

const branchId = randomUUID(),
  organizationId = randomUUID();
const st = (fn) => kdsStationId(branchId, fn);
const prep = randomUUID(),
  assembly = randomUUID();
// Cashier menu: hashed product, variant and option ids (synthetic).
const pos = {
  combo: { product: randomUUID(), variant: randomUUID() },
  cola: { product: randomUUID(), variant: randomUUID() },
  burger: { product: randomUUID(), variant: randomUUID() },
  legacy: { product: randomUUID(), variant: randomUUID() },
  options: { cola: randomUUID(), spicy: randomUUID(), burger: randomUUID() },
};
const text = (ru) => ({ ru, kk: '' });
const menu = {
  schema_version: 1,
  release_id: randomUUID(),
  branch_id: branchId,
  version: 3,
  published_at: '2026-11-10T00:00:00.000Z',
  items: [
    {
      product_id: pos.combo.product,
      variant_id: pos.combo.variant,
      category_id: randomUUID(),
      name: text('Pick Combo'),
      price_minor: '350000',
      currency: 'KZT',
      source_id: 'pick-combo',
      modifier_groups: [
        {
          id: randomUUID(),
          name: text('Напиток'),
          min_selected: 1,
          max_selected: 1,
          options: [
            {
              id: pos.options.cola,
              name: text('Кола'),
              price_minor: '0',
              linked_variant_id: pos.cola.variant,
            },
          ],
        },
        {
          id: randomUUID(),
          name: text('Острота'),
          min_selected: 0,
          max_selected: 2,
          options: [
            { id: pos.options.spicy, name: text('Острый'), price_minor: '0' },
            {
              id: pos.options.burger,
              name: text('Бургер'),
              price_minor: '0',
              linked_variant_id: pos.burger.variant,
            },
          ],
        },
      ],
    },
    ...[
      [pos.cola, 'cola', 'Кола 0,5'],
      [pos.burger, 'burger', 'Pick Burger'],
      [pos.legacy, undefined, 'Позиция без slug'],
    ].map(([ids, slug, name]) => ({
      product_id: ids.product,
      variant_id: ids.variant,
      category_id: randomUUID(),
      name: text(name),
      price_minor: '100000',
      currency: 'KZT',
      ...(slug ? { source_id: slug } : {}),
    })),
  ],
};
const routing = {
  version: 3,
  assemblyStationId: assembly,
  routes: [
    ...['burger', 'strips', 'fries', 'mystery'].map((productId) => ({
      productId,
      stationId: prep,
      kind: 'prep',
    })),
    ...['cola', 'sauce'].map((productId) => ({
      productId,
      stationId: assembly,
      kind: 'assembly_item',
    })),
    {
      productId: 'box',
      stationId: assembly,
      kind: 'assembly_item',
      unexpandedCombo: 'whole_product',
    },
    ...[pos.combo, pos.burger, pos.legacy].map((ids) => ({
      productId: ids.product,
      stationId: prep,
      kind: 'prep',
    })),
    { productId: pos.cola.product, stationId: assembly, kind: 'assembly_item' },
  ],
};
const tables = ['burger', 'strips', 'fries', 'pick-combo', 'box'];
const fullLayout = (version = 2) => ({
  schema_version: 1,
  branch_id: branchId,
  version,
  stations: [
    {
      edge_station_id: st('breading'),
      function: 'breading',
      terminal_ids: [],
      product_ids: ['strips', 'pick-combo'],
      counts: [
        { product_id: 'strips', unit: 'finger', count: 3 },
        { product_id: 'pick-combo', unit: 'finger', count: 2 },
      ],
    },
    {
      edge_station_id: st('toasts'),
      function: 'toasts',
      terminal_ids: [],
      product_ids: ['burger', 'pick-combo', 'toast'],
      counts: [
        { product_id: 'burger', unit: 'burger', count: 1 },
        { product_id: 'pick-combo', unit: 'burger', count: 1 },
      ],
    },
    {
      edge_station_id: st('assembly_hall'),
      function: 'assembly_hall',
      terminal_ids: [],
      product_ids: tables,
    },
    {
      edge_station_id: st('assembly_delivery'),
      function: 'assembly_delivery',
      terminal_ids: [],
      product_ids: tables,
    },
    {
      edge_station_id: st('issue'),
      function: 'issue',
      terminal_ids: [],
      product_ids: ['cola', 'sauce'],
    },
    {
      edge_station_id: st('delivery_handover'),
      function: 'delivery_handover',
      terminal_ids: [],
      product_ids: [],
    },
  ],
});
const line = (productId, quantity = 1, extra = {}) => ({
  lineId: randomUUID(),
  productId,
  title: 'Synthetic ' + productId.slice(0, 8),
  description: 'Synthetic',
  quantity,
  ...extra,
});
const snapshot = (lines, extra = {}) =>
  SnapshotSchema.parse({
    organizationId,
    branchId,
    channel: 'mobile',
    serviceMode: 'dine_in',
    currency: 'KZT',
    totalMinor: '100000',
    lines,
    ...extra,
  });
const modifier = (optionId, label, linkedProductId = null) => ({
  groupId: 'group-' + label,
  groupTitle: text('Группа'),
  optionId,
  label: text(label),
  quantity: 1,
  linkedProductId,
});
const plan = (snap, layout = fullLayout(), slugs = cloudKdsSlugs) =>
  kdsTaskPlan({ snapshot: snap, legacy: taskPlan(snap, routing), layout, slugs });
const byKey = (result) => new Map(result.plan.map((task) => [task.componentKey, task]));
const legacyOf = (snap, key) => taskPlan(snap, routing).find((t) => t.componentKey === key);

/** Every task is a valid kitchen task of the contract, keys are unique, kinds match stations. */
function valid(result) {
  const kinds = { breading: 'prep', toasts: 'prep' };
  assert.equal(new Set(result.plan.map((t) => t.componentKey)).size, result.plan.length);
  for (const task of result.plan) {
    FulfillmentTaskKdsSchema.parse(task.details.kds);
    FulfillmentTaskSchema.parse({
      taskId: randomUUID(),
      stationId: task.stationId,
      version: 1,
      state: 'queued',
      kind: task.kind,
      details: task.details,
    });
    assert.equal(
      task.kind,
      (kinds[task.details.kds.function] ?? 'assembly') === 'prep' ? 'prep' : 'assembly_item',
    );
    assert.equal(task.stationId, st(task.details.kds.function));
    assert.ok(task.componentKey.endsWith(':' + task.details.kds.function));
  }
  return result;
}

/** Scripted database client for the seam: readiness, settings and menu answers. */
function scripted({ ready = true, settings = null, menuReady = true, menuPayload = menu } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql) {
      queries.push(sql);
      if (sql.includes("to_regclass('kds_settings')")) return { rows: [{ ready }] };
      if (sql.includes('FROM kds_settings')) return { rows: settings ? [settings] : [] };
      if (sql.includes("to_regclass('active_menu')")) return { rows: [{ ready: menuReady }] };
      if (sql.includes('FROM active_menu'))
        return { rows: [{ release_id: menuPayload.release_id }] };
      if (sql.includes('FROM menu_snapshots')) return { rows: [{ payload: menuPayload }] };
      throw new Error('Unexpected query: ' + sql);
    },
  };
}
const enabled = (layout = fullLayout(), extra = {}) => ({
  layout_enabled: true,
  shift_mode: 'normal',
  version: layout.version,
  layout,
  ...extra,
});

test('golden: without an enabled layout the seam returns exactly taskPlan and the routing station', async () => {
  const vectors = [
    snapshot([line('burger', 2), line('cola')]),
    snapshot([
      line('box', 1, { selectedDetails: { kind: 'combo', modifiers: [], components: [] } }),
    ]),
    snapshot(
      [
        line('pick-combo', 3, {
          selectedDetails: {
            kind: 'combo',
            modifiers: [modifier('cola', 'Кола', 'cola')],
            components: [
              {
                productId: 'strips',
                quantity: 2,
                name: text('Стрипсы'),
                description: text('Synthetic'),
              },
              { productId: 'cola', quantity: 1, name: text('Кола'), description: text('Cold') },
            ],
          },
        }),
      ],
      { serviceMode: 'takeaway', delivery: { provider: 'glovo', externalNumber: 'G-123' } },
    ),
    snapshot([line(pos.combo.product, 2), line(pos.legacy.product)], { channel: 'pos' }),
  ];
  const off = [
    { name: '027 absent or not readable', client: () => scripted({ ready: false }) },
    { name: 'no settings row', client: () => scripted() },
    {
      name: 'layout off',
      client: () => scripted({ settings: enabled(fullLayout(), { layout_enabled: false }) }),
    },
    {
      name: 'enabled without active layout',
      client: () => scripted({ settings: { ...enabled(), version: null, layout: null } }),
    },
    {
      name: 'stored layout of another branch',
      client: () => scripted({ settings: enabled({ ...fullLayout(), branch_id: randomUUID() }) }),
    },
    {
      name: 'stored layout version mismatch',
      client: () => scripted({ settings: { ...enabled(), version: 9 } }),
    },
    {
      name: 'stored layout without issue',
      client: () =>
        scripted({
          settings: enabled({
            ...fullLayout(),
            stations: fullLayout().stations.filter((s) => s.function !== 'issue'),
          }),
        }),
    },
  ];
  for (const snap of vectors)
    for (const { name, client } of off) {
      const db = client();
      const result = await buildKitchenPlan(db, { branchId, snapshot: snap, routing });
      const expected = taskPlan(snap, routing);
      assert.equal(JSON.stringify(result.plan), JSON.stringify(expected), name);
      assert.deepEqual(result, { plan: expected, assemblyStationId: assembly }, name);
      assert.ok(!JSON.stringify(result).includes('"kds"'), name);
      // Read-only: only the readiness probe and the settings row; never the menu.
      assert.ok(
        db.queries.every((sql) => /^\s*SELECT/.test(sql)),
        name,
      );
      assert.ok(!db.queries.some((sql) => sql.includes('menu')), name);
    }
});

test('the legacy routing still decides: ROUTING_MISSING and INVALID with the layout on', async () => {
  for (const snap of [
    snapshot([line('unrouted')]),
    snapshot([
      line('burger', 1, { selectedDetails: { kind: 'set', modifiers: [], components: [] } }),
    ]),
  ])
    await assert.rejects(
      buildKitchenPlan(scripted({ settings: enabled() }), { branchId, snapshot: snap, routing }),
      (error) => error.code === 'ROUTING_MISSING',
    );
  const twice = line('burger');
  await assert.rejects(
    buildKitchenPlan(scripted({ settings: enabled() }), {
      branchId,
      snapshot: snapshot([twice, twice]),
      routing,
    }),
    (error) => error.code === 'INVALID',
  );
});

test('hall order: table 1 with toasts upstream, drinks at issue, unmapped on the table, issue finishes', async () => {
  const snap = snapshot([line('burger', 2), line('cola', 3), line('mystery'), line('strips', 2)]);
  const result = valid(
    await buildKitchenPlan(scripted({ settings: enabled() }), {
      branchId,
      snapshot: snap,
      routing,
    }),
  );
  assert.equal(result.assemblyStationId, st('issue'));
  const [burger, cola, mystery, strips] = snap.lines.map((l) => l.lineId);
  const tasks = byKey(result);
  assert.deepEqual(
    [...tasks.keys()],
    [
      burger + ':parent:assembly_hall',
      burger + ':parent:toasts',
      cola + ':parent:issue',
      mystery + ':parent:assembly_hall',
      strips + ':parent:assembly_hall',
    ],
  );
  const legacy = (id) => legacyOf(snap, id + ':parent').details;
  assert.deepEqual(tasks.get(burger + ':parent:assembly_hall').details, {
    ...legacy(burger),
    kds: { function: 'assembly_hall' },
  });
  assert.deepEqual(tasks.get(burger + ':parent:toasts'), {
    componentKey: burger + ':parent:toasts',
    stationId: st('toasts'),
    kind: 'prep',
    details: {
      ...legacy(burger),
      kds: { function: 'toasts', upstreamOf: st('assembly_hall'), units: 2, unit: 'burger' },
    },
  });
  assert.deepEqual(tasks.get(cola + ':parent:issue').details, {
    ...legacy(cola),
    kds: { function: 'issue' },
  });
  assert.deepEqual(tasks.get(mystery + ':parent:assembly_hall').details.kds, {
    function: 'assembly_hall',
    unmapped: true,
  });
  assert.deepEqual(tasks.get(strips + ':parent:assembly_hall').details.kds, {
    function: 'assembly_hall',
    fingers: 6,
  });
  // Takeaway is a hall order too (sales channel hall): same stations.
  const takeaway = snapshot(snap.lines, { serviceMode: 'takeaway' });
  assert.deepEqual(plan(takeaway), plan(snap));
});

test('aggregator order: table 2, drinks and sauces still at issue (2), courier counter (3) finishes', () => {
  const delivery = { provider: 'yandex_eda', externalNumber: 'YA-77' };
  const snap = snapshot([line('burger'), line('sauce', 2)], { serviceMode: 'takeaway', delivery });
  const result = valid(plan(snap));
  assert.equal(result.assemblyStationId, st('delivery_handover'));
  assert.deepEqual(
    result.plan.map((t) => [t.details.kds.function, t.stationId]),
    [
      ['assembly_delivery', st('assembly_delivery')],
      ['toasts', st('toasts')],
      ['issue', st('issue')],
    ],
  );
  assert.equal(result.plan[1].details.kds.upstreamOf, st('assembly_delivery'));
  // Without table 2 and without station 3 in the layout: table 1 and issue (2).
  const lean = fullLayout();
  lean.stations = lean.stations.filter(
    (s) => !['assembly_delivery', 'delivery_handover'].includes(s.function),
  );
  const fallback = valid(plan(snap, lean));
  assert.equal(fallback.assemblyStationId, st('issue'));
  assert.deepEqual(
    fallback.plan.map((t) => t.details.kds.function),
    ['assembly_hall', 'toasts', 'issue'],
  );
  assert.equal(fallback.plan[1].details.kds.upstreamOf, st('assembly_hall'));
  // Only one of the two missing: each falls back on its own.
  const noCounter = fullLayout();
  noCounter.stations = noCounter.stations.filter((s) => s.function !== 'delivery_handover');
  assert.equal(plan(snap, noCounter).assemblyStationId, st('issue'));
  assert.equal(plan(snap, noCounter).plan[0].stationId, st('assembly_delivery'));
});

test('cloud combo: components split by station, linked drink choice hidden on the table only', () => {
  const choice = modifier('cola', 'Кола', 'cola'),
    note = modifier('no-salt', 'Без соли');
  const combo = line('pick-combo', 2, {
    selectedDetails: {
      kind: 'combo',
      modifiers: [choice, note],
      components: [
        { productId: 'burger', quantity: 1, name: text('Бургер'), description: text('Synthetic') },
        { productId: 'strips', quantity: 2, name: text('Стрипсы'), description: text('Synthetic') },
        { productId: 'cola', quantity: 1, name: text('Кола'), description: text('Cold') },
      ],
    },
  });
  const snap = snapshot([combo]);
  const result = valid(plan(snap));
  const key = (part) => combo.lineId + ':component:' + part;
  const tasks = byKey(result);
  assert.deepEqual(
    [...tasks.keys()],
    [
      key('burger') + ':assembly_hall',
      key('burger') + ':toasts',
      key('strips') + ':assembly_hall',
      key('cola') + ':issue',
    ],
  );
  for (const id of [
    key('burger') + ':assembly_hall',
    key('burger') + ':toasts',
    key('strips') + ':assembly_hall',
  ])
    assert.deepEqual(tasks.get(id).details.modifiers, [note], id);
  assert.deepEqual(tasks.get(key('cola') + ':issue').details.modifiers, [choice, note]);
  assert.deepEqual(tasks.get(key('strips') + ':assembly_hall').details.kds, {
    function: 'assembly_hall',
    fingers: 12,
  });
  assert.equal(tasks.get(key('burger') + ':toasts').details.kds.units, 2);
  // A choice linked to a table product stays visible on the table.
  const burgerChoice = modifier('burger', 'Бургер', 'burger');
  const linked = snapshot([
    {
      ...combo,
      lineId: randomUUID(),
      selectedDetails: { ...combo.selectedDetails, modifiers: [burgerChoice] },
    },
  ]);
  for (const task of plan(linked).plan) assert.deepEqual(task.details.modifiers, [burgerChoice]);
  // An unexpanded whole-product combo is one table task by its slug.
  const box = snapshot([
    line('box', 1, { selectedDetails: { kind: 'combo', modifiers: [], components: [] } }),
  ]);
  assert.deepEqual(
    valid(plan(box)).plan.map((t) => t.details.kds),
    [{ function: 'assembly_hall' }],
  );
});

test('cashier combo: slugs from the menu, linked drink option becomes an issue task', () => {
  const slugs = menuKdsSlugs(menu);
  assert.equal(slugs.product(pos.combo.product), 'pick-combo');
  assert.equal(slugs.product(pos.legacy.product), null);
  assert.deepEqual(slugs.option(pos.options.cola), { slug: 'cola', productId: pos.cola.product });
  assert.equal(slugs.option(pos.options.spicy), null);
  const cola = modifier(pos.options.cola, 'Кола'),
    spicy = modifier(pos.options.spicy, 'Острый'),
    burger = modifier(pos.options.burger, 'Бургер');
  const combo = line(pos.combo.product, 2, {
    selectedDetails: { kind: 'item', components: [], modifiers: [cola, spicy, burger] },
  });
  const plain = line(pos.cola.product, 1, {
    selectedDetails: { kind: 'item', components: [], modifiers: [] },
  });
  const noSlug = line(pos.legacy.product, 1, {
    selectedDetails: { kind: 'item', components: [], modifiers: [] },
  });
  const snap = snapshot([combo, plain, noSlug], { channel: 'pos', serviceMode: 'takeaway' });
  const result = valid(plan(snap, fullLayout(), slugs));
  const tasks = byKey(result);
  const parent = combo.lineId + ':parent';
  assert.deepEqual(
    [...tasks.keys()],
    [
      parent + ':assembly_hall',
      parent + ':toasts',
      combo.lineId + ':modifier:0:issue',
      plain.lineId + ':parent:issue',
      noSlug.lineId + ':parent:assembly_hall',
    ],
  );
  assert.deepEqual(tasks.get(parent + ':assembly_hall').details, {
    ...legacyOf(snap, parent).details,
    modifiers: [spicy, burger],
    kds: { function: 'assembly_hall', fingers: 4 },
  });
  assert.deepEqual(tasks.get(parent + ':toasts').details.modifiers, [spicy, burger]);
  assert.deepEqual(tasks.get(parent + ':toasts').details.kds, {
    function: 'toasts',
    upstreamOf: st('assembly_hall'),
    units: 2,
    unit: 'burger',
  });
  assert.deepEqual(tasks.get(combo.lineId + ':modifier:0:issue'), {
    componentKey: combo.lineId + ':modifier:0:issue',
    stationId: st('issue'),
    kind: 'assembly_item',
    details: {
      lineId: combo.lineId,
      productId: pos.cola.product,
      title: 'Кола',
      quantity: 2,
      parentTitle: combo.title,
      description: '',
      modifiers: [],
      kds: { function: 'issue' },
    },
  });
  assert.deepEqual(tasks.get(noSlug.lineId + ':parent:assembly_hall').details.kds, {
    function: 'assembly_hall',
    unmapped: true,
  });
  // Without linked_variant_id (no combo_stops menu) the choice stays visible on the table.
  const withoutLinks = structuredClone(menu);
  for (const group of withoutLinks.items[0].modifier_groups)
    for (const option of group.options) delete option.linked_variant_id;
  const unlinked = plan(snap, fullLayout(), menuKdsSlugs(withoutLinks));
  assert.deepEqual(byKey(unlinked).get(parent + ':assembly_hall').details.modifiers, [
    cola,
    spicy,
    burger,
  ]);
  assert.ok(!byKey(unlinked).has(combo.lineId + ':modifier:0:issue'));
  // No readable menu: every cashier product is unmapped on the table; nothing is lost.
  const blind = valid(plan(snap, fullLayout(), noKdsSlugs));
  assert.deepEqual(
    blind.plan.map((t) => [t.details.kds.function, t.details.kds.unmapped]),
    [
      ['assembly_hall', true],
      ['assembly_hall', true],
      ['assembly_hall', true],
    ],
  );
});

test('the seam reads the cashier menu only for cashier orders and degrades without it', async () => {
  const combo = line(pos.combo.product, 1, {
    selectedDetails: { kind: 'item', components: [], modifiers: [] },
  });
  const cashier = snapshot([combo], { channel: 'pos' });
  const db = scripted({ settings: enabled() });
  const result = await buildKitchenPlan(db, { branchId, snapshot: cashier, routing });
  assert.deepEqual(result, plan(cashier, fullLayout(), menuKdsSlugs(menu)));
  assert.ok(db.queries.some((sql) => sql.includes('FROM menu_snapshots')));
  const blind = await buildKitchenPlan(scripted({ settings: enabled(), menuReady: false }), {
    branchId,
    snapshot: cashier,
    routing,
  });
  assert.deepEqual(blind, plan(cashier, fullLayout(), noKdsSlugs));
  const cloudDb = scripted({ settings: enabled() });
  await buildKitchenPlan(cloudDb, { branchId, snapshot: snapshot([line('burger')]), routing });
  assert.ok(!cloudDb.queries.some((sql) => sql.includes('menu')));
});

test('toast units without a count, a toast only on issue, a layout without toasts or breading', () => {
  const layout = fullLayout();
  layout.stations.find((s) => s.function === 'toasts').product_ids.push('cola');
  const snap = snapshot([line('strips', 4), line('cola', 2), line('fries', 3)]);
  // 'toast' has no count: units = quantity, no unit. A toast product only on issue is upstream
  // of issue, the station that receives its main task.
  layout.stations.find((s) => s.function === 'toasts').product_ids.push('fries');
  const tasks = valid(plan(snap, layout)).plan;
  const toast = tasks.filter((t) => t.details.kds.function === 'toasts');
  assert.deepEqual(
    toast.map((t) => t.details.kds),
    [
      { function: 'toasts', upstreamOf: st('issue'), units: 2 },
      { function: 'toasts', upstreamOf: st('assembly_hall'), units: 3 },
    ],
  );
  const minimal = fullLayout();
  minimal.stations = minimal.stations.filter((s) =>
    ['assembly_hall', 'issue'].includes(s.function),
  );
  assert.deepEqual(
    valid(plan(snap, minimal)).plan.map((t) => t.details.kds),
    [{ function: 'assembly_hall' }, { function: 'issue' }, { function: 'assembly_hall' }],
  );
});

test('beyond the legacy bounds the layout never refuses: the legacy plan is kept', async () => {
  // Fingers above 1 000 000 for one line.
  const heavy = snapshot([
    line('strips', 1000, {
      selectedDetails: {
        kind: 'combo',
        modifiers: [],
        components: [
          { productId: 'strips', quantity: 1000, name: text('Стрипсы'), description: text('S') },
        ],
      },
    }),
  ]);
  assert.equal(plan(heavy), null);
  // More than 2000 tasks: 1001 burgers become 2002 tasks.
  const many = snapshot(Array.from({ length: 1001 }, () => line('burger')));
  assert.equal(taskPlan(many, routing).length, 1001);
  assert.equal(plan(many), null);
  for (const snap of [heavy, many])
    assert.deepEqual(
      await buildKitchenPlan(scripted({ settings: enabled() }), {
        branchId,
        snapshot: snap,
        routing,
      }),
      { plan: taskPlan(snap, routing), assemblyStationId: assembly },
    );
});

test('the stored-layout check mirrors KdsLayoutSchema of the contract', () => {
  const good = fullLayout();
  assert.deepEqual(parseKdsLayout(good, branchId, 2), KdsLayoutSchema.parse(good));
  const minimal = {
    ...good,
    stations: good.stations.filter((s) => ['assembly_hall', 'issue'].includes(s.function)),
  };
  assert.ok(KdsLayoutSchema.safeParse(minimal).success);
  assert.deepEqual(parseKdsLayout(minimal, branchId, 2), minimal);
  const mutate = (fn) => {
    const copy = structuredClone(good);
    fn(copy);
    return copy;
  };
  for (const bad of [
    mutate((l) => (l.schema_version = 2)),
    mutate((l) => l.stations.pop() && l.stations.splice(4, 1)),
    mutate((l) => (l.stations[3].function = 'assembly_hall')),
    mutate((l) => (l.stations[3].edge_station_id = l.stations[2].edge_station_id)),
    mutate((l) => l.stations[2].product_ids.push('burger')),
    mutate((l) => (l.stations[0].counts[0].unit = 'toast')),
    mutate((l) => (l.stations[1].counts[0].unit = 'finger')),
    mutate((l) => (l.stations[1].counts[0].product_id = 'fries')),
    mutate((l) => l.stations[1].counts.push({ product_id: 'burger', unit: 'toast', count: 1 })),
    mutate((l) => (l.stations[2].counts = [{ product_id: 'burger', unit: 'burger', count: 1 }])),
    mutate((l) => (l.stations[2].product_ids = ['Not-A-Slug'])),
    mutate((l) => (l.extra = true)),
  ]) {
    assert.equal(KdsLayoutSchema.safeParse(bad).success, false, JSON.stringify(bad));
    assert.equal(parseKdsLayout(bad, branchId, bad.version), null, JSON.stringify(bad));
  }
  assert.equal(parseKdsLayout(good, randomUUID(), 2), null);
  assert.equal(parseKdsLayout(good, branchId, 3), null);
  assert.equal(parseKdsLayout(null, branchId, 2), null);
});
