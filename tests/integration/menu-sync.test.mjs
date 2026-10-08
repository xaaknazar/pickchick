import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { URLSearchParams } from 'node:url';
import test from 'node:test';
import { createApi } from '@pickchick/api';
import { createEdge } from '@pickchick/edge';
import { createPool } from '@pickchick/database';
import { EdgeMenuStateQuerySchema, ErrorSchema } from '@pickchick/contracts';
import {
  publishMenu,
  pullMenu,
  applyMenu,
  acknowledgeMenu,
  provisionDevice,
  revokeDevice,
  syncMenuOnce,
  hashJson,
} from '@pickchick/menu-sync';
import { withSyncDatabases, running, authFor, headersFor, request } from '../helpers/sync.mjs';

const isConflict = (error) => error.code === 'CONFLICT';

test('HTTP worker delivers menu; cloud only activates after edge commit and ACK', async () => {
  await withSyncDatabases(async ({ cloud, edge, device, branch, menu }) => {
    const identity = await provisionDevice(cloud.pool, device);
    const release = menu();
    await publishMenu(cloud.pool, release);
    const api = await running(createApi, cloud.config);
    let local = await running(createEdge, edge.config);
    let apiOpen = true;
    try {
      assert.equal((await request(`${api.url}/v1/branches/${branch}/menu`)).status, 404);
      assert.deepEqual(await syncMenuOnce(edge.pool, branch, api.url, identity), {
        state: 'applied',
      });
      assert.deepEqual(
        await (await request(`${api.url}/v1/branches/${branch}/menu`)).json(),
        release,
      );
      assert.deepEqual(await syncMenuOnce(edge.pool, branch, api.url, identity), { state: 'idle' });
      await api.app.close();
      apiOpen = false;
      await local.app.close();
      local = await running(createEdge, edge.config);
      assert.deepEqual(await (await request(`${local.url}/edge/v1/menu`)).json(), release);
      assert.equal((await request(`${local.url}/health/ready`)).status, 200);
    } finally {
      await local.app.close();
      if (apiOpen) await api.app.close();
    }
  });
});

test('concurrent publication is idempotent and sequence allocation rolls back on conflict', async () => {
  await withSyncDatabases(async ({ cloud, menu }) => {
    const release = menu();
    const [first, again] = await Promise.all([
      publishMenu(cloud.pool, release),
      publishMenu(cloud.pool, release),
    ]);
    assert.deepEqual(first, again);
    await assert.rejects(publishMenu(cloud.pool, { ...release, items: [] }), isConflict);
    await assert.rejects(publishMenu(cloud.pool, menu()), isConflict);
    const second = await publishMenu(cloud.pool, menu(2));
    assert.equal(second.producer_sequence, '2');
    assert.equal((await cloud.pool.query('SELECT count(*) FROM menu_releases')).rows[0].count, '2');
  });
});

