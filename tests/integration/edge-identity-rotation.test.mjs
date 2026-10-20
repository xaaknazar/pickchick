import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApi } from '@pickchick/api';
import { createPool, transaction } from '@pickchick/database';
import {
  authenticateDevice,
  confirmDeviceIdentity,
  hashToken,
  provisionDevice,
  revokeDevice,
  rotateDeviceIdentity,
} from '@pickchick/menu-sync';
import { renewIdentityFile } from '@pickchick/fulfillment-transport';
import { edgeIdentityRotationGrants } from '../../infra/staging/edge-identity-rotation-grants.mjs';
import { withSyncDatabases, running, authFor, headersFor, request } from '../helpers/sync.mjs';

const code = (expected) => (error) => error.code === expected;
const DAY = 24 * 3600 * 1000;
const rotate = (pool, identity, rotationId = randomUUID()) =>
  rotateDeviceIdentity(pool, authFor(identity), { rotation_id: rotationId });
const confirm = (pool, identity, rotationId) =>
  confirmDeviceIdentity(pool, authFor(identity), { rotation_id: rotationId });
const authenticates = (pool, identity) =>
  transaction(pool, (client) => authenticateDevice(client, authFor(identity)));
const expireIn = (cloud, device, interval) =>
  cloud.pool.query(
    `UPDATE device_credentials SET issued_at = clock_timestamp() - interval '1 day',
       expires_at = clock_timestamp() + $2::interval WHERE device_id = $1`,
    [device, interval],
  );
const count = async (pool, sql, args = []) => Number((await pool.query(sql, args)).rows[0].count);
const rotations = (cloud) => count(cloud.pool, 'SELECT count(*) FROM device_identity_rotations');
const near = (actual, expected, toleranceMs = 60_000) =>
  assert.ok(
    Math.abs(Date.parse(actual) - expected) < toleranceMs,
    `${actual} not near ${new Date(expected).toISOString()}`,
  );

test('rotation runs only inside the renewal window and never for expired, revoked or pending credentials', async () => {
  await withSyncDatabases(async ({ cloud, device, org, branch }) => {
    const identity = await provisionDevice(cloud.pool, device);
    const hashBefore = hashToken(identity.token);
    await assert.rejects(rotate(cloud.pool, identity), code('CONFLICT'), 'fresh 30-day key');
    await expireIn(cloud, device, '10 days 5 minutes');
    await assert.rejects(rotate(cloud.pool, identity), code('CONFLICT'), 'outside window');
    for (const body of [
      {},
      { rotation_id: 'nope' },
      { rotation_id: randomUUID(), extra: true },
      [randomUUID()],
      null,
    ])
      await assert.rejects(
        rotateDeviceIdentity(cloud.pool, authFor(identity), body),
        code('INVALID_REQUEST'),
      );
    for (const auth of [
      { ...authFor(identity), token: '0'.repeat(64) },
      { ...authFor(identity), token: identity.token.toUpperCase() },
      { ...authFor(identity), deviceId: randomUUID() },
      { ...authFor(identity), deviceId: 'device' },
    ])
      await assert.rejects(
        rotateDeviceIdentity(cloud.pool, auth, { rotation_id: randomUUID() }),
        code('UNAUTHORIZED'),
      );
    // Expired one second ago: never extended.
    await cloud.pool.query(
      "UPDATE device_credentials SET expires_at = clock_timestamp() - interval '1 second'",
    );
    await assert.rejects(rotate(cloud.pool, identity), code('UNAUTHORIZED'));
    assert.equal(
      (await cloud.pool.query('SELECT token_hash FROM device_credentials')).rows[0].token_hash,
      hashBefore,
    );
    // Revoked (inside the window and otherwise valid): refused, and stays revoked.
    const renewed = await provisionDevice(cloud.pool, device, true);
    await expireIn(cloud, device, '5 days');
    await revokeDevice(cloud.pool, device);
    await assert.rejects(rotate(cloud.pool, renewed), code('UNAUTHORIZED'));
    assert.equal(
      (await cloud.pool.query('SELECT status FROM devices WHERE id=$1', [device])).rows[0].status,
      'revoked',
    );
    // A pending (never provisioned) device in another branch has nothing to rotate.
    const otherBranch = randomUUID(),
      pending = randomUUID();
    await cloud.pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) SELECT $1,organization_id,legal_entity_id,'SYNC2','Other' FROM branches WHERE id=$2",
      [otherBranch, branch],
    );
    await cloud.pool.query(
      "INSERT INTO devices(id,branch_id,organization_id,kind,name) VALUES ($1,$2,$3,'edge','Pending')",
      [pending, otherBranch, org],
    );
    await assert.rejects(
      rotateDeviceIdentity(
        cloud.pool,
        { deviceId: pending, token: renewed.token },
        { rotation_id: randomUUID() },
      ),
      code('UNAUTHORIZED'),
    );
    assert.equal(await rotations(cloud), 0);
  });
});

