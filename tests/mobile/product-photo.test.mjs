import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';
import { CatalogMediaMapSchema } from '@pickchick/catalog-admin/contracts';
import {
  mediaForVersion,
  mediaPrefetchUris,
  remoteMediaSource,
  resolveProductPhoto,
  seedImageKey,
} from '../../apps/mobile/src/product-photo.ts';
import {
  PUBLISHED_CATALOG_REFRESH_MS,
  catalogRefreshTarget,
  createCatalogRecovery,
  parseCatalogVersionHeader,
} from '../../apps/mobile/src/catalog-recovery.ts';
import { hasPhotoPilot } from '../../apps/mobile/src/product-photo-selection.ts';

const ORIGIN = 'https://pickchick.185.129.51.103.nip.io';
const sha = (c) => c.repeat(64);
const entry = (card, hero = sha('b'), thumb = sha('c')) => ({
  sha256: card,
  card: `/v1/media/catalog/${card}.card.webp`,
  hero: `/v1/media/catalog/${hero}.hero.webp`,
  thumb: `/v1/media/catalog/${thumb}.thumb.webp`,
});
const bundled = {
  byId: { burger: 'menu:burger', 'pick-combo': 'menu:pick-combo' },
  byKey: { 'shot.jpg': 'key:shot', 'i7.jpg': 'key:i7', 'i0.jpg': 'key:i0' },
  logo: 'logo',
};

test('photo precedence is uploaded remote photo, then the bundled key photo, then the logo', () => {
  assert.equal(seedImageKey('burger'), 'shot.jpg');
  assert.equal(seedImageKey('piko'), 'generic-drink');
  assert.equal(seedImageKey('unknown'), undefined);
  const burger = { id: 'burger', image: 'image:burger', imageKey: 'shot.jpg' };
  const media = entry(sha('a'));

  // 1. Remote: the variant URL on the API origin, cached under that rendition's own hash.
  for (const [variant, hash] of [
    ['card', sha('a')],
    ['hero', sha('b')],
    ['thumb', sha('c')],
  ]) {
    const photo = resolveProductPhoto(burger, media, variant, bundled, ORIGIN);
    assert.equal(photo.kind, 'remote');
    assert.deepEqual(photo.source, {
      uri: `${ORIGIN}/v1/media/catalog/${hash}.${variant}.webp`,
      cacheKey: hash,
    });
    assert.equal(photo.cacheKey, hash);
    // A remote photo always carries its bundled fallback for offline or failed loads.
    assert.deepEqual(photo.fallback, { kind: 'id', source: 'menu:burger' });
  }

  // 2. Bundled: the seed key keeps the context retouch; a back-office key wins over the id.
  assert.deepEqual(resolveProductPhoto(burger, undefined, 'card', bundled, ORIGIN), {
    kind: 'id',
    source: 'menu:burger',
  });
  assert.deepEqual(
    resolveProductPhoto({ ...burger, imageKey: 'i0.jpg' }, undefined, 'card', bundled, ORIGIN),
    { kind: 'key', source: 'key:i0' },
  );
  assert.deepEqual(
    resolveProductPhoto({ ...burger, imageKey: 'i0.jpg' }, media, 'card', bundled, ORIGIN).fallback,
    { kind: 'key', source: 'key:i0' },
  );
  // A seeded product without a context retouch uses its key photo.
  assert.deepEqual(
    resolveProductPhoto(
      { id: 'lemonade', image: 'x', imageKey: 'i0.jpg' },
      undefined,
      'card',
      bundled,
      ORIGIN,
    ),
    { kind: 'key', source: 'key:i0' },
  );
  // A new back-office product never borrows another product's retouch by id.
  assert.deepEqual(
    resolveProductPhoto(
      { id: 'new-wrap', image: 'x', imageKey: 'i7.jpg' },
      undefined,
      'card',
      { ...bundled, byId: { ...bundled.byId, 'new-wrap': 'menu:stale' } },
      ORIGIN,
    ),
    { kind: 'key', source: 'key:i7' },
  );

  // 3. Logo: a key without a bundled photo (generic-drink) on a product other than its seed.
  assert.deepEqual(
    resolveProductPhoto(
      { id: 'cola', image: 'x', imageKey: 'generic-drink' },
      undefined,
      'card',
      bundled,
      ORIGIN,
    ),
    { kind: 'logo', source: 'logo' },
  );

  // Design and legacy TEST/menu products have no published key: id retouch, then their image.
  assert.deepEqual(
    resolveProductPhoto(
      { id: 'burger', image: 'image:burger' },
      undefined,
      'card',
      bundled,
      ORIGIN,
    ),
    { kind: 'id', source: 'menu:burger' },
  );
  assert.deepEqual(
    resolveProductPhoto({ id: 'water', image: 'image:water' }, undefined, 'card', bundled, ORIGIN),
    { kind: 'key', source: 'image:water' },
  );
  // Own properties only: an inherited key never resolves.
  assert.deepEqual(
    resolveProductPhoto(
      { id: 'toString', image: 'x', imageKey: 'constructor' },
      undefined,
      'card',
      bundled,
      ORIGIN,
    ),
    { kind: 'logo', source: 'logo' },
  );
});

