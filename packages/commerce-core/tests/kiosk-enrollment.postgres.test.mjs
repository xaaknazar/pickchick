import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, realpath, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPool } from '@pickchick/database';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { KioskEnrollment, createKioskEnrollmentMaterial } from '../dist/index.js';
process.env.APP_ENV ??= 'test';
process.env.CLOUD_DATABASE_URL ??=
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55432/pickchick_cloud';
process.env.EDGE_DATABASE_URL ??=
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55433/pickchick_edge';
process.env.EDGE_BRANCH_ID ??= randomUUID();
process.env.REDIS_URL ??= 'redis://127.0.0.1:56379/0';
for (const name of ['CLOUD_DATABASE_URL', 'EDGE_DATABASE_URL'])
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(process.env[name]).hostname));
async function fixture(run) {
  await withSyncDatabases(async (f) => {
    const pool = f.cloud.pool,
      key = randomBytes(32),
      deviceId = randomUUID(),
      deviceToken = randomBytes(32).toString('hex');
    const login = 'Synthetic_13.',
      password = 'synthetic-password-14';
    await pool.query(
      'INSERT INTO kiosk_devices(id,organization_id,branch_id,token_hash) VALUES($1,$2,$3,$4)',
      [deviceId, f.org, f.branch, createHash('sha256').update(deviceToken).digest('hex')],
    );
    const m = await createKioskEnrollmentMaterial(
      { login, password, deviceId, organizationId: f.org, branchId: f.branch, key: deviceToken },
      key,
    );
    await pool.query(
      `INSERT INTO kiosk_enrollment_aliases(login,device_id,organization_id,branch_id,password_salt,password_verifier,token_ciphertext,token_nonce,token_tag,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,statement_timestamp(),statement_timestamp()+interval '24 hours')`,
      [login, deviceId, f.org, f.branch, m.salt, m.verifier, m.ciphertext, m.nonce, m.tag],
    );
    const options = { encryptionKey: key, organizationId: f.org, branchId: f.branch };
    await run({
      f,
      pool,
      key,
      deviceId,
      deviceToken,
      login,
      password,
      options,
      service: new KioskEnrollment(pool, options),
      requestId: randomUUID(),
    });
  });
}
const forbidden = (p) => assert.rejects(p, (e) => e.code === 'FORBIDDEN');
test('exchange returns existing credentials; same nonce replays, different nonce fails; no guests/orders', () =>
  fixture(async (x) => {
    const input = { login: x.login, password: x.password, requestId: x.requestId };
    assert.deepEqual(await x.service.exchange(input), { deviceId: x.deviceId, key: x.deviceToken });
    assert.deepEqual(await x.service.exchange(input), { deviceId: x.deviceId, key: x.deviceToken });
    await forbidden(x.service.exchange({ ...input, requestId: randomUUID() }));
    for (const table of ['kiosk_sessions', 'commerce_orders'])
      assert.equal((await x.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
  }));
test('five bad attempts durably lock for 15min across service instances', () =>
  fixture(async (x) => {
    for (let i = 0; i < 5; i++)
      await forbidden(
        x.service.exchange({
          login: x.login,
          password: 'wrong-synthetic-password',
          requestId: x.requestId,
        }),
      );
    const row = (
      await x.pool.query(
        "SELECT locked_until>clock_timestamp()+interval '14 minutes' locked,request_id FROM kiosk_enrollment_aliases",
      )
    ).rows[0];
    assert.equal(row.locked, true);
    assert.equal(row.request_id, null);
    await forbidden(
      new KioskEnrollment(x.pool, x.options).exchange({
        login: x.login,
        password: x.password,
        requestId: x.requestId,
      }),
    );
    await x.pool.query(
      "UPDATE kiosk_enrollment_aliases SET locked_until=clock_timestamp()-interval '1 second'",
    );
    assert.equal(
      (await x.service.exchange({ login: x.login, password: x.password, requestId: x.requestId }))
        .key,
      x.deviceToken,
    );
  }));
test('scope, case-sensitive alias, expiry, malformed input all deny without consume', () =>
  fixture(async (x) => {
    const input = { login: x.login, password: x.password, requestId: x.requestId };
    await forbidden(
      new KioskEnrollment(x.pool, { ...x.options, branchId: randomUUID() }).exchange(input),
    );
    await forbidden(x.service.exchange({ ...input, login: x.login.toLowerCase() }));
    await forbidden(x.service.exchange({ ...input, requestId: 'invalid' }));
    await x.pool.query(
      "UPDATE kiosk_enrollment_aliases SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour'",
    );
    await forbidden(x.service.exchange(input));
    assert.equal(
      (await x.pool.query('SELECT request_id FROM kiosk_enrollment_aliases')).rows[0].request_id,
      null,
    );
  }));
test('revoked, changed token hash, wrong encryption key, tampered ciphertext deny', () =>
  fixture(async (x) => {
    const input = { login: x.login, password: x.password, requestId: x.requestId };
    await forbidden(
      new KioskEnrollment(x.pool, { ...x.options, encryptionKey: randomBytes(32) }).exchange(input),
    );
    await x.pool.query('UPDATE kiosk_devices SET active=false');
    await forbidden(x.service.exchange(input));
    await x.pool.query('UPDATE kiosk_devices SET active=true,token_hash=$1', ['0'.repeat(64)]);
    await forbidden(x.service.exchange(input));
    await x.pool.query('UPDATE kiosk_devices SET token_hash=$1', [
      createHash('sha256').update(x.deviceToken).digest('hex'),
    ]);
    await x.pool.query('UPDATE kiosk_enrollment_aliases SET token_ciphertext=$1', [
      randomBytes(64),
    ]);
    await forbidden(x.service.exchange(input));
  }));
test('offline provisioning SQL exact replay and conflict guards preserve private files', () =>
  fixture(async (x) => {
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'kiosk-alias-synthetic-'));
    try {
      const device = join(dir, 'device.json'),
        credentials = join(dir, 'credentials.json'),
        key = join(dir, 'key'),
        sqlfile = join(dir, 'enroll.sql');
      const data = JSON.stringify({
        deviceId: x.deviceId,
        organizationId: x.f.org,
        branchId: x.f.branch,
        deviceToken: x.deviceToken,
      });
      await writeFile(device, data, { mode: 0o600 });
      await writeFile(credentials, JSON.stringify({ login: 'OtherAlias', password: x.password }), {
        mode: 0o600,
      });
      await writeFile(key, x.key.toString('hex'), { mode: 0o600 });
      execFileSync(
        process.execPath,
        [
          'scripts/provision-kiosk-enrollment.mjs',
          '--device',
          device,
          '--credentials',
          credentials,
          '--encryption-key',
          key,
          '--output-sql',
          sqlfile,
        ],
        { cwd: new URL('../../../', import.meta.url), stdio: 'pipe' },
      );
      const sql = await readFile(sqlfile, 'utf8');
      assert.ok(!sql.includes(x.password) && !sql.includes(x.deviceToken));
      assert.equal((await stat(sqlfile)).mode & 0o077, 0);
      await x.pool.query(sql);
      await x.pool.query(sql);
      assert.equal(
        (
          await x.pool.query(
            "SELECT count(*)::int n FROM kiosk_enrollment_aliases WHERE login='OtherAlias'",
          )
        ).rows[0].n,
        1,
      );
      await assert.rejects(x.pool.query(sql.replaceAll('OtherAlias', x.login)));
      await x.pool.query('ROLLBACK');
      assert.equal(await readFile(device, 'utf8'), data);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }));

test('concurrent claims permit only one nonce; unknown aliases have bounded work', () =>
  fixture(async (x) => {
    const claims = await Promise.allSettled([
      x.service.exchange({ login: x.login, password: x.password, requestId: randomUUID() }),
      x.service.exchange({ login: x.login, password: x.password, requestId: randomUUID() }),
    ]);
    assert.equal(claims.filter((r) => r.status === 'fulfilled').length, 1);
    const unknown = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        x.service.exchange({ login: `Unknown${i}`, password: x.password, requestId: randomUUID() }),
      ),
    );
    assert.ok(unknown.every((r) => r.status === 'rejected' && r.reason.code === 'FORBIDDEN'));
    assert.equal(
      (await x.pool.query('SELECT count(*)::int n FROM kiosk_enrollment_aliases')).rows[0].n,
      1,
    );
  }));