test('rotation issues a fresh 30-day secret, keeps the old one until confirmed plus 24 h and audits append-only', async () => {
  await withSyncDatabases(async ({ cloud, device, branch }) => {
    const identity = await provisionDevice(cloud.pool, device);
    await expireIn(cloud, device, '5 days');
    const oldExpiry = (await cloud.pool.query('SELECT expires_at FROM device_credentials')).rows[0]
      .expires_at;
    const rotationId = randomUUID();
    const started = Date.now();
    const rotated = await rotate(cloud.pool, identity, rotationId);
    assert.deepEqual(Object.keys(rotated).sort(), [
      'branch_id',
      'device_id',
      'expires_at',
      'previous_valid_until',
      'replayed',
      'rotation_id',
      'token',
    ]);
    assert.equal(rotated.device_id, device);
    assert.equal(rotated.branch_id, branch);
    assert.equal(rotated.rotation_id, rotationId);
    assert.equal(rotated.replayed, false);
    assert.match(rotated.token, /^[a-f0-9]{64}$/);
    assert.notEqual(rotated.token, identity.token);
    near(rotated.expires_at, started + 30 * DAY);
    // Unconfirmed, the old secret keeps its own expiry: a lost response stays replayable.
    assert.equal(Date.parse(rotated.previous_valid_until), oldExpiry.getTime());
    // Both work during the overlap.
    assert.equal(await authenticates(cloud.pool, identity), branch);
    assert.equal(await authenticates(cloud.pool, rotated), branch);
    const credential = (await cloud.pool.query('SELECT * FROM device_credentials')).rows[0];
    assert.equal(credential.token_hash, hashToken(rotated.token));
    assert.equal(credential.previous_token_hash, hashToken(identity.token));
    const audit = (await cloud.pool.query('SELECT * FROM device_identity_rotations')).rows[0];
    assert.equal(audit.actor, 'device');
    assert.equal(audit.device_id, device);
    assert.equal(audit.from_token_hash, hashToken(identity.token));
    assert.equal(audit.to_token_hash, hashToken(rotated.token));
    assert.equal(audit.confirmed_at, null);
    // No raw secret is stored anywhere.
    const stored = (
      await cloud.pool.query(
        'SELECT (SELECT jsonb_agg(c) FROM device_credentials c)::text || (SELECT jsonb_agg(r) FROM device_identity_rotations r)::text AS text',
      )
    ).rows[0].text;
    for (const token of [identity.token, rotated.token])
      assert.equal(stored.includes(token), false);
    // Confirmation shortens the overlap to 24 h, anchored at the first confirmation.
    const confirmed = await confirm(cloud.pool, rotated, rotationId);
    near(confirmed.previous_valid_until, Date.now() + DAY);
    assert.deepEqual(await confirm(cloud.pool, rotated, rotationId), confirmed);
    assert.equal(
      (
        await cloud.pool.query('SELECT previous_expires_at FROM device_credentials')
      ).rows[0].previous_expires_at.toISOString(),
      confirmed.previous_valid_until,
    );
    assert.equal(await authenticates(cloud.pool, identity), branch);
    // After the overlap the old secret is dead, the new one is not.
    await cloud.pool.query(
      "UPDATE device_credentials SET previous_expires_at = clock_timestamp() - interval '1 second'",
    );
    await assert.rejects(authenticates(cloud.pool, identity), code('UNAUTHORIZED'));
    assert.equal(await authenticates(cloud.pool, rotated), branch);
    // The overlap never outlives the replaced credential's own expiry.
    await expireIn(cloud, device, '2 hours');
    const expiry = (await cloud.pool.query('SELECT expires_at FROM device_credentials')).rows[0]
      .expires_at;
    const second = await rotate(cloud.pool, rotated);
    assert.equal(Date.parse(second.previous_valid_until), expiry.getTime());
    // The audit ledger is append-only; only confirmation/replay counters move forward.
    for (const sql of [
      `UPDATE device_identity_rotations SET to_token_hash = '${'0'.repeat(64)}'`,
      "UPDATE device_identity_rotations SET expires_at = expires_at + interval '1 year'",
      'UPDATE device_identity_rotations SET replay_count = replay_count - 1 WHERE replay_count > 0',
      'DELETE FROM device_identity_rotations',
    ]) {
      if (sql.includes('replay_count - 1'))
        await cloud.pool.query(
          'UPDATE device_identity_rotations SET replay_count = 1 WHERE rotation_id = $1',
          [rotationId],
        );
      await assert.rejects(cloud.pool.query(sql), code('23514'), sql);
    }
    assert.equal(
      (await confirm(cloud.pool, second, second.rotation_id)).previous_valid_until,
      expiry.toISOString(),
    );
    await assert.rejects(
      cloud.pool.query(
        "UPDATE device_identity_rotations SET confirmed_at = confirmed_at + interval '1 minute' WHERE confirmed_at IS NOT NULL",
      ),
      code('23514'),
    );
    // Manual re-provisioning (device:setup --rotate) also ends any overlap at once.
    const manual = await provisionDevice(cloud.pool, device, true);
    await assert.rejects(authenticates(cloud.pool, rotated), code('UNAUTHORIZED'));
    await assert.rejects(authenticates(cloud.pool, second), code('UNAUTHORIZED'));
    assert.equal(await authenticates(cloud.pool, manual), branch);
    assert.deepEqual(
      (
        await cloud.pool.query(
          'SELECT previous_token_hash, previous_expires_at FROM device_credentials',
        )
      ).rows[0],
      { previous_token_hash: null, previous_expires_at: null },
    );
  });
});

