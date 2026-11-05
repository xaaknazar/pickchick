/* global structuredClone */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { MenuSnapshotSchema } from '../../packages/contracts/dist/index.js';
import {
  CatalogPayloadSchema,
  CatalogStateSchema,
  assertCatalogPublishable,
  stripStorefrontPayload,
} from '../../packages/catalog-admin/dist/contracts.js';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';
import { withPikoFlavors } from '../../packages/catalog-admin/dist/piko-flavors.js';
import { deriveRouting, projectCatalogMenu } from '../../packages/menu-sync/dist/index.js';
import { priceCatalogSnapshot } from '../../packages/catalog-pricing/dist/index.js';
import { parityRun } from '../../scripts/catalog-edge-parity.mjs';
import {
  CATEGORIES,
  LEGACY_SLUGS,
  PAYLOAD_BUDGET_BYTES,
  SHEETS,
  apiBase,
  assertParityReport,
  buildMenu,
  catalogApi,
  loadManifest,
  parseArguments,
  parseTsv,
  payloadHash,
  readCredential,
  requestIdFor,
  runBuild,
  runPublish,
  runSave,
  tengeToMinor,
} from '../../scripts/catalog-menu-import.mjs';

const FIXTURE = fileURLToPath(
  new URL('../../packages/catalog-admin/fixtures/real-menu-2026-11/', import.meta.url),
);
const SCRIPT = fileURLToPath(new URL('../../scripts/catalog-menu-import.mjs', import.meta.url));
const branch = '10000000-0000-4000-8000-000000000003';
const actor = '10000000-0000-4000-8000-000000000009';
const device = '10000000-0000-4000-8000-000000000010';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const codes = (errors) => [...new Set(errors.map((error) => error.code))].sort();
const sheets = () =>
  Object.fromEntries(
    Object.entries(SHEETS).map(([key, spec]) => [
      key,
      parseTsv(readFileSync(join(FIXTURE, spec.file)), key),
    ]),
  );
const built = buildMenu(sheets());
const payload = built.payload;
const reviewed = { ...payload, content_reviewed: true };

/** The published v11 menu as the cashier and the back office hold it (synthetic copy). */
const v11 = withPikoFlavors({
  ...mockupCatalogDraft,
  content_source: 'operator',
  content_reviewed: true,
});
const v11State = {
  branch: { id: branch, code: 'SYN', name: 'Synthetic' },
  draft: null,
  published: {
    version: 11,
    published_at: '2026-10-14T00:00:00.000Z',
    published_by: actor,
    payload: v11,
  },
};
const edgeMenu = projectCatalogMenu(
  v11,
  branch,
  8,
  '2026-10-14T00:00:00.000Z',
  '20000000-0000-4000-8000-000000000008',
);

/** Source tables of the AILILLU cards (docs/operations/iiko-menu-details-2026-09-28.md). */
function iikoTables() {
  const doc = readFileSync(
    new URL('../../docs/operations/iiko-menu-details-2026-09-28.md', import.meta.url),
    'utf8',
  );
  const part = (from, to) => doc.slice(doc.indexOf(from), doc.indexOf(to));
  const positions = new Map(),
    modifiers = new Map(),
    rules = new Map();
  for (const line of part('## Все 54 позиции', '## Правила всех 13 комбо').split('\n')) {
    const m = /^\|\s*(\d{5})\s*\|\s*(.+?)\s*\|\s*(\d+)\s*\|\s*([\d.]+)\s*\|$/.exec(line);
    if (m) positions.set(m[1], { name: m[2], tenge: BigInt(m[3]) });
  }
  for (const line of part('## Правила всех 13 комбо', '## Что требует проверки').split('\n')) {
    let m = /^\|\s*(.+?)\s+(\d{5})\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*max (\d)\s*\|$/.exec(line);
    if (m) rules.set(m[2], { drink: m[3], dip: m[4], paidMax: Number(m[5]) });
    m = /^\|\s*(\d{5})\s*\|\s*(-.+?)\s*\|\s*(\d+)\s*\|$/.exec(line);
    if (m) modifiers.set(m[1], { name: m[2], tenge: BigInt(m[3]) });
    m = /^\|\s*.+?\/\s*(\d{4})\s*\|\s*(\d{5})\s*\|\s*(-.+?)\s*\|\s*(\d+)\s*\|$/.exec(line);
    if (m) modifiers.set(m[2], { name: m[3], tenge: BigInt(m[4]) });
  }
  return { positions, modifiers, rules };
}
/** design-catalog.md 3.3: iiko article -> catalog slug (owner default, contracts 9 q.13). */
const DESIGN_SLUGS = {
  '00144': 'pick-combo',
  '00145': 'master-combo',
  '00147': 'solo-combo',
  '00146': 'burger-combo',
  '00399': 'pick-meal-combo',
  '00437': 'chick-burger-combo',
  '00438': 'chick-meal-combo',
  '00232': 'finger-duo',
  '00441': 'burger-duo',
  '00242': 'mix-duo',
  '00241': 'chick-burger-duo',
  '00440': 'mix-chick-duo',
  '00442': 'mix-burger-duo',
  '00162': 'fingers-25',
  '00163': 'fingers-50',
  '00164': 'fingers-75',
  '00165': 'fingers-100',
  '00150': 'fingers',
  '00194': 'burger',
  '00434': 'chick-burger',
  '00148': 'toast',
  '00149': 'coleslaw',
  '00151': 'wedges',
  '00152': 'sauce',
  '00234': 'sauce-300',
  '00238': 'sauce-400',
  '00239': 'sauce-500',
  '00309': 'sauce-hot',
  '00310': 'sauce-hot-300',
  '00311': 'sauce-hot-400',
  '00312': 'sauce-hot-500',
  '00313': 'sauce-cheese',
  '00314': 'sauce-cheese-300',
  '00315': 'sauce-cheese-400',
  '00316': 'sauce-cheese-500',
  '00159': 'cola-bottle',
  '00209': 'cola',
  '00231': 'cola-zero',
  '00414': 'cola-zero-can',
  '00161': 'sprite',
  '00210': 'sprite-can',
  '00160': 'fanta',
  '00211': 'fanta-can',
  '00413': 'fuse-peach',
  '00196': 'fuse-berry',
  '00412': 'fuse-mango',
  '00411': 'fuse-mango-pineapple',
  '00408': 'fuse-watermelon',
  '00410': 'fuse-lemon',
  '00409': 'fuse-strawberry-melon',
  '00158': 'lemonade',
  '00197': 'water',
  '00195': 'piko',
  '00198': 'iced-tea',
};

