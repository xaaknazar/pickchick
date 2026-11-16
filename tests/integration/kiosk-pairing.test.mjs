// «Подключить киоск» (owner request 16.11.2026): a branch manager issues a kiosk device and its
// one-time ID/key from «Устройства»; the iPad exchanges them through the unchanged
// /enrollment/exchange. Real PostgreSQL, the real API controller and the back-office proxy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createHttpApplication, RESOURCE } from '@pickchick/platform';
import { createPool } from '@pickchick/database';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { grantBackoffice } from '../../packages/backoffice-core/dist/index.js';
import { DeviceRegistry } from '../../packages/backoffice-core/dist/device-registry.js';
import { KioskEnrollment } from '../../packages/commerce-core/dist/index.js';
import {
  DeviceRegistryController,
  kioskPairingOptions,
} from '../../services/api/dist/device-registry-controller.js';
import { createBackofficeServer } from '../../apps/backoffice/server.mjs';
import { kioskPairingGrants } from '../../infra/staging/kiosk-pairing-grants.mjs';

const sha = (v) => createHash('sha256').update(v).digest('hex');
async function fixture(fn) {
  return withSyncDatabases(async (c) => {
    const manager = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name: 'Synthetic kiosk manager',
      branch_ids: [c.branch],
    });
    await grantBackoffice(c.cloud.pool, manager.actor_id, c.branch, 'manager');
    const options = { encryptionKey: randomBytes(32), organizationId: c.org, branchId: c.branch };
    await fn({
      ...c,
      manager,
      options,
      registry: new DeviceRegistry(c.cloud.pool, true, true, options),
      body: (extra = {}) => ({
        request_id: randomUUID(),
        name: 'Киоск у входа',
        reason: 'Новый iPad на точке',
        ...extra,
      }),
    });
  });
}

test('issued ID/key enroll the iPad through the unchanged exchange; nothing secret is stored', () =>
  fixture(async (c) => {
    const before = await c.registry.read(c.manager.token, c.branch);
    assert.equal(before.kiosk_pairing_enabled, true);
    const issued = await c.registry.issueKiosk(c.manager.token, c.branch, c.body());
    assert.match(issued.login, /^ipad-[a-z0-9]{6}$/);
    assert.match(issued.password, /^[a-z0-9]{16}$/);
    assert.ok(!/[01ilo]/.test(issued.password), 'no ambiguous symbols');
    const ttl = Date.parse(issued.expires_at) - Date.now();
    assert.ok(ttl > 29 * 60_000 && ttl <= 30 * 60_000, String(ttl));

    // The device belongs to this branch; the alias holds a verifier, never the password.
    const device = (
      await c.cloud.pool.query('SELECT * FROM kiosk_devices WHERE id=$1', [issued.device_id])
    ).rows[0];
    assert.equal(device.branch_id, c.branch);
    assert.equal(device.organization_id, c.org);
    assert.equal(device.active, true);
    const stored = JSON.stringify(
      (
        await c.cloud.pool.query(
          `SELECT a.*,i.* FROM kiosk_enrollment_aliases a JOIN kiosk_pairing_issues i USING(login)`,
        )
      ).rows,
      (_k, v) => (v && v.type === 'Buffer' ? Buffer.from(v.data).toString('hex') : v),
    );
    assert.ok(!stored.includes(issued.password));

    // Waiting state in the list, without the password.
    const waiting = await c.registry.read(c.manager.token, c.branch);
    const row = waiting.devices.find((d) => d.id === issued.device_id);
    assert.equal(row.kind, 'kiosk');
    assert.equal(row.name, 'Киоск у входа');
    assert.deepEqual(row.kiosk_pairing, { login: issued.login, expires_at: issued.expires_at });
    assert.ok(!JSON.stringify(waiting).includes(issued.password));

    // The iPad form calls the existing exchange with exactly these values.
    const enrollment = new KioskEnrollment(c.cloud.pool, c.options);
    const requestId = randomUUID();
    const credentials = await enrollment.exchange({
      login: issued.login,
      password: issued.password,
      requestId,
    });
    assert.equal(credentials.deviceId, issued.device_id);
    assert.equal(sha(credentials.key), device.token_hash);
    // A lost answer may be retried by the same iPad only.
    assert.deepEqual(
      await enrollment.exchange({ login: issued.login, password: issued.password, requestId }),
      credentials,
    );
    await assert.rejects(
      enrollment.exchange({
        login: issued.login,
        password: issued.password,
        requestId: randomUUID(),
      }),
      { code: 'FORBIDDEN' },
    );
    await assert.rejects(
      enrollment.exchange({ login: issued.login, password: 'x'.repeat(16), requestId }),
      { code: 'FORBIDDEN' },
    );
    const paired = (await c.registry.read(c.manager.token, c.branch)).devices.find(
      (d) => d.id === issued.device_id,
    );
    assert.equal(paired.kiosk_pairing, null);
    assert.equal(paired.name, 'Киоск у входа');
    assert.equal(paired.status, 'active');
  }));

