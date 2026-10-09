import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { fixtureMenu } from '@pickchick/test-fixtures';
import { KioskSessions } from '../dist/kiosk-sessions.js';
import { KioskCheckout } from '../dist/kiosk-checkout.js';
import { CommerceRepository } from '../dist/repository.js';
import { digest } from '../dist/model.js';
import { publishCatalog } from './catalog-fixture.mjs';
import { priceCatalogSnapshot } from '@pickchick/catalog-pricing';
const connection =
  process.env.COMMERCE_TEST_DATABASE_URL ??
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55432/pickchick_cloud';
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection).hostname),
  'Kiosk tests require localhost PostgreSQL',
);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('hex');
const denied = (error) => error.code === 'FORBIDDEN';
async function fixture(run) {
  const schema = 'kiosk_' + randomUUID().replaceAll('-', ''),
    admin = createPool(connection);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(connection);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = createPool(url.toString(), 12);
  try {
    await migrate(
      pool,
      fileURLToPath(new URL('../../../db/cloud/migrations/', import.meta.url)),
      'cloud',
    );
    const org = randomUUID(),
      legal = randomUUID(),
      branch = randomUUID(),
      device = randomUUID(),
      token = secret(),
      key = randomBytes(32);
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Synthetic kiosk')", [org]);
    await pool.query(
      "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES($1,$2,'Synthetic','000000000000')",
      [legal, org],
    );
    await pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,'KIOSK','Synthetic')",
      [branch, org, legal],
    );
    await pool.query(
      'INSERT INTO kiosk_devices(id,organization_id,branch_id,token_hash) VALUES($1,$2,$3,$4)',
      [device, org, branch, hash(token)],
    );
    const sessions = new KioskSessions(pool, { piiKey: key });
    const start = async () => {
      const input = { sessionId: randomUUID(), token: secret() };
      return { ...(await sessions.start(device, token, input)), token: input.token };
    };
    async function order(sessionId, customerId = null) {
      const release = randomUUID(),
        fiscal = randomUUID(),
        payment = randomUUID();
      const menu = { ...fixtureMenu, branch_id: branch, release_id: release };
      await pool.query(
        'INSERT INTO menu_releases(id,branch_id,version,schema_version,payload,checksum,published_at) VALUES($1,$2,$3,1,$4,$5,clock_timestamp())',
        [release, branch, menu.version, menu, digest(menu)],
      );
      for (const [id, kind] of [
        [fiscal, 'fiscal'],
        [payment, 'payment'],
      ])
        await pool.query(
          "INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,kind,provider,external_reference,enabled,legal_entity_id) VALUES($1,$2,$3,$4,'synthetic-test',$6,true,$5)",
          [id, org, branch, kind, legal, id],
        );
      const repo = new CommerceRepository(pool),
        scope = { organizationId: org, branchId: branch, principalId: sessionId, role: 'sales' };
      let priced = {
        releaseId: release,
        customerId,
        channel: 'mobile',
        serviceMode: 'takeaway',
        currency: 'KZT',
        ttlSeconds: 300,
        lines: [
          {
            lineId: randomUUID(),
            productId: 'synthetic-burger',
            title: 'Synthetic',
            quantity: 1,
            unitPriceMinor: '10000',
            discountMinor: '0',
            taxCode: 'TEST',
          },
        ],
      };
      if (
        customerId === null &&
        (await pool.query('SELECT 1 FROM kiosk_sessions WHERE id=$1', [sessionId])).rowCount
      ) {
        const pub = await publishCatalog({ pool, scope });
        const catalogQuote = priceCatalogSnapshot(
          { reference: pub.reference, orderingEnabled: true, payload: pub.payload },
          { organizationId: org, branchId: branch, customerId: null, channel: 'kiosk' },
          {
            catalog_version: 1,
            service_mode: 'takeaway',
            items: [{ sku: 'BURGER', quantity: 1, selections: [] }],
          },
        );
        priced = {
          ...catalogQuote,
          taxBinding: { legalEntityId: legal, approvalReference: 'Synthetic test', version: 1 },
          lines: catalogQuote.lines.map((line) => ({ ...line, taxCode: 'TEST' })),
        };
      }
      const quote = await repo.issueQuote(scope, randomUUID(), priced);
      const created = await repo.createOrder(scope, randomUUID(), {
        quoteId: quote.quoteId,
        fiscalAccountId: fiscal,
      });
      const edge = randomUUID();
      await pool.query(
        "INSERT INTO devices(id,branch_id,organization_id,kind,name,status) VALUES($1,$2,$3,'edge','Synthetic','active')",
        [edge, branch, org],
      );
      await repo.confirmAdmission(
        { organizationId: org, branchId: branch, deviceId: edge },
        {
          eventId: randomUUID(),
          orderId: created.orderId,
          reservationId: randomUUID(),
          quoteDigest: quote.digest,
        },
      );
      return { ...created, payment, scope };
    }
    await run({
      pool,
      sessions,
      org,
      branch,
      device,
      token,
      key,
      start,
      order,
      connection: url.toString(),
      schema,
    });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