test('a lost response is replayed with the old secret until confirmed; other ids and devices conflict', async () => {
  await withSyncDatabases(async ({ cloud, device, org, branch }) => {
    const identity = await provisionDevice(cloud.pool, device);
    await expireIn(cloud, device, '3 days');
    const rotationId = randomUUID();
    const first = await rotate(cloud.pool, identity, rotationId);
    const replay = await rotate(cloud.pool, identity, rotationId);
    assert.equal(replay.token, first.token);
    assert.equal(replay.expires_at, first.expires_at);
    assert.equal(replay.previous_valid_until, first.previous_valid_until);
    assert.equal(replay.replayed, true);
    // The new secret with its own rotation id is idempotent too (nothing new revealed).
    const own = await rotate(cloud.pool, first, rotationId);
    assert.equal(own.token, first.token);
    assert.equal(own.replayed, true);
    assert.equal(
      (await cloud.pool.query('SELECT replay_count FROM device_identity_rotations')).rows[0]
        .replay_count,
      1,
    );
    // The superseded secret cannot start another rotation; the new one is not due.
    await assert.rejects(rotate(cloud.pool, identity), code('CONFLICT'));
    await assert.rejects(rotate(cloud.pool, first), code('CONFLICT'));
    // Confirmation needs the new secret and is idempotent.
    await assert.rejects(confirm(cloud.pool, identity, rotationId), code('CONFLICT'));
    await assert.rejects(confirm(cloud.pool, first, randomUUID()), code('CONFLICT'));
    const confirmed = await confirm(cloud.pool, first, rotationId);
    assert.equal(confirmed.rotation_id, rotationId);
    assert.equal(confirmed.expires_at, first.expires_at);
    assert.deepEqual(await confirm(cloud.pool, first, rotationId), confirmed);
    // Once confirmed, the old secret (still inside its overlap) can no longer replay.
    assert.equal(await authenticates(cloud.pool, identity), branch);
    await assert.rejects(rotate(cloud.pool, identity, rotationId), code('CONFLICT'));
    // A rotation id belongs to one device.
    const otherBranch = randomUUID(),
      other = randomUUID();
    await cloud.pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) SELECT $1,organization_id,legal_entity_id,'SYNC2','Other' FROM branches WHERE id=$2",
      [otherBranch, branch],
    );
    await cloud.pool.query(
      "INSERT INTO devices(id,branch_id,organization_id,kind,name) VALUES ($1,$2,$3,'edge','Other')",
      [other, otherBranch, org],
    );
    const otherIdentity = await provisionDevice(cloud.pool, other);
    await expireIn(cloud, other, '3 days');
    await assert.rejects(rotate(cloud.pool, otherIdentity, rotationId), code('CONFLICT'));
    assert.equal(await authenticates(cloud.pool, otherIdentity), otherBranch);
    assert.equal(await rotations(cloud), 1);
  });
});

