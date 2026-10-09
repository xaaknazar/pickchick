import { encodeCatalogImage } from '../../services/api/dist/catalog-image-encoder.js';
/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createPool } from '@pickchick/database';
import { createApi } from '@pickchick/api';
import { fetchMenuMedia, provisionDevice } from '@pickchick/menu-sync';
import { catalogAdminGrants } from '../../infra/staging/catalog-admin-grants.mjs';
import { catalogAccessGrants } from '../../infra/staging/catalog-edge-grants.mjs';
import { catalogAssetGrants } from '../../infra/staging/catalog-asset-grants.mjs';
import { backofficeGrants } from '../../infra/staging/backoffice-grants.mjs';
import {
  CatalogAdmin,
  CatalogAdminError,
  CatalogAssetSchema,
  CatalogMedia,
  catalogMediaEntries,
  provisionCatalogManager,
} from '../../packages/catalog-admin/dist/index.js';
import { running, withSyncDatabases } from '../helpers/sync.mjs';

const sharp = createRequire(new URL('../../services/api/package.json', import.meta.url))('sharp');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const immutable = (error) => error.code === '23514';
const denied = (error) => error.code === '42501';
const isError = (code, reason) => (error) =>
  error instanceof CatalogAdminError && error.code === code && error.reason === reason;