test('enrollment validates key and deployment branch without allocating a guest', () =>
  fixture(async (f) => {
    assert.deepEqual(await f.sessions.validateDevice(f.device, f.token), {
      deviceId: f.device,
      organizationId: f.org,
      branchId: f.branch,
    });
    await assert.rejects(f.sessions.validateDevice(f.device, secret()), denied);
    await assert.rejects(f.sessions.validateDevice(randomUUID(), f.token), denied);
    const enrolled = await f.sessions.validateDevice(f.device, f.token);
    const options = {
      organizationId: f.org,
      branchId: f.branch,
      paymentAccountId: randomUUID(),
      fiscalPolicy: 'deferred_pilot',
      approvalReference: 'Synthetic enrollment only',
      taxCode: 'TEST',
      maxOrderMinor: '50000',
      hours: { openingTime: '10:00', closingTime: '00:00', timeZone: 'Asia/Almaty' },
    };
    const checkout = new KioskCheckout(f.pool, options, f.sessions);
    const config = await checkout.config({ ...enrolled, sessionId: f.device });
    assert.equal(config.enabled, false);
    assert.equal(config.branchId, f.branch);
    const other = new KioskCheckout(f.pool, { ...options, branchId: randomUUID() }, f.sessions);
    await assert.rejects(other.config({ ...enrolled, sessionId: f.device }), denied);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM kiosk_sessions')).rows[0].n, 0);
    await f.pool.query('UPDATE kiosk_devices SET active=false WHERE id=$1', [f.device]);
    await assert.rejects(f.sessions.validateDevice(f.device, f.token), denied);
  }));
test('start replay is stable, concurrent idempotent and credentials stay hash-only', () =>
  fixture(async (f) => {
    const input = { sessionId: randomUUID(), token: secret() };
    const [a, b] = await Promise.all([
      f.sessions.start(f.device, f.token, input),
      f.sessions.start(f.device, f.token, input),
    ]);
    assert.deepEqual(a, b);
    assert.deepEqual(await f.sessions.start(f.device, f.token, input), a);
    assert.deepEqual(await f.sessions.authenticate(f.device, f.token, input.token), {
      sessionId: a.sessionId,
      organizationId: f.org,
      branchId: f.branch,
      deviceId: f.device,
    });
    const row = (await f.pool.query('SELECT * FROM kiosk_sessions')).rows[0];
    assert.equal(row.token_hash, hash(input.token));
    assert.ok(!JSON.stringify(row).includes(input.token));
    await assert.rejects(
      f.sessions.start(f.device, f.token, { ...input, token: secret() }),
      denied,
    );
  }));
