/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createApi } from '@pickchick/api';
import { provisionDevice } from '@pickchick/menu-sync';
import { CatalogPayloadSchema } from '@pickchick/catalog-admin/contracts';
import { KioskSessions } from '../../packages/commerce-core/dist/index.js';
import {
  catalogPayload,
  publishCatalog,
} from '../../packages/commerce-core/tests/catalog-fixture.mjs';
import { running, withSyncDatabases } from '../helpers/sync.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const webp = (seed) => {
  const body = Buffer.from(`synthetic-${seed}-${randomUUID()}`);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'ascii');
  return Buffer.concat([header, body]);
};

/** The real API with synthetic mobile and kiosk storefront settings (no payment is created). */
async function fixture(run, { media = 'true' } = {}) {
  await withSyncDatabases(async (ctx) => {
    const pool = ctx.cloud.pool,
      scope = { organizationId: ctx.org, branchId: ctx.branch },
      kiosk = randomUUID(),
      deviceKey = randomBytes(32).toString('hex'),
      piiKey = randomBytes(32);
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
    const token = randomBytes(32).toString('hex');
    await new KioskSessions(pool, { piiKey }).start(kiosk, deviceKey, {
      sessionId: randomUUID(),
      token,
    });
    const env = {
      CUSTOMER_KASPI_PILOT_ENABLED: 'true',
      CUSTOMER_KASPI_ORGANIZATION_ID: ctx.org,
      CUSTOMER_KASPI_BRANCH_ID: ctx.branch,
      KASPI_REMOTE_ACCOUNT_ID: randomUUID(),
      CUSTOMER_KASPI_PILOT_CUSTOMER_IDS: randomUUID(),
      CUSTOMER_KASPI_FISCAL_DEFERRAL_REFERENCE: 'Synthetic storefront media test only',
      CUSTOMER_KASPI_OPENING_TIME: '10:00',
      CUSTOMER_KASPI_CLOSING_TIME: '00:00',
      CUSTOMER_KASPI_TIMEZONE: 'Asia/Almaty',
      CATALOG_MOBILE_STOREFRONT_ENABLED: 'true',
      KIOSK_CHECKOUT_ENABLED: 'true',
      KIOSK_CHECKOUT_ORGANIZATION_ID: ctx.org,
      KIOSK_CHECKOUT_BRANCH_ID: ctx.branch,
      KIOSK_CHECKOUT_FISCAL_POLICY: 'deferred_pilot',
      KIOSK_CHECKOUT_APPROVAL_REFERENCE: 'Synthetic storefront media test only',
      KIOSK_CHECKOUT_TAX_CODE: 'PENDING_PILOT',
      KIOSK_CHECKOUT_PII_KEY: piiKey.toString('hex'),
      CATALOG_MEDIA_UPLOAD_ENABLED: media,
    };
    const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    let api;
    try {
      Object.assign(process.env, env);
      api = await running(createApi, ctx.cloud.config);
      const request = async (path, headers = {}) => {
        const response = await fetch(api.url + path, { headers });
        const text = await response.text();
        return {
          status: response.status,
          headers: response.headers,
          body: text ? JSON.parse(text) : null,
        };
      };
      const kioskHeaders = {
        'X-Kiosk-Device': kiosk,
        'X-Kiosk-Key': deviceKey,
        Authorization: 'Bearer ' + token,
      };
      const publish = (version, payload) => publishCatalog({ pool, scope }, { version, payload });
      await run({ ...ctx, pool, request, kioskHeaders, publish });
    } finally {
      if (api) await api.app.close();
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  });
}

async function photoPayload(ctx) {
  const manager = randomUUID(),
    asset = randomUUID(),
    variants = { card: webp('card'), hero: webp('hero'), thumb: webp('thumb') };
  await ctx.pool.query(
    "INSERT INTO catalog_managers(id,organization_id,name,token_hash) VALUES($1,$2,'Synthetic media fixture',$3)",
    [manager, ctx.org, sha(manager)],
  );
  await ctx.pool.query(
    'INSERT INTO catalog_assets(id,organization_id,sha256,source_sha256,width,height,uploaded_by) VALUES($1,$2,$3,$4,900,700,$5)',
    [asset, ctx.org, sha(variants.hero), sha('source'), manager],
  );
  for (const [variant, bytes] of Object.entries(variants))
    await ctx.pool.query(
      'INSERT INTO catalog_asset_variants(asset_id,variant,sha256,width,height,bytes) VALUES($1,$2,$3,200,150,$4)',
      [asset, variant, sha(bytes), bytes],
    );
  const payload = structuredClone(catalogPayload());
  payload.products[0].image = { asset_id: asset, sha256: sha(variants.card), cutout: true };
  payload.products[0].kitchen_route = 'prep';
  return {
    payload: CatalogPayloadSchema.parse(payload),
    card: sha(variants.card),
    hero: sha(variants.hero),
    thumb: sha(variants.thumb),
  };
}

test('storefront routes strip new fields, serve the media map and signal the catalog version', () =>
  fixture(async (ctx) => {
    const photo = await photoPayload(ctx);
    await ctx.publish(1, photo.payload);
    const expected = {
      version: 1,
      products: {
        burger: {
          sha256: photo.card,
          card: `/v1/media/catalog/${photo.card}.card.webp`,
          hero: `/v1/media/catalog/${photo.hero}.hero.webp`,
          thumb: `/v1/media/catalog/${photo.thumb}.thumb.webp`,
          cutout: true,
        },
      },
    };
    for (const [prefix, headers] of [
      ['/v1/customer-checkout', {}],
      ['/v1/kiosk-checkout', ctx.kioskHeaders],
    ]) {
      const catalog = await ctx.request(prefix + '/catalog', headers);
      assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
      assert.ok(catalog.body.payload.products.every((p) => !('image' in p)));
      assert.ok(catalog.body.payload.products.every((p) => !('kitchen_route' in p)));
      const media = await ctx.request(prefix + '/catalog/media?version=1', headers);
      assert.equal(media.status, 200, JSON.stringify(media.body));
      assert.deepEqual(media.body, expected);
      assert.match(media.headers.get('cache-control'), /no-store/);
      const stale = await ctx.request(prefix + '/catalog/media?version=2', headers);
      assert.equal(stale.status, 409);
      assert.equal(stale.body.code, 'CONFLICT');
      for (const bad of ['', '?version=x', '?version=1&version=1'])
        assert.equal((await ctx.request(prefix + '/catalog/media' + bad, headers)).status, 400);
      const availability = await ctx.request(prefix + '/availability', headers);
      assert.equal(availability.status, 200);
      assert.equal(availability.headers.get('x-catalog-version'), '1');
      assert.match(availability.headers.get('x-availability-signature'), /^[a-f0-9]{64}$/);
      assert.equal((await ctx.request(prefix + '/availability?after=nothex', headers)).status, 400);
    }
    // Kiosk device auth: a wrong device key or session gets no media map and no long-poll.
    for (const forged of [
      { 'X-Kiosk-Key': 'f'.repeat(64) },
      { Authorization: 'Bearer ' + 'e'.repeat(64) },
    ])
      for (const path of ['/catalog/media?version=1', '/availability?after=' + 'a'.repeat(64)])
        assert.equal(
          (await ctx.request('/v1/kiosk-checkout' + path, { ...ctx.kioskHeaders, ...forged }))
            .status,
          403,
        );
    const kioskBody = (await ctx.request('/v1/kiosk-checkout/availability', ctx.kioskHeaders)).body;
    assert.deepEqual(Object.keys(kioskBody).sort(), ['fresh', 'products']);

    // Both long-polls wait on their signature and wake on a price-only republish.
    const wait = async (prefix, headers) => {
      const first = await ctx.request(prefix + '/availability', headers);
      const signature = first.headers.get('x-availability-signature');
      const started = Date.now();
      const next = ctx.request(prefix + '/availability?after=' + signature, headers);
      return { first, signature, started, next };
    };
    const mobile = await wait('/v1/customer-checkout', {});
    const kiosk = await wait('/v1/kiosk-checkout', ctx.kioskHeaders);
    assert.equal(mobile.first.body.signature, mobile.signature);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await ctx.publish(2, catalogPayload('12000'));
    for (const poll of [mobile, kiosk]) {
      const next = await poll.next;
      assert.equal(next.status, 200);
      assert.equal(next.headers.get('x-catalog-version'), '2');
      assert.notEqual(next.headers.get('x-availability-signature'), poll.signature);
      assert.ok(Date.now() - poll.started < 6_000);
      assert.ok(Date.now() - poll.started >= 1_000);
    }
    // A new version, no photo any more: the stale map version conflicts, the new one is empty.
    assert.equal((await ctx.request('/v1/customer-checkout/catalog/media?version=1')).status, 409);
    assert.deepEqual((await ctx.request('/v1/customer-checkout/catalog/media?version=2')).body, {
      version: 2,
      products: {},
    });
  }));

test('the media kill switch empties the map while the catalog keeps working', () =>
  fixture(
    async (ctx) => {
      const photo = await photoPayload(ctx);
      await ctx.publish(1, photo.payload);
      for (const [prefix, headers] of [
        ['/v1/customer-checkout', {}],
        ['/v1/kiosk-checkout', ctx.kioskHeaders],
      ]) {
        const media = await ctx.request(prefix + '/catalog/media?version=1', headers);
        assert.equal(media.status, 200);
        assert.deepEqual(media.body, { version: 1, products: {} });
        assert.equal((await ctx.request(prefix + '/catalog', headers)).status, 200);
      }
      assert.equal((await ctx.request(`/v1/media/catalog/${photo.card}.card.webp`)).status, 404);
    },
    { media: 'false' },
  ));
