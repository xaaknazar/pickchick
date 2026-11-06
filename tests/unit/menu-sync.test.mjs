import assert from 'node:assert/strict';
import test from 'node:test';
/* global structuredClone, DOMException */
import { randomUUID } from 'node:crypto';
import {
  CatalogProjectionError,
  EDGE_MENU_FEATURES,
  canonicalJson,
  channelItemPriceMinor,
  channelOptionPriceMinor,
  edgeMenuFeatures,
  hashJson,
  isPermanentMediaFailure,
  localCloudOrigin,
  menuDeliveryChecksums,
  menuDeliveryForm,
  projectCatalogMenu,
  withoutAggregatorPrices,
  withoutComboStopLinks,
  withoutEdgeOnlyFields,
} from '@pickchick/menu-sync';
import {
  EdgeMenuFeatureSchema,
  EdgeMenuStateQuerySchema,
  MenuAckSchema,
  MenuPublishedSchema,
  MenuSnapshotSchema,
  menuAckResult,
} from '@pickchick/contracts';
import { fixtureMenu } from '@pickchick/test-fixtures';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';
import { EDGE_KEYS } from './catalog-frozen-storefront.mjs';

test('menu protocol hashes ignore object key order while preserving array order', () => {
  assert.equal(canonicalJson({ z: 'қ', a: { y: 2, b: 1 } }), '{"a":{"b":1,"y":2},"z":"қ"}');
  assert.equal(hashJson({ b: 2, a: 1 }), hashJson({ a: 1, b: 2 }));
  assert.notEqual(hashJson([1, 2]), hashJson([2, 1]));
  assert.equal(
    MenuSnapshotSchema.safeParse({ ...fixtureMenu, version: 2147483648 }).success,
    false,
  );
});

test('local sync never forwards device credentials to remote or userinfo origins', () => {
  assert.equal(localCloudOrigin('http://127.0.0.1:3100'), 'http://127.0.0.1:3100');
  for (const url of [
    'https://example.com',
    'http://localhost:3100',
    'http://127.0.0.1/path',
    'http://user:secret@127.0.0.1',
    'http://127.0.0.1?x=1',
    'http://127.0.0.1#x',
  ])
    assert.throws(() => localCloudOrigin(url));
});

