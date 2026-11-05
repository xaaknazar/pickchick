// Cutover CC-3 (contracts 5.3, R4): aggregator prices live in the catalog channel_prices_minor
// under yandex_eda/glovo, publish only behind CATALOG_AGGREGATOR_PRICES_ENABLED, reach only the
// cashier edge, and never a storefront. Everything here is synthetic.
/* global structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOG_AGGREGATOR_CHANNELS,
  CatalogAdminError,
  CatalogPayloadSchema,
  CatalogProductSchema,
  CatalogStateSchema,
  assertCatalogPublishable,
  catalogAdminOptions,
  isCatalogAggregatorChannel,
  stripStorefrontPayload,
} from '../../packages/catalog-admin/dist/index.js';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';
import { priceCatalogSnapshot } from '../../packages/catalog-pricing/dist/index.js';
import { projectCatalogMenu } from '../../packages/menu-sync/dist/index.js';
import { SHEETS, buildMenu, parseTsv, payloadHash } from '../../scripts/catalog-menu-import.mjs';
import { frozenStorefrontSchemas } from './catalog-frozen-storefront.mjs';

const branch = '10000000-0000-4000-8000-000000000003';
const FIXTURE = fileURLToPath(
  new URL('../../packages/catalog-admin/fixtures/real-menu-2026-11/', import.meta.url),
);
const refused = (error) =>
  error instanceof CatalogAdminError &&
  error.code === 'CONFLICT' &&
  error.reason === 'CHANNEL_PRICES_NOT_SUPPORTED';
const withPrices = (prices) => {
  const payload = structuredClone(mockupCatalogDraft);
  payload.products[0].channel_prices_minor = prices;
  return CatalogPayloadSchema.parse(payload);
};
/** The real 54-item menu of the import fixture with synthetic aggregator prices on most items. */
function realMenuWithAggregatorPrices() {
  const sheets = Object.fromEntries(
    Object.entries(SHEETS).map(([key, spec]) => [
      key,
      parseTsv(readFileSync(join(FIXTURE, spec.file)), key),
    ]),
  );
  const built = buildMenu(sheets);
  assert.deepEqual(built.errors, []);
  const payload = structuredClone({ ...built.payload, content_reviewed: true });
  payload.products.forEach((product, index) => {
    const hall = BigInt(product.price_minor);
    // Whole tenge, about 15 % above the hall; every third item is not sold in Glovo.
    const yandex = ((hall * 115n) / 10000n) * 100n;
    product.channel_prices_minor = {
      yandex_eda: String(yandex),
      ...(index % 3 ? { glovo: String(yandex + 10000n) } : {}),
    };
  });
  // One own-channel override next to the aggregator keys (mobile storefront branch).
  payload.products[1].channel_prices_minor.mobile = payload.products[1].price_minor;
  return CatalogPayloadSchema.parse(payload);
}

test('the catalog accepts exactly the two aggregator channel keys', () => {
  assert.deepEqual(CATALOG_AGGREGATOR_CHANNELS, ['yandex_eda', 'glovo']);
  assert.equal(isCatalogAggregatorChannel('yandex_eda'), true);
  assert.equal(isCatalogAggregatorChannel('mobile'), false);
  const product = mockupCatalogDraft.products[0];
  for (const prices of [
    { yandex_eda: '459000' },
    { glovo: '0' },
    { yandex_eda: '1', glovo: '2', mobile: '3', pos: '4', kiosk: '5' },
  ])
    assert.equal(
      CatalogProductSchema.safeParse({ ...product, channel_prices_minor: prices }).success,
      true,
    );
  for (const prices of [
    { yandex: '1' },
    { wolt: '1' },
    { chocofood: '1' },
    { yandex_eda: '1.5' },
    { glovo: '-1' },
    { glovo: 100 },
  ])
    assert.equal(
      CatalogProductSchema.safeParse({ ...product, channel_prices_minor: prices }).success,
      false,
      JSON.stringify(prices),
    );
});