test('only immutable hash paths of the requested variant on an https API origin become remote', () => {
  const good = entry(sha('d'));
  assert.ok(remoteMediaSource(good, 'card', ORIGIN));
  assert.ok(remoteMediaSource(good, 'card', 'https://api.pickchick.kz'));
  for (const [media, variant, origin] of [
    [undefined, 'card', ORIGIN],
    [{ ...good, card: good.hero }, 'card', ORIGIN],
    [{ ...good, card: `/v1/media/catalog/${sha('D')}.card.webp` }, 'card', ORIGIN],
    [
      { ...good, card: `https://evil.example/v1/media/catalog/${sha('d')}.card.webp` },
      'card',
      ORIGIN,
    ],
    [{ ...good, card: `/v1/media/catalog/${sha('d')}.card.webp?x=1` }, 'card', ORIGIN],
    [{ ...good, card: `/v1/media/catalog/../${sha('d')}.card.webp` }, 'card', ORIGIN],
    [{ ...good, card: 42 }, 'card', ORIGIN],
    [good, 'card', 'http://pickchick.185.129.51.103.nip.io'],
    [good, 'card', `${ORIGIN}/`],
  ]) {
    assert.equal(remoteMediaSource(media, variant, origin), null, JSON.stringify([media, origin]));
    const photo = resolveProductPhoto(
      { id: 'burger', image: 'x', imageKey: 'shot.jpg' },
      media,
      variant,
      bundled,
      origin,
    );
    assert.equal(photo.kind, 'id');
  }
});

test('media maps apply only to their own publication version and prefetch each rendition once', () => {
  const map = CatalogMediaMapSchema.parse({
    version: 4,
    products: { burger: entry(sha('a')), cola: entry(sha('e'), sha('b'), sha('c')) },
  });
  assert.deepEqual(Object.keys(mediaForVersion(map, 4)), ['burger', 'cola']);
  assert.deepEqual(mediaForVersion(map, 3), {});
  assert.deepEqual(mediaForVersion(null, 4), {});
  const uris = mediaPrefetchUris(map, ORIGIN);
  assert.deepEqual(uris.sort(), [
    `${ORIGIN}/v1/media/catalog/${sha('a')}.card.webp`,
    `${ORIGIN}/v1/media/catalog/${sha('b')}.hero.webp`,
    `${ORIGIN}/v1/media/catalog/${sha('c')}.thumb.webp`,
    `${ORIGIN}/v1/media/catalog/${sha('e')}.card.webp`,
  ]);
  assert.deepEqual(mediaPrefetchUris(null, ORIGIN), []);
  assert.deepEqual(mediaPrefetchUris(map, 'http://insecure.example'), []);
});

test('products with an uploaded hero open the photo product page', () => {
  assert.equal(hasPhotoPilot('burger'), true);
  assert.equal(hasPhotoPilot({ id: 'burger' }), true);
  assert.equal(hasPhotoPilot('new-wrap'), false);
  assert.equal(hasPhotoPilot({ id: 'new-wrap' }), false);
  assert.equal(hasPhotoPilot({ id: 'new-wrap', media: entry(sha('a')) }), true);
});

