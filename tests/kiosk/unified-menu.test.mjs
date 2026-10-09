import test from 'node:test';
import { setImmediate } from 'node:timers';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  AVAILABILITY_LONG_POLL_MS,
  CommercialKioskController,
  MEDIA_RETRY_MS,
  applyAvailability,
  publishedKioskCatalog,
} from '../../apps/kiosk/src/commercial-controller.ts';
import {
  KIOSK_LONG_POLL_TIMEOUT_MS,
  commercialKioskRead,
} from '../../apps/kiosk/src/commercial-api.ts';
import { KioskError } from '../../apps/kiosk/src/api.ts';
import {
  CatalogMediaRegistry,
  DEFAULT_TILE,
  MEDIA_ID_PREFIX,
} from '../../apps/kiosk/src/photo-source.ts';
import { PLAIN_AVAILABILITY_MS, startKioskPolling } from '../../apps/kiosk/src/polling.ts';
import { mockupCatalogDraft } from '@pickchick/catalog-admin/seed';

const branchId = '7a6f6d98-395d-4462-b5e4-b0364a4a8ec1';
const iso = '2026-10-04T00:00:00Z';
const origin = 'https://kiosk.example.test';
const hex = (c) => c.repeat(64);
const entry = (c, extra = {}) => ({
  sha256: hex(c),
  card: `/v1/media/catalog/${hex(c)}.card.webp`,
  hero: `/v1/media/catalog/${hex(String.fromCharCode(c.charCodeAt(0) + 1))}.hero.webp`,
  thumb: `/v1/media/catalog/${hex(String.fromCharCode(c.charCodeAt(0) + 2))}.thumb.webp`,
  ...extra,
});

// --- photo resolver -------------------------------------------------------------------------
const CARD = 101,
  HERO = 102,
  SHOT = 103,
  LOGO = 104,
  APPLE = 105,
  ORANGE = 106;
const bundled = {
  card: (id) =>
    id === 'i7.jpg'
      ? { source: CARD, tile: '#FEFEFE', cutout: false }
      : id === 'i4.jpg'
        ? { source: CARD, tile: '#FEF8F0', cutout: true }
        : id === 'drink:piko'
          ? { source: APPLE, secondarySource: ORANGE, tile: '#FEF8F0', cutout: true }
          : null,
  hero: (id) => (id === 'i7.jpg' ? { source: HERO, tile: '#024ECA', cutout: false } : null),
  product: (id) => (id === 'i7.jpg' || id === 'i4.jpg' ? SHOT : undefined),
  logo: LOGO,
};

test('resolver is remote-first and falls back to bundled photo, mockup shot, then logo', () => {
  const r = new CatalogMediaRegistry(origin, bundled);
  const media = entry('a', { tile_color: '#112233', cutout: true });
  const id = r.artworkId({ id: 'pick-combo', image_id: 'i7.jpg', media });
  assert.equal(id, `${MEDIA_ID_PREFIX}pick-combo`);
  assert.deepEqual(r.photo(id, 'card'), {
    source: { uri: `${origin}${media.card}` },
    tile: '#112233',
    cutout: true,
    sha256: hex('a'),
  });
  assert.deepEqual(r.photo(id, 'hero').source, { uri: `${origin}${media.hero}` });
  assert.equal(r.photo(id, 'hero').sha256, hex('b'));
  assert.deepEqual(r.candidates(id, 'card'), [
    [{ uri: `${origin}${media.card}` }],
    [CARD],
    [SHOT],
    [LOGO],
  ]);
  assert.deepEqual(r.candidates(id, 'hero'), [
    [{ uri: `${origin}${media.hero}` }],
    [HERO],
    [SHOT],
    [LOGO],
  ]);
  // Without media the bundled chain is unchanged.
  assert.equal(r.artworkId({ id: 'pick-combo', image_id: 'i7.jpg' }), null);
  assert.deepEqual(r.photo('i7.jpg', 'card'), { source: CARD, tile: '#FEFEFE', cutout: false });
  assert.deepEqual(r.candidates('i7.jpg', 'card'), [[CARD], [SHOT], [LOGO]]);
  assert.deepEqual(r.candidates('drink:piko', 'card'), [[APPLE, ORANGE], [LOGO]]);
  assert.deepEqual(r.candidates('unknown.jpg', 'card'), [[LOGO]]);
  // An unregistered media id never resolves to a stale remote photo.
  assert.equal(r.photo(`${MEDIA_ID_PREFIX}missing`, 'card'), null);
  assert.deepEqual(r.candidates(`${MEDIA_ID_PREFIX}missing`, 'card'), [[LOGO]]);
});

