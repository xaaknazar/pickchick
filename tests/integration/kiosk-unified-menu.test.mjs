/* global structuredClone */
// The iPad kiosk client (commercial controller + HTTP layer) against the real API: photo map,
// availability long-poll with X-Availability-Signature, and a republish seen on the start screen.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createApi } from '@pickchick/api';
import { localSelectionIds, provisionDevice } from '@pickchick/menu-sync';
import { CatalogPayloadSchema } from '@pickchick/catalog-admin/contracts';
import {
  catalogPayload,
  publishCatalog,
} from '../../packages/commerce-core/tests/catalog-fixture.mjs';
import { running, withSyncDatabases } from '../helpers/sync.mjs';
import { CommercialKioskController } from '../../apps/kiosk/src/commercial-controller.ts';
import {
  commercialKioskRead,
  commercialKioskRequest,
} from '../../apps/kiosk/src/commercial-api.ts';
import { KIOSK_API_URL } from '../../apps/kiosk/src/api.ts';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const webp = (seed) => {
  const body = Buffer.from(`synthetic-${seed}-${randomUUID()}`);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'ascii');
  return Buffer.concat([header, body]);
};

async function fixture(run) {
  await withSyncDatabases(async (ctx) => {
    const pool = ctx.cloud.pool,
      scope = { organizationId: ctx.org, branchId: ctx.branch },
      device = { deviceId: randomUUID(), key: randomBytes(32).toString('hex') },
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
      [device.deviceId, ctx.org, ctx.branch, sha(device.key)],
    );
    const env = {
      CUSTOMER_KASPI_PILOT_ENABLED: 'true',
      CUSTOMER_KASPI_ORGANIZATION_ID: ctx.org,
      CUSTOMER_KASPI_BRANCH_ID: ctx.branch,
      KASPI_REMOTE_ACCOUNT_ID: randomUUID(),
      CUSTOMER_KASPI_PILOT_CUSTOMER_IDS: randomUUID(),
      CUSTOMER_KASPI_FISCAL_DEFERRAL_REFERENCE: 'Synthetic kiosk unified menu test only',
      CUSTOMER_KASPI_OPENING_TIME: '10:00',
      CUSTOMER_KASPI_CLOSING_TIME: '00:00',
      CUSTOMER_KASPI_TIMEZONE: 'Asia/Almaty',
      KIOSK_CHECKOUT_ENABLED: 'true',
      KIOSK_CHECKOUT_ORGANIZATION_ID: ctx.org,
      KIOSK_CHECKOUT_BRANCH_ID: ctx.branch,
      KIOSK_CHECKOUT_FISCAL_POLICY: 'deferred_pilot',
      KIOSK_CHECKOUT_APPROVAL_REFERENCE: 'Synthetic kiosk unified menu test only',
      KIOSK_CHECKOUT_TAX_CODE: 'PENDING_PILOT',
      KIOSK_CHECKOUT_PII_KEY: piiKey.toString('hex'),
      CATALOG_MEDIA_UPLOAD_ENABLED: 'true',
    };
    const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    let api;
    try {
      Object.assign(process.env, env);
      api = await running(createApi, ctx.cloud.config);
      // The kiosk HTTP layer is used unchanged; only its fixed origin is pointed at the test API.
      const fetcher = (url, init) => fetch(String(url).replace(KIOSK_API_URL, api.url), init);
      const reads = [];
      const state = { rawSession: null, rawFlow: null };
      const io = {
        readDevice: async () => JSON.stringify(device),
        readSession: async () => state.rawSession,
        writeSession: async (raw) => {
          state.rawSession = raw;
        },
        removeSession: async () => {
          state.rawSession = null;
        },
        readFlow: async () => state.rawFlow,
        writeFlow: async (raw) => {
          state.rawFlow = raw;
        },
        now: Date.now,
        uuid: randomUUID,
        request: (path, token, body, key) =>
          commercialKioskRequest(path, token, body, key, fetcher, device),
        read: (path, token, options) => {
          reads.push(path);
          return commercialKioskRead(path, token, fetcher, device, options);
        },
      };
      const publish = (version, payload) => publishCatalog({ pool, scope }, { version, payload });
      await run({ ...ctx, pool, publish, io, reads, api });
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
    "INSERT INTO catalog_managers(id,organization_id,name,token_hash) VALUES($1,$2,'Synthetic kiosk media fixture',$3)",
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
  payload.products[0].image = {
    asset_id: asset,
    sha256: sha(variants.card),
    tile_color: '#0A1B2C',
    cutout: true,
  };
  return { payload: CatalogPayloadSchema.parse(payload), card: sha(variants.card) };
}

test('kiosk client reads the photo map, long-polls stops and reloads a republish on the start screen', () =>
  fixture(async (ctx) => {
    const photo = await photoPayload(ctx);
    await ctx.publish(1, photo.payload);
    const kiosk = new CommercialKioskController(ctx.io);
    assert.equal(await kiosk.restore(), true, kiosk.getSnapshot().error);
    let snapshot = kiosk.getSnapshot();
    assert.equal(snapshot.step, 'start');
    assert.equal(snapshot.catalog.catalog_version, '1');
    const burger = snapshot.catalog.products.find((p) => p.id === 'burger');
    assert.equal(burger.image_id, 'i0.jpg', 'image_id stays the bundled key');
    assert.deepEqual(burger.media, {
      sha256: photo.card,
      card: `/v1/media/catalog/${photo.card}.card.webp`,
      hero: burger.media.hero,
      thumb: burger.media.thumb,
      tile_color: '#0A1B2C',
      cutout: true,
    });
    assert.equal(burger.available, true);
    // The published photo is served by the public media route the kiosk renders.
    const image = await fetch(ctx.api.url + burger.media.card);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/webp');

    // An edge stop reaches the idle start screen within one long-poll cycle.
    const started = Date.now();
    const cycle = kiosk.watchAvailability();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(kiosk.getSnapshot().busy, false);
    await ctx.pool.query(
      'UPDATE cloud_branch_availability SET stopped_ids=$2::uuid[],revision=2,observed_at=clock_timestamp() WHERE branch_id=$1',
      [ctx.branch, [localSelectionIds(ctx.branch, 'burger', [])[0]]],
    );
    assert.equal(await cycle, 'changed');
    assert(Date.now() - started < 8_000);
    assert.match(ctx.reads.at(-1), /^\/availability\?after=[a-f0-9]{64}$/);
    snapshot = kiosk.getSnapshot();
    assert.equal(snapshot.catalog.products.find((p) => p.id === 'burger').available, false);
    assert.equal(snapshot.catalog.products.find((p) => p.id === 'sauce').available, true);

    // A price-only republish wakes the long-poll and is loaded at once on the start screen.
    const reload = kiosk.watchAvailability();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await ctx.pool.query(
      'UPDATE cloud_branch_availability SET observed_at=clock_timestamp() WHERE branch_id=$1',
      [ctx.branch],
    );
    await ctx.publish(2, catalogPayload('12000'));
    assert.equal(await reload, 'reloaded', kiosk.getSnapshot().error ?? '');
    snapshot = kiosk.getSnapshot();
    assert.equal(snapshot.catalog.catalog_version, '2');
    assert.equal(snapshot.catalog.products.find((p) => p.id === 'burger').price_minor, '12000');
    assert.equal(snapshot.catalog.products.find((p) => p.id === 'burger').media, undefined);
    assert.equal(snapshot.catalog.products.find((p) => p.id === 'burger').available, false);
    assert(ctx.reads.includes('/catalog/media?version=2'));
    assert.equal(snapshot.step, 'start');
    assert.equal(snapshot.error, null);
  }));
