/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { localSelectionIds, provisionDevice } from '@pickchick/menu-sync';
import {
  CatalogMediaMapSchema,
  CatalogMobileStorefrontSchema,
  CatalogPayloadSchema,
  CatalogProductSchema,
} from '@pickchick/catalog-admin/contracts';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import {
  CustomerCheckout,
  KioskCheckout,
  KioskSessions,
  catalogMediaMap,
  parseCatalogMediaVersion,
  pollAvailability,
} from '../dist/index.js';
import { catalogPayload, publishCatalog } from './catalog-fixture.mjs';

// Same explicit localhost fixtures as the other commerce suites; never read a private server env.
process.env.APP_ENV ??= 'test';
process.env.CLOUD_DATABASE_URL ??=
  process.env.COMMERCE_TEST_DATABASE_URL ??
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55432/pickchick_cloud';
process.env.EDGE_DATABASE_URL ??=
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55433/pickchick_edge';
process.env.EDGE_BRANCH_ID ??= randomUUID();
process.env.REDIS_URL ??= 'redis://127.0.0.1:56379/0';
for (const name of ['CLOUD_DATABASE_URL', 'EDGE_DATABASE_URL'])
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env[name]).hostname));

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Smallest bytes the catalog_asset_variants CHECKs accept: a RIFF/WEBP header, unique filler. */
const webp = (seed) => {
  const body = Buffer.from(`synthetic-${seed}-${randomUUID()}`);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'ascii');
  return Buffer.concat([header, body]);
};
/** The strict product shape bundled in kiosk build 7 and the mobile TestFlight build. */
const OldProductSchema = CatalogProductSchema.omit({ image: true, kitchen_route: true });
const OldStorefrontSchema = (channel) =>
  z.strictObject({
    ...CatalogMobileStorefrontSchema.shape,
    channel: z.literal(channel),
    payload: z.strictObject({
      ...CatalogPayloadSchema.shape,
      products: z.array(OldProductSchema).min(1).max(100),
    }),
  });

async function fixture(run) {
  await withSyncDatabases(async (ctx) => {
    const pool = ctx.cloud.pool,
      scope = { organizationId: ctx.org, branchId: ctx.branch },
      kiosk = randomUUID(),
      deviceKey = randomBytes(32).toString('hex');
    // An active, bound edge device with a fresh heartbeat, as the transport leaves it.
    await provisionDevice(pool, ctx.device);
    await pool.query(
      'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
      [ctx.branch, ctx.org, ctx.device, randomUUID()],
    );
    await pool.query(
      "INSERT INTO cloud_branch_availability(branch_id,device_id,revision,stopped_ids) VALUES($1,$2,1,'{}')",
      [ctx.branch, ctx.device],
    );
    await pool.query(
      'INSERT INTO kiosk_devices(id,organization_id,branch_id,token_hash) VALUES($1,$2,$3,$4)',
      [kiosk, ctx.org, ctx.branch, sha(deviceKey)],
    );
    const sessions = new KioskSessions(pool, { piiKey: randomBytes(32) });
    const token = randomBytes(32).toString('hex');
    await sessions.start(kiosk, deviceKey, { sessionId: randomUUID(), token });
    const guest = await sessions.authenticate(kiosk, deviceKey, token);
    const kioskCheckout = new KioskCheckout(
      pool,
      {
        ...scope,
        paymentAccountId: randomUUID(),
        paymentMethod: 'kaspi_invoice',
        fiscalPolicy: 'deferred_pilot',
        approvalReference: 'Synthetic storefront test only',
        taxCode: 'PENDING_PILOT',
        maxOrderMinor: '50000',
        hours: { openingTime: '10:00', closingTime: '00:00', timeZone: 'Asia/Almaty' },
      },
      sessions,
    );
    const customerOptions = {
      ...scope,
      paymentAccountId: randomUUID(),
      customerIds: [randomUUID()],
      publishedCatalogEnabled: true,
      maxOrderMinor: '10000',
      approvalReference: 'Synthetic storefront test only',
    };
    const customer = new CustomerCheckout(pool, customerOptions);
    const publish = (version, payload) => publishCatalog({ pool, scope }, { version, payload });
    const manager = async (organizationId = ctx.org) => {
      const id = randomUUID();
      await pool.query(
        "INSERT INTO catalog_managers(id,organization_id,name,token_hash) VALUES($1,$2,'Synthetic media fixture',$3)",
        [id, organizationId, sha(id)],
      );
      return id;
    };
    /** An uploaded photo exactly as WP-F stores it: three content-addressed WebP renditions. */
    const asset = async (organizationId = ctx.org, variants = ['card', 'hero', 'thumb']) => {
      const id = randomUUID(),
        bytes = Object.fromEntries(variants.map((variant) => [variant, webp(variant)])),
        hero = bytes.hero ?? webp('hero');
      await pool.query(
        'INSERT INTO catalog_assets(id,organization_id,sha256,source_sha256,width,height,uploaded_by) VALUES($1,$2,$3,$4,900,700,$5)',
        [id, organizationId, sha(hero), sha(webp('source')), await manager(organizationId)],
      );
      for (const [variant, value] of Object.entries(bytes))
        await pool.query(
          'INSERT INTO catalog_asset_variants(asset_id,variant,sha256,width,height,bytes) VALUES($1,$2,$3,200,150,$4)',
          [id, variant, sha(value), value],
        );
      return {
        id,
        card: bytes.card ? sha(bytes.card) : sha(webp('missing')),
        hero: bytes.hero ? sha(bytes.hero) : undefined,
        thumb: bytes.thumb ? sha(bytes.thumb) : undefined,
      };
    };
    await run({
      ...ctx,
      pool,
      scope,
      guest,
      sessions,
      kiosk,
      deviceKey,
      kioskCheckout,
      customer,
      customerOptions,
      publish,
      asset,
      manager,
    });
  });
}