test('tile colour and cutout come from media, then the image key, then white', () => {
  const r = new CatalogMediaRegistry(origin, bundled);
  const plain = r.artworkId({ id: 'fingers', image_id: 'i4.jpg', media: entry('c') });
  assert.equal(r.photo(plain, 'card').tile, '#FEF8F0');
  assert.equal(r.photo(plain, 'card').cutout, true);
  const combo = r.artworkId({ id: 'pick', image_id: 'i7.jpg', media: entry('d') });
  assert.equal(r.photo(combo, 'hero').tile, '#024ECA');
  assert.equal(r.photo(combo, 'card').cutout, false);
  const fresh = r.artworkId({ id: 'new-item', image_id: 'generic-x', media: entry('e') });
  assert.equal(r.photo(fresh, 'card').tile, DEFAULT_TILE);
  assert.equal(r.photo(fresh, 'card').cutout, false);
  const lower = r.artworkId({
    id: 'odd',
    image_id: 'i7.jpg',
    media: entry('f', { tile_color: '#abcdef', cutout: false }),
  });
  assert.equal(r.photo(lower, 'card').tile, '#FEFEFE', 'malformed tile colour is ignored');
  for (const card of [
    'https://evil.test/x.webp',
    `/v1/media/catalog/${hex('a')}.hero.webp`,
    `/v1/media/catalog/${hex('A')}.card.webp`,
    `/v1/media/catalog/${hex('a')}.card.webp?x=1`,
  ])
    assert.equal(
      r.artworkId({ id: 'x', image_id: 'i7.jpg', media: { ...entry('a'), card } }),
      null,
      card,
    );
});

test('bundled image keys use remote media only when unambiguous and already on disk', () => {
  const r = new CatalogMediaRegistry(origin, bundled);
  const urls = r.sync([
    { id: 'pick-combo', image_id: 'i7.jpg', media: entry('a') },
    { id: 'drink-1', image_id: 'generic-drink', media: entry('c') },
    { id: 'drink-2', image_id: 'generic-drink' },
    { id: 'fingers', image_id: 'i4.jpg' },
  ]);
  assert.deepEqual(urls.sort(), [
    `${origin}${entry('a').card}`,
    `${origin}${entry('a').hero}`,
    `${origin}${entry('c').card}`,
    `${origin}${entry('c').hero}`,
  ]);
  assert.equal(r.photo('i7.jpg', 'card').source, CARD, 'not prefetched yet');
  r.markReady(urls);
  assert.deepEqual(r.photo('i7.jpg', 'card').source, { uri: `${origin}${entry('a').card}` });
  assert.equal(r.photo('generic-drink', 'card'), null, 'a shared key stays bundled');
  assert.equal(r.photo('i4.jpg', 'card').source, CARD);
  // A republish without the photo drops the key index at once.
  r.sync([{ id: 'pick-combo', image_id: 'i7.jpg' }]);
  assert.equal(r.photo('i7.jpg', 'card').source, CARD);
});

