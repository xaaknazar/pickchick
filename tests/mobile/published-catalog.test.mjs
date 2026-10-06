import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers';
import {
  publishedProductData,
  publishedCartVersion,
} from '../../apps/mobile/src/published-catalog.ts';
import { pricingFixture, product, group, option } from '../helpers/catalog-pricing.mjs';
import { catalogAdminOptions } from '../../packages/catalog-admin/dist/index.js';

test('published mobile projection retains identities, text, nutrition and modifier defaults with channel/base pricing', () => {
  const f = pricingFixture([
    product('burger', {
      name: { ru: 'Бургер', kk: 'Бургер KZ' },
      channel_prices_minor: { mobile: '0' },
      modifier_groups: [
        group(
          [option('extra', { default_quantity: 1, price_delta_minor: '123', max_quantity: 2 })],
          { min: 1 },
        ),
      ],
    }),
    product('side'),
  ]);
  const publication = {
    branch: { id: f.scope.branchId },
    version: 7,
    payload: f.publication.payload,
  };
  const products = publishedProductData(publication, 'kk');
  assert.equal(products[0].name, 'Бургер KZ');
  assert.equal(products[0].priceMinor, '0');
  assert.equal(products[1].priceMinor, f.publication.payload.products[1].price_minor);
  assert.deepEqual(products[0].nutrition, f.publication.payload.products[0].nutrition);
  assert.deepEqual(products[0].modifierGroups[0].options[0], {
    id: 'extra',
    label: 'extra',
    price_delta_minor: '123',
    default_quantity: 1,
    max_quantity: 2,
    available: true,
  });
  const cart = [{ product: products[0], quantity: 1 }];
  assert.equal(publishedCartVersion(cart, f.scope.branchId), 7);
  assert.throws(() => publishedCartVersion(cart, randomUUID()), /CONFLICT/);
  assert.throws(
    () =>
      publishedCartVersion(
        [
          ...cart,
          {
            product: { ...products[1], catalogVersion: `published:${f.scope.branchId}:8` },
            quantity: 1,
          },
        ],
        f.scope.branchId,
      ),
    /CONFLICT/,
  );
  assert.throws(
    () =>
      publishedCartVersion([...cart, { product: { id: 'legacy' }, quantity: 1 }], f.scope.branchId),
    /CONFLICT/,
  );
  assert.equal(
    publishedCartVersion(
      [{ product: { id: 'legacy', catalogVersion: 'mockup-v0.3' }, quantity: 1 }],
      f.scope.branchId,
    ),
    undefined,
  );
});

test('mobile rollout gate defaults closed and refuses invalid or unconfigured activation', () => {
  assert.deepEqual(catalogAdminOptions({}), { enabled: false });
  for (const env of [
    { CATALOG_MOBILE_STOREFRONT_ENABLED: '1' },
    { CATALOG_MOBILE_STOREFRONT_ENABLED: 'true' },
    { CATALOG_MOBILE_STOREFRONT_ENABLED: 'true', CUSTOMER_KASPI_BRANCH_ID: randomUUID() },
  ])
    assert.throws(() => catalogAdminOptions(env), /CONFIGURATION_INVALID/);
  const branch = randomUUID();
  assert.equal(
    catalogAdminOptions({
      CATALOG_MOBILE_STOREFRONT_ENABLED: 'true',
      CUSTOMER_KASPI_BRANCH_ID: branch,
      CUSTOMER_KASPI_PILOT_ENABLED: 'true',
    }).mobileStorefrontBranchId,
    branch,
  );
});