test('every hall price, name and mapping of the 54 AILILLU cards reaches the payload exactly', () => {
  assert.deepEqual(built.errors, []);
  const iiko = iikoTables();
  assert.equal(iiko.positions.size, 54);
  assert.equal(Object.keys(DESIGN_SLUGS).length, 54);
  assert.equal(payload.products.length, 54);
  const rows = new Map(sheets().positions.map((row) => [row.iiko_sku, row]));
  for (const [sku, card] of iiko.positions) {
    const slug = DESIGN_SLUGS[sku];
    const row = rows.get(sku);
    assert.equal(row?.slug, slug, sku);
    assert.equal(row.iiko_name, card.name, sku);
    const product = payload.products.find((p) => p.id === slug);
    assert.equal(product.price_minor, (card.tenge * 100n).toString(), `${sku} ${slug}`);
    assert.equal(product.name.ru, card.name, sku);
    assert.equal(product.sku, slug, 'cart identities stay the slug');
  }
  for (const slug of LEGACY_SLUGS)
    assert.ok(
      payload.products.some((p) => p.id === slug),
      slug,
    );
  assert.deepEqual([...LEGACY_SLUGS].sort(), mockupCatalogDraft.products.map((p) => p.id).sort());
});

test('every modifier surcharge and combo rule follows the iiko cards; defaults are cola and the house dip', () => {
  const iiko = iikoTables();
  assert.equal(iiko.modifiers.size, 33);
  assert.equal(iiko.rules.size, 13);
  const groupRows = sheets().groups;
  for (const [sku, modifier] of iiko.modifiers) {
    const rows = groupRows.filter((row) => row.iiko_sku === sku);
    assert.ok(rows.length >= 1, sku);
    for (const row of rows) {
      assert.equal(row.iiko_name, modifier.name, sku);
      assert.equal(
        tengeToMinor(row.delta_tenge, { allowZero: true }),
        (modifier.tenge * 100n).toString(),
      );
    }
  }
  const options = (product, group) => product.modifier_groups.find((g) => g.id === group).options;
  for (const [sku, rule] of iiko.rules) {
    const product = payload.products.find((p) => p.id === DESIGN_SLUGS[sku]);
    assert.equal(product.kind, 'combo');
    assert.match(product.id, /-(combo|duo)$/);
    assert.deepEqual(
      product.modifier_groups.map((g) => g.id),
      ['drink', 'sauce', 'sauce-paid-signature', 'sauce-paid-cheese', 'sauce-paid-hot'],
    );
    const people = /min 2, max 2/.test(rule.drink) ? 2 : 1;
    const [drink, dip, ...paid] = product.modifier_groups;
    assert.equal(rule.drink, `min ${people}, max ${people}`);
    assert.deepEqual([drink.min, drink.max], [people, people], sku);
    assert.deepEqual([dip.min, dip.max], [rule.dip.startsWith('min') ? people : 0, people], sku);
    for (const group of paid) assert.deepEqual([group.min, group.max], [0, rule.paidMax], sku);
    assert.equal(drink.options.length, 20);
    assert.equal(dip.options.length, 5);
    assert.deepEqual(
      drink.options.filter((o) => o.default_quantity).map((o) => [o.id, o.default_quantity]),
      [['cola-bottle', people]],
    );
    assert.deepEqual(
      dip.options.filter((o) => o.default_quantity).map((o) => [o.id, o.default_quantity]),
      [['sauce', people]],
    );
    assert.deepEqual(
      options(product, 'sauce-paid-signature').map((o) => o.price_delta_minor),
      ['79000', '109000', '139000'],
    );
  }
  const chick = payload.products.find((p) => p.id === 'chick-meal-combo');
  assert.equal(chick.modifier_groups[2].max, 5);
  assert.deepEqual(
    payload.products.find((p) => p.id === 'piko').modifier_groups.map((g) => [g.id, g.min, g.max]),
    [['piko-flavor', 1, 1]],
  );
  // Nothing else has choices (iiko: «Модификаторы отсутствуют» on the other 41 cards).
  assert.equal(payload.products.filter((p) => p.modifier_groups.length).length, 14);
  for (const product of payload.products) {
    assert.deepEqual(product.combo_components, []);
    for (const group of product.modifier_groups)
      for (const option of group.options) assert.equal(option.linked_product_id, null);
  }
});

test('categories, kinds and claims are the ones installed clients understand', () => {
  assert.deepEqual(
    payload.categories.map((c) => c.name.ru),
    ['Комбо', 'На двоих', 'На компанию', 'Допы', 'Соусы', 'Напитки'],
  );
  assert.deepEqual(
    CATEGORIES.map((c) => c.ru),
    payload.categories.map((c) => c.name.ru),
  );
  const v11Ids = new Map(mockupCatalogDraft.categories.map((c) => [c.name.ru, c.id]));
  for (const category of payload.categories)
    if (v11Ids.has(category.name.ru)) assert.equal(category.id, v11Ids.get(category.name.ru));
  const byCategory = (name) =>
    payload.products
      .filter((p) => p.category_id === payload.categories.find((c) => c.name.ru === name).id)
      .map((p) => p.id);
  assert.equal(byCategory('Комбо').length, 7);
  assert.equal(byCategory('На двоих').length, 6);
  assert.deepEqual(byCategory('На компанию'), [
    'fingers-25',
    'fingers-50',
    'fingers-75',
    'fingers-100',
  ]);
  assert.deepEqual(byCategory('Допы').sort(), [
    'burger',
    'chick-burger',
    'coleslaw',
    'fingers',
    'toast',
    'wedges',
  ]);
  assert.equal(byCategory('Соусы').length, 12);
  assert.equal(byCategory('Напитки').length, 19);
  for (const product of payload.products) {
    if (byCategory('Комбо').includes(product.id) || byCategory('На двоих').includes(product.id))
      assert.equal(product.kind, 'combo');
    else if (byCategory('На компанию').includes(product.id)) assert.equal(product.kind, 'set');
    else assert.equal(product.kind, 'item');
    assert.deepEqual(product.nutrition, {
      basis: 'per_serving',
      energy_kcal: 0,
      protein_g: 0,
      fat_g: 0,
      carbs_g: 0,
    });
    assert.equal(product.nutrition_status, 'unverified');
    assert.deepEqual([product.allergens, product.allergens_status], [[], 'unknown']);
    assert.equal(product.available, true);
    assert.equal('kitchen_route' in product || 'image' in product, false);
  }
  assert.equal(payload.content_source, 'operator');
  assert.equal(payload.content_reviewed, false);
  assert.deepEqual(payload.upsell_product_ids, mockupCatalogDraft.upsell_product_ids);
  assert.deepEqual(payload.estimated_minutes, mockupCatalogDraft.estimated_minutes);
});

/**
 * Strict schema bundled in the installed kiosk build 7 and mobile TestFlight builds (catalog-admin
 * contracts of c3a0fbee without the later image and kitchen_route fields), frozen as a copy so a
 * future contract change cannot move it.
 */