async function photo(color, width = 900, height = 700) {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .composite([
      {
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><circle cx="${width / 2}" cy="${height / 2}" r="${height / 3}" fill="#ffffff"/></svg>`,
        ),
      },
    ])
    .jpeg()
    .toBuffer();
}

const ENV = {
  CATALOG_MEDIA_UPLOAD_ENABLED: 'true',
  CATALOG_ACCESS_ROLES_ENABLED: 'true',
};

/** The real API (createApi wiring, raw parser, filters) on a least-privilege runtime role. */
async function fixture(run, env = ENV) {
  await withSyncDatabases(async (ctx) => {
    const manager = await provisionCatalogManager(ctx.cloud.pool, {
      organization_id: ctx.org,
      name: 'Synthetic photo manager',
      branch_ids: [ctx.branch],
    });
    const analyst = await provisionCatalogManager(ctx.cloud.pool, {
      organization_id: ctx.org,
      name: 'Synthetic photo analyst',
      branch_ids: [ctx.branch],
    });
    await ctx.cloud.pool.query(
      "INSERT INTO bo_access_grants(actor_id,branch_id,role) VALUES($1,$3,'manager'),($2,$3,'analyst')",
      [manager.actor_id, analyst.actor_id, ctx.branch],
    );
    const role = 'catalog_assets_' + randomUUID().replaceAll('-', '');
    await ctx.cloud.admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    let runtime, api;
    const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    try {
      await ctx.cloud.pool.query(
        `GRANT USAGE ON SCHEMA ${ctx.cloud.schema} TO ${role};
         GRANT SELECT ON branches, devices, device_credentials, schema_migrations TO ${role};
         GRANT UPDATE(id) ON devices TO ${role};
         GRANT UPDATE(device_id) ON device_credentials TO ${role};`,
      );
      await ctx.cloud.pool.query(catalogAdminGrants(role, true));
      await ctx.cloud.pool.query(backofficeGrants(role, false));
      await ctx.cloud.pool.query(catalogAccessGrants(role, true));
      await ctx.cloud.pool.query(catalogAssetGrants(role, true));
      const url = new URL(ctx.cloud.config.databaseUrl);
      url.searchParams.set('options', `-c search_path=${ctx.cloud.schema} -c role=${role}`);
      runtime = createPool(url.toString(), 4);
      Object.assign(process.env, env);
      api = await running(createApi, {
        ...ctx.cloud.config,
        databaseUrl: url.toString(),
        catalogAdminEnabled: true,
      });
      const request = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
        const response = await fetch(api.url + path, {
          method,
          headers: {
            ...(token ? { Authorization: 'Bearer ' + token } : {}),
            ...headers,
          },
          ...(body === undefined ? {} : { body }),
        });
        const raw = Buffer.from(await response.arrayBuffer());
        const json = /json/.test(response.headers.get('content-type') ?? '')
          ? JSON.parse(raw.toString())
          : null;
        return { status: response.status, headers: response.headers, raw, body: json };
      };
      const upload = (bytes, token = manager.token, key = randomUUID(), type = 'image/jpeg') =>
        request(`/v1/admin/catalog/branches/${ctx.branch}/assets`, {
          method: 'POST',
          body: bytes,
          token,
          headers: { 'Content-Type': type, 'Idempotency-Key': key },
        });
      await run({ ...ctx, manager, analyst, role, runtime, api, request, upload });
    } finally {
      if (api) await api.app.close();
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      if (runtime) await runtime.end();
      await ctx.cloud.pool.query(`DROP OWNED BY ${role}`);
      await ctx.cloud.admin.query(`DROP ROLE ${role}`);
    }
  });
}

test('analyst gets 403, a manager upload is idempotent and identical photos share one asset', async () =>
  fixture(async (ctx) => {
    const bytes = await photo('#c0392b');
    const forbidden = await ctx.upload(bytes, ctx.analyst.token);
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.code, 'FORBIDDEN');
    assert.equal((await ctx.upload(bytes, 'f'.repeat(64))).status, 401);
    const key = randomUUID();
    const first = await ctx.upload(bytes, ctx.manager.token, key);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const asset = CatalogAssetSchema.parse(first.body);
    assert.equal(asset.source_sha256, sha(bytes));
    assert.equal(asset.uploaded_by, ctx.manager.actor_id);
    assert.deepEqual(asset.image, { asset_id: asset.asset_id, sha256: asset.variants.card.sha256 });
    assert.equal(asset.sha256, asset.variants.hero.sha256);
    assert.deepEqual(
      [asset.variants.card.width, asset.variants.hero.width, asset.variants.thumb.width],
      [640, 900, 240],
    );
    assert.equal(
      asset.variants.card.url,
      `/v1/media/catalog/${asset.variants.card.sha256}.card.webp`,
    );
    // Lost response: the same key replays the stored answer byte for byte.
    const replay = await ctx.upload(bytes, ctx.manager.token, key);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, first.body);
    // Same key, other bytes: a conflict, never a silent overwrite.
    assert.equal((await ctx.upload(await photo('#2980b9'), ctx.manager.token, key)).status, 409);
    // Same bytes under a new key: the same asset and hashes are reused.
    const again = await ctx.upload(bytes);
    assert.equal(again.status, 200);
    assert.equal(again.body.asset_id, asset.asset_id);
    assert.equal(again.body.variants.card.sha256, asset.variants.card.sha256);
    const audit = await ctx.cloud.pool.query(
      'SELECT action, actor_id, branch_id FROM catalog_asset_audit ORDER BY occurred_at, action DESC',
    );
    assert.deepEqual(
      audit.rows.map((row) => row.action),
      ['uploaded', 'reused'],
    );
    assert.ok(audit.rows.every((row) => row.actor_id === ctx.manager.actor_id));
    assert.equal(
      (await ctx.cloud.pool.query('SELECT count(*)::int n FROM catalog_asset_variants')).rows[0].n,
      3,
    );
    // Analysts may list (read) the organisation's photos.
    const list = await ctx.request(`/v1/admin/catalog/branches/${ctx.branch}/assets`, {
      token: ctx.analyst.token,
    });
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.assets.map((item) => item.asset_id),
      [asset.asset_id],
    );
    assert.match(list.headers.get('cache-control'), /no-store/);
  }));

test('bad uploads fail with a precise reason and store nothing', async () =>
  fixture(async (ctx) => {
    const bytes = await photo('#16a085');
    const expect = async (response, status, reason) => {
      assert.equal(response.status, status);
      if (reason) assert.deepEqual(response.body.error, { code: reason });
      assert.equal(response.body.trace_id.length, 36);
    };
    await expect(
      await ctx.upload(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"/>'),
        ctx.manager.token,
        randomUUID(),
        'image/png',
      ),
      400,
      'ASSET_UNSUPPORTED_TYPE',
    );
    await expect(
      await ctx.upload(
        await sharp(bytes).gif().toBuffer(),
        ctx.manager.token,
        randomUUID(),
        'image/png',
      ),
      400,
      'ASSET_UNSUPPORTED_TYPE',
    );
    // Not an image content type: the raw parser never runs, the body is rejected.
    await expect(
      await ctx.upload(bytes, ctx.manager.token, randomUUID(), 'image/svg+xml'),
      400,
      'ASSET_UNSUPPORTED_TYPE',
    );
    await expect(await ctx.upload(bytes, ctx.manager.token, 'not-a-uuid'), 400);
    const oversize = Buffer.alloc(10 * 1024 * 1024 + 1);
    oversize.set([0xff, 0xd8, 0xff]);
    const tooLarge = await ctx.upload(oversize);
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.body.code, 'PAYLOAD_TOO_LARGE');
    for (const table of ['catalog_assets', 'catalog_asset_variants', 'catalog_asset_audit'])
      assert.equal(
        (await ctx.cloud.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,
        0,
        table,
      );
    // Per-actor rate limit: 30 uploads per 10 minutes, replays excluded.
    const key = randomUUID();
    const first = await ctx.upload(bytes, ctx.manager.token, key);
    assert.equal(first.status, 200);
    for (let i = 0; i < 29; i += 1)
      await ctx.cloud.pool.query(
        "INSERT INTO catalog_asset_audit(id,organization_id,branch_id,actor_id,asset_id,request_id,action,source_sha256) VALUES($1,$2,$3,$4,$5,$6,'reused',$7)",
        [
          randomUUID(),
          ctx.org,
          ctx.branch,
          ctx.manager.actor_id,
          first.body.asset_id,
          randomUUID(),
          first.body.source_sha256,
        ],
      );
    const limited = await ctx.upload(await photo('#8e44ad'));
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, 'RATE_LIMITED');
    assert.equal(limited.body.retryable, true);
    assert.deepEqual(limited.body.error, { code: 'ASSET_RATE_LIMITED' });
    assert.deepEqual((await ctx.upload(bytes, ctx.manager.token, key)).body, first.body);
  }));

test('drafts and publications must reference existing assets of the organisation', async () =>
  fixture(async (ctx) => {
    const service = new CatalogAdmin(ctx.runtime, { enabled: true, enforceRoles: true });
    const uploaded = (await ctx.upload(await photo('#d35400'))).body;
    let state = await service.seed(ctx.manager.token, ctx.branch, {
      expected_revision: 0,
      request_id: randomUUID(),
    });
    const save = (payload) =>
      service.save(ctx.manager.token, ctx.branch, {
        expected_revision: state.draft.revision,
        request_id: randomUUID(),
        payload,
      });
    const payload = structuredClone(state.draft.payload);
    payload.content_reviewed = true;
    payload.products[0].image = { asset_id: randomUUID(), sha256: uploaded.image.sha256 };
    await assert.rejects(save(payload), isError('CONFLICT', 'ASSET_MISSING'));
    // The hero (or any non-card) hash is not a valid product.image reference.
    payload.products[0].image = { asset_id: uploaded.asset_id, sha256: uploaded.sha256 };
    await assert.rejects(save(payload), isError('CONFLICT', 'ASSET_MISSING'));
    payload.products[0].image = { ...uploaded.image, tile_color: '#FFFFFF', cutout: false };
    state = await save(payload);
    assert.deepEqual(state.draft.payload.products[0].image, payload.products[0].image);
    const entries = await catalogMediaEntries(ctx.runtime, ctx.org, state.draft.payload);
    assert.deepEqual(Object.keys(entries), [payload.products[0].id]);
    assert.deepEqual(entries[payload.products[0].id], {
      sha256: uploaded.image.sha256,
      card: uploaded.variants.card.url,
      hero: uploaded.variants.hero.url,
      thumb: uploaded.variants.thumb.url,
      tile_color: '#FFFFFF',
      cutout: false,
    });
    // A draft written before this check (inserted directly) still cannot be published.
    const stale = structuredClone(state.draft.payload);
    stale.products[1].image = { asset_id: randomUUID(), sha256: 'e'.repeat(64) };
    const raw = JSON.stringify(stale);
    await ctx.cloud.pool.query(
      'INSERT INTO catalog_draft_versions(branch_id,organization_id,revision,payload,payload_hash,actor_id) VALUES($1,$2,$3,$4,$5,$6)',
      [ctx.branch, ctx.org, state.draft.revision + 1, raw, sha(raw), ctx.manager.actor_id],
    );
    await ctx.cloud.pool.query(
      'UPDATE catalog_branch_heads SET draft_revision=$2 WHERE branch_id=$1',
      [ctx.branch, state.draft.revision + 1],
    );
    const response = await ctx.request(`/v1/admin/catalog/branches/${ctx.branch}/publish`, {
      method: 'POST',
      token: ctx.manager.token,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_revision: state.draft.revision + 1,
        expected_published_version: 0,
        request_id: randomUUID(),
        confirmation: 'publish_catalog',
      }),
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'CONFLICT');
    assert.deepEqual(response.body.error, { code: 'ASSET_MISSING' });
    assert.equal((await service.read(ctx.manager.token, ctx.branch)).published, null);
    // The valid draft publishes again once saved over the stale revision.
    state = await service.read(ctx.manager.token, ctx.branch);
    state = await save(payload);
    const published = await service.publish(ctx.manager.token, ctx.branch, {
      expected_revision: state.draft.revision,
      expected_published_version: 0,
      request_id: randomUUID(),
      confirmation: 'publish_catalog',
    });
    assert.deepEqual(published.published.payload.products[0].image, payload.products[0].image);
  }));

test('public media is immutable and credential-free; the edge download needs its device token', async () =>
  fixture(async (ctx) => {
    const asset = (await ctx.upload(await photo('#27ae60'))).body;
    const card = asset.variants.card;
    const media = await ctx.request(card.url, {
      headers: { Authorization: 'Bearer ' + ctx.manager.token, Cookie: 'session=x' },
    });
    assert.equal(media.status, 200);
    assert.equal(sha(media.raw), card.sha256);
    assert.equal(media.raw.length, card.bytes);
    assert.equal(media.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(media.headers.get('etag'), `"${card.sha256}"`);
    assert.equal(media.headers.get('content-type'), 'image/webp');
    assert.equal(media.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(media.headers.get('access-control-allow-origin'), '*');
    assert.equal(media.headers.get('content-length'), String(card.bytes));
    // The plain `<sha>.webp` form resolves too, by the rendition's own hash.
    const plain = await ctx.request(`/v1/media/catalog/${asset.variants.thumb.sha256}.webp`);
    assert.equal(sha(plain.raw), asset.variants.thumb.sha256);
    const head = await ctx.request(asset.variants.hero.url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.raw.length, 0);
    assert.equal(head.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const cached = await ctx.request(card.url, {
      headers: { 'If-None-Match': `"${card.sha256}"` },
    });
    assert.equal(cached.status, 304);
    assert.equal(cached.raw.length, 0);
    for (const path of [
      `/v1/media/catalog/${card.sha256}.hero.webp`,
      `/v1/media/catalog/${'0'.repeat(64)}.card.webp`,
      `/v1/media/catalog/${card.sha256.toUpperCase()}.webp`,
      `/v1/media/catalog/${card.sha256}.card.png`,
    ]) {
      const missing = await ctx.request(path);
      assert.equal(missing.status, 404, path);
      assert.match(missing.headers.get('cache-control'), /no-store/);
    }
    assert.equal((await ctx.request(card.url, { method: 'POST' })).status, 404);
    assert.equal((await ctx.request(card.url, { method: 'DELETE' })).status, 404);

    const edgePath = `/internal/v1/edge/media/${card.sha256}.card.webp`;
    assert.equal((await ctx.request(edgePath)).status, 401);
    assert.equal(
      (
        await ctx.request(edgePath, {
          headers: { 'X-Device-Id': ctx.device, Authorization: 'Bearer ' + 'a'.repeat(64) },
        })
      ).status,
      401,
    );
    const identity = await provisionDevice(ctx.cloud.pool, ctx.device);
    const device = { 'X-Device-Id': identity.device_id, Authorization: 'Bearer ' + identity.token };
    const edge = await ctx.request(edgePath, { headers: device });
    assert.equal(edge.status, 200);
    assert.equal(sha(edge.raw), card.sha256);
    assert.equal(edge.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.equal(
      (
        await ctx.request(`/internal/v1/edge/media/${'1'.repeat(64)}.card.webp`, {
          headers: device,
        })
      ).status,
      404,
    );
    // The WP-C edge worker downloads, hash-verifies and caches it through the real route.
    assert.deepEqual(
      await fetchMenuMedia(ctx.edge.pool, ctx.api.url + '/', identity, [card.sha256]),
      { fetched: 1 },
    );
    assert.equal(
      (await ctx.edge.pool.query('SELECT sha256 FROM menu_media')).rows[0].sha256,
      card.sha256,
    );
    // A device of another organisation never reaches these renditions.
    const org = randomUUID(),
      legal = randomUUID(),
      branch = randomUUID(),
      other = randomUUID();
    await ctx.cloud.pool.query("INSERT INTO organizations(id,name) VALUES ($1,'Other synthetic')", [
      org,
    ]);
    await ctx.cloud.pool.query(
      "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES ($1,$2,'Other synthetic','000000000001')",
      [legal, org],
    );
    await ctx.cloud.pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES ($1,$2,$3,'OTHER','Other')",
      [branch, org, legal],
    );
    await ctx.cloud.pool.query(
      "INSERT INTO devices(id,branch_id,organization_id,kind,name) VALUES ($1,$2,$3,'edge','Other')",
      [other, branch, org],
    );
    const foreign = await provisionDevice(ctx.cloud.pool, other);
    assert.equal(
      (
        await ctx.request(edgePath, {
          headers: { 'X-Device-Id': foreign.device_id, Authorization: 'Bearer ' + foreign.token },
        })
      ).status,
      404,
    );
  }));

test('uploads fail closed without a host encoder; existing media and receipt replays still work', async () =>
  fixture(async (ctx) => {
    const bytes = await photo('#224466');
    const key = randomUUID();
    const missing = new CatalogMedia(ctx.runtime, {
      enabled: true,
      mediaEnabled: true,
      enforceRoles: true,
    });
    await assert.rejects(
      missing.upload(ctx.manager.token, ctx.branch, bytes, key),
      (error) => error instanceof CatalogAdminError && error.code === 'SERVICE_UNAVAILABLE',
    );
    for (const table of ['catalog_assets', 'catalog_asset_variants', 'catalog_asset_audit'])
      assert.equal(
        Number((await ctx.cloud.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count),
        0,
      );
    const response = await ctx.upload(bytes, ctx.manager.token, key);
    assert.equal(response.status, 200);
    const asset = CatalogAssetSchema.parse(response.body);
    assert.deepEqual(await missing.upload(ctx.manager.token, ctx.branch, bytes, key), asset);
    assert.equal((await ctx.request(asset.variants.card.url)).status, 200);
  }));

test('every media route fails closed while CATALOG_MEDIA_UPLOAD_ENABLED is off', async () =>
  fixture(
    async (ctx) => {
      const enabled = new CatalogMedia(
        ctx.runtime,
        { enabled: true, mediaEnabled: true, enforceRoles: true },
        encodeCatalogImage,
      );
      const bytes = await photo('#7f8c8d');
      const asset = await enabled.upload(ctx.manager.token, ctx.branch, bytes, randomUUID());
      const off = await ctx.upload(bytes);
      assert.equal(off.status, 503);
      assert.equal(off.body.code, 'SERVICE_UNAVAILABLE');
      assert.equal(
        (
          await ctx.request(`/v1/admin/catalog/branches/${ctx.branch}/assets`, {
            token: ctx.manager.token,
          })
        ).status,
        503,
      );
      assert.equal((await ctx.request(asset.variants.card.url)).status, 404);
      const identity = await provisionDevice(ctx.cloud.pool, ctx.device);
      assert.equal(
        (
          await ctx.request(`/internal/v1/edge/media/${asset.image.sha256}.card.webp`, {
            headers: {
              'X-Device-Id': identity.device_id,
              Authorization: 'Bearer ' + identity.token,
            },
          })
        ).status,
        404,
      );
      // The catalog editor being off also closes uploads, whatever the media flag says.
      await assert.rejects(
        new CatalogMedia(ctx.runtime, { enabled: false, mediaEnabled: true }).upload(
          ctx.manager.token,
          ctx.branch,
          bytes,
          randomUUID(),
        ),
        (error) => error instanceof CatalogAdminError && error.code === 'SERVICE_UNAVAILABLE',
      );
    },
    { CATALOG_MEDIA_UPLOAD_ENABLED: 'false', CATALOG_ACCESS_ROLES_ENABLED: 'true' },
  ));

test('asset rows are immutable, hash-checked and append-only under production grants', async () =>
  fixture(async (ctx) => {
    const asset = (await ctx.upload(await photo('#f39c12'))).body;
    for (const sql of [
      'UPDATE catalog_assets SET width=1',
      'DELETE FROM catalog_assets',
      "UPDATE catalog_asset_variants SET variant='hero'",
      'DELETE FROM catalog_asset_variants',
      'UPDATE catalog_asset_audit SET action=action',
      'DELETE FROM catalog_asset_audit',
      'TRUNCATE catalog_asset_variants',
    ])
      await assert.rejects(ctx.runtime.query(sql), denied, sql);
    for (const sql of [
      'UPDATE catalog_assets SET width=1',
      'DELETE FROM catalog_asset_variants',
      'DELETE FROM catalog_asset_audit',
    ])
      await assert.rejects(ctx.cloud.pool.query(sql), immutable, sql);
    const webp = await sharp(await photo('#000000', 64, 64))
      .webp()
      .toBuffer();
    const insert = (variant, digest, bytes) =>
      ctx.cloud.pool.query(
        'INSERT INTO catalog_asset_variants(asset_id,variant,sha256,width,height,bytes) VALUES($1,$2,$3,64,64,$4)',
        [asset.asset_id, variant, digest, bytes],
      );
    // A stored rendition must hash to its name and be a WebP container.
    const other = randomUUID();
    await ctx.cloud.pool.query(
      'INSERT INTO catalog_assets(id,organization_id,sha256,source_sha256,width,height,uploaded_by) VALUES($1,$2,$3,$3,64,64,$4)',
      [other, ctx.org, sha(webp), ctx.manager.actor_id],
    );
    await assert.rejects(
      ctx.cloud.pool.query(
        "INSERT INTO catalog_asset_variants(asset_id,variant,sha256,width,height,bytes) VALUES($1,'card',$2,64,64,$3)",
        [other, 'f'.repeat(64), webp],
      ),
      (error) => error.code === '23514',
    );
    const png = await sharp(webp).png().toBuffer();
    await assert.rejects(
      ctx.cloud.pool.query(
        "INSERT INTO catalog_asset_variants(asset_id,variant,sha256,width,height,bytes) VALUES($1,'card',$2,64,64,$3)",
        [other, sha(png), png],
      ),
      (error) => error.code === '23514',
    );
    await assert.rejects(
      ctx.cloud.pool.query(
        "INSERT INTO catalog_asset_variants(asset_id,variant,sha256,width,height,bytes) VALUES($1,'thumb',$2,640,64,$3)",
        [other, sha(webp), webp],
      ),
      (error) => error.code === '23514',
    );
    // Duplicate variant of an existing asset is rejected by the primary key.
    await assert.rejects(insert('card', sha(webp), webp), (error) => error.code === '23505');
  }));
