import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localCatalogId } from '@pickchick/menu-sync';
import {
  MenuLinkSaveCommand,
  MenuLinksApproveCommand,
  P1Command,
  StockSettingsCommand,
  catalogIndex,
  cloudOrderLines,
  menuLinkItems,
  posOrderLines,
  recipesByOutput,
  resolveOrder,
  roundHalfUp,
} from '../dist/index.js';

/** Pure part of the automatic consumption (consumption.ts); no database. Synthetic catalogs. */
const BRANCH = '00000000-0000-4000-8000-000000000001';
const t = (ru) => ({ ru });
const p = (id, extra = {}) => ({
  id,
  name: t('Товар ' + id),
  available: true,
  kind: 'item',
  combo_components: [],
  modifier_groups: [],
  ...extra,
});
const link = (key, lines, status = 'approved') => [
  key,
  { catalog_key: key, effect: lines.length ? 'consume' : 'none', lines, status, revision: 1 },
];
const ids = {
  a: randomUUID(),
  b: randomUUID(),
  out: randomUUID(),
  mid: randomUUID(),
};

test('rounding: one half-up per ingredient', () => {
  const r = (n, d) => roundHalfUp({ n: BigInt(n), d: BigInt(d) }).toString();
  assert.deepEqual(
    [r(1, 2), r(1, 3), r(2, 3), r(5, 2), r(200, 3), r(100, 3), r(0, 1), r(7, 7), r(3, 2)],
    ['1', '0', '1', '3', '67', '33', '0', '1', '2'],
  );
});

test('POS ids map back to catalog slugs exactly; foreign options and unknown items are counted', () => {
  const catalog = catalogIndex(BRANCH, 3, {
    products: [
      p('burger', {
        modifier_groups: [
          { id: 'extra', title: t('Добавки'), options: [{ id: 'cheese', label: t('Сыр') }] },
        ],
      }),
      p('cola'),
    ],
  });
  const variant = (slug) => localCatalogId(BRANCH, 'base-preview', slug);
  const option = (key) => localCatalogId(BRANCH, 'modifier-option', key);
  assert.deepEqual(
    posOrderLines(catalog, [
      {
        variant_id: variant('burger'),
        quantity: 2,
        modifiers: [{ option_id: option('burger:extra:cheese'), quantity: 2 }],
      },
      {
        variant_id: variant('cola'),
        quantity: 1,
        modifiers: [{ option_id: option('burger:extra:cheese') }],
      },
      { variant_id: randomUUID(), quantity: 1 },
    ]),
    {
      lines: [
        {
          product_id: 'burger',
          quantity: 2,
          selections: [{ group_id: 'extra', option_id: 'cheese', quantity: 2 }],
        },
        { product_id: 'cola', quantity: 1, selections: [] },
      ],
      unknown: 2,
    },
  );
  assert.deepEqual(posOrderLines(catalog, 'not lines'), { lines: [], unknown: 1 });
  // Another branch hashes differently: nothing matches.
  assert.equal(
    posOrderLines(catalog, [
      { variant_id: localCatalogId(randomUUID(), 'base-preview', 'cola'), quantity: 1 },
    ]).unknown,
    1,
  );
  assert.deepEqual(
    cloudOrderLines({
      catalogReference: { version: 4 },
      lines: [
        {
          productId: 'burger',
          quantity: 1,
          selectedDetails: { modifiers: [{ groupId: 'extra', optionId: 'cheese', quantity: 1 }] },
        },
      ],
    }),
    {
      version: 4,
      lines: [
        {
          product_id: 'burger',
          quantity: 1,
          selections: [{ group_id: 'extra', option_id: 'cheese', quantity: 1 }],
        },
      ],
    },
  );
  assert.deepEqual(cloudOrderLines({ lines: [] }), { version: null, lines: [] });
  assert.deepEqual(cloudOrderLines(null), { version: null, lines: [] });
});