function frozenStorefrontSchemas() {
  const { z } = createRequire(
    new URL('../../packages/catalog-admin/package.json', import.meta.url),
  )('zod');
  const keys = [
    'i0.jpg',
    'i1.jpg',
    'i2.jpg',
    'i4.jpg',
    'i5.jpg',
    'i6.jpg',
    'i7.jpg',
    'i8.jpg',
    'i9.jpg',
    'i10.jpg',
    'i11.jpg',
    'i12.jpg',
    'i13.jpg',
    'i14.jpg',
    'i15.jpg',
    'i16.jpg',
    'i17.jpg',
    'i18.jpg',
    'i19.jpg',
    'i20.jpg',
    'i22.jpg',
    'i23.jpg',
    'shot.jpg',
    'generic-drink',
  ];
  const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
  const Minor = z.string().regex(/^(0|[1-9][0-9]{0,15})$/);
  const Text = z.strictObject({ ru: z.string().max(2000), kk: z.string().max(2000) });
  const Title = z.strictObject({
    ru: z.string().trim().min(1).max(150),
    kk: z.string().trim().max(150),
  });
  const Modifier = z.strictObject({
    id: Id,
    title: Title,
    min: z.int().min(0).max(100),
    max: z.int().min(1).max(100),
    options: z
      .array(
        z.strictObject({
          id: Id,
          label: Title,
          price_delta_minor: Minor,
          default_quantity: z.int().min(0).max(40),
          max_quantity: z.int().min(1).max(40),
          available: z.boolean(),
          nutrition_multiplier: z.number().positive().max(100).optional(),
          linked_product_id: Id.nullable(),
        }),
      )
      .min(1)
      .max(20),
  });
  const Product = z.strictObject({
    id: Id,
    sku: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    name: Title,
    description: Text,
    category_id: Id,
    price_minor: Minor,
    channel_prices_minor: z
      .strictObject({ mobile: Minor.optional(), pos: Minor.optional(), kiosk: Minor.optional() })
      .optional(),
    image_asset_key: z.string().refine((v) => keys.includes(v)),
    available: z.boolean(),
    prep_required: z.boolean(),
    prep_minutes: z.int().min(1).max(120),
    serving_label: Title,
    weight_g: z.int().min(1).max(100000).nullable(),
    volume_ml: z.int().min(1).max(100000).nullable(),
    ingredients: Text,
    allergens: z.array(z.string().trim().min(1).max(100)).max(30),
    allergens_status: z.enum(['unknown', 'declared']),
    nutrition: z.strictObject({
      basis: z.enum(['per_serving', 'per_100_g']),
      energy_kcal: z.number().min(0).max(100000),
      protein_g: z.number().min(0).max(10000),
      fat_g: z.number().min(0).max(10000),
      carbs_g: z.number().min(0).max(10000),
    }),
    nutrition_status: z.enum(['unverified', 'operator_entered']),
    kind: z.enum(['item', 'combo', 'set']),
    combo_components: z
      .array(z.strictObject({ product_id: Id, quantity: z.int().min(1).max(1000) }))
      .max(40),
    modifier_groups: z.array(Modifier).max(10),
  });
  const Payload = z
    .strictObject({
      schema_version: z.literal(1),
      currency: z.literal('KZT'),
      content_source: z.enum(['mockup', 'operator']),
      content_reviewed: z.boolean(),
      categories: z
        .array(z.strictObject({ id: Id, name: Title }))
        .min(1)
        .max(30),
      products: z.array(Product).min(1).max(100),
      estimated_minutes: z.strictObject({
        min: z.int().min(1).max(120),
        max: z.int().min(1).max(120),
      }),
      upsell_product_ids: z.array(Id).max(20),
    })
    .superRefine((value, ctx) => {
      const issue = (message) => ctx.addIssue({ code: 'custom', message });
      const unique = (values) => new Set(values).size === values.length;
      if (Buffer.byteLength(JSON.stringify(value)) > 262144) issue('too large');
      if (
        !unique(value.categories.map((v) => v.id)) ||
        !unique(value.products.map((v) => v.id)) ||
        !unique(value.products.map((v) => v.sku))
      )
        issue('duplicate');
      const ids = new Set(value.products.map((v) => v.id)),
        categories = new Set(value.categories.map((v) => v.id));
      if (!unique(value.upsell_product_ids) || value.upsell_product_ids.some((id) => !ids.has(id)))
        issue('upsell');
      if (value.estimated_minutes.min > value.estimated_minutes.max) issue('eta');
      for (const product of value.products) {
        if (!categories.has(product.category_id)) issue('category');
        if (
          !unique(product.allergens) ||
          !unique(product.modifier_groups.map((v) => v.id)) ||
          !unique(product.combo_components.map((v) => v.product_id))
        )
          issue('dependency');
        if (product.kind === 'item' && product.combo_components.length) issue('item components');
        const links = product.combo_components.map((v) => v.product_id);
        for (const group of product.modifier_groups) {
          if (group.min > group.max || !unique(group.options.map((v) => v.id))) issue('group');
          let defaults = 0,
            capacity = 0;
          for (const option of group.options) {
            if (
              option.default_quantity > option.max_quantity ||
              (!option.available && option.default_quantity > 0)
            )
              issue('default');
            defaults += option.default_quantity;
            if (option.available) capacity += option.max_quantity;
            if (option.linked_product_id) links.push(option.linked_product_id);
          }
          if (defaults < group.min || defaults > group.max || capacity < group.min)
            issue('unsatisfiable');
        }
        if (links.some((id) => !ids.has(id))) issue('links');
      }
    });
  const Mobile = z.strictObject({
    branch: z.strictObject({
      id: z.uuid(),
      code: z.string(),
      name: z.string(),
      timezone: z.literal('Asia/Almaty'),
      ordering_enabled: z.boolean(),
    }),
    channel: z.literal('mobile'),
    version: z.int().positive(),
    published_at: z.iso.datetime(),
    payload: Payload,
  });
  return { Payload, Mobile, Kiosk: Mobile.extend({ channel: z.literal('kiosk') }) };
}
/** MenuSnapshot keys the installed edge (c3a0fbee contracts) parses strictly. */
const EDGE_KEYS = {
  item: [
    'product_id',
    'variant_id',
    'category_id',
    'name',
    'price_minor',
    'currency',
    'image_url',
    'modifier_groups',
    'source_id',
    'sku',
    'kind',
    'sort_order',
    'description',
    'image',
    'kitchen',
  ],
  group: ['id', 'name', 'min_selected', 'max_selected', 'options'],
  option: ['id', 'name', 'price_minor', 'max_quantity', 'default_quantity', 'available'],
  kitchen: ['route', 'unexpanded_combo'],
};

