import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Module } from '@nestjs/common';
import { createPool } from '@pickchick/database';
import { CustomerIdentity, CUSTOMER_IDENTITY } from '@pickchick/customer-identity';
import { createHttpApplication, RESOURCE } from '@pickchick/platform';
import { encrypt } from '../../customer-identity/dist/crypto.js';
import { FarmController } from '../../../services/api/dist/farm-controller.js';
import { FarmPersistence, FARM } from '../dist/index.js';

test('farm HTTP verifies real bearer identity, preserves error codes and disables by default', async () => {
  const url = process.env.FARM_TEST_DATABASE_URL;
  assert.ok(url, 'FARM_TEST_DATABASE_URL required');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname));
  const schema = 'farm_http_' + randomUUID().replaceAll('-', '');
  const admin = createPool(url);
  await admin.query(`CREATE SCHEMA ${schema}`);
  // Pool startup option establishes search_path before leasing, avoiding async connect-hook races.
  const scopedUrl = new URL(url);
  scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
  const pool = createPool(scopedUrl.href);
  let app;
  const previous = process.env.FARM_ENABLED;
  try {
    for (const filename of [
      '007_cloud_customer_identity.sql',
      '037_cloud_farm.sql',
      '038_cloud_farm_field_capacity.sql',
    ])
      await pool.query(
        await readFile(
          new URL('../../../db/cloud/migrations/' + filename, import.meta.url),
          'utf8',
        ),
      );
    const key = randomBytes(32),
      customer = randomUUID(),
      token = randomBytes(32).toString('hex');
    await pool.query(
      'INSERT INTO identity_customers(id,phone_lookup,phone_cipher,profile_cipher,created_at) VALUES($1,$2,$3,$4,clock_timestamp())',
      [
        customer,
        'a'.repeat(64),
        encrypt(key, `phone:${customer}`, '+77010000001'),
        encrypt(key, `profile:${customer}`, { display_name: null, birth_date: null }),
      ],
    );
    await pool.query(
      "INSERT INTO identity_sessions(id,customer_id,device_hash,access_hash,access_expires_at,refresh_hash,created_at,refreshed_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 hour',$5,clock_timestamp(),clock_timestamp())",
      [
        randomUUID(),
        customer,
        'b'.repeat(64),
        createHash('sha256').update(token).digest('hex'),
        'c'.repeat(64),
      ],
    );
    const identity = new CustomerIdentity(
      pool,
      {
        enabled: true,
        consentVersion: 'test',
        termsUrl: 'https://example.test/terms',
        privacyUrl: 'https://example.test/privacy',
        dailySmsBudget: 10,
        lookupKey: key,
        otpKey: key,
        piiKey: key,
        receiptKey: key,
      },
      {
        provider: 'mobizon',
        async sendCode() {
          throw new Error('No deliveries in farm test');
        },
      },
    );
    const farm = new FarmPersistence(pool, true);
    class TestModule {}
    Module({
      controllers: [FarmController],
      providers: [
        { provide: CUSTOMER_IDENTITY, useValue: identity },
        { provide: FARM, useValue: farm },
        {
          provide: RESOURCE,
          useValue: {
            config: { service: 'test' },
            admission: {
              intercept(_ctx, next) {
                return next.handle();
              },
            },
          },
        },
      ],
    })(TestModule);
    app = await createHttpApplication(TestModule);
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    async function request(path = '', body, auth = token, protocol = '2') {
      const response = await fetch(
        origin + '/v1/customer-farm' + path + (protocol ? '?protocol=' + protocol : ''),
        {
          headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json' },
          ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
        },
      );
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return { status: response.status, body: await response.json() };
    }
    delete process.env.FARM_ENABLED;
    assert.deepEqual(await request(), { status: 503, body: { code: 'FARM_UNAVAILABLE' } });
    process.env.FARM_ENABLED = '1';
    assert.equal((await request('', undefined, 'd'.repeat(64))).status, 401);
    for (const protocol of ['', '1', '3']) {
      const legacy = await request('', undefined, token, protocol);
      assert.equal(legacy.status, 503);
      assert.equal(legacy.body.code, 'FARM_UNAVAILABLE');
      assert.equal(legacy.body.minimumProtocol, 2);
      assert.match(legacy.body.message, /Обновите/);
      assert.equal((await pool.query('SELECT count(*)::int n FROM customer_farms')).rows[0].n, 0);
    }
    const initial = await request();
    assert.equal(initial.status, 200);
    assert.equal(initial.body.state.revision, 0);
    const command = {
      commandId: randomUUID(),
      expectedRevision: 0,
      command: { type: 'buyPlot', x: 31, y: 31 },
    };
    assert.equal((await request('/commands', command)).status, 200);
    const saved = (await pool.query('SELECT state FROM customer_farms')).rows[0].state;
    const legacyCommand = await request(
      '/commands',
      { ...command, commandId: randomUUID() },
      token,
      '',
    );
    assert.equal(legacyCommand.body.minimumProtocol, 2);
    assert.deepEqual((await pool.query('SELECT state FROM customer_farms')).rows[0].state, saved);
    const stale = await request('/commands', { ...command, commandId: randomUUID() });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'STALE_STATE');
    assert.equal(stale.body.state.revision, 1);
    assert.equal(
      (await request('/commands', { ...command, command: { type: 'expand' } })).body.code,
      'COMMAND_ID_CONFLICT',
    );
    assert.equal(
      (await request('/commands', { ...command, customerId: randomUUID() })).body.code,
      'INVALID_REQUEST',
    );
    await pool.query(
      "UPDATE identity_sessions SET access_expires_at=clock_timestamp()-interval '1 second'",
    );
    assert.equal((await request()).status, 401);
  } finally {
    if (previous === undefined) delete process.env.FARM_ENABLED;
    else process.env.FARM_ENABLED = previous;
    if (app) await app.close();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