test('combos explode by components up to 5 levels; links win; problems block', () => {
  // c0 -> c1 -> ... -> c6 -> leaf: the leaf is 7 levels down.
  const chain = Array.from({ length: 7 }, (_, i) =>
    p('c' + i, {
      kind: 'combo',
      combo_components: [{ product_id: i === 6 ? 'leaf' : 'c' + (i + 1), quantity: 2 }],
    }),
  );
  const catalog = catalogIndex(BRANCH, 1, { products: [...chain, p('leaf')] });
  const context = (links) => ({
    catalog,
    links: new Map(links),
    recipes: recipesByOutput([]),
    ingredients: new Set([ids.a, ids.b]),
  });
  const leafLink = link('leaf', [{ ingredient_id: ids.a, quantity: '3' }]);
  // From c2: c2..c6 are 5 levels, the leaf is the 5th component level: fine (2^5 x 3 = 96).
  const deep = resolveOrder(context([leafLink]), [
    { product_id: 'c2', quantity: 1, selections: [] },
  ]);
  assert.deepEqual(deep.problems, []);
  assert.equal(roundHalfUp(deep.needs.get(ids.a)).toString(), '96');
  const tooDeep = resolveOrder(context([leafLink]), [
    { product_id: 'c0', quantity: 1, selections: [] },
  ]);
  assert.deepEqual(
    tooDeep.problems.map((x) => x.code),
    ['COMBO_TOO_DEEP'],
  );
  // A combo with its own link uses it and not its components.
  const own = resolveOrder(
    context([leafLink, link('c5', [{ ingredient_id: ids.b, quantity: '1' }])]),
    [{ product_id: 'c5', quantity: 4, selections: [] }],
  );
  assert.deepEqual([...own.needs.keys()], [ids.b]);
  assert.equal(roundHalfUp(own.needs.get(ids.b)).toString(), '4');
  // Draft link, missing link, unknown item, unknown stock item, effect none.
  const problems = resolveOrder(
    context([
      link('c6', [{ ingredient_id: ids.a, quantity: '1' }], 'draft'),
      link('leaf', [{ ingredient_id: randomUUID(), quantity: '1' }]),
    ]),
    [
      { product_id: 'c6', quantity: 1, selections: [] },
      { product_id: 'nope', quantity: 1, selections: [] },
    ],
  );
  assert.deepEqual(
    problems.problems.map((x) => [x.code, x.catalog_key]),
    [
      ['LINK_NOT_APPROVED', 'c6'],
      ['ITEM_UNKNOWN', 'nope'],
    ],
  );
  const none = resolveOrder(context([link('leaf', [])]), [
    { product_id: 'c6', quantity: 1, selections: [] },
  ]);
  assert.deepEqual(none.problems, []);
  assert.equal(none.needs.size, 0);
  const missing = resolveOrder(context([]), [{ product_id: 'leaf', quantity: 1, selections: [] }]);
  assert.deepEqual(missing.problems, [
    { code: 'NO_LINK', catalog_key: 'leaf', name: 'Товар leaf', ingredient_id: null },
  ]);
});