test("the built payload passes today's publication checks, the budget and the frozen client schemas", () => {
  assert.equal(CatalogPayloadSchema.safeParse(payload).success, true);
  assert.equal(CatalogPayloadSchema.safeParse(reviewed).success, true);
  assert.doesNotThrow(() => assertCatalogPublishable(reviewed));
  assert.doesNotThrow(() => assertCatalogPublishable(reviewed, true));
  assert.ok(built.bytes <= PAYLOAD_BUDGET_BYTES, `${built.bytes} bytes`);
  assert.equal(PAYLOAD_BUDGET_BYTES, 235520);
  assert.equal(Buffer.byteLength(JSON.stringify(payload)), built.bytes);
  assert.ok(
    Buffer.byteLength(JSON.stringify(reviewed)) <= built.bytes,
    'true is shorter than false',
  );
  const frozen = frozenStorefrontSchemas();
  const storefront = stripStorefrontPayload(CatalogPayloadSchema.parse(reviewed));
  assert.equal(frozen.Payload.safeParse(storefront).success, true);
  const envelope = {
    branch: {
      id: branch,
      code: 'SYN',
      name: 'Synthetic',
      timezone: 'Asia/Almaty',
      ordering_enabled: true,
    },
    channel: 'mobile',
    version: 12,
    published_at: '2026-11-09T18:00:00.000Z',
    payload: storefront,
  };
  assert.equal(frozen.Mobile.safeParse(envelope).success, true);
  assert.equal(frozen.Kiosk.safeParse({ ...envelope, channel: 'kiosk' }).success, true);
  // The frozen copy is strict: a field it does not know is refused (it is not a no-op check).
  const extended = structuredClone(storefront);
  extended.products[0].kitchen_route = 'prep';
  assert.equal(frozen.Payload.safeParse(extended).success, false);
  // Installed edge: the projection without stage-2 features has only keys it parses.
  const menu = projectCatalogMenu(reviewed, branch, 9, '2026-11-09T18:00:00.000Z');
  assert.equal(MenuSnapshotSchema.safeParse(menu).success, true);
  assert.equal(menu.items.length, 54);
  for (const item of menu.items) {
    for (const key of Object.keys(item)) assert.ok(EDGE_KEYS.item.includes(key), key);
    for (const key of Object.keys(item.kitchen)) assert.ok(EDGE_KEYS.kitchen.includes(key), key);
    for (const group of item.modifier_groups) {
      for (const key of Object.keys(group)) assert.ok(EDGE_KEYS.group.includes(key), key);
      for (const option of group.options)
        for (const key of Object.keys(option)) assert.ok(EDGE_KEYS.option.includes(key), key);
    }
  }
  // Two installed stations (prep + assembly): every new item gets a route, nothing unresolved.
  const prep = '30000000-0000-4000-8000-000000000001',
    assembly = '30000000-0000-4000-8000-000000000002';
  const installed = projectCatalogMenu(v11, branch, 8, '2026-10-14T00:00:00.000Z');
  const routing = {
    version: 4,
    assemblyStationId: assembly,
    routes: installed.items.map((item) => ({
      productId: item.product_id,
      stationId: item.kitchen.route === 'prep' ? prep : assembly,
      kind: item.kitchen.route,
    })),
  };
  const derived = deriveRouting(menu, routing, [
    { id: prep, kind: 'prep' },
    { id: assembly, kind: 'assembly' },
  ]);
  assert.ok(derived.routes.length >= 54);
  // Stage-2 combo stops (when enabled later): a drink or dip option named after a product follows its stop.
  const stops = projectCatalogMenu(reviewed, branch, 9, '2026-11-09T18:00:00.000Z', undefined, {
    comboStops: true,
  });
  const pick = stops.items.find((item) => item.source_id === 'pick-combo');
  const unlinked = pick.modifier_groups
    .flatMap((group) => group.options)
    .filter((option) => !option.linked_variant_id).length;
  assert.equal(
    unlinked,
    2 + 2 + 9,
    'piko flavors, ketchup/bbq and the paid sauces have no product',
  );
});

test('control baskets of the iiko cards price exactly and invalid choices are refused', () => {
  const reference = {
    organizationId: '10000000-0000-4000-8000-000000000001',
    branchId: branch,
    version: 12,
    payloadHash: payloadHash(reviewed),
    publishedAt: '2026-11-09T18:00:00.000Z',
  };
  const price = (items) =>
    priceCatalogSnapshot(
      { reference, orderingEnabled: true, payload: reviewed },
      {
        organizationId: reference.organizationId,
        branchId: branch,
        customerId: null,
        channel: 'kiosk',
      },
      { catalog_version: 12, service_mode: 'takeaway', items },
    ).totalMinor;
  const item = (sku, quantity = 1, selections = []) => ({ sku, quantity, selections });
  const pick = (group, option, quantity = 1) => ({ group_id: group, option_id: option, quantity });
  assert.equal(price([item('burger'), item('water')]), '248000');
  assert.equal(price([item('burger', 2), item('wedges')]), '477000');
  assert.equal(
    price([item('pick-meal-combo', 1, [pick('drink', 'cola-bottle'), pick('sauce', 'sauce')])]),
    '399000',
  );
  assert.equal(
    price([item('pick-meal-combo', 1, [pick('drink', 'cola'), pick('sauce', 'sauce')])]),
    '409000',
  );
  assert.equal(
    price([
      item('pick-meal-combo', 1, [
        pick('drink', 'lemonade'),
        pick('sauce', 'sauce'),
        pick('sauce-paid-signature', 'sauce-plus-790'),
      ]),
    ]),
    '498000',
  );
  assert.equal(
    price([
      item('burger-duo', 1, [
        pick('drink', 'cola-bottle'),
        pick('drink', 'lemonade'),
        pick('sauce', 'sauce', 2),
      ]),
    ]),
    '619000',
  );
  const refused = (items) =>
    assert.throws(
      () => price(items),
      (error) => error.code === 'INVALID_SELECTION',
    );
  refused([item('pick-meal-combo', 1, [pick('sauce', 'sauce')])]);
  refused([item('pick-meal-combo', 1, [pick('drink', 'cola-bottle')])]);
  refused([item('burger-duo', 1, [pick('drink', 'cola-bottle')])]);
  refused([item('burger-duo', 1, [pick('drink', 'cola-bottle', 2), pick('drink', 'fanta')])]);
  refused([
    item('pick-meal-combo', 1, [
      pick('drink', 'water'),
      pick('sauce', 'sauce'),
      pick('sauce-paid-hot', 'sauce-hot-plus-790', 4),
    ]),
  ]);
  refused([
    item('chick-meal-combo', 1, [
      pick('drink', 'water'),
      pick('sauce-paid-hot', 'sauce-hot-plus-790', 6),
    ]),
  ]);
  assert.equal(
    price([
      item('chick-meal-combo', 1, [
        pick('drink', 'water'),
        pick('sauce-paid-hot', 'sauce-hot-plus-790', 5),
      ]),
    ]),
    String(429000 + 5 * 79000),
  );
  // The free dip is optional where the card shows only a maximum.
  assert.equal(price([item('pick-combo', 1, [pick('drink', 'cola-bottle')])]), '369000');
});