test('concurrent delivery stores one snapshot, inbox effect and durable ACK', async () => {
  await withSyncDatabases(async ({ cloud, edge, branch, menu }) => {
    const event = await publishMenu(cloud.pool, menu());
    const results = await Promise.all([
      applyMenu(edge.pool, branch, event),
      applyMenu(edge.pool, branch, event),
    ]);
    assert.deepEqual(results[0], results[1]);
    for (const table of ['menu_snapshots', 'inbox_messages', 'outbox_events']) {
      assert.equal((await edge.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count, '1');
    }
    const stream = (await edge.pool.query('SELECT * FROM menu_sync_state')).rows[0];
    assert.notEqual(stream.ack_producer_id, event.producer_id);
  });
});

test('edge rejects corrupt checksum, foreign branch, unknown schema and sequence gaps', async () => {
  await withSyncDatabases(async ({ cloud, edge, branch, menu }) => {
    const event = await publishMenu(cloud.pool, menu());
    for (const invalid of [
      { ...event, producer_sequence: '2' },
      { ...event, branch_id: randomUUID() },
      { ...event, aggregate_id: randomUUID() },
      { ...event, schema_version: 99 },
      { ...event, payload: { ...event.payload, checksum: '0'.repeat(64) } },
    ])
      await assert.rejects(applyMenu(edge.pool, branch, invalid));
    assert.equal((await edge.pool.query('SELECT count(*) FROM menu_snapshots')).rows[0].count, '0');
    await applyMenu(edge.pool, branch, event);
    const changed = { ...event, correlation_id: randomUUID() };
    await assert.rejects(applyMenu(edge.pool, branch, changed), isConflict);
    const next = await publishMenu(cloud.pool, menu(2));
    await assert.rejects(
      applyMenu(edge.pool, branch, { ...next, producer_id: randomUUID() }),
      isConflict,
    );
    assert.equal(
      (await edge.pool.query('SELECT last_sequence FROM menu_sync_state')).rows[0].last_sequence,
      '1',
    );
  });
});

test('lost ACK response survives pool restart and an old ACK never rolls back a newer menu', async () => {
  await withSyncDatabases(async ({ cloud, edge, device, branch, menu }) => {
    const identity = await provisionDevice(cloud.pool, device);
    const first = await publishMenu(cloud.pool, menu());
    const ack = await applyMenu(edge.pool, branch, first);
    await acknowledgeMenu(cloud.pool, authFor(identity), ack); // response lost before local outbox update
    const api = await running(createApi, cloud.config);
    const restartedPool = createPool(edge.config.databaseUrl);
    try {
      assert.deepEqual(await syncMenuOnce(restartedPool, branch, api.url, identity), {
        state: 'acknowledged',
      });
      assert.equal(
        (await edge.pool.query('SELECT count(*) FROM outbox_events WHERE acknowledged_at IS NULL'))
          .rows[0].count,
        '0',
      );
      const nextMenu = menu(2);
      await publishMenu(cloud.pool, nextMenu);
      await syncMenuOnce(restartedPool, branch, api.url, identity);
      await acknowledgeMenu(cloud.pool, authFor(identity), ack);
      assert.equal(
        (await cloud.pool.query('SELECT release_id FROM branch_menu_activations')).rows[0]
          .release_id,
        nextMenu.release_id,
      );
      assert.equal(
        (await cloud.pool.query('SELECT count(*) FROM inbox_messages')).rows[0].count,
        '2',
      );
    } finally {
      await restartedPool.end();
      await api.app.close();
    }
  });
});

test('device keys are hashed, rotated, expired and revoked with HTTP access denied', async () => {
  await withSyncDatabases(async ({ cloud, device }) => {
    const identity = await provisionDevice(cloud.pool, device);
    const stored = (await cloud.pool.query('SELECT token_hash FROM device_credentials')).rows[0]
      .token_hash;
    assert.notEqual(stored, identity.token);
    const api = await running(createApi, cloud.config);
    const pull = (headers) => request(`${api.url}/internal/v1/edge/sync/pull`, { headers });
    try {
      const missing = await pull({});
      assert.equal(missing.status, 401);
      assert.equal(ErrorSchema.parse(await missing.json()).code, 'UNAUTHORIZED');
      const malformed = await request(`${api.url}/internal/v1/edge/sync/ack`, {
        method: 'POST',
        headers: headersFor(identity),
        body: '{',
      });
      assert.equal(malformed.status, 400);
      ErrorSchema.parse(await malformed.json());
      const oversized = await request(`${api.url}/internal/v1/edge/sync/ack`, {
        method: 'POST',
        headers: headersFor(identity),
        body: JSON.stringify({ text: 'x'.repeat(150000) }),
      });
      assert.equal(oversized.status, 413);
      ErrorSchema.parse(await oversized.json());
      assert.equal((await pull(headersFor({ ...identity, token: '0'.repeat(64) }))).status, 401);
      const rotated = await provisionDevice(cloud.pool, device, true);
      assert.equal((await pull(headersFor(identity))).status, 401);
      assert.equal((await pull(headersFor(rotated))).status, 200);
      await cloud.pool.query(
        "UPDATE device_credentials SET issued_at = now() - interval '2 days', expires_at = now() - interval '1 day'",
      );
      assert.equal((await pull(headersFor(rotated))).status, 401);
      const renewed = await provisionDevice(cloud.pool, device, true);
      await revokeDevice(cloud.pool, device);
      assert.equal((await pull(headersFor(renewed))).status, 401);
      await assert.rejects(provisionDevice(cloud.pool, device, true), isConflict);
      assert.equal(
        (await cloud.pool.query("SELECT count(*) FROM device_audit WHERE action = 'revoked'"))
          .rows[0].count,
        '1',
      );
    } finally {
      await api.app.close();
    }
  });
});

test('devices cannot read or acknowledge another branch and only one edge can be active', async () => {
  await withSyncDatabases(async ({ cloud, edge, org, legal, branch, device, menu }) => {
    await provisionDevice(cloud.pool, device);
    const otherBranch = randomUUID(),
      otherDevice = randomUUID(),
      duplicate = randomUUID();
    await cloud.pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES ($1,$2,$3,'OTHER','Other synthetic')",
      [otherBranch, org, legal],
    );
    await cloud.pool.query(
      "INSERT INTO devices(id,branch_id,organization_id,kind,name) VALUES ($1,$2,$3,'edge','Other edge'),($4,$5,$3,'edge','Duplicate edge')",
      [otherDevice, otherBranch, org, duplicate, branch],
    );
    const other = await provisionDevice(cloud.pool, otherDevice);
    await assert.rejects(provisionDevice(cloud.pool, duplicate), (error) => error.code === '23505');
    const event = await publishMenu(cloud.pool, menu());
    const ack = await applyMenu(edge.pool, branch, event);
    const api = await running(createApi, cloud.config);
    try {
      const pull = await request(`${api.url}/internal/v1/edge/sync/pull?branch_id=${branch}`, {
        headers: headersFor(other),
      });
      assert.deepEqual(await pull.json(), { event: null });
      const response = await request(`${api.url}/internal/v1/edge/sync/ack`, {
        method: 'POST',
        headers: headersFor(other),
        body: JSON.stringify(ack),
      });
      assert.equal(response.status, 404);
      assert.equal(
        (await cloud.pool.query('SELECT count(*) FROM branch_menu_activations')).rows[0].count,
        '0',
      );
    } finally {
      await api.app.close();
    }
  });
});