test('device credentials, revocation and cross-device session isolation', () =>
  fixture(async (f) => {
    const a = await f.start(),
      other = randomUUID(),
      otherToken = secret();
    await f.pool.query(
      'INSERT INTO kiosk_devices(id,organization_id,branch_id,token_hash) VALUES($1,$2,$3,$4)',
      [other, f.org, f.branch, hash(otherToken)],
    );
    await assert.rejects(f.sessions.authenticate(other, otherToken, a.token), denied);
    await assert.rejects(
      f.sessions.start(other, otherToken, { sessionId: a.sessionId, token: a.token }),
      denied,
    );
    await assert.rejects(f.sessions.authenticate(f.device, secret(), a.token), denied);
    await assert.rejects(
      f.sessions.start(f.device, 'bad', { sessionId: randomUUID(), token: secret() }),
      denied,
    );
    await f.pool.query('UPDATE kiosk_devices SET active=false WHERE id=$1', [f.device]);
    await assert.rejects(f.sessions.authenticate(f.device, f.token, a.token), denied);
    await assert.rejects(f.start(), denied);
    await assert.rejects(f.sessions.setPhone(a.sessionId, '+77000000000'), denied);
  }));
test('expired and ended sessions cannot authenticate or be restarted', () =>
  fixture(async (f) => {
    const a = await f.start();
    await f.sessions.end(a.sessionId);
    await f.sessions.end(a.sessionId);
    await assert.rejects(f.sessions.authenticate(f.device, f.token, a.token), denied);
    assert.equal(
      (await f.sessions.authenticate(f.device, f.token, a.token, { allowEnded: true })).sessionId,
      a.sessionId,
    );
    await assert.rejects(
      f.sessions.start(f.device, f.token, { sessionId: a.sessionId, token: a.token }),
      denied,
    );
    const b = await f.start();
    await f.pool.query(
      "UPDATE kiosk_sessions SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",
      [b.sessionId],
    );
    await assert.rejects(f.sessions.authenticate(f.device, f.token, b.token), denied);
    assert.equal(
      (await f.sessions.authenticate(f.device, f.token, b.token, { allowExpired: true })).sessionId,
      b.sessionId,
    );
    await assert.rejects(
      f.sessions.authenticate(f.device, f.token, a.token, { allowExpired: true }),
      denied,
    );
    await assert.rejects(f.sessions.setPhone(b.sessionId, '+77000000000'), denied);
  }));
test('phone is encrypted, immutable and idempotent; unresolved order refuses end', () =>
  fixture(async (f) => {
    const a = await f.start(),
      phone = '+77000000000';
    await f.sessions.setPhone(a.sessionId, phone);
    const before = (await f.pool.query('SELECT * FROM kiosk_sessions WHERE id=$1', [a.sessionId]))
      .rows[0];
    assert.ok(!before.phone_ciphertext.includes(Buffer.from(phone)));
    assert.equal(before.phone_nonce.length, 12);
    assert.equal(before.phone_tag.length, 16);
    await f.sessions.setPhone(a.sessionId, phone);
    assert.deepEqual(
      (await f.pool.query('SELECT * FROM kiosk_sessions WHERE id=$1', [a.sessionId])).rows[0],
      before,
    );
    await assert.rejects(
      f.sessions.setPhone(a.sessionId, '+77000000001'),
      (e) => e.code === 'CONFLICT',
    );
    await assert.rejects(
      f.sessions.setPhone(a.sessionId, '77000000000'),
      (e) => e.code === 'INVALID',
    );
    const order = await f.order(a.sessionId);
    assert.equal(await f.sessions.readOrderPhone(order.orderId), phone);
    await assert.rejects(f.sessions.end(a.sessionId), { code: 'CONFLICT' });
    assert.equal(await f.sessions.readOrderPhone(order.orderId), phone);
    assert.equal(await f.sessions.readOrderPhone(randomUUID()), null);
    await assert.rejects(
      new KioskSessions(f.pool, { piiKey: randomBytes(32) }).readOrderPhone(order.orderId),
      (e) => e.code === 'NOT_READY',
    );
  }));