test('tenge to tiyn: whole tenge only, no floats, no tiyn typed by mistake', () => {
  for (const [input, minor] of [
    ['3690', '369000'],
    ['3 690', '369000'],
    ['3\u00a0690', '369000'],
    ['44 990', '4499000'],
    ['3690,00', '369000'],
    ['3690.0', '369000'],
    ['1', '100'],
  ])
    assert.equal(tengeToMinor(input), minor, input);
  assert.equal(tengeToMinor('0', { allowZero: true, max: 10_000n }), '0');
  for (const [input, code] of [
    ['3690,5', 'PRICE_NOT_WHOLE_TENGE'],
    ['3690.50', 'PRICE_NOT_WHOLE_TENGE'],
    ['3,690', 'PRICE_NOT_WHOLE_TENGE'],
    ['', 'PRICE_INVALID'],
    ['-1', 'PRICE_INVALID'],
    ['1e3', 'PRICE_INVALID'],
    ['0369', 'PRICE_INVALID'],
    ['0', 'PRICE_INVALID'],
    ['36 90', 'PRICE_INVALID'],
    ['369000', 'PRICE_IMPLAUSIBLE'],
  ])
    assert.throws(
      () => tengeToMinor(input),
      (error) => error.code === code,
      input,
    );
  assert.throws(
    () => tengeToMinor('10001', { allowZero: true, max: 10_000n }),
    (e) => e.code === 'PRICE_IMPLAUSIBLE',
  );
});

test('sheet parsing: exact headers, UTF-8 only, quoted cells, rectangular rows', () => {
  const header = SHEETS.components.columns.join('\t');
  assert.deepEqual(
    parseTsv(
      `\ufeff${header}\r\npick-combo\tfingers\t4\t"с ""кавычками""\tи табом"\r\n\r\n`,
      'components',
    ),
    [
      {
        line: 2,
        product_slug: 'pick-combo',
        component_slug: 'fingers',
        quantity: '4',
        comment: 'с "кавычками"\tи табом',
      },
    ],
  );
  const fails = (input, code) =>
    assert.throws(
      () => parseTsv(input, 'components'),
      (error) => error.code === code,
    );
  fails('product_slug\tcomponent\tquantity\tcomment\n', 'TSV_HEADER');
  fails(`${header}\npick-combo\tfingers\n`, 'TSV_ROW');
  fails(`${header}\npick-combo\tfingers\t"4\tx\n`, 'TSV_ROW');
  fails(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(header, 'utf16le')]), 'TSV_ENCODING');
  fails(Buffer.from([...Buffer.from(header + '\n'), 0xc3, 0x28, 0x0a]), 'TSV_ENCODING');
});

/** Fresh sheets with one change applied (the fixture rows are never mutated). */
function variant(change) {
  const copy = sheets();
  change(copy);
  return buildMenu(copy);
}
const row = (rows, slug) => rows.find((r) => r.slug === slug);

test('sheet errors are reported with their place and block the payload', () => {
  const cases = [
    [(s) => (s.positions = s.positions.filter((r) => r.slug !== 'piko')), 'EXISTING_SLUG_MISSING'],
    [(s) => (row(s.positions, 'pick-meal-combo').slug = 'pick-meal'), 'COMBO_SUFFIX'],
    [(s) => (row(s.positions, 'burger').price_tenge = '1990,5'), 'PRICE_NOT_WHOLE_TENGE'],
    [(s) => (row(s.positions, 'burger').price_tenge = '199000'), 'PRICE_IMPLAUSIBLE'],
    [(s) => (row(s.positions, 'burger').category = 'Бургеры'), 'CATEGORY_UNKNOWN'],
    [(s) => (row(s.positions, 'burger').image_asset_key = 'i3.jpg'), 'IMAGE_KEY_INVALID'],
    [(s) => (row(s.positions, 'burger').weight_g = '247.8'), 'MEASURE_INVALID'],
    [(s) => (row(s.positions, 'burger').status = 'исправить'), 'ROW_MARKED_FIX'],
    [(s) => (row(s.positions, 'toast').slug = 'burger'), 'SLUG_DUPLICATE'],
    [(s) => (row(s.positions, 'toast').iiko_sku = '00194'), 'SKU_DUPLICATE'],
    [
      (s) =>
        (s.rules.find(
          (r) => r.product_slug === 'pick-meal-combo' && r.group_id === 'sauce',
        ).default_qty = '0'),
      'RULE_DEFAULT_BELOW_MIN',
    ],
    [
      (s) => (s.rules.find((r) => r.group_id === 'drink').default_option_id = 'beer'),
      'RULE_DEFAULT_UNKNOWN',
    ],
    [(s) => s.rules.push({ ...s.rules[0] }), 'RULE_DUPLICATE'],
    [(s) => s.groups.push({ ...s.groups[0], option_id: 'extra-drink' }), 'GROUP_TOO_LARGE'],
    [(s) => (s.groups[1].delta_tenge = '0,5'), 'PRICE_NOT_WHOLE_TENGE'],
    [
      (s) =>
        s.components.push({
          line: 2,
          product_slug: 'burger',
          component_slug: 'toast',
          quantity: '1',
          comment: '',
        }),
      'COMPONENT_PRODUCT_INVALID',
    ],
    [
      (s) => (s.catalog.find((r) => r.key === 'upsell_product_ids').value = 'sauce,nachos'),
      'UPSELL_UNKNOWN',
    ],
    [
      (s) => {
        for (let i = 0; i < 47; i++)
          s.positions.push({ ...row(s.positions, 'toast'), slug: `extra-${i}`, iiko_sku: '' });
      },
      'PRODUCT_COUNT',
    ],
    [(s) => s.positions.forEach((r) => (r.description_ru = 'a'.repeat(2000))), 'PAYLOAD_BUDGET'],
  ];
  for (const [change, code] of cases) {
    const result = variant(change);
    assert.ok(codes(result.errors).includes(code), `${code}: ${codes(result.errors)}`);
    assert.equal(result.payload, null, code);
    const error = result.errors.find((e) => e.code === code);
    assert.ok(error.detail, code);
  }
  const located = variant((s) => (row(s.positions, 'burger').price_tenge = '1990,5')).errors[0];
  assert.deepEqual(
    { sheet: located.sheet, field: located.field },
    { sheet: 'positions.tsv', field: 'price_tenge' },
  );
  assert.equal(typeof located.line, 'number');
  // A slug of the published catalog (not only the 24 mockup slugs) must also stay.
  const current = {
    payload: {
      ...v11,
      products: [...v11.products, { ...v11.products[0], id: 'old-special', sku: 'old-special' }],
    },
    branchId: branch,
    version: 11,
  };
  assert.ok(codes(buildMenu(sheets(), { current }).errors).includes('EXISTING_SLUG_MISSING'));
});

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-menu-import-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function writeInputs(dir) {
  const current = join(dir, 'v11-state.json'),
    edge = join(dir, 'edge-menu.json');
  await writeFile(current, JSON.stringify(v11State));
  await writeFile(edge, JSON.stringify(edgeMenu));
  return { current, edge };
}

