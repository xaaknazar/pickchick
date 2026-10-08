import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApi } from '@pickchick/api';
import { createEdge } from '@pickchick/edge';
import { createPool } from '@pickchick/database';
import { ErrorSchema } from '@pickchick/contracts';
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
    await assert.rejects(applyMenu(edge.pool, branch, stale), isConflict);
  });
});

const ackFor = (event, extra = {}) => ({
  event_id: event.event_id,
  producer_id: event.producer_id,
  producer_sequence: event.producer_sequence,
  branch_id: event.branch_id,
  release_id: event.aggregate_id,
  checksum: event.payload.checksum,
  ...extra,
});

test('rejected ACK keeps strict order, never activates, records the verdict and unblocks the next event', async () => {
  await withSyncDatabases(async ({ cloud, device, menu }) => {
    const auth = authFor(await provisionDevice(cloud.pool, device));
    const first = await publishMenu(cloud.pool, menu());
    const second = await publishMenu(cloud.pool, menu(2));
    for (const invalid of [
      ackFor(first, { result: 'rejected' }),
      ackFor(first, { reason: 'INVALID_MENU' }),
      ackFor(first, { result: 'applied', reason: 'INVALID_MENU' }),
      ackFor(first, { result: 'rejected', reason: 'SOMETHING_ELSE' }),
    ])
      await assert.rejects(
        acknowledgeMenu(cloud.pool, auth, invalid),
        (e) => e.code === 'INVALID_REQUEST',
      );
    await assert.rejects(
      acknowledgeMenu(
        cloud.pool,
        auth,
        ackFor(second, { result: 'rejected', reason: 'INVALID_MENU' }),
      ),
      isConflict,
      'a rejection cannot skip the oldest pending event',
    );
    const reject = ackFor(first, { result: 'rejected', reason: 'VERSION_NOT_NEWER' });
    await acknowledgeMenu(cloud.pool, auth, reject);
    await acknowledgeMenu(cloud.pool, auth, reject);
    await assert.rejects(acknowledgeMenu(cloud.pool, auth, ackFor(first)), isConflict);
    assert.equal(
      (await cloud.pool.query('SELECT count(*)::int n FROM branch_menu_activations')).rows[0].n,
      0,
    );
    assert.deepEqual((await pullMenu(cloud.pool, auth)).event, second);
    // Applied ACKs without `result` stay byte-identical to the old protocol.
    await acknowledgeMenu(cloud.pool, auth, ackFor(second));
    assert.equal(
      (await cloud.pool.query('SELECT release_id FROM branch_menu_activations')).rows[0].release_id,
      second.aggregate_id,
    );
    assert.deepEqual(
      (
        await cloud.pool.query(
          'SELECT r.result,r.reason,m.version FROM catalog_menu_delivery_results r JOIN menu_releases m ON m.id=r.release_id ORDER BY m.version',
        )
      ).rows,
      [
        { result: 'rejected', reason: 'VERSION_NOT_NEWER', version: 1 },
        { result: 'applied', reason: null, version: 2 },
      ],
    );
    assert.equal(
      (
        await cloud.pool.query('SELECT payload_hash FROM inbox_messages WHERE event_id=$1', [
          second.event_id,
        ])
      ).rows[0].payload_hash,
      hashJson(ackFor(second)),
    );
    assert.equal((await pullMenu(cloud.pool, auth)).event, null);
  });
});