test('concurrent rotations never fork a credential and revocation wins over a racing rotation', async () => {
  await withSyncDatabases(async ({ cloud, device, branch }) => {
    const identity = await provisionDevice(cloud.pool, device);
    await expireIn(cloud, device, '1 day');
    const distinct = await Promise.allSettled(
      Array.from({ length: 8 }, () => rotate(cloud.pool, identity)),
    );
    const won = distinct.filter((r) => r.status === 'fulfilled');
    assert.equal(won.length, 1);
    for (const lost of distinct.filter((r) => r.status === 'rejected'))
      assert.equal(lost.reason.code, 'CONFLICT');
    assert.equal(await rotations(cloud), 1);
    assert.equal(
      (await cloud.pool.query('SELECT token_hash FROM device_credentials')).rows[0].token_hash,
      hashToken(won[0].value.token),
    );
    // The same rotation id in parallel: every caller gets the one credential.
    await expireIn(cloud, device, '1 day');
    const current = won[0].value;
    const same = randomUUID();
    const replays = await Promise.all(
      Array.from({ length: 6 }, () => rotate(cloud.pool, current, same)),
    );
    assert.equal(new Set(replays.map((r) => r.token)).size, 1);
    assert.equal(replays.filter((r) => !r.replayed).length, 1);
    assert.equal(await rotations(cloud), 2);
    assert.equal(await authenticates(cloud.pool, replays[0]), branch);
    // Rotation racing revocation: whichever commits first, the device ends revoked and no
    // credential (old, new or overlap) authenticates.
    await expireIn(cloud, device, '1 day');
    const racing = replays[0];
    const [rotation] = await Promise.allSettled([
      rotate(cloud.pool, racing),
      revokeDevice(cloud.pool, device),
    ]);
    await assert.rejects(authenticates(cloud.pool, racing), code('UNAUTHORIZED'));
    if (rotation.status === 'fulfilled')
      await assert.rejects(authenticates(cloud.pool, rotation.value), code('UNAUTHORIZED'));
    else assert.equal(rotation.reason.code, 'UNAUTHORIZED');
  });
});