const capabilities = {
  schema_version: 1,
  environment: 'staging',
  data_mode: 'synthetic',
  ordering_enabled: false,
  features: { phone_auth: false, payments: false, fiscal: false, checkout: false, loyalty: false },
};
const branch = {
  id: '10000000-0000-4000-8000-000000000003',
  code: 'test',
  name: 'Synthetic',
  timezone: 'Asia/Almaty',
  ordering_enabled: true,
};

async function publication() {
  const { mockupCatalogDraft } = await import('@pickchick/catalog-admin/seed');
  return {
    branch,
    channel: 'mobile',
    version: 5,
    published_at: '2026-10-08T00:00:00.000Z',
    payload: { ...mockupCatalogDraft, content_source: 'operator', content_reviewed: true },
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('the published catalog is the default and its media map is read for the loaded version', async (t) => {
  const { loadCatalog, publishedCatalogEnabled } = await import('../../apps/mobile/src/api.ts');
  const previous = process.env.EXPO_PUBLIC_PUBLISHED_CATALOG;
  t.after(() => {
    if (previous === undefined) delete process.env.EXPO_PUBLIC_PUBLISHED_CATALOG;
    else process.env.EXPO_PUBLIC_PUBLISHED_CATALOG = previous;
  });
  const storefront = await publication();
  const media = { version: 5, products: { burger: entry(sha('a')) } };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const parsed = new URL(url);
    calls.push(parsed.pathname + parsed.search);
    assert.equal(parsed.origin, ORIGIN);
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    if (parsed.pathname === '/v1/capabilities') return json(capabilities);
    if (parsed.pathname === '/v1/customer-checkout/catalog') return json(storefront);
    if (parsed.pathname === '/v1/customer-checkout/catalog/media') return json(media);
    throw new Error('unexpected ' + parsed.pathname);
  });
  for (const value of [undefined, '1', 'true', '']) {
    if (value === undefined) delete process.env.EXPO_PUBLIC_PUBLISHED_CATALOG;
    else process.env.EXPO_PUBLIC_PUBLISHED_CATALOG = value;
    assert.equal(publishedCatalogEnabled(), true);
    calls.length = 0;
    const result = await loadCatalog(null);
    assert.equal(result.publication.version, 5);
    assert.equal(result.menu, null);
    assert.deepEqual(result.media, media);
    assert.deepEqual(calls.sort(), [
      '/v1/capabilities',
      '/v1/customer-checkout/catalog',
      '/v1/customer-checkout/catalog/media?version=5',
    ]);
  }
  process.env.EXPO_PUBLIC_PUBLISHED_CATALOG = '0';
  assert.equal(publishedCatalogEnabled(), false);
});

test('a failing media map keeps the published catalog with bundled photos', async (t) => {
  const { loadCatalog, loadCatalogMedia } = await import('../../apps/mobile/src/api.ts');
  delete process.env.EXPO_PUBLIC_PUBLISHED_CATALOG;
  const storefront = await publication();
  let mediaResponse;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(url).pathname;
    if (path === '/v1/capabilities') return json(capabilities);
    if (path === '/v1/customer-checkout/catalog') return json(storefront);
    return mediaResponse();
  });
  const failures = {
    'route missing (404)': () => json({ code: 'NOT_FOUND' }, 404),
    'version moved (409)': () => json({ code: 'CONFLICT' }, 409),
    'server error': () => json({ code: 'INTERNAL' }, 500),
    'network error': () => Promise.reject(new TypeError('Network request failed')),
    'html body': () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    'other version': () => json({ version: 4, products: {} }),
    'external url': () =>
      json({
        version: 5,
        products: { burger: { ...entry(sha('a')), card: 'https://evil.example/x.webp' } },
      }),
    'unknown field': () => json({ version: 5, products: {}, extra: true }),
  };
  for (const [name, response] of Object.entries(failures)) {
    mediaResponse = response;
    const result = await loadCatalog(null);
    assert.equal(result.publication.version, 5, name);
    assert.deepEqual(result.media, { version: 5, products: {} }, name);
  }
  assert.deepEqual(await loadCatalogMedia(0), { version: 0, products: {} });
  // An aborted load never reports a catalog, even though the media read itself is tolerant.
  const controller = new AbortController();
  mediaResponse = () => {
    controller.abort();
    return json({ version: 5, products: {} });
  };
  await assert.rejects(loadCatalog(null, controller.signal), /Aborted/);
});