test('explicit live catalog loading uses the checkout branch and never falls back to old menus', async () => {
  const { loadCatalog } = await import('../../apps/mobile/src/api.ts');
  const previousFetch = globalThis.fetch,
    previousFlag = process.env.EXPO_PUBLIC_PUBLISHED_CATALOG;
  const f = pricingFixture();
  const calls = [];
  const publication = {
    branch: {
      id: f.scope.branchId,
      code: 'SYNTHETIC',
      name: 'Current synthetic restaurant',
      timezone: 'Asia/Almaty',
      ordering_enabled: true,
    },
    channel: 'mobile',
    version: 3,
    published_at: '2026-10-03T00:00:00.000Z',
    payload: f.publication.payload,
  };
  const capabilities = {
    schema_version: 1,
    environment: 'staging',
    data_mode: 'pilot',
    ordering_enabled: false,
    features: {
      phone_auth: true,
      test_order_flow: true,
      payments: false,
      fiscal: false,
      checkout: false,
      loyalty: false,
    },
  };
  let missing = false;
  process.env.EXPO_PUBLIC_PUBLISHED_CATALOG = '1';
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === '/v1/customer-checkout/catalog' && missing)
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    assert.ok(['/v1/capabilities', '/v1/customer-checkout/catalog'].includes(path));
    return new Response(JSON.stringify(path.endsWith('/catalog') ? publication : capabilities), {
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const value = await loadCatalog(randomUUID());
    assert.equal(value.branch.id, f.scope.branchId);
    assert.equal(value.menu, null);
    assert.equal(value.publication.version, 3);
    missing = true;
    await assert.rejects(loadCatalog(null));
    assert.ok(calls.every((path) => !path.includes('/test/') && !path.includes('/menu')));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousFlag === undefined) delete process.env.EXPO_PUBLIC_PUBLISHED_CATALOG;
    else process.env.EXPO_PUBLIC_PUBLISHED_CATALOG = previousFlag;
  }
});

test('explicit cart refresh retains quantity and modifiers and names removed unavailable lines', async () => {
  const { reconcilePublishedCart } = await import('../../apps/mobile/src/published-catalog.ts');
  const f = pricingFixture([
    product('burger', {
      modifier_groups: [group([option('extra', { price_delta_minor: '100', max_quantity: 2 })])],
    }),
    product('side'),
  ]);
  const publication = {
    branch: { id: f.scope.branchId },
    version: 1,
    payload: f.publication.payload,
  };
  const previous = publishedProductData(publication, 'ru').map((p) => ({ ...p, image: 1 }));
  const cart = [
    {
      product: previous[0],
      quantity: 3,
      selections: [{ group_id: 'side', option_id: 'extra', quantity: 2 }],
    },
    { product: previous[1], quantity: 2, selections: [] },
  ];
  const current = previous.map((p) => ({
    ...p,
    priceMinor: '20000',
    catalogVersion: `published:${f.scope.branchId}:2`,
  }));
  const refreshed = reconcilePublishedCart(cart, [current[0]]);
  assert.equal(cart.length, 2);
  assert.equal(cart[0].product.catalogVersion, `published:${f.scope.branchId}:1`);
  assert.equal(refreshed.cart[0].quantity, 3);
  assert.deepEqual(refreshed.cart[0].selections, cart[0].selections);
  assert.equal(refreshed.cart[0].product.priceMinor, '20000');
  assert.deepEqual(refreshed.removed, [previous[1].name]);
});