test('menu checksum is stable with the unified-menu fields and changes only with content', () => {
  const branch = '10000000-0000-4000-8000-000000000003';
  const release = '30000000-0000-4000-8000-000000000001';
  const at = '2026-10-04T00:00:00.000Z';
  const first = projectCatalogMenu(mockupCatalogDraft, branch, 3, at, release);
  const second = projectCatalogMenu(structuredClone(mockupCatalogDraft), branch, 3, at, release);
  assert.ok(first.categories && first.items.every((item) => item.kitchen && item.source_id));
  assert.equal(hashJson(first), hashJson(second));
  // Key order in the stored JSON never changes the checksum.
  const reordered = JSON.parse(
    JSON.stringify(first, (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value,
    ),
  );
  assert.equal(hashJson(reordered), hashJson(first));
  assert.equal(
    hashJson(MenuSnapshotSchema.parse(JSON.parse(canonicalJson(first)))),
    hashJson(first),
  );
  const photo = structuredClone(mockupCatalogDraft);
  photo.products[0].image = { asset_id: randomUUID(), sha256: 'ab'.repeat(32) };
  assert.notEqual(hashJson(projectCatalogMenu(photo, branch, 3, at, release)), hashJson(first));
});

test('menu ACK keeps applied ACKs byte-identical and requires a reason for rejection', () => {
  const ack = {
    event_id: randomUUID(),
    producer_id: randomUUID(),
    producer_sequence: '3',
    branch_id: randomUUID(),
    release_id: randomUUID(),
    checksum: 'c'.repeat(64),
  };
  const parsed = MenuAckSchema.parse(ack);
  assert.equal('result' in parsed, false);
  assert.equal(hashJson(parsed), hashJson(ack));
  assert.equal(menuAckResult(parsed), 'applied');
  assert.equal(menuAckResult(MenuAckSchema.parse({ ...ack, result: 'applied' })), 'applied');
  const rejected = MenuAckSchema.parse({
    ...ack,
    result: 'rejected',
    reason: 'ROUTING_UNRESOLVED',
  });
  assert.equal(menuAckResult(rejected), 'rejected');
  for (const reason of ['VERSION_NOT_NEWER', 'MEDIA_UNAVAILABLE', 'INVALID_MENU'])
    assert.equal(MenuAckSchema.safeParse({ ...ack, result: 'rejected', reason }).success, true);
  for (const bad of [
    { ...ack, result: 'rejected' },
    { ...ack, reason: 'INVALID_MENU' },
    { ...ack, result: 'applied', reason: 'INVALID_MENU' },
    { ...ack, result: 'rejected', reason: 'UNKNOWN' },
    { ...ack, result: 'ignored' },
  ])
    assert.equal(MenuAckSchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test('edge menu state query accepts the worker query params and nothing else', () => {
  const id = randomUUID();
  assert.deepEqual(EdgeMenuStateQuerySchema.parse({ active_release_id: id, active_version: '2' }), {
    active_release_id: id,
    active_version: 2,
  });
  assert.equal(
    EdgeMenuStateQuerySchema.parse({ active_release_id: id, active_version: 7 }).active_version,
    7,
  );
  for (const bad of [
    { active_release_id: id, active_version: '0' },
    { active_release_id: id, active_version: '-1' },
    { active_release_id: id, active_version: '02' },
    { active_release_id: id, active_version: '1.5' },
    { active_release_id: id, active_version: '2147483648' },
    { active_release_id: 'x', active_version: '2' },
    { active_release_id: id },
    { active_release_id: id, active_version: '2', extra: '1' },
  ])
    assert.equal(EdgeMenuStateQuerySchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test('photo download failures: 4xx and bad bytes are permanent, outages are transient', () => {
  for (const message of [
    'Sync HTTP 404',
    'Sync HTTP 401',
    'Menu media hash mismatch',
    'Menu media is not WebP',
    'Sync response too large',
  ])
    assert.equal(isPermanentMediaFailure(new Error(message)), true, message);
  for (const message of [
    'Sync HTTP 503',
    'Sync HTTP 500',
    'Sync HTTP 429',
    'Sync HTTP 408',
    'fetch failed',
  ])
    assert.equal(isPermanentMediaFailure(new Error(message)), false, message);
  assert.equal(isPermanentMediaFailure(new DOMException('timeout', 'TimeoutError')), false);
  assert.equal(isPermanentMediaFailure('Sync HTTP 404'), false);
});

// Cutover CC-3 (contracts 5.3): delivery forms over the feature subsets {combo_stops,
// aggregator_prices}. Each form must be exactly the menu the cloud would publish with those
// flags, its checksum must be accepted by the ACK, and nothing changes for unmarked menus.
const cutoverBranch = '10000000-0000-4000-8000-000000000003';
const cutoverRelease = '30000000-0000-4000-8000-000000000011';
const cutoverAt = '2026-11-16T05:00:00.000Z';
/** Combo stop data (fixed components, linked option) and aggregator prices (synthetic tiyn). */
function cutoverCatalog() {
  const catalog = structuredClone(mockupCatalogDraft);
  const product = (id) => catalog.products.find((p) => p.id === id);
  product('pick-combo').combo_components = [
    { product_id: 'fingers', quantity: 3 },
    { product_id: 'toast', quantity: 1 },
  ];
  for (const option of product('pick-combo').modifier_groups.find((g) => g.id === 'drink').options)
    if (option.id === 'cola-bottle') option.linked_product_id = 'cola';
  product('pick-combo').channel_prices_minor = { yandex_eda: '459000', glovo: '469000' };
  product('burger').channel_prices_minor = { yandex_eda: '269000' };
  product('cola').channel_prices_minor = { glovo: '119000' };
  return catalog;
}
const featureSets = [
  [],
  ['combo_stops'],
  ['aggregator_prices'],
  ['combo_stops', 'aggregator_prices'],
];
/** The catalog as it can be published with the aggregator flag off: no aggregator keys. */
function withoutAggregatorKeys(catalog) {
  const copy = structuredClone(catalog);
  for (const product of copy.products) {
    if (!product.channel_prices_minor) continue;
    delete product.channel_prices_minor.yandex_eda;
    delete product.channel_prices_minor.glovo;
    if (!Object.keys(product.channel_prices_minor).length) delete product.channel_prices_minor;
  }
  return copy;
}
/** What the cloud publishes with exactly these flags (CATALOG_EDGE_COMBO_STOPS / AGGREGATOR). */
const project = (catalog, features) =>
  projectCatalogMenu(
    features.includes('aggregator_prices') ? catalog : withoutAggregatorKeys(catalog),
    cutoverBranch,
    4,
    cutoverAt,
    cutoverRelease,
    {
      comboStops: features.includes('combo_stops'),
      aggregatorPrices: features.includes('aggregator_prices'),
    },
  );
const publishedEvent = (menu) =>
  MenuPublishedSchema.parse({
    event_id: '40000000-0000-4000-8000-000000000001',
    producer_id: '40000000-0000-4000-8000-000000000002',
    producer_sequence: '4',
    branch_id: cutoverBranch,
    aggregate_type: 'menu_release',
    aggregate_id: menu.release_id,
    aggregate_version: menu.version,
    schema_version: 1,
    event_type: 'menu.published',
    payload: { menu, checksum: hashJson(menu) },
    occurred_at: cutoverAt,
    correlation_id: '40000000-0000-4000-8000-000000000003',
    causation_id: null,
  });
const comboFieldsIn = (menu) =>
  /combo_component_variant_ids|linked_variant_id/.test(JSON.stringify(menu));
const aggregatorFieldsIn = (menu) => /aggregator_prices_minor/.test(JSON.stringify(menu));

test('the edge advertises both menu features; the cloud knows exactly these two', () => {
  assert.deepEqual(EDGE_MENU_FEATURES, ['combo_stops', 'aggregator_prices']);
  assert.deepEqual(EdgeMenuFeatureSchema.options, ['combo_stops', 'aggregator_prices']);
  assert.deepEqual(edgeMenuFeatures(EDGE_MENU_FEATURES.join(',')), [
    'combo_stops',
    'aggregator_prices',
  ]);
  assert.deepEqual(edgeMenuFeatures('aggregator_prices,future_thing'), ['aggregator_prices']);
});

test('delivery form for each of the 4 feature subsets is the menu published with those flags', () => {
  const catalog = cutoverCatalog();
  const full = project(catalog, ['combo_stops', 'aggregator_prices']);
  const event = publishedEvent(full);
  const checksums = new Set();
  for (const features of featureSets) {
    const form = menuDeliveryForm(event, features);
    const expected = project(catalog, features);
    assert.deepEqual(form.payload.menu, expected, features.join(','));
    assert.equal(form.payload.checksum, hashJson(expected));
    assert.equal(form.payload.checksum, hashJson(form.payload.menu));
    assert.equal(comboFieldsIn(form.payload.menu), features.includes('combo_stops'));
    assert.equal(aggregatorFieldsIn(form.payload.menu), features.includes('aggregator_prices'));
    // Envelope identity is never touched: the edge ACKs the same event, sequence and release.
    assert.deepEqual({ ...form, payload: null }, { ...event, payload: null });
    assert.equal(MenuPublishedSchema.safeParse(form).success, true);
    checksums.add(form.payload.checksum);
    // Feature order and unknown values do not matter.
    assert.deepEqual(menuDeliveryForm(event, [...features].reverse()), form);
    assert.deepEqual(menuDeliveryForm(event, [...features, 'future_thing']), form);
  }
  assert.equal(checksums.size, 4);
  // The ACK accepts exactly these four checksums and nothing else.
  assert.deepEqual(menuDeliveryChecksums(event), checksums);
  assert.equal(menuDeliveryChecksums(event).has('a'.repeat(64)), false);
  // The full form is the stored event itself, the empty one has no cashier-only field.
  assert.equal(menuDeliveryForm(event, ['combo_stops', 'aggregator_prices']), event);
  assert.deepEqual(menuDeliveryForm(event, []).payload.menu, withoutEdgeOnlyFields(full));
  for (const item of menuDeliveryForm(event, []).payload.menu.items) {
    for (const key of Object.keys(item)) assert.ok(EDGE_KEYS.item.includes(key), key);
    for (const group of item.modifier_groups ?? [])
      for (const option of group.options)
        for (const key of Object.keys(option)) assert.ok(EDGE_KEYS.option.includes(key), key);
  }
});

test('aggregator prices are projected only for keyed products and price channels as the cashier does', () => {
  const menu = project(cutoverCatalog(), ['aggregator_prices']);
  const item = (slug) => menu.items.find((i) => i.source_id === slug);
  assert.deepEqual(item('pick-combo').aggregator_prices_minor, {
    yandex_eda: '459000',
    glovo: '469000',
  });
  assert.deepEqual(item('burger').aggregator_prices_minor, { yandex_eda: '269000' });
  assert.deepEqual(item('cola').aggregator_prices_minor, { glovo: '119000' });
  assert.equal('aggregator_prices_minor' in item('fingers'), false);
  assert.equal(menu.items.filter((i) => i.aggregator_prices_minor).length, 3);
  // Key present = sold in that channel; hall stays price_minor; options keep the hall surcharge.
  assert.equal(channelItemPriceMinor(item('burger'), 'hall'), item('burger').price_minor);
  assert.equal(channelItemPriceMinor(item('burger'), 'yandex_eda'), '269000');
  assert.equal(channelItemPriceMinor(item('burger'), 'glovo'), null);
  assert.equal(channelItemPriceMinor(item('fingers'), 'yandex_eda'), null);
  const option = item('pick-combo').modifier_groups[0].options[0];
  assert.equal(channelOptionPriceMinor(option, 'glovo'), option.price_minor);
  // Identities and every other field are exactly the hall projection.
  assert.deepEqual(withoutAggregatorPrices(menu), project(cutoverCatalog(), []));
});

test('aggregator prices off: refused as before; own-channel overrides stay refused when on', () => {
  const catalog = cutoverCatalog();
  for (const options of [{}, { comboStops: true }, { aggregatorPrices: false }])
    assert.throws(
      () => projectCatalogMenu(catalog, cutoverBranch, 4, cutoverAt, cutoverRelease, options),
      (error) =>
        error instanceof CatalogProjectionError && error.code === 'CHANNEL_PRICES_NOT_SUPPORTED',
    );
  for (const channel of ['mobile', 'pos', 'kiosk']) {
    const own = cutoverCatalog();
    own.products.find((p) => p.id === 'fingers').channel_prices_minor = { [channel]: '1' };
    assert.throws(
      () => project(own, ['combo_stops', 'aggregator_prices']),
      /CHANNEL_PRICES_NOT_SUPPORTED/,
      channel,
    );
  }
  // A hidden product's aggregator price is accepted and simply not published.
  const hidden = cutoverCatalog();
  for (const p of hidden.products) delete p.channel_prices_minor;
  hidden.products.find((p) => p.id === 'water').available = false;
  hidden.products.find((p) => p.id === 'water').channel_prices_minor = { glovo: '1' };
  assert.equal(aggregatorFieldsIn(project(hidden, ['aggregator_prices'])), false);
});

test('flags off: projection, delivery forms and ACK checksums are byte-identical to before', () => {
  const plain = structuredClone(mockupCatalogDraft);
  const legacy = projectCatalogMenu(plain, cutoverBranch, 4, cutoverAt, cutoverRelease);
  // The new option changes nothing on a catalog without aggregator keys.
  for (const options of [{ aggregatorPrices: true }, { aggregatorPrices: false }])
    assert.equal(
      canonicalJson(
        projectCatalogMenu(plain, cutoverBranch, 4, cutoverAt, cutoverRelease, options),
      ),
      canonicalJson(legacy),
    );
  const event = publishedEvent(legacy);
  for (const features of featureSets) assert.equal(menuDeliveryForm(event, features), event);
  assert.deepEqual(menuDeliveryChecksums(event), new Set([event.payload.checksum]));
  assert.equal(withoutAggregatorPrices(legacy), legacy);
  assert.equal(withoutEdgeOnlyFields(legacy), legacy);
  // Stage 2 only (combo stops on, no aggregator data): the two historical forms, nothing more.
  const stage2Catalog = cutoverCatalog();
  for (const p of stage2Catalog.products) delete p.channel_prices_minor;
  const stage2 = publishedEvent(project(stage2Catalog, ['combo_stops']));
  const plainForm = menuDeliveryForm(stage2, []);
  assert.deepEqual(plainForm.payload.menu, withoutComboStopLinks(stage2.payload.menu));
  assert.equal(menuDeliveryForm(stage2, ['combo_stops']), stage2);
  assert.equal(menuDeliveryForm(stage2, ['combo_stops', 'aggregator_prices']), stage2);
  assert.deepEqual(menuDeliveryForm(stage2, ['aggregator_prices']), plainForm);
  assert.deepEqual(
    menuDeliveryChecksums(stage2),
    new Set([stage2.payload.checksum, plainForm.payload.checksum]),
  );
});