test('X-Catalog-Version parsing and refresh decision only react to a newer head once', () => {
  for (const [header, value] of [
    ['7', 7],
    [' 12 ', 12],
    ['999999999', 999999999],
    [null, null],
    [undefined, null],
    ['', null],
    ['0', null],
    ['-1', null],
    ['07', null],
    ['1.5', null],
    ['1e3', null],
    ['1000000000', null],
    ['7, 8', null],
  ])
    assert.equal(parseCatalogVersionHeader(header), value, String(header));
  assert.equal(catalogRefreshTarget(6, 5, null), 6);
  assert.equal(catalogRefreshTarget(6, 5, 6), null, 'already requested');
  assert.equal(catalogRefreshTarget(7, 5, 6), 7, 'a newer head while loading');
  assert.equal(catalogRefreshTarget(5, 5, null), null);
  assert.equal(catalogRefreshTarget(4, 5, null), null, 'never moves back');
  assert.equal(catalogRefreshTarget(null, 5, null), null);
  assert.equal(catalogRefreshTarget(6, null, null), null, 'no published catalog loaded');
});

function recoveryHarness(t, load, successDelay) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const recovery = createCatalogRecovery({
    load,
    random: () => 1,
    isRetryable: () => true,
    onLoading: (background) => events.push(['loading', background]),
    onSuccess: (value) => events.push(['success', value]),
    onFailure: (_error, background) => events.push(['failure', background]),
    successDelay,
  });
  t.after(() => recovery.stop());
  const advance = async (ms) => {
    t.mock.timers.tick(ms);
    await flush();
  };
  return { recovery, events, advance };
}

test('a version header bump re-reads the catalog in the background exactly once', async (t) => {
  let version = 5;
  let release;
  const h = recoveryHarness(
    t,
    () =>
      new Promise((resolve) => {
        release = () => resolve(version);
      }),
    () => null,
  );
  h.recovery.setActive(true);
  await flush();
  // The long-poll reports v6 while the activation read is still running: one more read follows.
  h.recovery.refresh();
  h.recovery.refresh();
  version = 6;
  release();
  await flush();
  await flush();
  assert.deepEqual(h.events, [
    ['loading', false],
    ['success', 6],
    ['loading', true],
  ]);
  release();
  await flush();
  assert.deepEqual(h.events.at(-1), ['success', 6]);
  // An idle refresh starts at once without the activation loading state.
  h.recovery.refresh();
  await flush();
  assert.deepEqual(h.events.at(-1), ['loading', true]);
  release();
  await flush();
  await h.advance(PUBLISHED_CATALOG_REFRESH_MS * 3);
  assert.equal(h.events.filter(([kind]) => kind === 'loading').length, 3, 'null keeps read-once');
  h.recovery.setActive(false);
  h.recovery.refresh();
  await flush();
  assert.equal(h.events.filter(([kind]) => kind === 'loading').length, 3, 'inactive ignores it');
});

test('published catalogs are re-read every minute in the foreground; failures stay background', async (t) => {
  let calls = 0;
  let offline = false;
  const h = recoveryHarness(
    t,
    async () => {
      calls++;
      if (offline) throw new Error('offline');
      return calls;
    },
    () => PUBLISHED_CATALOG_REFRESH_MS,
  );
  h.recovery.setActive(true);
  await flush();
  assert.equal(calls, 1);
  await h.advance(PUBLISHED_CATALOG_REFRESH_MS - 1);
  assert.equal(calls, 1);
  await h.advance(1);
  assert.equal(calls, 2);
  offline = true;
  await h.advance(PUBLISHED_CATALOG_REFRESH_MS);
  assert.deepEqual(h.events.slice(-2), [
    ['loading', true],
    ['failure', true],
  ]);
  offline = false;
  await h.advance(2000);
  assert.deepEqual(h.events.slice(-2), [
    ['loading', true],
    ['success', 4],
  ]);
  h.recovery.setActive(false);
  await h.advance(PUBLISHED_CATALOG_REFRESH_MS * 2);
  assert.equal(calls, 4, 'no re-read in the background state');
  h.recovery.setActive(true);
  await flush();
  assert.deepEqual(h.events.at(-2), ['loading', false]);
});