test('only a manager of the served branch issues; replay, limits and an unused expiry', () =>
  fixture(async (c) => {
    const body = c.body();
    const first = await c.registry.issueKiosk(c.manager.token, c.branch, body);
    await assert.rejects(c.registry.issueKiosk(c.manager.token, c.branch, body), {
      code: 'CONFLICT',
      reason: 'KIOSK_PAIRING_ALREADY_ISSUED',
    });
    await assert.rejects(
      c.registry.issueKiosk(c.manager.token, c.branch, { ...body, name: 'Другое' }),
      (e) => e.code === 'CONFLICT' && e.reason === undefined,
    );
    await assert.rejects(c.registry.issueKiosk(c.manager.token, c.branch, { name: 'x' }), {
      code: 'INVALID_REQUEST',
    });
    // Another branch of the organization is not served by the kiosk API.
    const other = new DeviceRegistry(c.cloud.pool, true, true, {
      ...c.options,
      branchId: randomUUID(),
    });
    await assert.rejects(other.issueKiosk(c.manager.token, c.branch, c.body()), {
      code: 'CONFLICT',
      reason: 'KIOSK_BRANCH_NOT_SERVED',
    });
    assert.equal((await other.read(c.manager.token, c.branch)).kiosk_pairing_enabled, false);
    // Off by configuration: refused before any write.
    const off = new DeviceRegistry(c.cloud.pool, true, true, null);
    await assert.rejects(off.issueKiosk(c.manager.token, c.branch, c.body()), {
      code: 'SERVICE_UNAVAILABLE',
      reason: 'KIOSK_PAIRING_DISABLED',
    });
    // Five per manager in ten minutes.
    for (let i = 0; i < 4; i++) await c.registry.issueKiosk(c.manager.token, c.branch, c.body());
    await assert.rejects(c.registry.issueKiosk(c.manager.token, c.branch, c.body()), {
      code: 'CONFLICT',
      reason: 'KIOSK_PAIRING_LIMIT',
    });
    assert.equal(
      (await c.cloud.pool.query('SELECT count(*)::int n FROM kiosk_devices')).rows[0].n,
      5,
    );
    // An ID/key never entered is no device of the point once it expires.
    await c.cloud.pool.query(
      `UPDATE kiosk_enrollment_aliases SET created_at=created_at-interval '2 hours',
       expires_at=created_at-interval '1 hour' WHERE login=$1`,
      [first.login],
    );
    const list = await c.registry.read(c.manager.token, c.branch);
    assert.ok(!list.devices.some((d) => d.id === first.device_id));
    assert.equal(list.devices.filter((d) => d.kind === 'kiosk').length, 4);
    // An analyst reads but never issues.
    await grantBackoffice(c.cloud.pool, c.manager.actor_id, c.branch, 'analyst');
    await assert.rejects(c.registry.issueKiosk(c.manager.token, c.branch, c.body()), {
      code: 'FORBIDDEN',
    });
    // The audit row is append-only.
    await assert.rejects(c.cloud.pool.query("UPDATE kiosk_pairing_issues SET reason='changed'"), {
      message: /append-only/,
    });
  }));