test('retention purge preserves unresolved bank recovery, removes terminal phone', () =>
  fixture(async (f) => {
    const a = await f.start(),
      phone = '+77000000000';
    await f.sessions.setPhone(a.sessionId, phone);
    const order = await f.order(a.sessionId);
    const attempt = (
      await new CommerceRepository(f.pool).startPaymentAttempt(order.scope, randomUUID(), {
        orderId: order.orderId,
        providerAccountId: order.payment,
      })
    ).attemptId;
    await f.pool.query("UPDATE commerce_payment_attempts SET state='unknown' WHERE id=$1", [
      attempt,
    ]);
    await f.pool.query(
      "UPDATE kiosk_sessions SET phone_expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",
      [a.sessionId],
    );
    await assert.rejects(f.sessions.end(a.sessionId), { code: 'CONFLICT' });
    assert.equal(await f.sessions.purgeExpiredPhones(), 0);
    assert.equal(await f.sessions.readOrderPhone(order.orderId), phone);
    await f.pool.query(
      "INSERT INTO commerce_kaspi_invoices(attempt_id,order_id,account_id,amount_minor,state,reference) VALUES($1,$2,$3,10000,'unknown','SYNTHETIC1')",
      [attempt, order.orderId, order.payment],
    );
    await f.pool.query("UPDATE commerce_payment_attempts SET state='failed' WHERE id=$1", [
      attempt,
    ]);
    assert.equal(await f.sessions.purgeExpiredPhones(), 0);
    assert.equal(await f.sessions.readOrderPhone(order.orderId), phone);
    await f.pool.query("UPDATE commerce_kaspi_invoices SET state='failed' WHERE attempt_id=$1", [
      attempt,
    ]);
    assert.equal(await f.sessions.readOrderPhone(order.orderId), null);
    assert.equal(await f.sessions.purgeExpiredPhones(), 1);
    const row = (await f.pool.query('SELECT * FROM kiosk_sessions WHERE id=$1', [a.sessionId]))
      .rows[0];
    assert.equal(row.phone_ciphertext, null);
    assert.ok(row.phone_expires_at);
    assert.equal(await f.sessions.purgeExpiredPhones(), 0);
  }));
test('device organization cannot diverge from branch ownership', () =>
  fixture(async (f) => {
    const org = randomUUID();
    await f.pool.query("INSERT INTO organizations(id,name) VALUES($1,'Other synthetic')", [org]);
    await assert.rejects(
      f.pool.query(
        'INSERT INTO kiosk_devices(id,organization_id,branch_id,token_hash) VALUES($1,$2,$3,$4)',
        [randomUUID(), org, f.branch, hash(secret())],
      ),
      (e) => e.code === '23514',
    );
    await assert.rejects(
      f.pool.query('UPDATE kiosk_devices SET organization_id=$2 WHERE id=$1', [f.device, org]),
      (e) => e.code === '23514',
    );
    assert.throws(
      () => new KioskSessions(f.pool, { piiKey: Buffer.alloc(31) }),
      (e) => e.code === 'INVALID',
    );
    assert.throws(
      () => new KioskSessions(f.pool, { piiKey: f.key, sessionTtlSeconds: 86400 }),
      (e) => e.code === 'INVALID',
    );
  }));

test('customer order never resolves kiosk phone despite matching principal', () =>
  fixture(async (f) => {
    const a = await f.start();
    await f.sessions.setPhone(a.sessionId, '+77000000000');
    const customer = randomUUID();
    await f.pool.query(
      "INSERT INTO identity_customers(id,phone_lookup,phone_cipher,profile_cipher,created_at) VALUES($1,$2,'synthetic-encrypted','synthetic-profile',clock_timestamp())",
      [customer, hash(secret())],
    );
    const order = await f.order(a.sessionId, customer);
    assert.equal(await f.sessions.readOrderPhone(order.orderId), null);
  }));
test('unrelated order principal cannot recover another guest phone', () =>
  fixture(async (f) => {
    const a = await f.start();
    await f.sessions.setPhone(a.sessionId, '+77000000000');
    const order = await f.order(randomUUID());
    assert.equal(await f.sessions.readOrderPhone(order.orderId), null);
    await assert.rejects(
      f.sessions.start(f.device, f.token, { sessionId: randomUUID(), token: a.token }),
      denied,
    );
  }));

test('strict start input and bounded active sessions preserve idempotent replay', () =>
  fixture(async (f) => {
    for (const bad of [null, {}, { sessionId: randomUUID(), token: secret(), extra: true }])
      await assert.rejects(f.sessions.start(f.device, f.token, bad), (e) => e.code === 'INVALID');
    const sessions = [];
    for (let i = 0; i < 10; i++) sessions.push(await f.start());
    await assert.rejects(f.start(), denied);
    const a = sessions[0];
    assert.equal(
      (await f.sessions.start(f.device, f.token, { sessionId: a.sessionId, token: a.token }))
        .sessionId,
      a.sessionId,
    );
    await f.sessions.end(a.sessionId);
    await f.start();
  }));