/** Burger with an uploaded photo and an explicit kitchen route, as WP-A/WP-F publish it. */
function unifiedPayload(image, { price = '10000', sauceImage } = {}) {
  const payload = structuredClone(catalogPayload(price));
  payload.products[0].image = image;
  payload.products[0].kitchen_route = 'prep';
  if (sauceImage) payload.products[1].image = sauceImage;
  payload.products[1].kitchen_route = 'assembly_item';
  return CatalogPayloadSchema.parse(payload);
}

test('storefront catalogs strip the photo ref and kitchen route so installed strict clients parse', () =>
  fixture(async (f) => {
    const photo = await f.asset();
    const payload = unifiedPayload({
      asset_id: photo.id,
      sha256: photo.card,
      tile_color: '#02448C',
      cutout: true,
    });
    await f.publish(1, payload);
    for (const [channel, read] of [
      ['mobile', () => f.customer.catalog()],
      ['kiosk', () => f.kioskCheckout.catalog(f.guest)],
    ]) {
      const catalog = await read();
      for (const product of catalog.payload.products) {
        assert.equal('image' in product, false);
        assert.equal('kitchen_route' in product, false);
        assert.equal(product.image_asset_key, 'i0.jpg');
      }
      // The exact old strict schema (no unified-menu fields) accepts the whole response.
      OldStorefrontSchema(channel).parse(catalog);
      assert.throws(() =>
        OldStorefrontSchema(channel).parse({
          ...catalog,
          payload: { ...catalog.payload, products: payload.products },
        }),
      );
      assert.equal(catalog.version, 1);
      assert.deepEqual(
        catalog.payload.products.map((p) => p.price_minor),
        payload.products.map((p) => p.price_minor),
      );
    }
    // The stored publication keeps the ref: only the storefront response is stripped.
    const stored = (
      await f.pool.query('SELECT payload FROM catalog_publications WHERE branch_id=$1', [f.branch])
    ).rows[0].payload;
    assert.equal(stored.products[0].image.asset_id, photo.id);
    assert.equal(stored.products[0].kitchen_route, 'prep');
  }));