test('build writes a deterministic manifest with SHA-256 of every input and output', async (t) => {
  const dir = await tempDir(t);
  const inputs = await writeInputs(dir);
  const first = await runBuild({ dir: FIXTURE, out: join(dir, 'a'), ...inputs });
  const second = await runBuild({ dir: FIXTURE, out: join(dir, 'b'), ...inputs });
  assert.equal(first.ok, true);
  for (const name of ['manifest.json', 'payload.json', 'review.md', 'expected-edge-changes.json'])
    assert.deepEqual(
      await readFile(join(dir, 'a', name)),
      await readFile(join(dir, 'b', name)),
      name,
    );
  assert.equal(first.manifestSha256, second.manifestSha256);
  const manifest = first.manifest;
  for (const spec of Object.values(SHEETS))
    assert.equal(manifest.inputs[spec.file].sha256, sha256(readFileSync(join(FIXTURE, spec.file))));
  assert.equal(manifest.inputs.current.sha256, sha256(await readFile(inputs.current)));
  assert.equal(manifest.inputs.edge.sha256, sha256(await readFile(inputs.edge)));
  for (const name of ['payload.json', 'review.md', 'expected-edge-changes.json']) {
    assert.equal(manifest.outputs[name].sha256, sha256(await readFile(join(dir, 'a', name))), name);
    assert.equal((await stat(join(dir, 'a', name))).mode & 0o777, 0o600, name);
  }
  assert.equal(
    manifest.payload.sha256,
    payloadHash(JSON.parse(await readFile(join(dir, 'a', 'payload.json'), 'utf8'))),
  );
  assert.equal(manifest.payload.sha256, payloadHash(payload));
  assert.equal(manifest.payload.products, 54);
  assert.equal(manifest.payload.budget_bytes, PAYLOAD_BUDGET_BYTES);
  assert.deepEqual(manifest.current, {
    branch_id: branch,
    version: 11,
    payload_sha256: payloadHash(v11),
  });
  assert.deepEqual(manifest.edge, {
    branch_id: branch,
    release_id: edgeMenu.release_id,
    version: 8,
  });
  assert.deepEqual(manifest.errors, []);
  assert.equal(JSON.stringify(manifest).includes(dir), false, 'no local paths in the manifest');
  // Request ids follow the manifest bytes and are valid UUIDs.
  const id = requestIdFor(first.manifestSha256, 'save');
  assert.equal(id, requestIdFor(second.manifestSha256, 'save'));
  assert.notEqual(id, requestIdFor(first.manifestSha256, 'publish'));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  // The reviewed list passes the parity gate for this payload and edge menu.
  const report = parityRun({
    catalog: JSON.parse(await readFile(join(dir, 'a', 'payload.json'), 'utf8')),
    snapshot: edgeMenu,
    allow: {
      expected: JSON.parse(await readFile(join(dir, 'a', 'expected-edge-changes.json'), 'utf8')),
      sha256: manifest.outputs['expected-edge-changes.json'].sha256,
    },
  });
  assert.equal(report.allow.ok, true);
  assert.equal(report.summary.removed, 0, 'no installed cashier item disappears');
  assert.equal(report.summary.added, 30);
  // Without --edge there is no list (publish will refuse such a build).
  const noEdge = await runBuild({ dir: FIXTURE, out: join(dir, 'c') });
  assert.equal(noEdge.manifest.outputs['expected-edge-changes.json'], null);
  assert.deepEqual(await readdir(join(dir, 'c')).then((names) => names.sort()), [
    'manifest.json',
    'payload.json',
    'review.md',
  ]);
  await assert.rejects(
    runBuild({ dir: FIXTURE, out: join(dir, 'c') }),
    (e) => e.code === 'OUT_NOT_EMPTY',
  );
});