test('provision CLI writes exclusive private credentials, emits no secrets, removes failed output', () =>
  fixture(async (f) => {
    const directory = await mkdtemp(join(tmpdir(), 'pickchick-kiosk-'));
    try {
      const output = join(directory, 'device.json'),
        script = fileURLToPath(new URL('../../../scripts/provision-kiosk.mjs', import.meta.url));
      const args = [script, '--organization', f.org, '--branch', f.branch, '--output', output];
      const result = await promisify(execFile)(process.execPath, args, {
        env: { ...process.env, CLOUD_DATABASE_URL: f.connection },
      });
      const credentials = JSON.parse(await readFile(output, 'utf8'));
      assert.equal((await stat(output)).mode & 0o777, 0o600);
      assert.equal(credentials.organizationId, f.org);
      assert.equal(credentials.branchId, f.branch);
      assert.match(credentials.deviceToken, /^[0-9a-f]{64}$/);
      assert.ok(!result.stdout.includes(credentials.deviceToken));
      assert.ok(!result.stderr.includes(credentials.deviceToken));
      assert.equal(
        (
          await f.pool.query('SELECT token_hash FROM kiosk_devices WHERE id=$1', [
            credentials.deviceId,
          ])
        ).rows[0].token_hash,
        hash(credentials.deviceToken),
      );
      await assert.rejects(
        promisify(execFile)(process.execPath, args, {
          env: { ...process.env, CLOUD_DATABASE_URL: f.connection },
        }),
      );
      assert.equal(JSON.parse(await readFile(output, 'utf8')).deviceToken, credentials.deviceToken);
      const failed = join(directory, 'failed.json');
      await assert.rejects(
        promisify(execFile)(
          process.execPath,
          [script, '--organization', f.org, '--branch', randomUUID(), '--output', failed],
          { env: { ...process.env, CLOUD_DATABASE_URL: f.connection } },
        ),
      );
      await assert.rejects(stat(failed), (e) => e.code === 'ENOENT');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }));
test('runtime starts and updates sessions with device lock-anchor column privilege only', () =>
  fixture(async (f) => {
    const role = 'kiosk_runtime_' + randomUUID().replaceAll('-', '');
    await f.pool.query(`CREATE ROLE ${role}`);
    let runtime;
    try {
      await f.pool.query(`GRANT USAGE ON SCHEMA ${f.schema} TO ${role}`);
      await f.pool.query(
        `GRANT SELECT ON commerce_orders,commerce_payment_attempts,commerce_kaspi_invoices,commerce_refunds,commerce_captures,cloud_fulfillment_projection,commerce_kiosk_payment_incidents TO ${role}`,
      );
      await f.pool.query(`GRANT SELECT,UPDATE(lock_anchor) ON kiosk_devices TO ${role}`);
      await f.pool.query(
        `GRANT SELECT,INSERT,UPDATE(ended_at,phone_ciphertext,phone_nonce,phone_tag,phone_expires_at) ON kiosk_sessions TO ${role}`,
      );
      const url = new URL(f.connection);
      url.searchParams.set('options', `-c search_path=${f.schema} -c role=${role}`);
      runtime = createPool(url.toString(), 1);
      const sessions = new KioskSessions(runtime, { piiKey: f.key }),
        input = { sessionId: randomUUID(), token: secret() };
      await sessions.start(f.device, f.token, input);
      await sessions.setPhone(input.sessionId, '+77000000000');
      await sessions.end(input.sessionId);
      await assert.rejects(
        runtime.query('UPDATE kiosk_devices SET active=false WHERE id=$1', [f.device]),
        (e) => e.code === '42501',
      );
    } finally {
      if (runtime) await runtime.end();
      await f.pool.query(`DROP OWNED BY ${role}`);
      await f.pool.query(`DROP ROLE ${role}`);
    }
  }));

test('menu release exact session grants support start replay, authenticate and end without PII or money writes', () =>
  fixture(async (f) => {
    const role = 'kiosk_menu_' + randomUUID().replaceAll('-', '');
    await f.pool.query(`CREATE ROLE ${role} NOLOGIN`);
    let runtime;
    try {
      await f.pool.query(`GRANT USAGE ON SCHEMA ${f.schema} TO ${role}`);
      await f.pool.query(
        `GRANT SELECT ON commerce_orders,commerce_payment_attempts,commerce_kaspi_invoices,commerce_refunds,commerce_captures,cloud_fulfillment_projection,commerce_kiosk_payment_incidents TO ${role}`,
      );
      // The installed enrollment release already permits the device read/lock.
      await f.pool.query(`GRANT SELECT,UPDATE(lock_anchor) ON kiosk_devices TO ${role}`);
      const url = new URL(f.connection);
      url.searchParams.set('options', `-c search_path=${f.schema} -c role=${role}`);
      runtime = createPool(url.toString(), 1);
      const sessions = new KioskSessions(runtime, { piiKey: f.key });
      const input = { sessionId: randomUUID(), token: secret() };
      assert.equal((await sessions.validateDevice(f.device, f.token)).deviceId, f.device);
      await assert.rejects(sessions.start(f.device, f.token, input), (e) => e.code === '42501');
      // Exercise the actual reviewed release delta, so its SQL cannot silently
      // drift from the permissions used by this PostgreSQL regression test.
      const helper = fileURLToPath(
        new URL('../../../infra/staging/release-kiosk-menu.py', import.meta.url),
      );
      const program = `import importlib.util,sys
spec=importlib.util.spec_from_file_location('menu_grants_test',sys.argv[1])
module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
print(module.GRANTS.replace('pickchick_app',sys.argv[2]))`;
      const { stdout } = await promisify(execFile)('python3', ['-c', program, helper, role]);
      await f.pool.query(stdout);
      const started = await sessions.start(f.device, f.token, input);
      assert.deepEqual(await sessions.start(f.device, f.token, input), started);
      assert.deepEqual(await sessions.authenticate(f.device, f.token, input.token), {
        sessionId: input.sessionId,
        organizationId: f.org,
        branchId: f.branch,
        deviceId: f.device,
      });
      for (const statement of [
        'UPDATE kiosk_devices SET active=false',
        "UPDATE kiosk_devices SET token_hash=repeat('0',64)",
        'UPDATE kiosk_sessions SET expires_at=expires_at',
        "UPDATE kiosk_sessions SET token_hash=repeat('0',64)",
        'UPDATE commerce_orders SET total_minor=total_minor',
        'INSERT INTO commerce_payment_attempts DEFAULT VALUES',
        'INSERT INTO commerce_captures DEFAULT VALUES',
      ])
        await assert.rejects(runtime.query(statement), (e) => e.code === '42501');
      await assert.rejects(
        sessions.setPhone(input.sessionId, '+77000000000'),
        (e) => e.code === '42501',
      );
      await sessions.end(input.sessionId);
      await sessions.end(input.sessionId);
      await assert.rejects(sessions.authenticate(f.device, f.token, input.token), denied);
      assert.equal(
        (await sessions.authenticate(f.device, f.token, input.token, { allowEnded: true }))
          .sessionId,
        input.sessionId,
      );
      const row = (
        await f.pool.query('SELECT * FROM kiosk_sessions WHERE id=$1', [input.sessionId])
      ).rows[0];
      assert.ok(row.ended_at);
      assert.equal(row.phone_ciphertext, null);
      assert.equal(
        (await f.pool.query('SELECT count(*)::int n FROM commerce_orders')).rows[0].n,
        0,
      );
      assert.equal(
        (await f.pool.query('SELECT count(*)::int n FROM commerce_payment_attempts')).rows[0].n,
        0,
      );
    } finally {
      if (runtime) await runtime.end();
      await f.pool.query(`DROP OWNED BY ${role}`);
      await f.pool.query(`DROP ROLE ${role}`);
    }
  }));