test('failure during inbox write rolls back snapshot, activation, cursor and ACK together', async () => {
  await withSyncDatabases(async ({ cloud, edge, branch, menu }) => {
    const event = await publishMenu(cloud.pool, menu());
    await edge.pool
      .query(`CREATE FUNCTION fail_inbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated inbox failure'; END; $$;
      CREATE TRIGGER test_failure BEFORE INSERT ON inbox_messages FOR EACH ROW EXECUTE FUNCTION fail_inbox()`);
    await assert.rejects(applyMenu(edge.pool, branch, event));
    for (const table of ['menu_snapshots', 'active_menu', 'menu_sync_state', 'outbox_events'])
      assert.equal((await edge.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count, '0');
    await edge.pool.query('DROP TRIGGER test_failure ON inbox_messages');
    await applyMenu(edge.pool, branch, event);
  });
});

test('publication failure cannot commit a release without its delivery event', async () => {
  await withSyncDatabases(async ({ cloud, menu }) => {
    await cloud.pool
      .query(`CREATE FUNCTION fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated outbox failure'; END; $$;
      CREATE TRIGGER test_failure BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION fail_outbox()`);
    const release = menu();
    await assert.rejects(publishMenu(cloud.pool, release));
    assert.equal((await cloud.pool.query('SELECT count(*) FROM menu_releases')).rows[0].count, '0');
    assert.equal((await cloud.pool.query('SELECT count(*) FROM menu_streams')).rows[0].count, '0');
    await cloud.pool.query('DROP TRIGGER test_failure ON outbox_events');
    assert.equal((await publishMenu(cloud.pool, release)).producer_sequence, '1');
  });
});

test('offline ACK stays durable and retry resumes after central HTTP service returns', async () => {
  await withSyncDatabases(async ({ cloud, edge, device, branch, menu }) => {
    const identity = await provisionDevice(cloud.pool, device);
    const event = await publishMenu(cloud.pool, menu());
    await applyMenu(edge.pool, branch, event);
    await assert.rejects(syncMenuOnce(edge.pool, branch, 'http://127.0.0.1:1', identity));
    assert.equal(
      (await edge.pool.query('SELECT count(*) FROM outbox_events WHERE acknowledged_at IS NULL'))
        .rows[0].count,
      '1',
    );
    const api = await running(createApi, cloud.config);
    try {
      assert.deepEqual(await syncMenuOnce(edge.pool, branch, api.url, identity), {
        state: 'acknowledged',
      });
      assert.equal(
        (await cloud.pool.query('SELECT release_id FROM branch_menu_activations')).rows[0]
          .release_id,
        event.aggregate_id,
      );
    } finally {
      await api.app.close();
    }
  });
});

test('pull redelivers oldest event; ACK gaps and wrong checksum are rejected', async () => {
  await withSyncDatabases(async ({ cloud, edge, device, branch, menu }) => {
    const identity = await provisionDevice(cloud.pool, device);
    const auth = authFor(identity);
    const first = await publishMenu(cloud.pool, menu());
    const next = await publishMenu(cloud.pool, menu(2));
    assert.deepEqual((await pullMenu(cloud.pool, auth)).event, first);
    assert.deepEqual((await pullMenu(cloud.pool, auth)).event, first);
    const ack = await applyMenu(edge.pool, branch, first);
    const futureAck = {
      ...ack,
      event_id: next.event_id,
      producer_sequence: next.producer_sequence,
      release_id: next.aggregate_id,
      checksum: next.payload.checksum,
    };
    await assert.rejects(acknowledgeMenu(cloud.pool, auth, futureAck), isConflict);
    await assert.rejects(
      acknowledgeMenu(cloud.pool, auth, { ...ack, checksum: '0'.repeat(64) }),
      isConflict,
    );
    await acknowledgeMenu(cloud.pool, auth, ack);
    assert.deepEqual((await pullMenu(cloud.pool, auth)).event, next);
    const stale = {
      ...next,
      payload: { menu: { ...next.payload.menu, version: 1 }, checksum: '' },
      aggregate_version: 1,
    };
    stale.payload.checksum = hashJson(stale.payload.menu);
    // A version that is not newer is a poison event: ACKed as rejected, never retried forever.
    const rejected = await applyMenu(edge.pool, branch, stale);
    assert.equal(rejected.result, 'rejected');
    assert.equal(rejected.reason, 'VERSION_NOT_NEWER');
    assert.equal(
      (await edge.pool.query('SELECT release_id FROM active_menu')).rows[0].release_id,
      first.aggregate_id,
    );
  });
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Synthetic WebP container; the edge verifies the header and the content hash only. */
const webp = (seed) => {
  const body = Buffer.concat([Buffer.from('WEBPVP8L'), Buffer.from(seed.repeat(16))]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF'), size, body]);
};
const withImage = (release, bytes) => {
  const sha = sha256(bytes);
  // menu() shares the fixture items array: replace it, never mutate it.
  release.items = [
    {
      ...release.items[0],
      image_url: `/assets/menu/${sha}.webp`,
      image: { sha256: sha, url: `/assets/menu/${sha}.webp` },
    },
    ...release.items.slice(1),
  ];
  return sha;
};
/** Legacy cloud releases without delivery events, as the WP-B version bootstrap leaves them. */
async function seedCloudReleases(cloud, menu, upTo) {
  for (let version = 1; version <= upTo; version += 1) {
    const legacy = menu(version);
    await cloud.pool.query(
      `INSERT INTO menu_releases(id, branch_id, version, schema_version, payload, checksum, published_at)
      VALUES ($1,$2,$3,1,$4,$5,$6)`,
      [legacy.release_id, legacy.branch_id, version, legacy, hashJson(legacy), legacy.published_at],
    );
  }
}
const eventFor = (menu, sequence, producer) => ({
  event_id: randomUUID(),
  producer_id: producer,
  producer_sequence: String(sequence),
  aggregate_type: 'menu_release',
  aggregate_id: menu.release_id,
  aggregate_version: menu.version,
  event_type: 'menu.published',
  schema_version: 1,
  branch_id: menu.branch_id,
  occurred_at: new Date().toISOString(),
  correlation_id: randomUUID(),
  causation_id: null,
  payload: { menu, checksum: hashJson(menu) },
});
/** Operator-installed local snapshot (scripts/local-pos-catalog-upgrade.mjs), no menu cursor. */
async function seedLocalMenu(edge, menu) {
  await edge.pool.query(
    `INSERT INTO menu_snapshots(id, branch_id, version, schema_version, payload, checksum, published_at)
    VALUES ($1,$2,$3,1,$4,$5,$6)`,
    [menu.release_id, menu.branch_id, menu.version, menu, hashJson(menu), menu.published_at],
  );
  await edge.pool.query('INSERT INTO active_menu(branch_id, release_id) VALUES ($1,$2)', [
    menu.branch_id,
    menu.release_id,
  ]);
}
/** Loopback stand-in for the private cloud API: a menu event queue, ACKs and media files. */
async function fakeCloud(media = new Map()) {
  const queue = [],
    requests = [],
    acks = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ path: url.pathname, query: url.search, headers: req.headers });
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/internal/v1/edge/sync/pull')
      return json(200, { event: queue[0] ?? null });
    if (url.pathname === '/internal/v1/edge/sync/ack') {
      const ack = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      acks.push(ack);
      if (queue[0]?.event_id === ack.event_id) queue.shift();
      return json(200, { event_id: ack.event_id, acknowledged: true });
    }
    const file = /^\/internal\/v1\/edge\/media\/([a-f0-9]{64})\.card\.webp$/.exec(url.pathname);
    if (file && media.has(file[1])) {
      res.writeHead(200, { 'Content-Type': 'image/webp' });
      return res.end(media.get(file[1]));
    }
    return json(404, { code: 'NOT_FOUND' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    queue,
    requests,
    acks,
    media,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('bootstrap: local v2 with an empty cursor reports v2 on pull, then applies cloud v3 at sequence 1', async () => {
  await withSyncDatabases(async ({ cloud, edge, device, branch, menu }) => {
    const identity = await provisionDevice(cloud.pool, device);
    const fake = await fakeCloud();
    try {
      assert.deepEqual(await syncMenuOnce(edge.pool, branch, fake.url, identity), {
        state: 'idle',
      });
      assert.equal(fake.requests[0].query, '');
      const local = menu(2);
      await seedLocalMenu(edge, local);
      await syncMenuOnce(edge.pool, branch, fake.url, identity);
      const reported = Object.fromEntries(new URLSearchParams(fake.requests[1].query));
      assert.deepEqual(reported, { active_release_id: local.release_id, active_version: '2' });
      assert.deepEqual(EdgeMenuStateQuerySchema.parse(reported), {
        active_release_id: local.release_id,
        active_version: 2,
      });
      assert.equal(fake.requests[1].headers.authorization, `Bearer ${identity.token}`);
    } finally {
      await fake.close();
    }
    await seedCloudReleases(cloud, menu, 2);
    const release = menu(3);
    const event = await publishMenu(cloud.pool, release);
    assert.equal(event.producer_sequence, '1');
    const api = await running(createApi, cloud.config);
    try {
      assert.deepEqual(await syncMenuOnce(edge.pool, branch, api.url, identity), {
        state: 'applied',
      });
      assert.deepEqual(
        await (await request(`${api.url}/v1/branches/${branch}/menu`)).json(),
        release,
      );
      assert.deepEqual(await syncMenuOnce(edge.pool, branch, api.url, identity), { state: 'idle' });
    } finally {
      await api.app.close();
    }
    assert.equal(
      (await edge.pool.query('SELECT release_id FROM active_menu')).rows[0].release_id,
      release.release_id,
    );
    assert.deepEqual(
      (await edge.pool.query('SELECT version, result, reason FROM menu_apply_results')).rows,
      [{ version: 3, result: 'applied', reason: null }],
    );
    // Applied ACKs keep the pre-v2 shape: no result field.
    const ack = (
      await edge.pool.query("SELECT payload FROM outbox_events WHERE event_type='menu.applied'")
    ).rows[0].payload;
    assert.equal('result' in ack, false);
  });
});

test('a version that is not newer is ACKed rejected, keeps the active menu, and the next event applies', async () => {
  await withSyncDatabases(async ({ cloud, edge, device, branch, menu }) => {
    const identity = await provisionDevice(cloud.pool, device);
    const local = menu(2);
    await seedLocalMenu(edge, local);
    await seedCloudReleases(cloud, menu, 1);
    const stale = await publishMenu(cloud.pool, menu(2));
    const next = menu(3);
    await publishMenu(cloud.pool, next);
    const api = await running(createApi, cloud.config);
    try {
      assert.deepEqual(await syncMenuOnce(edge.pool, branch, api.url, identity), {
        state: 'rejected',
        reason: 'VERSION_NOT_NEWER',
      });
      assert.equal(
        (await edge.pool.query('SELECT release_id FROM active_menu')).rows[0].release_id,
        local.release_id,
      );
      const outbox = (
        await edge.pool.query(
          "SELECT payload, acknowledged_at FROM outbox_events WHERE event_type='menu.applied'",
        )
      ).rows;
      assert.equal(outbox.length, 1);
      assert.equal(outbox[0].payload.result, 'rejected');
      assert.equal(outbox[0].payload.reason, 'VERSION_NOT_NEWER');
      assert.ok(outbox[0].acknowledged_at);
      // Replaying the same delivery returns the stored rejected ACK.
      assert.deepEqual(await applyMenu(edge.pool, branch, stale), outbox[0].payload);
      assert.deepEqual(await syncMenuOnce(edge.pool, branch, api.url, identity), {
        state: 'applied',
      });
      assert.deepEqual(await syncMenuOnce(edge.pool, branch, api.url, identity), { state: 'idle' });
    } finally {
      await api.app.close();
    }
    assert.equal(
      (await edge.pool.query('SELECT release_id FROM active_menu')).rows[0].release_id,
      next.release_id,
    );
    assert.equal(
      (await edge.pool.query('SELECT last_sequence FROM menu_sync_state')).rows[0].last_sequence,
      '2',
    );
    assert.equal(
      (await cloud.pool.query('SELECT release_id FROM branch_menu_activations')).rows[0].release_id,
      next.release_id,
    );
    assert.deepEqual(
      (
        await edge.pool.query(
          'SELECT version, result, reason FROM menu_apply_results ORDER BY version',
        )
      ).rows,
      [
        { version: 2, result: 'rejected', reason: 'VERSION_NOT_NEWER' },
        { version: 3, result: 'applied', reason: null },
      ],
    );
  });
});

test('photos are downloaded and hash-verified before apply; missing media is rejected after 3 attempts', async () => {
  await withSyncDatabases(async ({ cloud, edge, device, branch, menu }) => {
    const identity = await provisionDevice(cloud.pool, device);
    const fake = await fakeCloud();
    const mediaAttempts = new Map();
    const sync = () => syncMenuOnce(edge.pool, branch, fake.url, identity, { mediaAttempts });
    let local;
    try {
      const missing = menu(1);
      const missingSha = withImage(missing, webp('missing'));
      fake.queue.push(await publishMenu(cloud.pool, missing));
      await assert.rejects(sync(), /Sync HTTP 404/);
      await assert.rejects(sync(), /Sync HTTP 404/);
      assert.equal(fake.acks.length, 0);
      assert.deepEqual(await sync(), { state: 'rejected', reason: 'MEDIA_UNAVAILABLE' });
      const mediaRequests = fake.requests.filter((r) => r.path.includes('/media/'));
      assert.equal(mediaRequests.length, 3);
      assert.ok(
        mediaRequests.every(
          (r) =>
            r.path === `/internal/v1/edge/media/${missingSha}.card.webp` &&
            r.headers.authorization === `Bearer ${identity.token}` &&
            r.headers['x-device-id'] === identity.device_id,
        ),
      );
      assert.equal(fake.acks.length, 1);
      assert.equal(fake.acks[0].result, 'rejected');
      assert.equal(fake.acks[0].reason, 'MEDIA_UNAVAILABLE');
      assert.equal((await edge.pool.query('SELECT count(*)::int n FROM active_menu')).rows[0].n, 0);
      assert.equal(mediaAttempts.size, 0);

      // Bytes that do not hash to the requested name are never stored or served.
      const tampered = menu(2);
      const tamperedSha = withImage(tampered, webp('genuine'));
      fake.media.set(tamperedSha, webp('tampered'));
      fake.queue.push(await publishMenu(cloud.pool, tampered));
      await assert.rejects(sync(), /hash mismatch/);
      assert.equal((await edge.pool.query('SELECT count(*)::int n FROM menu_media')).rows[0].n, 0);
      fake.media.set(tamperedSha, webp('genuine'));
      assert.deepEqual(await sync(), { state: 'applied' });
      local = tampered;
      assert.equal(
        (await edge.pool.query('SELECT sha256, mime FROM menu_media')).rows[0].sha256,
        tamperedSha,
      );
      assert.deepEqual(await sync(), { state: 'idle' });
    } finally {
      await fake.close();
    }
    const server = await running(createEdge, edge.config);
    try {
      const version = await request(`${server.url}/edge/v1/menu/version`);
      assert.equal(version.status, 200);
      assert.deepEqual(await version.json(), { release_id: local.release_id, version: 2 });
      const sha = local.items[0].image.sha256;
      const image = await request(`${server.url}/edge/v1/media/${sha}.webp`);
      assert.equal(image.status, 200);
      assert.equal(image.headers.get('content-type'), 'image/webp');
      assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(image.headers.get('cache-control'), 'private, max-age=31536000, immutable');
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), webp('genuine'));
      for (const path of [
        `${'0'.repeat(64)}.webp`,
        `${sha.toUpperCase()}.webp`,
        `${sha}.card.webp`,
        `${sha}.png`,
      ])
        assert.equal((await request(`${server.url}/edge/v1/media/${path}`)).status, 404);
    } finally {
      await server.app.close();
    }
  });
});

test('deterministic invalid menus are ACKed INVALID_MENU or MEDIA_UNAVAILABLE; integrity faults still throw', async () => {
  await withSyncDatabases(async ({ edge, branch, menu }) => {
    const producer = randomUUID();
    const duplicate = menu(1);
    duplicate.items = [duplicate.items[0], { ...duplicate.items[0] }];
    const first = eventFor(duplicate, 1, producer);
    const [a, b] = await Promise.all([
      applyMenu(edge.pool, branch, first),
      applyMenu(edge.pool, branch, first),
    ]);
    assert.deepEqual(a, b);
    assert.equal(a.reason, 'INVALID_MENU');
    // An intact menu this edge cannot parse (future schema) is rejected, not retried forever.
    const future = { ...menu(2), future_field: true };
    const drifted = eventFor(future, 2, producer);
    await assert.rejects(
      applyMenu(edge.pool, branch, {
        ...drifted,
        payload: { ...drifted.payload, checksum: '0'.repeat(64) },
      }),
      isConflict,
    );
    await assert.rejects(
      applyMenu(edge.pool, branch, { ...drifted, producer_id: randomUUID() }),
      isConflict,
    );
    const invalid = await applyMenu(edge.pool, branch, drifted);
    assert.equal(invalid.reason, 'INVALID_MENU');
    assert.equal(invalid.release_id, future.release_id);
    assert.deepEqual(await applyMenu(edge.pool, branch, drifted), invalid);
    const photo = menu(3);
    withImage(photo, webp('absent'));
    const media = await applyMenu(edge.pool, branch, eventFor(photo, 3, producer));
    assert.equal(media.reason, 'MEDIA_UNAVAILABLE');
    const valid = menu(4);
    assert.equal(
      (await applyMenu(edge.pool, branch, eventFor(valid, 4, producer))).result,
      undefined,
    );
    assert.equal(
      (await edge.pool.query('SELECT count(*)::int n FROM menu_snapshots')).rows[0].n,
      1,
    );
    assert.equal(
      (await edge.pool.query('SELECT count(*)::int n FROM inbox_messages')).rows[0].n,
      4,
    );
    assert.equal(
      (
        await edge.pool.query(
          "SELECT count(*)::int n FROM outbox_events WHERE event_type='menu.applied'",
        )
      ).rows[0].n,
      4,
    );
  });
});

test('menu media and apply results are content-checked and immutable', async () => {
  await withSyncDatabases(async ({ edge }) => {
    const bytes = webp('stored');
    await assert.rejects(
      edge.pool.query("INSERT INTO menu_media(sha256,mime,bytes) VALUES ($1,'image/webp',$2)", [
        '0'.repeat(64),
        bytes,
      ]),
      (error) => error.code === '23514',
    );
    await assert.rejects(
      edge.pool.query("INSERT INTO menu_media(sha256,mime,bytes) VALUES ($1,'image/png',$2)", [
        sha256(bytes),
        bytes,
      ]),
      (error) => error.code === '23514',
    );
    await edge.pool.query("INSERT INTO menu_media(sha256,mime,bytes) VALUES ($1,'image/webp',$2)", [
      sha256(bytes),
      bytes,
    ]);
    await assert.rejects(
      edge.pool.query('DELETE FROM menu_media'),
      (error) => error.code === '23514',
    );
    await assert.rejects(
      edge.pool.query("UPDATE menu_media SET mime='image/webp'"),
      (error) => error.code === '23514',
    );
  });
});