test('HTTP pull records the reported edge menu; malformed reports are rejected without echo', async () => {
  await withSyncDatabases(async ({ cloud, device, branch }) => {
    const identity = await provisionDevice(cloud.pool, device);
    const api = await running(createApi, cloud.config);
    const release = randomUUID();
    const pull = (query) =>
      request(`${api.url}/internal/v1/edge/sync/pull${query}`, { headers: headersFor(identity) });
    const state = async () =>
      (
        await cloud.pool.query(
          'SELECT device_id,active_release_id,active_version FROM edge_menu_state WHERE branch_id=$1',
          [branch],
        )
      ).rows[0];
    try {
      const plain = await pull('?branch_id=ignored');
      assert.equal(plain.status, 200);
      assert.deepEqual(await plain.json(), { event: null });
      assert.equal(await state(), undefined);
      const reported = await pull(`?active_release_id=${release}&active_version=2`);
      assert.equal(reported.status, 200);
      assert.deepEqual(await state(), {
        device_id: device,
        active_release_id: release,
        active_version: 2,
      });
      for (const query of [
        `?active_release_id=${release}`,
        '?active_version=3',
        `?active_release_id=${release}&active_version=3x`,
        `?active_release_id=${release}&active_version=0`,
        `?active_release_id=${release}&active_version=3&active_version=4`,
        `?active_release_id=probe-${'z'.repeat(20)}&active_version=3`,
        `?active_release_id=${release}&active_version=99999999999`,
      ]) {
        const response = await pull(query);
        assert.equal(response.status, 400, query);
        const text = await response.text();
        assert.equal(text.includes('probe-'), false);
        assert.equal(text.includes('3x'), false);
        const body = JSON.parse(text);
        assert.equal(ErrorSchema.parse(body).code, 'INVALID_REQUEST');
      }
      const unauthorized = await request(
        `${api.url}/internal/v1/edge/sync/pull?active_release_id=${release}&active_version=9`,
        { headers: { ...headersFor(identity), Authorization: `Bearer ${'0'.repeat(64)}` } },
      );
      assert.equal(unauthorized.status, 401);
      assert.equal((await state()).active_version, 2);
    } finally {
      await api.app.close();
    }
  });
});

test('least-privilege runtime records edge state and verdicts but cannot rewrite them', async () => {
  const { edgeMenuStateGrants } = await import('../../infra/staging/catalog-edge-grants.mjs');
  await withSyncDatabases(async ({ cloud, device, menu }) => {
    const identity = await provisionDevice(cloud.pool, device);
    const first = await publishMenu(cloud.pool, menu());
    const role = 'menu_runtime_' + randomUUID().replaceAll('-', '');
    await cloud.admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    let runtime;
    try {
      // Mirrors the always-on menu sync part of infra/staging/provision.mjs.
      await cloud.pool.query(`GRANT USAGE ON SCHEMA ${cloud.schema} TO ${role};
        GRANT SELECT ON branches, devices, menu_releases, branch_menu_activations, outbox_events,
          inbox_messages, device_credentials, menu_streams TO ${role};
        GRANT UPDATE (id) ON branches, devices TO ${role};
        GRANT UPDATE (device_id) ON device_credentials TO ${role};
        GRANT UPDATE (attempts, acknowledged_at) ON outbox_events TO ${role};
        GRANT INSERT, UPDATE ON branch_menu_activations TO ${role};
        GRANT INSERT ON inbox_messages TO ${role};
        ${edgeMenuStateGrants(role)}`);
      const url = new URL(cloud.config.databaseUrl);
      url.searchParams.set('options', `-c search_path=${cloud.schema} -c role=${role}`);
      runtime = createPool(url.toString(), 2);
      const auth = authFor(identity);
      await pullMenu(runtime, auth, { active_release_id: randomUUID(), active_version: 2 });
      const current = { active_release_id: randomUUID(), active_version: 3 };
      assert.deepEqual((await pullMenu(runtime, auth, current)).event, first);
      await acknowledgeMenu(
        runtime,
        auth,
        ackFor(first, { result: 'rejected', reason: 'MEDIA_UNAVAILABLE' }),
      );
      assert.equal(
        (await cloud.pool.query('SELECT active_version FROM edge_menu_state')).rows[0]
          .active_version,
        3,
      );
      for (const sql of [
        `UPDATE edge_menu_state SET device_id='${randomUUID()}'`,
        `UPDATE edge_menu_state SET branch_id='${randomUUID()}'`,
        'DELETE FROM edge_menu_state',
        'DELETE FROM catalog_menu_delivery_results',
        "UPDATE catalog_menu_delivery_results SET result='applied'",
      ])
        await assert.rejects(runtime.query(sql), (e) => e.code === '42501', sql);
    } finally {
      if (runtime) await runtime.end();
      await cloud.pool.query(`DROP OWNED BY ${role}`);
      await cloud.admin.query(`DROP ROLE ${role}`);
    }
  });
});