test('the grants script gives the API role exactly what issuing needs and takes it back', () =>
  fixture(async (c) => {
    const role = 'kiosk_pairing_' + randomBytes(4).toString('hex');
    const password = randomBytes(12).toString('hex');
    const schema = new URL(c.cloud.config.databaseUrl).searchParams
      .get('options')
      .match(/search_path=(\S+)/)[1];
    const admin = c.cloud.pool;
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    let pool;
    try {
      // Baseline: the shared role reads (and row-locks) the tables, as the commercial and BO
      // profiles do; on kiosk_devices only UPDATE(lock_anchor), as in the enrollment release.
      await admin.query(
        `GRANT USAGE ON SCHEMA "${schema}" TO ${role}; GRANT SELECT, UPDATE ON ALL TABLES IN SCHEMA "${schema}" TO ${role};
         REVOKE UPDATE ON "${schema}".kiosk_devices FROM ${role}; GRANT UPDATE(lock_anchor) ON "${schema}".kiosk_devices TO ${role}`,
      );
      const url = new URL(c.cloud.config.databaseUrl);
      url.username = role;
      url.password = password;
      pool = createPool(url.toString());
      const registry = new DeviceRegistry(pool, true, true, c.options);
      // Without the 079 rights the list says «off» and issuing is refused cleanly.
      await admin.query(`REVOKE SELECT ON "${schema}".kiosk_pairing_issues FROM ${role}`);
      assert.equal((await registry.read(c.manager.token, c.branch)).kiosk_pairing_enabled, false);
      await assert.rejects(registry.issueKiosk(c.manager.token, c.branch, c.body()), {
        reason: 'KIOSK_PAIRING_DISABLED',
      });
      await admin.query(kioskPairingGrants(role, { backoffice: true, pairing: true }, schema));
      assert.equal((await registry.read(c.manager.token, c.branch)).kiosk_pairing_enabled, true);
      const issued = await registry.issueKiosk(c.manager.token, c.branch, c.body());
      assert.match(issued.login, /^ipad-/);
      // Never a rewrite of a device key or its activity.
      await assert.rejects(
        pool.query("UPDATE kiosk_devices SET token_hash=repeat('0',64) WHERE id=$1", [
          issued.device_id,
        ]),
        { code: '42501' },
      );
      await assert.rejects(
        pool.query('UPDATE kiosk_devices SET active=false WHERE id=$1', [issued.device_id]),
        { code: '42501' },
      );
      // Flag off: the reset takes back only what it gave.
      await admin.query(kioskPairingGrants(role, { backoffice: true, pairing: false }, schema));
      assert.equal((await registry.read(c.manager.token, c.branch)).kiosk_pairing_enabled, false);
      await assert.rejects(
        pool.query(
          'INSERT INTO kiosk_devices(id,organization_id,branch_id,token_hash) VALUES($1,$2,$3,$4)',
          [randomUUID(), c.org, c.branch, sha('x')],
        ),
        { code: '42501' },
      );
      assert.equal(
        (await pool.query('SELECT count(*)::int n FROM kiosk_devices')).rows[0].n,
        1,
        'SELECT of the commercial profile stays',
      );
    } finally {
      await pool?.end();
      await admin.query(`REASSIGN OWNED BY ${role} TO CURRENT_USER; DROP OWNED BY ${role}`);
      await admin.query(`DROP ROLE ${role}`);
    }
  }));

test('the grants SQL is exact and refuses unsafe names', () => {
  const sql = kioskPairingGrants('pickchick_app', { backoffice: true, pairing: true });
  assert.match(sql, /to_regclass\('public\.kiosk_pairing_issues'\)/);
  assert.match(
    sql,
    /GRANT INSERT\(id,organization_id,branch_id,token_hash\) ON "public"\."kiosk_devices"/,
  );
  assert.ok(!/UPDATE|DELETE|TRUNCATE/.test(sql));
  assert.ok(
    !/GRANT/.test(kioskPairingGrants('pickchick_app', { backoffice: true, pairing: false })),
  );
  assert.throws(() => kioskPairingGrants('x"; DROP', { backoffice: true, pairing: true }));
  assert.throws(() => kioskPairingGrants('pickchick_app', { backoffice: 'yes', pairing: true }));
});