test('legacy cart migration preserves old price, photos and selections until explicit refresh', async () => {
  const { restoreLegacyPublishedCart, publishedCartStorageRelease, reconcilePublishedCart } =
    await import('../../apps/mobile/src/published-catalog.ts');
  const { cartTotal, defaultSelections } = await import('../../apps/mobile/src/domain.ts');
  const legacy = {
    id: 'pick-combo',
    name: 'PickCombo',
    source: 'design',
    image: 123,
    catalogVersion: 'mockup-v0.3',
    priceMinor: '419000',
    modifierGroups: [
      {
        id: 'drink',
        min: 1,
        max: 1,
        options: [
          {
            id: 'cola',
            label: 'Cola',
            default_quantity: 1,
            max_quantity: 1,
            price_delta_minor: '0',
          },
          {
            id: 'water',
            label: 'Water',
            default_quantity: 0,
            max_quantity: 1,
            price_delta_minor: '1000',
          },
        ],
      },
    ],
  };
  const saved = {
    catalogMode: 'server',
    releaseId: 'test:mockup-v0.3',
    lines: [
      {
        id: legacy.id,
        quantity: 2,
        selections: [{ group_id: 'drink', option_id: 'water', quantity: 1 }],
      },
    ],
  };
  const restored = restoreLegacyPublishedCart(saved, [legacy]);
  assert.equal(cartTotal(restored), '840000');
  assert.equal(restored[0].product.image, 123);
  assert.deepEqual(restored[0].selections, saved.lines[0].selections);
  assert.equal(publishedCartStorageRelease(restored, 'published:branch:3'), saved.releaseId);
  assert.equal(publishedCartVersion(restored, 'branch'), undefined);
  // A restart still restores the exact old catalog, never current publication prices.
  assert.equal(
    cartTotal(
      restoreLegacyPublishedCart(
        { ...saved, releaseId: publishedCartStorageRelease(restored, 'published:branch:3') },
        [legacy],
      ),
    ),
    '840000',
  );
  const current = {
    ...legacy,
    source: 'server',
    priceMinor: '10000',
    catalogVersion: 'published:branch:3',
    modifierGroups: [
      {
        ...legacy.modifierGroups[0],
        options: legacy.modifierGroups[0].options.map((o) => ({
          ...o,
          price_delta_minor: o.id === 'water' ? '2500' : '0',
        })),
      },
    ],
  };
  const refreshed = reconcilePublishedCart(restored, [current]).cart;
  assert.equal(cartTotal(refreshed), '25000');
  assert.equal(cartTotal(restored), '840000');
  assert.equal(publishedCartVersion(refreshed, 'branch'), 3);
  assert.deepEqual(refreshed[0].selections, saved.lines[0].selections);
  assert.deepEqual(defaultSelections(current), [
    { group_id: 'drink', option_id: 'cola', quantity: 1 },
  ]);
  assert.deepEqual(
    restoreLegacyPublishedCart({ ...saved, releaseId: 'unknown-release' }, [legacy]),
    [],
  );
  assert.equal(publishedCartStorageRelease([], 'published:branch:3'), 'published:branch:3');
});

test('published catalog failure waits for sibling read before recovery can retry', async () => {
  const { loadCatalog } = await import('../../apps/mobile/src/api.ts');
  const previousFetch = globalThis.fetch;
  const previousFlag = process.env.EXPO_PUBLIC_PUBLISHED_CATALOG;
  let finishCapabilities;
  let settled = false;
  process.env.EXPO_PUBLIC_PUBLISHED_CATALOG = '1';
  globalThis.fetch = async (url) => {
    if (new URL(url).pathname === '/v1/customer-checkout/catalog')
      return new Response('{}', { status: 503 });
    return new Promise((resolve) => {
      finishCapabilities = () =>
        resolve(
          new Response('{}', {
            headers: { 'content-type': 'application/json' },
          }),
        );
    });
  };
  try {
    const pending = loadCatalog(null).catch((error) => {
      settled = true;
      return error;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    finishCapabilities();
    assert.ok((await pending) instanceof Error);
    assert.equal(settled, true);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousFlag === undefined) delete process.env.EXPO_PUBLIC_PUBLISHED_CATALOG;
    else process.env.EXPO_PUBLIC_PUBLISHED_CATALOG = previousFlag;
  }
});

test('legacy checkout upgrade rejection has an actionable application update message', async () => {
  const { checkoutError } = await import('../../apps/mobile/src/commerce-presentation.ts');
  assert.equal(
    checkoutError(new Error('CATALOG_UPGRADE_REQUIRED')),
    'Обновите приложение, чтобы получить актуальное меню и цены ресторана.',
  );
});