test('media map lists only stored renditions of the head version; other versions are a conflict', () =>
  fixture(async (f) => {
    const otherOrganization = randomUUID();
    await f.pool.query("INSERT INTO organizations(id,name) VALUES($1,'Other synthetic')", [
      otherOrganization,
    ]);
    // The same photo bytes of another organisation never resolve for this branch.
    const photo = await f.asset(),
      foreign = await f.asset(otherOrganization),
      partial = await f.asset(f.org, ['card', 'thumb']);
    // No publication yet: the storefront is not ready.
    await assert.rejects(f.customer.catalogMedia('1', { mediaEnabled: true }), {
      code: 'NOT_READY',
    });
    const media = { mediaEnabled: true };
    await f.publish(
      1,
      unifiedPayload(
        { asset_id: photo.id, sha256: photo.card, tile_color: '#FFFFFF', cutout: false },
        { sauceImage: { asset_id: foreign.id, sha256: foreign.card } },
      ),
    );
    for (const read of [
      (version, options = media) => f.customer.catalogMedia(version, options),
      (version, options = media) => f.kioskCheckout.catalogMedia(f.guest, version, options),
    ]) {
      const map = CatalogMediaMapSchema.parse(await read('1'));
      assert.deepEqual(map, {
        version: 1,
        products: {
          burger: {
            sha256: photo.card,
            card: `/v1/media/catalog/${photo.card}.card.webp`,
            hero: `/v1/media/catalog/${photo.hero}.hero.webp`,
            thumb: `/v1/media/catalog/${photo.thumb}.thumb.webp`,
            tile_color: '#FFFFFF',
            cutout: false,
          },
        },
      });
      // A client still holding an older (or a future) publication must reload the catalog.
      await assert.rejects(read('2'), { code: 'CONFLICT' });
      for (const bad of [undefined, '', '0', '01', 'abc', '1.5', '-1', ['1'], 1, '1234567890'])
        await assert.rejects(read(bad), { code: 'INVALID' }, String(bad));
      // Kill switch: with CATALOG_MEDIA_UPLOAD_ENABLED off every client keeps bundled photos.
      assert.deepEqual(await read('1', { mediaEnabled: false }), { version: 1, products: {} });
      await assert.rejects(read('2', { mediaEnabled: false }), { code: 'CONFLICT' });
    }
    // An incomplete asset (no hero) and a card sha that no longer matches are not listed.
    await f.publish(
      2,
      unifiedPayload(
        { asset_id: partial.id, sha256: partial.card },
        { sauceImage: { asset_id: photo.id, sha256: photo.hero } },
      ),
    );
    assert.deepEqual(await f.customer.catalogMedia('2', media), { version: 2, products: {} });
    await assert.rejects(f.customer.catalogMedia('1', media), { code: 'CONFLICT' });
    // Same flag and audience as the mobile catalog; another kiosk branch is refused.
    const hidden = new CustomerCheckout(f.pool, {
      ...f.customerOptions,
      publishedCatalogEnabled: false,
    });
    await assert.rejects(hidden.catalogMedia('2', media), { code: 'NOT_FOUND' });
    await assert.rejects(hidden.catalog(), { code: 'NOT_FOUND' });
    await assert.rejects(
      f.kioskCheckout.catalogMedia({ ...f.guest, branchId: randomUUID() }, '2', media),
      { code: 'FORBIDDEN' },
    );
    assert.equal(parseCatalogMediaVersion('17'), 17);
  }));

test('media map tolerates a database without the asset store and never lists unknown assets', () =>
  withSyncDatabases(async (ctx) => {
    const scope = { organizationId: ctx.org, branchId: ctx.branch };
    await ctx.cloud.pool.query(
      'DROP TABLE catalog_asset_audit, catalog_asset_variants, catalog_assets',
    );
    await publishCatalog(
      { pool: ctx.cloud.pool, scope },
      { payload: unifiedPayload({ asset_id: randomUUID(), sha256: 'a'.repeat(64) }) },
    );
    assert.deepEqual(await catalogMediaMap(ctx.cloud.pool, scope, '1', { mediaEnabled: true }), {
      version: 1,
      products: {},
    });
  }));