test('exchange succeeds with exact runtime column grants and cannot change device identity or key', () =>
  fixture(async (x) => {
    const role = `kiosk_enroll_test_${randomUUID().replaceAll('-', '')}`;
    await x.pool.query(`CREATE ROLE ${role} NOLOGIN`);
    let restricted;
    try {
      await x.pool.query(`GRANT USAGE ON SCHEMA ${x.f.cloud.schema} TO ${role}`);
      await x.pool.query(`GRANT SELECT ON kiosk_devices,kiosk_enrollment_aliases TO ${role}`);
      await x.pool.query(
        `GRANT UPDATE(request_id,failed_attempts,locked_until) ON kiosk_enrollment_aliases TO ${role}`,
      );
      const url = new URL(x.f.cloud.config.databaseUrl);
      url.searchParams.set('options', `-c search_path=${x.f.cloud.schema} -c role=${role}`);
      restricted = createPool(url.href);
      const service = new KioskEnrollment(restricted, x.options);
      const input = { login: x.login, password: x.password, requestId: x.requestId };
      await assert.rejects(service.exchange(input), (e) => e.code === '42501');
      await x.pool.query(`GRANT UPDATE(lock_anchor) ON kiosk_devices TO ${role}`);
      assert.deepEqual(await service.exchange(input), { deviceId: x.deviceId, key: x.deviceToken });
      assert.deepEqual(await service.exchange(input), { deviceId: x.deviceId, key: x.deviceToken });
      await assert.rejects(
        restricted.query('UPDATE kiosk_devices SET active=false'),
        (e) => e.code === '42501',
      );
      await assert.rejects(
        restricted.query("UPDATE kiosk_devices SET token_hash=repeat('0',64)"),
        (e) => e.code === '42501',
      );
      await x.pool.query('UPDATE kiosk_devices SET active=false');
      await forbidden(service.exchange(input));
    } finally {
      if (restricted) await restricted.end();
      await x.pool.query(`DROP OWNED BY ${role}`);
      await x.pool.query(`DROP ROLE ${role}`);
    }
  }));