test('publication refuses aggregator prices unless the flag allows them; own channels as before', () => {
  for (const prices of [{ yandex_eda: '1' }, { glovo: '1' }]) {
    const payload = withPrices(prices);
    // Historical calls (no options, the mobile boolean) refuse them exactly as before.
    assert.throws(() => assertCatalogPublishable(payload), refused);
    assert.throws(() => assertCatalogPublishable(payload, true), refused);
    assert.throws(() => assertCatalogPublishable(payload, { mobile: true }), refused);
    assert.throws(() => assertCatalogPublishable(payload, { aggregatorPrices: false }), refused);
    assert.doesNotThrow(() => assertCatalogPublishable(payload, { aggregatorPrices: true }));
  }
  // pos and kiosk stay refused; mobile only with its own switch.
  for (const channel of ['pos', 'kiosk']) {
    const payload = withPrices({ yandex_eda: '1', [channel]: '1' });
    assert.throws(
      () => assertCatalogPublishable(payload, { mobile: true, aggregatorPrices: true }),
      refused,
    );
  }
  const mobile = withPrices({ mobile: '1', glovo: '1' });
  assert.throws(() => assertCatalogPublishable(mobile, { aggregatorPrices: true }), refused);
  assert.doesNotThrow(() =>
    assertCatalogPublishable(mobile, { mobile: true, aggregatorPrices: true }),
  );
  assert.doesNotThrow(() => assertCatalogPublishable(withPrices({ mobile: '1' }), true));
  assert.throws(() => assertCatalogPublishable(withPrices({ mobile: '1' })), refused);
  assert.doesNotThrow(() => assertCatalogPublishable(withPrices({})));
});

test('storefronts never get aggregator keys; a payload without them is stripped as before', () => {
  const payload = withPrices({ mobile: '219900', yandex_eda: '459000', glovo: '469000' });
  payload.products[1].channel_prices_minor = { glovo: '1' };
  payload.products[2].channel_prices_minor = { kiosk: '239900' };
  payload.products[3].channel_prices_minor = {};
  const before = structuredClone(payload);
  const stripped = stripStorefrontPayload(payload);
  assert.deepEqual(payload, before, 'the stored payload is not mutated');
  assert.deepEqual(stripped.products[0].channel_prices_minor, { mobile: '219900' });
  assert.equal('channel_prices_minor' in stripped.products[1], false, 'emptied object removed');
  assert.deepEqual(stripped.products[2].channel_prices_minor, { kiosk: '239900' });
  assert.deepEqual(stripped.products[3].channel_prices_minor, {}, 'untouched without aggregators');
  assert.equal(/yandex_eda|glovo/.test(JSON.stringify(stripped)), false);
  // Without aggregator keys the result is byte-identical to the historical field stripping
  // (the D0 stripStorefrontPayload body, applied to the same parsed payload).
  const legacy = structuredClone(mockupCatalogDraft);
  legacy.products[0].channel_prices_minor = { mobile: '100', kiosk: '200' };
  legacy.products[0].kitchen_route = 'prep';
  const parsed = CatalogPayloadSchema.parse(legacy);
  const historical = {
    ...parsed,
    products: parsed.products.map((product) => {
      const copy = { ...product };
      for (const field of ['image', 'kitchen_route']) delete copy[field];
      return copy;
    }),
  };
  assert.equal(JSON.stringify(stripStorefrontPayload(parsed)), JSON.stringify(historical));
});

test('frozen strict storefront schema parses the stripped real menu with aggregator prices', () => {
  const payload = realMenuWithAggregatorPrices();
  assert.equal(payload.products.length, 54);
  const frozen = frozenStorefrontSchemas();
  // The full payload is refused by the installed clients: the strip is what protects them.
  assert.equal(frozen.Payload.safeParse(payload).success, false);
  const storefront = stripStorefrontPayload(payload);
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
    version: 13,
    published_at: '2026-11-16T05:00:00.000Z',
    payload: storefront,
  };
  assert.equal(frozen.Mobile.safeParse(envelope).success, true);
  assert.equal(frozen.Kiosk.safeParse({ ...envelope, channel: 'kiosk' }).success, true);
  assert.deepEqual(storefront.products[1].channel_prices_minor, {
    mobile: payload.products[1].price_minor,
  });
  assert.equal(
    storefront.products.filter((p) => p.channel_prices_minor).length,
    1,
    'only the mobile override is left',
  );
  // The cashier projection with the flag carries every aggregator price, nothing else changes.
  const menu = projectCatalogMenu(
    { ...payload, products: payload.products.map((p) => withoutMobile(p)) },
    branch,
    13,
    '2026-11-16T05:00:00.000Z',
    undefined,
    { aggregatorPrices: true },
  );
  assert.equal(menu.items.filter((i) => i.aggregator_prices_minor?.yandex_eda).length, 54);
  assert.equal(menu.items.filter((i) => i.aggregator_prices_minor?.glovo).length, 36);
});
const withoutMobile = (product) => {
  const prices = { ...product.channel_prices_minor };
  delete prices.mobile;
  return { ...product, channel_prices_minor: prices };
};