test('recipes: explode, stock policy, no policy blocks, nesting, cycles, ambiguity, depth', () => {
  const catalog = catalogIndex(BRANCH, 1, { products: [p('dish')] });
  // Every recipe here is explicitly exploded unless the case says otherwise.
  const recipe = (output, yieldQuantity, lines, extra = { stock_policy: 'explode' }) => ({
    id: randomUUID(),
    revision: 2,
    payload: {
      name: 'ТТК',
      product_id: 'ttk:1',
      output_ingredient_id: output,
      yield_quantity: yieldQuantity,
      lines: lines.map(([ingredient_id, quantity]) => ({ ingredient_id, quantity })),
      ...extra,
    },
  });
  const run = (records, quantity = 1) =>
    resolveOrder(
      {
        catalog,
        links: new Map([link('dish', [{ recipe_output_id: ids.out, quantity: '2' }])]),
        recipes: recipesByOutput(records),
        ingredients: new Set(Object.values(ids)),
      },
      [{ product_id: 'dish', quantity, selections: [] }],
    );
  // out (yield 3) = 1 mid + 50 a; mid (yield 2) = 10 b. dish = 2 out.
  const nested = run([
    recipe(ids.out, '3', [
      [ids.mid, '1'],
      [ids.a, '50'],
    ]),
    recipe(ids.mid, '2', [[ids.b, '10']]),
  ]);
  assert.deepEqual(nested.problems, []);
  // a: 2 x 50 / 3 = 100/3 -> 33; b: 2 x 1/3 x 10/2 = 10/3 -> 3.
  assert.deepEqual(Object.fromEntries([...nested.needs].map(([k, v]) => [k, `${v.n}/${v.d}`])), {
    [ids.b]: '10/3',
    [ids.a]: '100/3',
  });
  assert.equal(Object.keys(nested.recipes).length, 2);
  // The nested output kept as stock: mid itself is written off.
  const stock = run([
    recipe(ids.out, '3', [
      [ids.mid, '1'],
      [ids.a, '50'],
    ]),
    recipe(ids.mid, '2', [[ids.b, '10']], { stock_policy: 'stock' }),
  ]);
  assert.deepEqual([...stock.needs.keys()].sort(), [ids.a, ids.mid].sort());
  assert.equal(roundHalfUp(stock.needs.get(ids.mid)).toString(), '1');
  // Review BOUI-R1: a recipe without a policy is never exploded silently, at any level. The
  // order is blocked with the recipe named, and nothing of it is written off.
  const unset = run([recipe(ids.out, '3', [[ids.a, '50']], {})]);
  assert.deepEqual(unset.problems, [
    { code: 'RECIPE_POLICY_UNSET', catalog_key: null, name: 'ТТК', ingredient_id: ids.out },
  ]);
  assert.equal(unset.needs.size, 0);
  const nestedUnset = run([
    recipe(ids.out, '3', [
      [ids.mid, '1'],
      [ids.a, '50'],
    ]),
    recipe(ids.mid, '2', [[ids.b, '10']], {}),
  ]);
  assert.deepEqual(
    nestedUnset.problems.map((x) => [x.code, x.ingredient_id]),
    [['RECIPE_POLICY_UNSET', ids.mid]],
  );
  assert.equal(nestedUnset.needs.has(ids.b), false);
  // A cycle, two recipes for one output, no recipe at all.
  assert.deepEqual(
    run([
      recipe(ids.out, '1', [[ids.mid, '1']]),
      recipe(ids.mid, '1', [[ids.out, '1']]),
    ]).problems.map((x) => x.code),
    ['RECIPE_CYCLE'],
  );
  assert.deepEqual(
    run([recipe(ids.out, '1', [[ids.a, '1']]), recipe(ids.out, '1', [[ids.b, '1']])]).problems.map(
      (x) => x.code,
    ),
    ['RECIPE_AMBIGUOUS'],
  );
  assert.deepEqual(
    run([]).problems.map((x) => x.code),
    ['RECIPE_NOT_FOUND'],
  );
  // Seven nested outputs: deeper than 6 levels.
  const chain = Array.from({ length: 8 }, () => randomUUID());
  const records = chain.slice(0, 7).map((id, i) => recipe(id, '1', [[chain[i + 1], '1']]));
  const deep = resolveOrder(
    {
      catalog,
      links: new Map([link('dish', [{ recipe_output_id: chain[0], quantity: '1' }])]),
      recipes: recipesByOutput(records),
      ingredients: new Set(chain),
    },
    [{ product_id: 'dish', quantity: 1, selections: [] }],
  );
  assert.deepEqual(
    deep.problems.map((x) => x.code),
    ['RECIPE_TOO_DEEP'],
  );
});