test('API options: flag, back office, kiosk checkout and the enrollment key are all required', () => {
  const env = {
    BACKOFFICE_KIOSK_PAIRING_ENABLED: 'true',
    KIOSK_CHECKOUT_ENABLED: 'true',
    KIOSK_CHECKOUT_ORGANIZATION_ID: randomUUID(),
    KIOSK_CHECKOUT_BRANCH_ID: randomUUID(),
    KASPI_REMOTE_ACCOUNT_ID: randomUUID(),
    KIOSK_CHECKOUT_FISCAL_POLICY: 'deferred_pilot',
    CUSTOMER_KASPI_OPENING_TIME: '10:00',
    CUSTOMER_KASPI_CLOSING_TIME: '00:00',
    CUSTOMER_KASPI_TIMEZONE: 'Asia/Almaty',
    KIOSK_CHECKOUT_APPROVAL_REFERENCE: 'Synthetic approval',
    KIOSK_CHECKOUT_TAX_CODE: 'VAT0',
    KIOSK_ENROLLMENT_KEY: randomBytes(32).toString('hex'),
  };
  const options = kioskPairingOptions(env, true);
  assert.equal(options?.branchId, env.KIOSK_CHECKOUT_BRANCH_ID);
  assert.equal(options?.organizationId, env.KIOSK_CHECKOUT_ORGANIZATION_ID);
  assert.equal(options?.encryptionKey.length, 32);
  assert.equal(kioskPairingOptions(env, false), null);
  assert.equal(
    kioskPairingOptions({ ...env, BACKOFFICE_KIOSK_PAIRING_ENABLED: 'false' }, true),
    null,
  );
  assert.equal(kioskPairingOptions({ ...env, KIOSK_ENROLLMENT_KEY: undefined }, true), null);
  assert.equal(kioskPairingOptions({ ...env, KIOSK_CHECKOUT_ENABLED: 'false' }, true), null);
  assert.equal(kioskPairingOptions({ ...env, KIOSK_ENROLLMENT_KEY: 'short' }, true), null);
  assert.equal(kioskPairingOptions({ ...env, KIOSK_CHECKOUT_BRANCH_ID: 'x' }, true), null);
  assert.throws(() => kioskPairingOptions({ ...env, BACKOFFICE_KIOSK_PAIRING_ENABLED: '1' }, true));
});

test('HTTP: the back-office proxy passes «kiosk-pairing» and the list never repeats the key', () =>
  fixture(async (c) => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      BACKOFFICE_DEVICE_ACCESS_ENABLED: 'true',
      BACKOFFICE_KIOSK_PAIRING_ENABLED: 'true',
      KIOSK_CHECKOUT_ENABLED: 'true',
      KIOSK_CHECKOUT_ORGANIZATION_ID: c.org,
      KIOSK_CHECKOUT_BRANCH_ID: c.branch,
      KASPI_REMOTE_ACCOUNT_ID: randomUUID(),
      KIOSK_CHECKOUT_FISCAL_POLICY: 'deferred_pilot',
      CUSTOMER_KASPI_OPENING_TIME: '10:00',
      CUSTOMER_KASPI_CLOSING_TIME: '00:00',
      CUSTOMER_KASPI_TIMEZONE: 'Asia/Almaty',
      KIOSK_CHECKOUT_APPROVAL_REFERENCE: 'Synthetic approval',
      KIOSK_CHECKOUT_TAX_CODE: 'VAT0',
      KIOSK_ENROLLMENT_KEY: randomBytes(32).toString('hex'),
    });
    const require = createRequire(new URL('../../services/api/package.json', import.meta.url));
    const { Module } = require('@nestjs/common');
    class TestModule {}
    Module({
      controllers: [DeviceRegistryController],
      providers: [
        {
          provide: RESOURCE,
          useValue: {
            pool: c.cloud.pool,
            config: { ...c.cloud.config, backofficeEnabled: true },
            admission: {
              intercept(_c, next) {
                return next.handle();
              },
            },
          },
        },
      ],
    })(TestModule);
    let app, proxy;
    try {
      app = await createHttpApplication(TestModule);
      await app.listen(0, '127.0.0.1');
      proxy = createBackofficeServer({ apiPort: Number(new URL(await app.getUrl()).port) });
      await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${proxy.address().port}/v1/admin/backoffice/branches/${c.branch}/devices`;
      const request = (path, body) =>
        fetch(base + path, {
          method: body ? 'POST' : 'GET',
          headers: {
            Authorization: 'Bearer ' + c.manager.token,
            'Content-Type': 'application/json',
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      const issued = await request('/kiosk-pairing', c.body());
      assert.equal(issued.status, 201);
      assert.equal(issued.headers.get('cache-control'), 'no-store');
      const answer = await issued.json();
      assert.deepEqual(Object.keys(answer).sort(), [
        'device_id',
        'expires_at',
        'login',
        'password',
      ]);
      const list = await request('');
      const text = await list.text();
      assert.equal(list.status, 200);
      assert.ok(text.includes(answer.login));
      assert.ok(!text.includes(answer.password));
      assert.equal(JSON.parse(text).kiosk_pairing_enabled, true);
      const refused = await request('/kiosk-pairing', { name: 'x' });
      assert.equal(refused.status, 400);
      await refused.body.cancel();
    } finally {
      if (proxy) {
        proxy.closeAllConnections();
        await new Promise((r) => proxy.close(r));
      }
      await app?.close();
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }));