test('storefront pricing (mobile, kiosk) ignores aggregator prices', () => {
  const payload = realMenuWithAggregatorPrices();
  const reference = {
    organizationId: '10000000-0000-4000-8000-000000000001',
    branchId: branch,
    version: 13,
    payloadHash: payloadHash(payload),
    publishedAt: '2026-11-16T05:00:00.000Z',
  };
  const burger = payload.products.find((p) => p.id === 'burger');
  assert.ok(burger.channel_prices_minor.yandex_eda !== burger.price_minor);
  for (const channel of ['mobile', 'kiosk']) {
    const quote = priceCatalogSnapshot(
      { reference, orderingEnabled: true, payload },
      { organizationId: reference.organizationId, branchId: branch, customerId: null, channel },
      {
        catalog_version: 13,
        service_mode: 'takeaway',
        items: [{ sku: 'burger', quantity: 2, selections: [] }],
      },
    );
    assert.equal(quote.totalMinor, String(BigInt(burger.price_minor) * 2n), channel);
  }
});

test('CATALOG_AGGREGATOR_PRICES_ENABLED: off by default, only with edge publication, strict values', () => {
  const edge = {
    CATALOG_EDGE_PUBLICATION_ENABLED: 'true',
    CATALOG_EDGE_PUBLICATION_BRANCH_ID: branch,
  };
  assert.equal(catalogAdminOptions({}).edgeAggregatorPrices, undefined);
  assert.equal(catalogAdminOptions(edge).edgeAggregatorPrices, undefined);
  assert.equal(
    catalogAdminOptions({ ...edge, CATALOG_AGGREGATOR_PRICES_ENABLED: 'false' })
      .edgeAggregatorPrices,
    undefined,
  );
  assert.equal(
    catalogAdminOptions({ ...edge, CATALOG_AGGREGATOR_PRICES_ENABLED: 'true' })
      .edgeAggregatorPrices,
    true,
  );
  // Without the cashier publication the flag has nothing to publish to.
  assert.equal(
    catalogAdminOptions({ CATALOG_AGGREGATOR_PRICES_ENABLED: 'true' }).edgeAggregatorPrices,
    undefined,
  );
  for (const value of ['1', 'TRUE', 'yes', ''])
    assert.throws(
      () => catalogAdminOptions({ ...edge, CATALOG_AGGREGATOR_PRICES_ENABLED: value }),
      /CATALOG_AGGREGATOR_PRICES_CONFIGURATION_INVALID/,
    );
  // Stage 2 options are unchanged by the new flag.
  assert.deepEqual(catalogAdminOptions({ ...edge, CATALOG_AGGREGATOR_PRICES_ENABLED: 'true' }), {
    ...catalogAdminOptions(edge),
    edgeAggregatorPrices: true,
  });
});

test('catalog state: publication_support.aggregator_prices is either absent or true', () => {
  const state = {
    branch: { id: branch, code: 'SYN', name: 'Synthetic' },
    publication_support: { mobile: false, pos: true, kiosk: false },
    draft: null,
    published: null,
  };
  assert.deepEqual(CatalogStateSchema.parse(state), state);
  const on = {
    ...state,
    publication_support: { ...state.publication_support, aggregator_prices: true },
  };
  assert.deepEqual(CatalogStateSchema.parse(on), on);
  for (const value of [false, 'true', 1])
    assert.equal(
      CatalogStateSchema.safeParse({
        ...state,
        publication_support: { ...state.publication_support, aggregator_prices: value },
      }).success,
      false,
    );
});