test('options: own link, then the linked product, then the same-slug product', () => {
  const catalog = catalogIndex(BRANCH, 1, {
    products: [
      p('combo', {
        kind: 'combo',
        combo_components: [{ product_id: 'fries', quantity: 1 }],
        modifier_groups: [
          {
            id: 'drink',
            title: t('Напиток'),
            options: [
              { id: 'cola', label: t('Кола') },
              { id: 'big', label: t('Большая кола'), linked_product_id: 'cola' },
              { id: 'water', label: t('Вода') },
            ],
          },
        ],
      }),
      p('fries'),
      p('cola'),
    ],
  });
  const links = new Map([
    link('fries', [{ ingredient_id: ids.a, quantity: '150' }]),
    link('cola', [{ ingredient_id: ids.b, quantity: '1' }]),
  ]);
  const resolve = (option, extra = []) =>
    resolveOrder(
      {
        catalog,
        links: new Map([...links, ...extra]),
        recipes: new Map(),
        ingredients: new Set(Object.values(ids)),
      },
      [
        {
          product_id: 'combo',
          quantity: 2,
          selections: [{ group_id: 'drink', option_id: option, quantity: 1 }],
        },
      ],
    );
  assert.equal(roundHalfUp(resolve('cola').needs.get(ids.b)).toString(), '2');
  assert.equal(roundHalfUp(resolve('big').needs.get(ids.b)).toString(), '2');
  assert.deepEqual(
    resolve('water').problems.map((x) => [x.code, x.catalog_key]),
    [['NO_LINK', 'combo:drink:water']],
  );
  const own = resolve('big', [link('combo:drink:big', [{ ingredient_id: ids.b, quantity: '2' }])]);
  assert.equal(roundHalfUp(own.needs.get(ids.b)).toString(), '4');
  const items = menuLinkItems(catalog, links);
  assert.deepEqual(
    items.map((i) => [
      i.catalog_key,
      i.kind,
      i.linked_product_id,
      i.from_combo,
      i.covered_without_link,
    ]),
    [
      ['combo', 'combo', null, true, true],
      ['combo:drink:cola', 'option', 'cola', false, true],
      ['combo:drink:big', 'option', 'cola', false, true],
      ['combo:drink:water', 'option', null, false, false],
      ['fries', 'product', null, false, false],
      ['cola', 'product', null, false, false],
    ],
  );
});

test('command schemas: strict, effect none without lines, start_at for dry_run and on', () => {
  const save = {
    type: 'menu_link_save',
    catalog_ref: { product_id: 'fries' },
    effect: 'consume',
    lines: [{ ingredient_id: randomUUID(), quantity: '150' }],
    expected_revision: 0,
  };
  assert.equal(MenuLinkSaveCommand.safeParse(save).success, true);
  for (const bad of [
    { ...save, effect: 'none' },
    { ...save, lines: [] },
    { ...save, catalog_ref: { product_id: 'fries', group_id: 'x' } },
    { ...save, catalog_ref: { product_id: 'Fries' } },
    {
      ...save,
      lines: [{ ingredient_id: randomUUID(), recipe_output_id: randomUUID(), quantity: '1' }],
    },
    {
      ...save,
      lines: Array.from({ length: 51 }, () => ({ ingredient_id: randomUUID(), quantity: '1' })),
    },
    { ...save, extra: 1 },
  ])
    assert.equal(MenuLinkSaveCommand.safeParse(bad).success, false, JSON.stringify(bad));
  assert.equal(MenuLinkSaveCommand.safeParse({ ...save, effect: 'none', lines: [] }).success, true);
  const approve = {
    type: 'menu_links_approve',
    keys: ['fries', 'combo:drink:cola'],
    expected_revisions: { fries: 1, 'combo:drink:cola': 3 },
  };
  assert.equal(MenuLinksApproveCommand.safeParse(approve).success, true);
  assert.equal(
    MenuLinksApproveCommand.safeParse({ ...approve, expected_revisions: { fries: 1 } }).success,
    false,
  );
  assert.equal(
    MenuLinksApproveCommand.safeParse({ ...approve, keys: ['fries', 'fries'] }).success,
    false,
  );
  const settings = {
    type: 'stock_settings',
    autoconsume_mode: 'on',
    start_at: '2026-11-18T19:00:00.000Z',
    expected_revision: 0,
  };
  assert.equal(StockSettingsCommand.safeParse(settings).success, true);
  assert.equal(StockSettingsCommand.safeParse({ ...settings, start_at: null }).success, false);
  assert.equal(
    StockSettingsCommand.safeParse({ ...settings, autoconsume_mode: 'dry_run', start_at: null })
      .success,
    false,
  );
  assert.equal(
    StockSettingsCommand.safeParse({ ...settings, autoconsume_mode: 'off', start_at: null })
      .success,
    true,
  );
  assert.equal(
    StockSettingsCommand.safeParse({ ...settings, start_at: '2026-11-19T00:00:00+05:00' }).success,
    false,
  );
  for (const type of ['consumption_retry', 'consumption_skip'])
    assert.equal(
      P1Command.safeParse({ type, source: 'pos', order_id: randomUUID(), expected_revision: 1 })
        .success,
      true,
    );
  assert.equal(
    P1Command.safeParse({
      type: 'consumption_retry',
      source: 'edge',
      order_id: randomUUID(),
      expected_revision: 1,
    }).success,
    false,
  );
});