// --- header-aware HTTP reads ----------------------------------------------------------------
test('kiosk read allows only the photo map and availability long-poll and parses signal headers', async () => {
  const device = { deviceId: randomUUID(), key: 'a'.repeat(64) };
  const token = 'b'.repeat(64);
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ fresh: true, products: [] }), {
      headers: {
        'content-type': 'application/json',
        'x-catalog-version': '7',
        'x-availability-signature': 'c'.repeat(64),
      },
    });
  };
  const ok = await commercialKioskRead(
    `/availability?after=${'d'.repeat(64)}`,
    token,
    fetcher,
    device,
    {
      timeoutMs: 60000,
    },
  );
  assert.deepEqual(ok, {
    data: { fresh: true, products: [] },
    catalogVersion: 7,
    signature: 'c'.repeat(64),
  });
  assert.match(seen[0].url, /\/v1\/kiosk-checkout\/availability\?after=d{64}$/);
  assert.equal(seen[0].init.method, 'GET');
  assert.equal(seen[0].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(seen[0].init.headers['X-Kiosk-Device'], device.deviceId);
  assert.equal(seen[0].init.redirect, 'error');
  await commercialKioskRead('/catalog/media?version=12', token, fetcher, device);
  assert.match(seen[1].url, /\/v1\/kiosk-checkout\/catalog\/media\?version=12$/);
  for (const path of [
    '/availability?after=XYZ',
    `/availability?after=${'d'.repeat(64)}&x=1`,
    '/catalog/media?version=0',
    '/catalog/media?version=1&version=2',
    '/catalog/media',
    '/quotes',
    '/orders',
    '/catalog',
  ])
    await assert.rejects(commercialKioskRead(path, token, fetcher, device), /INVALID_PATH/, path);
  await assert.rejects(
    commercialKioskRead('/availability', '', fetcher, device),
    /GUEST_IDENTITY_UNAVAILABLE/,
  );
  await assert.rejects(
    commercialKioskRead('/availability', token, fetcher),
    /DEVICE_NOT_PROVISIONED/,
  );
  const bad = await commercialKioskRead(
    '/availability',
    token,
    async () =>
      new Response('{}', {
        headers: {
          'content-type': 'application/json',
          'x-catalog-version': '01',
          'x-availability-signature': 'Z'.repeat(64),
        },
      }),
    device,
  );
  assert.equal(bad.catalogVersion, null);
  assert.equal(bad.signature, null);
  await assert.rejects(
    commercialKioskRead(
      '/availability',
      token,
      async () =>
        new Response(JSON.stringify({ code: 'FORBIDDEN' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      device,
    ),
    (error) => error instanceof KioskError && error.code === 'FORBIDDEN',
  );
  assert(AVAILABILITY_LONG_POLL_MS <= KIOSK_LONG_POLL_TIMEOUT_MS);
  assert(AVAILABILITY_LONG_POLL_MS > 25000, 'longer than the server long-poll window');
});

// --- controller -----------------------------------------------------------------------------
function storefront(version = 2) {
  return {
    branch: {
      id: branchId,
      code: 'pilot',
      name: 'PickChick',
      timezone: 'Asia/Almaty',
      ordering_enabled: true,
    },
    channel: 'kiosk',
    version,
    published_at: iso,
    payload: globalThis.structuredClone(mockupCatalogDraft),
  };
}
const availabilityBody = (catalog, stopped = new Set(), fresh = true) => ({
  fresh,
  products: catalog.payload.products.map((p) => ({
    productId: p.id,
    available: p.available && !stopped.has(p.id),
    stoppedOptions: [],
  })),
});
function fixture() {
  const h = {
    rawSession: null,
    rawFlow: null,
    clock: Date.parse(iso),
    calls: [],
    reads: [],
    catalog: storefront(2),
    head: 2,
    stopped: new Set(),
    fresh: true,
    signature: () =>
      createHash('sha256')
        .update(JSON.stringify({ head: h.head, stopped: [...h.stopped].sort(), fresh: h.fresh }))
        .digest('hex'),
    media: { version: 2, products: {} },
    mediaFail: false,
    hold: null,
  };
  const guestCheck = (token) => assert.equal(token, JSON.parse(h.rawSession).token);
  h.io = {
    readDevice: async () => JSON.stringify({ deviceId: randomUUID(), key: 'a'.repeat(64) }),
    readSession: async () => h.rawSession,
    writeSession: async (raw) => {
      h.rawSession = raw;
    },
    removeSession: async () => {
      h.rawSession = null;
    },
    readFlow: async () => h.rawFlow,
    writeFlow: async (raw) => {
      h.rawFlow = raw;
    },
    now: () => h.clock,
    uuid: randomUUID,
    request: async (path, token, body) => {
      h.calls.push({ path, token, body });
      if (path === '/sessions')
        return {
          sessionId: body.sessionId,
          branchId,
          organizationId: randomUUID(),
          expiresAt: new Date(h.clock + 86400000).toISOString(),
        };
      if (path === '/sessions/end') return { ended: true };
      guestCheck(token);
      if (path === '/config')
        return { enabled: true, branchId, restaurant: 'PickChick', paymentMethod: 'kaspi_qr' };
      if (path === '/catalog') return h.catalog;
      throw Error(path);
    },
    read: async (path, token, options) => {
      h.reads.push({ path, options });
      guestCheck(token);
      if (path.startsWith('/catalog/media?version=')) {
        if (h.mediaFail) throw new KioskError('NOT_FOUND', 404);
        const requested = Number(path.split('=')[1]);
        if (requested !== h.head) throw new KioskError('CONFLICT', 409);
        return { data: h.media, catalogVersion: null, signature: null };
      }
      assert.match(path, /^\/availability(\?after=[a-f0-9]{64})?$/);
      if (path.includes('after=') && h.hold) await h.hold;
      return {
        data: availabilityBody(h.catalog, h.stopped, h.fresh),
        catalogVersion: h.head,
        signature: h.signature(),
      };
    },
  };
  return h;
}
const first = (h) => h.catalog.payload.products[0];

test('menu load attaches the published photo map; image_id stays the bundled key', async () => {
  const h = fixture();
  const p = first(h);
  h.media = {
    version: 2,
    products: { [p.id]: entry('a', { tile_color: '#FFFFFF', cutout: true }), ghost: entry('c') },
  };
  const c = new CommercialKioskController(h.io);
  assert.equal(await c.restore(), true);
  const product = c.getSnapshot().catalog.products.find((x) => x.id === p.id);
  assert.equal(product.image_id, p.image_asset_key);
  assert.deepEqual(product.media, h.media.products[p.id]);
  assert.equal(
    c.getSnapshot().catalog.products.filter((x) => x.media).length,
    1,
    'unknown products in the map are ignored',
  );
  assert.deepEqual(
    h.reads.map((r) => r.path),
    ['/catalog/media?version=2', '/availability'],
  );
  // The map of a version is fetched once.
  assert.equal(await c.refresh(), undefined);
  assert.equal(h.reads.filter((r) => r.path.startsWith('/catalog/media')).length, 1);
  assert.equal(c.getSnapshot().catalog.products.find((x) => x.id === p.id).media.sha256, hex('a'));
});

test('a missing or mismatched photo map keeps bundled photos and is retried at most once a minute', async () => {
  const h = fixture();
  h.mediaFail = true;
  const c = new CommercialKioskController(h.io);
  assert.equal(await c.restore(), true);
  assert.equal(c.getSnapshot().error, null);
  assert(c.getSnapshot().catalog.products.every((x) => !x.media));
  await c.refresh();
  assert.equal(h.reads.filter((r) => r.path.startsWith('/catalog/media')).length, 1);
  h.mediaFail = false;
  h.media = { version: 3, products: { [first(h).id]: entry('a') } };
  h.clock += MEDIA_RETRY_MS;
  await c.refresh();
  assert.equal(h.reads.filter((r) => r.path.startsWith('/catalog/media')).length, 2);
  assert(
    c.getSnapshot().catalog.products.every((x) => !x.media),
    'map of another version',
  );
  h.media = {
    version: 2,
    products: { [first(h).id]: { ...entry('a'), card: 'https://evil.test/a.webp' } },
  };
  h.clock += MEDIA_RETRY_MS;
  await c.refresh();
  assert(
    c.getSnapshot().catalog.products.every((x) => !x.media),
    'schema-invalid map',
  );
  assert.equal(c.getSnapshot().error, null);
});

test('stops arrive on the start screen through the long-poll without marking the kiosk busy', async () => {
  const h = fixture();
  const c = new CommercialKioskController(h.io);
  await c.restore();
  assert.equal(c.getSnapshot().step, 'start');
  const id = first(h).id;
  let resolve;
  h.hold = new Promise((r) => (resolve = r));
  const signature = h.signature();
  const cycle = c.watchAvailability();
  await new Promise((r) => setImmediate(r));
  assert.equal(c.getSnapshot().busy, false, 'the long-poll never blocks the UI');
  const last = h.reads.at(-1);
  assert.equal(last.path, `/availability?after=${signature}`);
  assert.equal(last.options.timeoutMs, AVAILABILITY_LONG_POLL_MS);
  h.stopped.add(id);
  resolve();
  assert.equal(await cycle, 'changed');
  assert.equal(c.getSnapshot().catalog.products.find((p) => p.id === id).available, false);
  assert.equal(c.getSnapshot().catalog.catalog_version, '2');
  h.hold = null;
  assert.equal(await c.watchAvailability(), 'unchanged');
  h.stopped.clear();
  assert.equal(await c.watchAvailability(), 'changed');
  assert.equal(c.getSnapshot().catalog.products.find((p) => p.id === id).available, true);
  h.fresh = false;
  assert.equal(await c.watchAvailability(), 'changed');
  assert(
    c.getSnapshot().catalog.products.every((p) => p.available === false),
    'stale stays fail-closed',
  );
});

test('a newer publication reloads the catalog at once on the start screen', async () => {
  const h = fixture();
  const c = new CommercialKioskController(h.io);
  await c.restore();
  const catalogReads = () => h.calls.filter((r) => r.path === '/catalog').length;
  const before = catalogReads();
  h.catalog = storefront(3);
  h.catalog.payload.products[0].price_minor = '777700';
  h.head = 3;
  h.media = { version: 3, products: { [first(h).id]: entry('a') } };
  assert.equal(await c.watchAvailability(), 'reloaded');
  assert.equal(catalogReads(), before + 1);
  const snapshot = c.getSnapshot();
  assert.equal(snapshot.catalog.catalog_version, '3');
  assert.equal(snapshot.catalog.products[0].price_minor, '777700');
  assert.equal(snapshot.catalog.products[0].media.sha256, hex('a'));
  assert.equal(snapshot.step, 'start');
  assert.equal(snapshot.error, null);
});

test('mid-session a newer publication is not reloaded, but stops still apply', async () => {
  const h = fixture();
  const c = new CommercialKioskController(h.io);
  await c.restore();
  await c.start();
  await c.setMode('takeaway');
  const product = c.getSnapshot().catalog.products[0];
  const selections = product.modifier_groups.flatMap((g) =>
    g.options
      .filter((o) => o.default_quantity > 0)
      .map((o) => ({ group_id: g.id, option_id: o.id, quantity: o.default_quantity })),
  );
  assert.equal(await c.addToCart(product.id, selections), true);
  const catalogReads = h.calls.filter((r) => r.path === '/catalog').length;
  h.catalog = storefront(3);
  h.catalog.payload.products[0].price_minor = '777700';
  h.catalog.payload.products.push({
    ...h.catalog.payload.products[1],
    id: 'brand-new',
    sku: 'NEW-1',
  });
  h.head = 3;
  h.stopped.add(product.id);
  assert.equal(await c.watchAvailability(), 'changed');
  assert.equal(h.calls.filter((r) => r.path === '/catalog').length, catalogReads);
  const snapshot = c.getSnapshot();
  assert.equal(snapshot.step, 'menu');
  assert.equal(snapshot.catalog.catalog_version, '2');
  assert.notEqual(snapshot.catalog.products[0].price_minor, '777700');
  assert(!snapshot.catalog.products.some((p) => p.id === 'brand-new'));
  assert.equal(snapshot.unavailableCartLines.length, 1, 'stopped line is flagged, not removed');
  assert.equal(JSON.parse(h.rawFlow).cart.length, 1);
});

test('a finished guest gets the next session from the start screen so the poll continues', async () => {
  const h = fixture();
  const c = new CommercialKioskController(h.io);
  await c.restore();
  await c.start();
  await c.setMode('takeaway');
  assert.equal(await c.newGuest(), true);
  assert.equal(h.rawSession, null);
  assert.equal(await c.watchAvailability(), 'reloaded');
  assert(h.rawSession, 'a new guest session was allocated');
  assert.equal(JSON.parse(h.rawFlow).guestId, JSON.parse(h.rawSession).sessionId);
  assert.equal(await c.watchAvailability(), 'unchanged');
});

test('without the header-aware reader the kiosk keeps plain reads and bundled photos', async () => {
  const h = fixture();
  const read = h.io.read;
  delete h.io.read;
  h.io.request = ((request) => async (path, token, body) =>
    path === '/availability' ? (await read(path, token)).data : request(path, token, body))(
    h.io.request,
  );
  const c = new CommercialKioskController(h.io);
  assert.equal(await c.restore(), true);
  assert(c.getSnapshot().catalog.products.every((p) => !p.media));
  assert.equal(await c.watchAvailability(), 'unsupported');
});

test('lenient availability ignores unknown products and fails missing ones closed', () => {
  const base = publishedKioskCatalog(storefront(2));
  const [a, b] = base.products;
  const body = {
    fresh: true,
    products: [
      { productId: a.id, available: true, stoppedOptions: [] },
      { productId: 'from-a-newer-publication', available: true, stoppedOptions: [] },
    ],
  };
  const { menu } = applyAvailability(base, body, false);
  assert.equal(menu.products.find((p) => p.id === a.id).available, true);
  assert.equal(menu.products.find((p) => p.id === b.id).available, false);
  assert.throws(() => applyAvailability(base, body, true), /INVALID_RESPONSE/);
  assert.equal(base.products.find((p) => p.id === b.id).available, b.available, 'base not mutated');
  for (const broken of [null, { fresh: 'yes', products: [] }, { fresh: true, products: [{}] }])
    assert.throws(() => applyAvailability(base, broken, false), /INVALID_RESPONSE/);
});

// --- background loop with fake timers --------------------------------------------------------
test('the start screen picks up a stop within one long-poll cycle (fake timers)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse(iso) });
  const h = fixture();
  const c = new CommercialKioskController(h.io);
  await c.restore();
  const id = first(h).id;
  let resolve;
  h.hold = new Promise((r) => (resolve = r));
  const stop = startKioskPolling(c, () => true);
  t.after(stop);
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  t.mock.timers.tick(2999);
  await flush();
  assert.equal(h.reads.filter((r) => r.path.includes('after=')).length, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(h.reads.filter((r) => r.path.includes('after=')).length, 1, 'first cycle started');
  assert.equal(c.getSnapshot().catalog.products.find((p) => p.id === id).available, true);
  h.stopped.add(id);
  h.hold = new Promise(() => {});
  resolve();
  await flush();
  assert.equal(c.getSnapshot().catalog.products.find((p) => p.id === id).available, false);
  t.mock.timers.tick(0);
  await flush();
  assert.equal(
    h.reads.filter((r) => r.path.includes('after=')).length,
    2,
    'the next long-poll starts at once with the new signature',
  );
  assert.equal(c.getSnapshot().step, 'start');
});

test('the loop backs off on errors and spaces out plain reads', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse(iso) });
  const results = ['failed', 'failed', 'unsupported', 'idle', 'changed'];
  const at = [];
  const controller = {
    getSnapshot: () => ({
      ready: true,
      busy: false,
      catalog: {},
      step: 'start',
      order: null,
      recoveryRequired: false,
      error: null,
    }),
    refresh: async () => {},
    tick: async () => {},
    watchAvailability: async () => {
      at.push(Date.now() - Date.parse(iso));
      return results.shift() ?? 'idle';
    },
  };
  const stop = startKioskPolling(controller, () => true);
  t.after(stop);
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };
  for (let i = 0; i < 40; i++) {
    t.mock.timers.tick(1000);
    await flush();
  }
  // 3 s first cycle, then 3 s and 6 s backoff, then a plain-read pause, then the idle base delay.
  assert.deepEqual(at.slice(0, 5), [3000, 6000, 12000, 12000 + PLAIN_AVAILABILITY_MS, 30000]);
  // An inactive app never polls.
  const calls = at.length;
  const quiet = startKioskPolling(controller, () => false);
  t.after(quiet);
  stop();
  for (let i = 0; i < 10; i++) {
    t.mock.timers.tick(1000);
    await flush();
  }
  assert.equal(at.length, calls);
});