test('the Russian review shows every price and marks every UNCONFIRMED mapping', async (t) => {
  const dir = await tempDir(t);
  await runBuild({ dir: FIXTURE, out: join(dir, 'out'), ...(await writeInputs(dir)) });
  const review = await readFile(join(dir, 'out', 'review.md'), 'utf8');
  assert.match(
    review,
    /Позиций: 54, без KK: \d+, без фото: \d+, без цены Яндекс: 54, без цены Glovo: 54\./,
  );
  assert.equal(/[\u2013\u2014]/.test(review), false, 'plain hyphen only');
  const lines = review.split('\n');
  for (const product of payload.products) {
    const line = lines.find((l) => l.includes(`| ${product.id} |`));
    assert.ok(line, product.id);
    assert.ok(line.includes(`| ${BigInt(product.price_minor) / 100n} ₸ |`), product.id);
  }
  assert.ok(lines.find((l) => l.includes('| pick-combo |')).includes('4190 ₸, «Pick Combo»'));
  assert.ok(lines.find((l) => l.includes('| chick-burger |')).includes('новая позиция'));
  for (const group of payload.products.find((p) => p.id === 'pick-meal-combo').modifier_groups)
    for (const option of group.options)
      assert.ok(
        lines.some(
          (l) =>
            l.includes(`| ${option.id} |`) &&
            l.includes(`| ${BigInt(option.price_delta_minor) / 100n} ₸ |`),
        ),
        option.id,
      );
  const all = sheets();
  const marked = [...all.positions, ...all.groups, ...all.rules].filter((r) => r.unconfirmed);
  assert.ok(marked.length >= 10);
  assert.equal(
    lines.filter((l) => l.startsWith('| ') && l.includes('| UNCONFIRMED: ')).length,
    marked.length,
  );
  assert.match(review, new RegExp(`Отметок UNCONFIRMED: ${marked.length}\\.`));
  const list = review.slice(
    review.indexOf('## Все отметки UNCONFIRMED'),
    review.indexOf('## Входные файлы'),
  );
  assert.equal(
    list
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| Лист') && !l.startsWith('| ---'))
      .length,
    marked.length,
  );
  for (const slug of ['pick-combo', 'burger-combo', 'finger-duo', 'burger-duo', 'mix-duo'])
    assert.ok(lines.find((l) => l.includes(`| ${slug} |`)).includes('UNCONFIRMED: slug'), slug);
  assert.match(review, /## Касса/);
  assert.match(review, /Управляющий: _+/);
  assert.match(review, /SHA-256 каталога \(payload\): `[a-f0-9]{64}`/);
});

/** In-memory catalog admin API with the server's revision, receipt and publication rules. */
async function stubCatalogApi(t, token) {
  const state = {
    branch: { id: branch, code: 'SYN', name: 'Synthetic' },
    publication_support: { mobile: true, pos: true, kiosk: true },
    edge_delivery: {
      catalog_version: 11,
      menu_version: 8,
      release_id: edgeMenu.release_id,
      device_id: device,
      status: 'applied',
      acknowledged_at: '2026-10-14T00:01:00.000Z',
      edge_active_version: 8,
      observed_at: '2026-11-05T00:00:00.000Z',
    },
    draft: {
      revision: 24,
      base_version: 11,
      updated_at: '2026-10-14T00:00:00.000Z',
      updated_by: actor,
      payload: v11,
    },
    published: {
      version: 11,
      published_at: '2026-10-14T00:00:00.000Z',
      published_by: actor,
      payload: v11,
    },
  };
  const receipts = new Map(),
    calls = [];
  const server = createServer(async (request, response) => {
    // Decode once: a Cyrillic character split across two TCP chunks must not become U+FFFD.
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    calls.push({
      method: request.method,
      url: request.url,
      body: body ? JSON.parse(body) : null,
      auth: request.headers.authorization,
    });
    const send = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== `Bearer ${token}`)
      return send(401, { code: 'UNAUTHORIZED' });
    const base = `/v1/admin/catalog/branches/${branch}`;
    const view = () => CatalogStateSchema.parse(structuredClone(state));
    if (request.method === 'GET' && request.url === base) return send(200, view());
    const input = JSON.parse(body || '{}');
    const hash = sha256(`${request.method} ${request.url} ${body}`);
    const receipt = receipts.get(input.request_id);
    if (receipt)
      return receipt.hash === hash ? send(200, receipt.response) : send(409, { code: 'CONFLICT' });
    if (request.method === 'PUT' && request.url === `${base}/draft`) {
      if (
        input.expected_revision !== state.draft.revision ||
        !CatalogPayloadSchema.safeParse(input.payload).success
      )
        return send(409, { code: 'CONFLICT' });
      state.draft = {
        ...state.draft,
        revision: state.draft.revision + 1,
        updated_at: '2026-11-09T17:00:00.000Z',
        payload: input.payload,
      };
    } else if (request.method === 'POST' && request.url === `${base}/publish`) {
      if (
        input.confirmation !== 'publish_catalog' ||
        input.expected_revision !== state.draft.revision ||
        input.expected_published_version !== state.published.version ||
        !state.draft.payload.content_reviewed
      )
        return send(409, { code: 'CONFLICT' });
      const version = state.published.version + 1;
      state.published = {
        version,
        published_at: '2026-11-09T18:00:00.000Z',
        published_by: actor,
        payload: state.draft.payload,
      };
      state.draft = { ...state.draft, revision: state.draft.revision + 1, base_version: version };
      state.edge_delivery = {
        ...state.edge_delivery,
        catalog_version: version,
        menu_version: 9,
        release_id: randomUUID(),
        status: 'pending',
        acknowledged_at: null,
      };
    } else return send(404, { code: 'NOT_FOUND' });
    const result = view();
    receipts.set(input.request_id, { hash, response: result });
    send(200, result);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, state, calls };
}
async function credentialFile(dir, token, mode = 0o600) {
  const path = join(dir, `credential-${mode.toString(8)}.json`);
  await writeFile(
    path,
    JSON.stringify({
      organization_id: '10000000-0000-4000-8000-000000000001',
      name: 'Synthetic catalog editor',
      branch_ids: [branch],
      actor_id: actor,
      token,
      issued_at: '2026-11-01T00:00:00.000Z',
    }),
  );
  await chmod(path, mode);
  return path;
}

test('save sets content_reviewed once with a manifest request id; publish needs the clean --allow report', async (t) => {
  const dir = await tempDir(t);
  const token = randomBytes(32).toString('hex');
  const stub = await stubCatalogApi(t, token);
  const inputs = await writeInputs(dir);
  const out = join(dir, 'out');
  await runBuild({ dir: FIXTURE, out, ...inputs });
  const loaded = await loadManifest(join(out, 'manifest.json'));
  assert.equal(loaded.reviewedSha256, payloadHash(reviewed));
  const api = catalogApi({ base: apiBase(stub.url), token });
  await assert.rejects(
    runSave({ loaded, branch, reviewedBy: 'x', api }),
    (e) => e.code === 'REVIEWER_INVALID',
  );
  const saved = await runSave({ loaded, branch, reviewedBy: 'Синтетический Управляющий', api });
  assert.equal(saved.status, 'saved');
  assert.equal(saved.draft_revision, 25);
  assert.equal(saved.receipt, 'written');
  const put = stub.calls.filter((call) => call.method === 'PUT');
  assert.equal(put.length, 1);
  assert.deepEqual(put[0].body, {
    expected_revision: 24,
    request_id: requestIdFor(loaded.sha256, 'save'),
    payload: reviewed,
  });
  assert.equal((await stat(join(out, 'save-receipt.json'))).mode & 0o777, 0o600);
  const again = await runSave({ loaded, branch, reviewedBy: 'Синтетический Управляющий', api });
  assert.deepEqual([again.status, again.receipt], ['already_saved', 'exists']);
  assert.equal(stub.calls.filter((call) => call.method === 'PUT').length, 1);
  // The parity report must be the --allow one for this build, edge menu and branch.
  const expected = JSON.parse(await readFile(join(out, 'expected-edge-changes.json'), 'utf8'));
  const parity = parityRun({
    catalog: loaded.payload,
    snapshot: edgeMenu,
    allow: { expected, sha256: loaded.expected.sha256 },
  });
  const refusedWith = async (report, code) =>
    assert.rejects(runPublish({ loaded, branch, parity: report, api }), (e) => e.code === code);
  await refusedWith(parityRun({ catalog: loaded.payload, snapshot: edgeMenu }), 'PARITY_FAILED');
  await refusedWith(
    { ...parity, ok: false, allow: { ...parity.allow, ok: false } },
    'PARITY_FAILED',
  );
  await refusedWith(
    { ...parity, allow: { ...parity.allow, file_sha256: 'f'.repeat(64) } },
    'PARITY_FAILED',
  );
  await refusedWith({ ...parity, edge_version: 7 }, 'PARITY_STALE');
  assert.equal(stub.calls.filter((call) => call.method === 'POST').length, 0);
  const published = await runPublish({ loaded, branch, parity, api });
  assert.deepEqual([published.status, published.published_version], ['published', 12]);
  assert.equal(published.edge_delivery.status, 'pending');
  const post = stub.calls.filter((call) => call.method === 'POST');
  assert.deepEqual(post[0].body, {
    expected_revision: 25,
    expected_published_version: 11,
    request_id: requestIdFor(loaded.sha256, 'publish'),
    confirmation: 'publish_catalog',
  });
  const repeat = await runPublish({ loaded, branch, parity, api });
  assert.deepEqual([repeat.status, repeat.receipt], ['already_published', 'exists']);
  assert.equal(stub.calls.filter((call) => call.method === 'POST').length, 1);
  // The review compared against v11; once v12 is head, a new save of this build is refused.
  await assert.rejects(
    runSave({ loaded, branch, reviewedBy: 'Синтетический Управляющий', api }),
    (e) => e.code === 'PUBLISHED_CHANGED',
  );
  assert.ok(stub.calls.every((call) => call.auth === `Bearer ${token}`));
});

test('save and publish refuse tampered builds, foreign branches and unsafe API or token files', async (t) => {
  // A build without --edge has no reviewed list: nothing proves the cashier change.
  const noList = { manifest: { payload: { edge_sha256: 'a'.repeat(64) } }, expected: null };
  assert.throws(
    () => assertParityReport({}, noList, branch, {}),
    (e) => e.code === 'PARITY_REQUIRED',
  );
  const dir = await tempDir(t);
  const token = randomBytes(32).toString('hex');
  const stub = await stubCatalogApi(t, token);
  const inputs = await writeInputs(dir);
  await runBuild({ dir: FIXTURE, out: join(dir, 'ok'), ...inputs });
  const api = catalogApi({ base: apiBase(stub.url), token });
  const loaded = await loadManifest(join(dir, 'ok', 'manifest.json'));
  await assert.rejects(
    runSave({
      loaded,
      branch: '10000000-0000-4000-8000-0000000000aa',
      reviewedBy: 'Синтетический',
      api,
    }),
    (e) => e.code === 'BRANCH_MISMATCH',
  );
  // A draft saved by someone else after the review: publish refuses instead of publishing it.
  const expected = JSON.parse(
    await readFile(join(dir, 'ok', 'expected-edge-changes.json'), 'utf8'),
  );
  const parity = parityRun({
    catalog: loaded.payload,
    snapshot: edgeMenu,
    allow: { expected, sha256: loaded.expected.sha256 },
  });
  await assert.rejects(
    runPublish({ loaded, branch, parity, api }),
    (e) => e.code === 'DRAFT_DIFFERS',
  );
  // Changed outputs after the manager signed.
  const review = join(dir, 'ok', 'review.md');
  await writeFile(review, (await readFile(review, 'utf8')).replace('3690 ₸', '3590 ₸'));
  await assert.rejects(
    loadManifest(join(dir, 'ok', 'manifest.json')),
    (e) => e.code === 'OUTPUT_CHANGED',
  );
  // A build with sheet errors has no payload and cannot be saved.
  const broken = join(dir, 'broken-sheets');
  await cp(FIXTURE, broken, { recursive: true });
  const positions = join(broken, 'positions.tsv');
  await writeFile(
    positions,
    (await readFile(positions, 'utf8')).replace('\t1990\t', '\t1990,50\t'),
  );
  const failed = await runBuild({ dir: broken, out: join(dir, 'failed') });
  assert.equal(failed.ok, false);
  assert.deepEqual(codes(failed.manifest.errors), ['PRICE_NOT_WHOLE_TENGE']);
  assert.equal(failed.manifest.outputs['payload.json'], null);
  assert.match(
    await readFile(join(dir, 'failed', 'review.md'), 'utf8'),
    /## Ошибки - публикация невозможна/,
  );
  await assert.rejects(
    loadManifest(join(dir, 'failed', 'manifest.json')),
    (e) => e.code === 'MANIFEST_HAS_ERRORS',
  );
  // API base and credential file.
  for (const value of [
    'http://example.com',
    'http://192.0.2.10:3100',
    'ftp://127.0.0.1',
    'https://user:pw@example.com',
    'https://example.com/?x=1',
    'not a url',
  ])
    assert.throws(
      () => apiBase(value),
      (e) => e.code === 'API_INVALID',
      value,
    );
  assert.equal(apiBase().href, 'http://127.0.0.1:3100/');
  assert.equal(apiBase('https://api.example.test/base').href, 'https://api.example.test/base/');
  assert.equal(await readCredential(await credentialFile(dir, token), branch), token);
  await assert.rejects(
    readCredential(await credentialFile(dir, token, 0o644), branch),
    (e) => e.code === 'TOKEN_FILE',
  );
  await assert.rejects(
    readCredential(await credentialFile(dir, token), '10000000-0000-4000-8000-0000000000aa'),
    (e) => e.code === 'TOKEN_FILE',
  );
  // An API refusal surfaces the stable code only.
  const wrong = catalogApi({ base: apiBase(stub.url), token: 'b'.repeat(64) });
  await assert.rejects(
    wrong.read(branch),
    (e) =>
      e.code === 'API_REFUSED' && /401 UNAUTHORIZED/.test(e.detail) && !e.detail.includes(token),
  );
  // The saved draft is read back and compared: a server that stored one damaged character is
  // caught (a body decoded chunk by chunk turns a split Cyrillic letter into U+FFFD).
  const lossy = {
    ...api,
    save: async (id, body) => {
      const answer = await api.save(id, body);
      answer.draft.payload.products[5].name.ru = answer.draft.payload.products[5].name.ru.replace(
        /.$/,
        '�',
      );
      return answer;
    },
  };
  await assert.rejects(
    runSave({ loaded, branch, reviewedBy: 'Синтетический Управляющий', api: lossy }),
    (e) => e.code === 'API_RESPONSE_INVALID',
  );
});

test('CLI: usage exit 2, refused build exit 1, save through the local API without printing the token', async (t) => {
  const dir = await tempDir(t);
  const run = (args) =>
    promisify(execFile)(process.execPath, [SCRIPT, ...args], { maxBuffer: 20_000_000 }).then(
      (result) => ({ code: 0, ...result }),
      (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
    );
  for (const argv of [
    [],
    ['deploy'],
    ['build', '--dir', FIXTURE],
    [
      'save',
      '--manifest',
      'm',
      '--reviewed-by',
      'x',
      '--branch',
      'not-a-uuid',
      '--token-file',
      'f',
    ],
  ]) {
    assert.throws(() => parseArguments(argv), argv.join(' '));
    assert.equal((await run(argv)).code, 2, argv.join(' '));
  }
  const inputs = await writeInputs(dir);
  const out = join(dir, 'out');
  const ok = await run([
    'build',
    '--dir',
    FIXTURE,
    '--out',
    out,
    '--current',
    inputs.current,
    '--edge',
    inputs.edge,
  ]);
  assert.equal(ok.code, 0, ok.stderr);
  const summary = JSON.parse(ok.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.summary.products, 54);
  const again = await run(['build', '--dir', FIXTURE, '--out', out]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /OUT_NOT_EMPTY/);
  const token = randomBytes(32).toString('hex');
  const stub = await stubCatalogApi(t, token);
  const credential = await credentialFile(dir, token);
  const saved = await run([
    'save',
    '--manifest',
    join(out, 'manifest.json'),
    '--reviewed-by',
    'Синтетический Управляющий',
    '--branch',
    branch,
    '--token-file',
    credential,
    '--api',
    stub.url,
  ]);
  assert.equal(saved.code, 0, saved.stderr);
  assert.equal(JSON.parse(saved.stdout).status, 'saved');
  assert.equal(`${saved.stdout}${saved.stderr}`.includes(token), false);
  const parityFile = join(dir, 'parity.json');
  await writeFile(parityFile, JSON.stringify({ ok: false }));
  const refused = await run([
    'publish',
    '--manifest',
    join(out, 'manifest.json'),
    '--parity',
    parityFile,
    '--branch',
    branch,
    '--token-file',
    credential,
    '--api',
    stub.url,
  ]);
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.stderr).code, 'PARITY_FAILED');
  assert.equal(`${refused.stdout}${refused.stderr}`.includes(token), false);
  const remote = await run([
    'save',
    '--manifest',
    join(out, 'manifest.json'),
    '--reviewed-by',
    'Синтетический Управляющий',
    '--branch',
    branch,
    '--token-file',
    credential,
    '--api',
    'http://192.0.2.10:3100',
  ]);
  assert.equal(remote.code, 1);
  assert.equal(JSON.parse(remote.stderr).code, 'API_INVALID');
});