test('HTTP rotation is off by default; enabled it is device-authenticated, readiness-checked and monitored', async () => {
  await withSyncDatabases(async ({ cloud, device }) => {
    const identity = await provisionDevice(cloud.pool, device);
    await expireIn(cloud, device, '4 days');
    const post = (url, path, auth, body) =>
      request(`${url}/internal/v1/edge/identity/${path}`, {
        method: 'POST',
        headers: auth ? headersFor(auth) : { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const off = await running(createApi, cloud.config);
    try {
      assert.equal(cloud.config.edgeIdentityRotationEnabled, undefined);
      for (const path of ['rotate', 'confirm'])
        assert.equal(
          (await post(off.url, path, identity, { rotation_id: randomUUID() })).status,
          404,
        );
      assert.equal(await rotations(cloud), 0);
    } finally {
      await off.app.close();
    }
    const on = await running(createApi, { ...cloud.config, edgeIdentityRotationEnabled: true });
    try {
      assert.equal((await post(on.url, 'rotate', null, { rotation_id: randomUUID() })).status, 401);
      assert.equal((await post(on.url, 'rotate', identity, { rotation: 1 })).status, 400);
      const rotationId = randomUUID();
      const response = await post(on.url, 'rotate', identity, { rotation_id: rotationId });
      assert.equal(response.status, 200);
      const rotated = await response.json();
      assert.equal(rotated.replayed, false);
      const pull = (auth) =>
        request(`${on.url}/internal/v1/edge/sync/pull`, { headers: headersFor(auth) });
      assert.equal((await pull(identity)).status, 200, 'old secret inside overlap');
      assert.equal((await pull(rotated)).status, 200);
      assert.equal(
        (await post(on.url, 'confirm', identity, { rotation_id: rotationId })).status,
        409,
      );
      const confirmed = await post(on.url, 'confirm', rotated, { rotation_id: rotationId });
      assert.equal(confirmed.status, 200);
      assert.equal((await confirmed.json()).rotation_id, rotationId);
      // An unknown rotation is a 409: 404 means only "rotation unavailable" to the edge.
      assert.equal(
        (await post(on.url, 'confirm', rotated, { rotation_id: randomUUID() })).status,
        409,
      );
      assert.equal(
        (await post(on.url, 'rotate', rotated, { rotation_id: randomUUID() })).status,
        409,
      );
      const ready = await request(`${on.url}/health/ready`);
      assert.equal(ready.status, 200);
      const metrics = await (await request(`${on.url}/health/metrics`)).text();
      assert.match(metrics, /\npickchick_edge_identity_active_devices 1\n/);
      const days = Number(metrics.match(/\npickchick_edge_identity_min_days_remaining (\S+)\n/)[1]);
      assert.ok(days > 29.9 && days <= 30, String(days));
      assert.match(metrics, /\npickchick_edge_identity_observed_age_seconds \d+\n/);
      assert.equal(metrics.includes(rotated.token) || metrics.includes(device), false);
    } finally {
      await on.app.close();
    }
  });
});

test('least-privilege API role rotates with the helper grants and nothing more; disabled grants refuse', async () => {
  await withSyncDatabases(async ({ cloud, device, branch }) => {
    const identity = await provisionDevice(cloud.pool, device);
    await expireIn(cloud, device, '2 days');
    const role = 'identity_runtime_' + randomUUID().replaceAll('-', '');
    await cloud.admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    let runtime;
    try {
      // The always-on device part of infra/staging/provision.mjs, then the rotation helper off.
      await cloud.pool.query(`GRANT USAGE ON SCHEMA ${cloud.schema} TO ${role};
        GRANT SELECT ON branches, devices, device_credentials, device_audit TO ${role};
        GRANT UPDATE (id) ON branches, devices TO ${role};
        GRANT UPDATE (device_id) ON device_credentials TO ${role};
        ${edgeIdentityRotationGrants(role, false)}`);
      const url = new URL(cloud.config.databaseUrl);
      url.searchParams.set('options', `-c search_path=${cloud.schema} -c role=${role}`);
      runtime = createPool(url.toString(), 2);
      assert.equal(await authenticates(runtime, identity), branch);
      await assert.rejects(rotate(runtime, identity), code('42501'));
      assert.equal(await rotations(cloud), 0);
      await cloud.pool.query(edgeIdentityRotationGrants(role, true));
      const rotationId = randomUUID();
      const rotated = await rotate(runtime, identity, rotationId);
      assert.equal((await rotate(runtime, identity, rotationId)).token, rotated.token);
      await confirm(runtime, rotated, rotationId);
      assert.equal(await authenticates(runtime, rotated), branch);
      for (const sql of [
        `UPDATE devices SET status='active' WHERE id='${device}'`,
        `UPDATE devices SET branch_id=branch_id WHERE id='${device}'`,
        'UPDATE device_credentials SET pos_sync_lock_anchor=false',
        `INSERT INTO device_credentials(device_id,token_hash,expires_at) VALUES ('${randomUUID()}','${'1'.repeat(64)}',now()+interval '1 day')`,
        `INSERT INTO device_audit(id,device_id,action,actor) VALUES ('${randomUUID()}','${device}','rotated','local_setup')`,
        `UPDATE device_identity_rotations SET to_token_hash=to_token_hash`,
        'DELETE FROM device_identity_rotations',
        'TRUNCATE device_identity_rotations',
        'DELETE FROM device_credentials',
      ])
        await assert.rejects(runtime.query(sql), code('42501'), sql);
      // Revocation after a rotation leaves the role nothing it can re-enable.
      await revokeDevice(cloud.pool, device);
      await expireIn(cloud, device, '1 day');
      await assert.rejects(rotate(runtime, rotated), code('UNAUTHORIZED'));
    } finally {
      if (runtime) await runtime.end();
      await cloud.pool.query(`DROP OWNED BY ${role}`);
      await cloud.admin.query(`DROP ROLE ${role}`);
    }
  });
});

async function withIdentityFiles(run) {
  await withSyncDatabases(async (ctx) => {
    const directory = await mkdtemp(join(tmpdir(), 'pickchick-identity-'));
    const api = await running(createApi, {
      ...ctx.cloud.config,
      edgeIdentityRotationEnabled: true,
    });
    try {
      const identity = await provisionDevice(ctx.cloud.pool, ctx.device);
      const path = join(directory, 'device-identity.json');
      const posDirectory = join(directory, 'pos');
      const mirror = join(posDirectory, 'device-identity.json');
      await writeFile(path, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
      const calls = [];
      const options = (patch = {}) => ({
        path,
        origin: api.url,
        branchId: ctx.branch,
        deviceId: ctx.device,
        io: {
          fetch: async (url, init) => {
            calls.push(new URL(url).pathname.split('/').at(-1));
            return fetch(url, init);
          },
        },
        ...patch,
      });
      const read = async (file = path) => JSON.parse(await readFile(file, 'utf8'));
      const write = (file, value) => writeFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      const files = async (dir = directory) => (await readdir(dir)).sort();
      /** Moves the cloud credential into the renewal window and mirrors its expiry locally. */
      const due = async (interval = '5 days', copies = [path]) => {
        await expireIn(ctx.cloud, ctx.device, interval);
        const expires = (
          await ctx.cloud.pool.query('SELECT expires_at FROM device_credentials')
        ).rows[0].expires_at.toISOString();
        for (const file of copies)
          await write(file, { ...(await read(file)), expires_at: expires });
      };
      await run({
        ...ctx,
        api,
        directory,
        posDirectory,
        path,
        mirror,
        identity,
        options,
        calls,
        read,
        write,
        files,
        due,
      });
    } finally {
      await api.app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
const failing = (endpoint, once = false) => {
  let failed = false;
  return {
    fetch: async (url, init) => {
      if (url.endsWith(endpoint) && !(once && failed)) {
        failed = true;
        if (endpoint === '/rotate') {
          // The cloud commits; the response is lost on the way back.
          await (await fetch(url, init)).arrayBuffer();
          throw new Error('connection reset');
        }
        throw new Error('tunnel down');
      }
      return fetch(url, init);
    },
  };
};

test('edge renewal is idle until due, then swaps the file atomically and keeps the overlap', async () => {
  await withIdentityFiles(async (t) => {
    const idle = await renewIdentityFile(t.options());
    assert.equal(idle.state, 'not_due');
    assert.ok(idle.daysRemaining > 29 && idle.daysRemaining <= 30);
    assert.deepEqual(t.calls, [], 'no cloud request while not due');
    assert.deepEqual(await t.files(), ['device-identity.json']);
    await t.due('6 days');
    const result = await renewIdentityFile(t.options());
    assert.equal(result.state, 'rotated');
    assert.equal(result.replayed, false);
    assert.ok(result.daysRemaining > 29.9);
    assert.deepEqual(t.calls, ['rotate', 'confirm']);
    const renewed = await t.read();
    assert.deepEqual(Object.keys(renewed).sort(), [
      'branch_id',
      'device_id',
      'expires_at',
      'token',
    ]);
    assert.notEqual(renewed.token, t.identity.token);
    assert.equal(renewed.device_id, t.device);
    assert.equal((await stat(t.path)).mode & 0o777, 0o600);
    assert.deepEqual(await t.files(), ['device-identity.json'], 'no temp, intent, lock or backup');
    assert.equal(JSON.stringify(result).includes(renewed.token), false);
    // Both secrets authenticate: other workers may still hold the old file for a moment.
    assert.equal(await authenticates(t.cloud.pool, t.identity), t.branch);
    assert.equal(await authenticates(t.cloud.pool, renewed), t.branch);
    assert.notEqual(
      (await t.cloud.pool.query('SELECT confirmed_at FROM device_identity_rotations')).rows[0]
        .confirmed_at,
      null,
    );
    t.calls.length = 0;
    assert.equal((await renewIdentityFile(t.options())).state, 'not_due');
    assert.deepEqual(t.calls, []);
  });
});

test('edge renewal resumes after a lost response, an unconfirmed candidate and a partial mirror swap', async () => {
  await withIdentityFiles(async (t) => {
    await mkdir(t.posDirectory);
    await t.write(t.mirror, t.identity);
    await t.due('2 days', [t.path, t.mirror]);
    const mirrors = [t.mirror];
    // 1. The cloud commits the rotation but the response never arrives.
    const lost = await renewIdentityFile(t.options({ mirrors, io: failing('/rotate') }));
    assert.deepEqual([lost.state, lost.error], ['retry', 'NETWORK_UNKNOWN']);
    assert.equal((await t.read()).token, t.identity.token, 'file untouched');
    assert.deepEqual(await t.files(), [
      'device-identity.json',
      'device-identity.json.rotation',
      'pos',
    ]);
    assert.equal(await rotations(t.cloud), 1);
    // 2. The replay returns the same secret; confirmation then fails before any swap.
    const unconfirmed = await renewIdentityFile(t.options({ mirrors, io: failing('/confirm') }));
    assert.deepEqual([unconfirmed.state, unconfirmed.error], ['retry', 'NETWORK_UNKNOWN']);
    assert.equal((await t.read()).token, t.identity.token, 'never installs an unconfirmed secret');
    const candidate = await t.read(`${t.path}.next`);
    assert.equal(
      hashToken(candidate.token),
      (await t.cloud.pool.query('SELECT token_hash FROM device_credentials')).rows[0].token_hash,
    );
    // 3. Confirmed and swapped, but the mirror cannot be written (crash mid-swap).
    const partial = await renewIdentityFile(
      t.options({
        mirrors,
        secureFile: async (file) => {
          if (file.startsWith(t.mirror)) throw new Error('disk full');
        },
      }),
    );
    assert.equal(partial.state, 'retry');
    assert.equal((await t.read()).token, candidate.token);
    assert.equal((await t.read(t.mirror)).token, t.identity.token);
    assert.equal((await t.read(`${t.path}.previous`)).token, t.identity.token, 'old copy kept');
    // 4. The next turn confirms what is in place, finishes the mirror and cleans up.
    const done = await renewIdentityFile(t.options({ mirrors }));
    assert.equal(done.state, 'rotated');
    assert.deepEqual(done.mirrors, ['replaced']);
    assert.equal((await t.read(t.mirror)).token, candidate.token);
    assert.deepEqual(await t.files(), ['device-identity.json', 'pos']);
    assert.deepEqual(await t.files(t.posDirectory), ['device-identity.json']);
    const audit = (await t.cloud.pool.query('SELECT * FROM device_identity_rotations')).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].replay_count, 1);
    assert.notEqual(audit[0].confirmed_at, null);
    assert.equal(await authenticates(t.cloud.pool, candidate), t.branch);
  });
});

test('edge renewal is single-flight and never overwrites a foreign mirror', async () => {
  await withIdentityFiles(async (t) => {
    await t.due();
    const both = await Promise.all([
      renewIdentityFile(t.options()),
      renewIdentityFile(t.options()),
    ]);
    assert.deepEqual(both.map((r) => r.state).sort(), ['busy', 'rotated']);
    assert.equal(await rotations(t.cloud), 1);
    // A fresh lock from another run blocks; an abandoned one is taken over.
    await t.due();
    await writeFile(`${t.path}.lock`, '');
    assert.equal((await renewIdentityFile(t.options())).state, 'busy');
    const old = new Date(Date.now() - 3600_000);
    await utimes(`${t.path}.lock`, old, old);
    await mkdir(t.posDirectory);
    const foreign = { ...(await t.read()), token: 'f'.repeat(64) };
    await t.write(t.mirror, foreign);
    const taken = await renewIdentityFile(t.options({ mirrors: [t.mirror] }));
    assert.equal(taken.state, 'rotated');
    assert.deepEqual(taken.mirrors, ['mismatch']);
    assert.deepEqual(await t.read(t.mirror), foreign);
    assert.deepEqual(await t.files(), ['device-identity.json', 'pos']);
    assert.equal(await rotations(t.cloud), 2);
  });
});

test('edge renewal refuses when the cloud flag is off, the key expired or was revoked, or the scope differs', async () => {
  await withIdentityFiles(async (t) => {
    await t.due();
    const off = await running(createApi, t.cloud.config);
    try {
      const refused = await renewIdentityFile(t.options({ origin: off.url }));
      assert.deepEqual([refused.state, refused.error], ['refused', 'CLOUD_ROTATION_DISABLED']);
    } finally {
      await off.app.close();
    }
    assert.equal((await t.read()).token, t.identity.token);
    // The intent stays: an earlier attempt with this id may have committed (lost response).
    assert.deepEqual(await t.files(), ['device-identity.json', 'device-identity.json.rotation']);
    const current = await t.read();
    await t.write(t.path, { ...current, expires_at: new Date(Date.now() - 1000).toISOString() });
    const expired = await renewIdentityFile(
      t.options({ io: { fetch: () => assert.fail('an expired key is never sent') } }),
    );
    assert.deepEqual([expired.state, expired.error], ['unauthorized', 'EXPIRED']);
    await t.write(t.path, current);
    await revokeDevice(t.cloud.pool, t.device);
    const revoked = await renewIdentityFile(t.options());
    assert.deepEqual([revoked.state, revoked.error], ['unauthorized', 'CREDENTIAL_REJECTED']);
    assert.deepEqual(await t.read(), current);
    assert.deepEqual(await t.files(), ['device-identity.json']);
    const blocked = await renewIdentityFile(t.options({ deviceId: randomUUID() }));
    assert.deepEqual([blocked.state, blocked.error], ['blocked', 'IDENTITY_SCOPE_MISMATCH']);
    assert.equal(await rotations(t.cloud), 0);
  });
});

test('edge renewal discards a pending candidate when the operator re-provisioned meanwhile', async () => {
  await withIdentityFiles(async (t) => {
    await t.due();
    const pending = await renewIdentityFile(t.options({ io: failing('/confirm') }));
    assert.equal(pending.state, 'retry');
    assert.deepEqual(await t.files(), [
      'device-identity.json',
      'device-identity.json.next',
      'device-identity.json.rotation',
    ]);
    const manual = await provisionDevice(t.cloud.pool, t.device, true);
    await t.write(t.path, manual);
    const result = await renewIdentityFile(t.options());
    assert.deepEqual([result.state, result.error], ['refused', 'INTENT_DISCARDED']);
    assert.deepEqual(await t.read(), manual, 'operator credential kept');
    assert.deepEqual(await t.files(), ['device-identity.json']);
    assert.equal((await renewIdentityFile(t.options())).state, 'not_due');
  });
});

test('a rotation the cloud committed survives the cloud flag being off: same id, no lock-out', async () => {
  await withIdentityFiles(async (t) => {
    const off = await running(createApi, t.cloud.config);
    try {
      // A. The cloud commits, the response is lost, then rotation is switched off.
      await t.due();
      const lost = await renewIdentityFile(t.options({ io: failing('/rotate') }));
      assert.deepEqual([lost.state, lost.error], ['retry', 'NETWORK_UNKNOWN']);
      for (let turn = 0; turn < 2; turn++) {
        const refused = await renewIdentityFile(t.options({ origin: off.url }));
        assert.deepEqual([refused.state, refused.error], ['refused', 'CLOUD_ROTATION_DISABLED']);
        assert.deepEqual(await t.files(), [
          'device-identity.json',
          'device-identity.json.rotation',
        ]);
      }
      // Back on: the kept rotation_id replays the committed key (a new id would get 409).
      const replayed = await renewIdentityFile(t.options());
      assert.deepEqual([replayed.state, replayed.replayed], ['rotated', true]);
      const first = await t.read();
      assert.equal(await authenticates(t.cloud.pool, first), t.branch);
      assert.equal(await rotations(t.cloud), 1);

      // B. The candidate is written but its confirmation meets the switched-off endpoint.
      await t.due();
      const pending = await renewIdentityFile(t.options({ io: failing('/confirm') }));
      assert.equal(pending.state, 'retry');
      const candidate = await t.read(`${t.path}.next`);
      const refused = await renewIdentityFile(t.options({ origin: off.url }));
      assert.deepEqual([refused.state, refused.error], ['refused', 'CLOUD_ROTATION_DISABLED']);
      assert.deepEqual(await t.files(), [
        'device-identity.json',
        'device-identity.json.next',
        'device-identity.json.rotation',
      ]);
      assert.equal((await t.read()).token, first.token, 'never installs an unconfirmed key');
      assert.deepEqual(await t.read(`${t.path}.next`), candidate, 'the issued key is kept');
      const done = await renewIdentityFile(t.options());
      assert.equal(done.state, 'rotated');
      assert.equal((await t.read()).token, candidate.token);
      assert.deepEqual(await t.files(), ['device-identity.json']);
      assert.equal(await rotations(t.cloud), 2);
    } finally {
      await off.app.close();
    }
  });
});