test('availability signature covers the head version, so a price-only republish wakes the long-poll', () =>
  fixture(async (f) => {
    await f.publish(1);
    const kiosk = await f.kioskCheckout.availabilityState(f.guest),
      mobile = await f.customer.availabilityState();
    // Bodies keep their exact old shapes; the kiosk body still has no signature field.
    assert.deepEqual(Object.keys(kiosk.body).sort(), ['fresh', 'products']);
    assert.deepEqual(await f.kioskCheckout.availability(f.guest), kiosk.body);
    assert.deepEqual(await f.customer.availability(), mobile.body);
    assert.deepEqual(Object.keys(mobile.body).sort(), [
      'branchId',
      'enabled',
      'fresh',
      'products',
      'signature',
    ]);
    assert.equal(kiosk.catalogVersion, 1);
    assert.equal(mobile.catalogVersion, 1);
    assert.match(kiosk.signature, /^[a-f0-9]{64}$/);
    assert.equal(kiosk.body.fresh, true);
    assert.deepEqual(
      kiosk.body.products.map((p) => [p.productId, p.available]),
      [
        ['burger', true],
        ['sauce', true],
      ],
    );
    // Reads are stable while nothing changes.
    assert.equal((await f.kioskCheckout.availabilityState(f.guest)).signature, kiosk.signature);
    assert.equal((await f.customer.availabilityState()).body.signature, mobile.body.signature);

    // Long-polls on both channels wait on the current signature; a price-only publication
    // (identical ids and availability) must still wake them.
    const fast = { intervalMs: 50, timeoutMs: 10_000 };
    const started = Date.now();
    const kioskPoll = pollAvailability(
      () => f.kioskCheckout.availabilityState(f.guest),
      kiosk.signature,
      fast,
    );
    const mobilePoll = pollAvailability(
      async () => {
        const state = await f.customer.availabilityState();
        return { ...state, signature: state.body.signature };
      },
      mobile.body.signature,
      fast,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    await f.publish(2, catalogPayload('12000'));
    const [kioskNext, mobileNext] = await Promise.all([kioskPoll, mobilePoll]);
    assert.ok(Date.now() - started < 5_000);
    assert.equal(kioskNext.catalogVersion, 2);
    assert.equal(mobileNext.catalogVersion, 2);
    assert.notEqual(kioskNext.signature, kiosk.signature);
    assert.notEqual(mobileNext.signature, mobile.body.signature);
    assert.deepEqual(kioskNext.body, kiosk.body);
    // Only the signature moved: same ids, availability and freshness as before the republish.
    assert.deepEqual({ ...mobileNext.body, signature: null }, { ...mobile.body, signature: null });
  }));

test('a pending back-office stop reaches kiosk availability at once and wakes its long-poll', () =>
  fixture(async (f) => {
    await f.publish(1);
    const before = await f.kioskCheckout.availabilityState(f.guest);
    const actor = await f.manager();
    const [variant] = localSelectionIds(f.branch, 'burger', []);
    const poll = pollAvailability(
      () => f.kioskCheckout.availabilityState(f.guest),
      before.signature,
      { intervalMs: 50, timeoutMs: 10_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    await f.pool.query(
      `INSERT INTO cloud_stop_commands(id,organization_id,branch_id,variant_id,catalog_ref,stopped,duration,reason,expected_version,actor_id,actor_label)
       VALUES($1,$2,$3,$4,'burger',true,'manual','Synthetic stop',0,$5,'Synthetic manager')`,
      [randomUUID(), f.org, f.branch, variant, actor],
    );
    const after = await poll;
    assert.notEqual(after.signature, before.signature);
    assert.equal(after.catalogVersion, 1);
    assert.deepEqual(
      after.body.products.map((p) => [p.productId, p.available]),
      [
        ['burger', false],
        ['sauce', true],
      ],
    );
    assert.equal(
      (await f.customer.availability()).products.find((p) => p.id === 'burger').available,
      false,
    );
    // A stale heartbeat changes the signature too (fresh is part of the body).
    await f.pool.query(
      "UPDATE cloud_branch_availability SET observed_at=now()-interval '1 minute' WHERE branch_id=$1",
      [f.branch],
    );
    const stale = await f.kioskCheckout.availabilityState(f.guest);
    assert.equal(stale.body.fresh, false);
    assert.notEqual(stale.signature, after.signature);
  }));

test('disabled mobile checkout keeps the disabled availability body and no catalog version', () =>
  fixture(async (f) => {
    const disabled = new CustomerCheckout(f.pool, null);
    assert.deepEqual(await disabled.availabilityState(), {
      body: { enabled: false, fresh: false, signature: 'disabled', products: [] },
      catalogVersion: null,
    });
    // Enabled before any publication: an empty product list and no version header.
    const empty = await f.customer.availabilityState();
    assert.equal(empty.catalogVersion, null);
    assert.deepEqual(empty.body.products, []);
  }));

test('long-poll returns at once without after, stays within its bound and stops when cancelled', async () => {
  let clock = 0,
    reads = 0;
  const read = async () => ({ signature: 'a'.repeat(64), n: ++reads });
  const wait = async (ms) => {
    clock += ms;
  };
  const now = () => clock;
  assert.equal((await pollAvailability(read, undefined, { now, wait })).n, 1);
  reads = 0;
  // Default bound: 25 s of one-second re-checks after the first read.
  const bounded = await pollAvailability(read, 'a'.repeat(64), { now, wait });
  assert.equal(bounded.n, 26);
  assert.equal(clock, 25_000);
  reads = 0;
  let cancelled = false;
  const stopped = await pollAvailability(
    async () => {
      const value = await read();
      if (value.n === 3) cancelled = true;
      return value;
    },
    'a'.repeat(64),
    { now, wait, cancelled: () => cancelled },
  );
  assert.equal(stopped.n, 3);
  reads = 0;
  assert.equal((await pollAvailability(read, 'b'.repeat(64), { now, wait })).n, 1);
});
