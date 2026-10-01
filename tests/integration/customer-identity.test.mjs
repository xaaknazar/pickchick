import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { customerAuthGrants } from '../../infra/staging/customer-auth-grants.mjs';
import { customerCommerceReadiness } from '../../scripts/customer-commerce-readiness.mjs';
import {
  CustomerIdentity,
  CustomerIdentityError,
  CustomerSessionSchema,
  OtpResponseSchema,
} from '../../packages/customer-identity/dist/index.js';
import { withSyncDatabases } from '../helpers/sync.mjs';
const phone = '+77010000001',
  ip = '192.0.2.1',
  version = 'synthetic-legal-v1';
const consent = { terms_version: version, privacy_version: version, marketing_opt_in: false };
const error = (expected) => (value) =>
  value instanceof CustomerIdentityError && value.code === expected;

test('operator readiness reads real identity records without exposing profiles or issuing payments', async () =>
  fixture(async (ctx) => {
    const { session } = await ctx.login();
    const before = ctx.deliveries.length;
    const report = await customerCommerceReadiness(ctx.pool, {});
    assert.equal(report.counts.customers, 1);
    assert.equal(report.counts.sessions, 1);
    assert.equal(report.counts.orders, 0);
    assert.equal(report.counts.invoices, 0);
    assert.equal(report.configurationReady, false);
    assert.ok(report.blockers.includes('pilot_configured'));
    assert.equal(report.realPaymentVerified, false);
    assert.equal(ctx.deliveries.length, before);
    for (const secret of [phone, session.customer.id, session.access_token, session.refresh_token])
      assert.ok(!JSON.stringify(report).includes(secret));
    assert.equal((await ctx.identity.me(session.access_token)).customer.id, session.customer.id);
  }));
const config = (budget) => ({
  enabled: true,
  consentVersion: version,
  termsUrl: 'https://example.test/terms',
  privacyUrl: 'https://example.test/privacy',
  dailySmsBudget: budget,
  lookupKey: randomBytes(32),
  otpKey: randomBytes(32),
  piiKey: randomBytes(32),
  receiptKey: randomBytes(32),
});
async function fixture(run, budget = 100) {
  await withSyncDatabases(async ({ cloud }) => {
    const deliveries = [],
      settings = config(budget);
    let outcome = {
      kind: 'submitted',
      provider: 'mobizon',
      submission: 'accepted',
      messageId: '1',
      campaignId: '1',
    };
    const delivery = {
      provider: 'mobizon',
      async sendCode(input) {
        deliveries.push(input);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    };
    const make = (overrides = {}) =>
        new CustomerIdentity(cloud.pool, { ...settings, ...overrides }, delivery),
      identity = make();
    async function challenge(device = randomUUID(), number = phone) {
      const requested = OtpResponseSchema.parse(
        await identity.requestOtp(
          {
            phone: number,
            delivery_consent: { privacy_version: version, accepted: true },
            device_id: device,
            request_id: randomUUID(),
          },
          ip,
        ),
      );
      const request = {
        challenge_id: requested.challenge_id,
        device_id: device,
        code: deliveries.at(-1).code,
        request_id: randomUUID(),
        consents: consent,
      };
      return { requested, request, device };
    }
    async function login(device = randomUUID(), number = phone) {
      const sent = await challenge(device, number);
      return {
        ...sent,
        session: CustomerSessionSchema.parse(await identity.verifyOtp(sent.request)),
      };
    }
    async function ageRequests() {
      await cloud.pool.query(
        "UPDATE identity_otp_challenges SET created_at=created_at-interval '61 seconds'",
      );
    }
    await run({
      pool: cloud.pool,
      cloud,
      settings,
      delivery,
      identity,
      make,
      deliveries,
      challenge,
      login,
      ageRequests,
      setOutcome: (value) => {
        outcome = value;
      },
    });
  });
}

test('deployed identity grants permit the complete session lifecycle and revoke all access when disabled', async () =>
  fixture(async (ctx) => {
    const role = 'identity_runtime_' + randomUUID().replaceAll('-', '');
    await ctx.cloud.admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    let runtime;
    try {
      await ctx.pool.query(`GRANT USAGE ON SCHEMA ${ctx.cloud.schema} TO ${role}`);
      await ctx.pool.query(customerAuthGrants(role, true));
      const url = new URL(ctx.cloud.config.databaseUrl);
      url.searchParams.set('options', `-c search_path=${ctx.cloud.schema} -c role=${role}`);
      runtime = createPool(url.toString(), 2);
      const identity = new CustomerIdentity(runtime, ctx.settings, ctx.delivery);
      const device = randomUUID();
      const requested = await identity.requestOtp(
        {
          phone,
          delivery_consent: { privacy_version: version, accepted: true },
          device_id: device,
          request_id: randomUUID(),
        },
        ip,
      );
      const verified = await identity.verifyOtp({
        challenge_id: requested.challenge_id,
        code: ctx.deliveries[0].code,
        device_id: device,
        request_id: randomUUID(),
        consents: consent,
      });
      const rotated = await identity.refresh({
        refresh_token: verified.refresh_token,
        device_id: device,
        request_id: randomUUID(),
      });
      await identity.patchMe(rotated.access_token, {
        nickname: 'Проверка роли',
        birth_date: '2000-02-29',
      });
      assert.equal((await identity.me(rotated.access_token)).customer.nickname, 'Проверка роли');
      await assert.rejects(
        runtime.query('DELETE FROM identity_customers'),
        (e) => e.code === '42501',
      );
      await assert.rejects(
        runtime.query('UPDATE identity_consents SET version=version'),
        (e) => e.code === '42501',
      );
      await assert.rejects(
        runtime.query('CREATE TABLE forbidden(id integer)'),
        (e) => e.code === '42501',
      );
      await identity.deleteMe(rotated.access_token);
      await identity.cleanup();
      await ctx.pool.query(customerAuthGrants(role, false));
      await assert.rejects(
        runtime.query('SELECT * FROM identity_sessions'),
        (e) => e.code === '42501',
      );
    } finally {
      if (runtime) await runtime.end();
      await ctx.pool.query(`DROP OWNED BY ${role}`);
      await ctx.cloud.admin.query(`DROP ROLE ${role}`);
    }
  }));

test('mobile session client survives committed verify and rotation response loss through real HTTP and PostgreSQL', async () =>
  fixture(async (ctx) => {
    const { createRequire } = await import('node:module');
    const require = createRequire(new URL('../../services/api/package.json', import.meta.url));
    const { Module } = require('@nestjs/common');
    const { createHttpApplication, RESOURCE } = await import('@pickchick/platform');
    const { CustomerAuthController } =
      await import('../../services/api/dist/customer-auth-controller.js');
    const { CUSTOMER_IDENTITY } = await import('@pickchick/customer-identity');
    const { CustomerSessionCore } = await import('../../apps/mobile/src/customer-session.ts');
    const { createCustomerRequest } = await import('../../apps/mobile/src/customer-http.ts');
    class ClientTestModule {}
    Module({
      controllers: [CustomerAuthController],
      providers: [
        { provide: CUSTOMER_IDENTITY, useValue: ctx.identity },
        {
          provide: RESOURCE,
          useValue: {
            config: {},
            admission: {
              intercept(_c, next) {
                return next.handle();
              },
            },
          },
        },
      ],
    })(ClientTestModule);
    const app = await createHttpApplication(ClientTestModule);
    try {
      await app.listen(0, '127.0.0.1');
      const origin = await app.getUrl();
      let raw = null;
      let lose = '/v1/auth/otp/verify';
      const transportCalls = [];
      const io = {
        read: async () => raw,
        write: async (value) => {
          raw = value;
        },
        now: Date.now,
        randomId: randomUUID,
        request: createCustomerRequest('https://isolated.example.test', async (input, options) => {
          const path = new URL(input).pathname;
          transportCalls.push({ path, body: options.body });
          const response = await fetch(origin + path, options);
          assert.match(response.headers.get('cache-control'), /no-store/);
          if (lose === path) {
            lose = null;
            await response.arrayBuffer();
            throw new Error('fixture lost committed reply');
          }
          return response;
        }),
      };
      let client = new CustomerSessionCore(io);
      await client.restore();
      await client.requestCode(phone, 'sms', version);
      const otp = ctx.deliveries[0].code;
      await assert.rejects(client.verifyCode(otp, version));
      assert.equal(client.customer, null);
      client = new CustomerSessionCore(io);
      await client.restore();
      await client.sync();
      const intentBeforeTypo = JSON.parse(raw).verify_intent;
      await assert.rejects(
        client.verifyCode(otp === '000000' ? '000001' : '000000', null),
        (e) => e.code === 'CONFLICT',
      );
      assert.deepEqual(JSON.parse(raw).verify_intent, intentBeforeTypo);
      await client.verifyCode(otp, null);
      const id = client.customer.id;
      await client.saveProfile({
        nickname: 'Проверка клиента',
        birthDate: '2000-02-29',
        gender: 'male',
      });
      const saved = JSON.parse(raw);
      saved.tokens.access_expires_at = new Date(Date.now() - 1000).toISOString();
      raw = JSON.stringify(saved);
      await ctx.pool.query(
        "UPDATE identity_sessions SET access_expires_at=clock_timestamp()-interval '1 second'",
      );
      client = new CustomerSessionCore(io);
      await client.restore();
      lose = '/v1/auth/refresh';
      await assert.rejects(client.accessToken());
      const key = JSON.parse(raw).refresh_request_id;
      client = new CustomerSessionCore(io);
      await client.restore();
      const tokens = await Promise.all(Array.from({ length: 30 }, () => client.accessToken()));
      assert.equal(new Set(tokens).size, 1);
      const refreshes = transportCalls.filter((c) => c.path === '/v1/auth/refresh');
      assert.equal(refreshes.length, 2);
      assert.equal(refreshes[0].body, refreshes[1].body);
      assert.equal(JSON.parse(refreshes[1].body).request_id, key);
      await client.sync();
      assert.equal(client.customer.id, id);
      assert.equal(client.customer.birth_date, '2000-02-29');
      assert.equal(ctx.deliveries.length, 1);
      assert.equal(
        (await ctx.pool.query('SELECT count(*) FROM identity_customers')).rows[0].count,
        '1',
      );
      assert.equal(
        (await ctx.pool.query('SELECT count(*) FROM identity_sessions WHERE revoked_at IS NULL'))
          .rows[0].count,
        '1',
      );
      await client.signOut();
      assert.equal(client.customer, null);
      assert.equal(JSON.parse(raw).tokens, null);
    } finally {
      await app.close();
    }
  }));
test('migration is reentrant through ledger and identity credentials are separate from TEST schema', async () =>
  fixture(async (ctx) => {
    assert.deepEqual(
      await migrate(
        ctx.pool,
        fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url)),
        'cloud',
      ),
      [],
    );
    const { session } = await ctx.login();
    assert.equal((await ctx.pool.query('SELECT count(*) FROM test_actors')).rows[0].count, '0');
    const tables = [
      'identity_customers',
      'identity_sessions',
      'identity_otp_challenges',
      'identity_consents',
    ];
    const raw = (
      await Promise.all(tables.map((t) => ctx.pool.query(`SELECT to_jsonb(t) AS row FROM ${t} t`)))
    ).map((r) => r.rows);
    const serialized = JSON.stringify(raw);
    for (const secret of [phone, session.access_token, session.refresh_token])
      assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes(JSON.stringify(ctx.deliveries[0].code)), false);
    assert.equal(raw[3].length, 3);
  }));
test('concurrent requests reserve once before delivery; restart preserves cooldown and budget', async () =>
  fixture(async (ctx) => {
    const device = randomUUID();
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        ctx.identity.requestOtp(
          {
            phone,
            delivery_consent: { privacy_version: version, accepted: true },
            device_id: device,
            request_id: randomUUID(),
          },
          ip,
        ),
      ),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(
      results.filter((r) => r.status === 'rejected').every((r) => error('RATE_LIMITED')(r.reason)),
    );
    assert.equal(ctx.deliveries.length, 1);
    await assert.rejects(
      ctx.make().requestOtp(
        {
          phone: '8 (701) 000-00-01',
          delivery_consent: { privacy_version: version, accepted: true },
          device_id: randomUUID(),
          request_id: randomUUID(),
        },
        ip,
      ),
      error('RATE_LIMITED'),
    );
    assert.equal(
      (await ctx.pool.query('SELECT reservations FROM identity_sms_daily_budget')).rows[0]
        .reservations,
      1,
    );
  }));
test('daily global budget fails closed under distinct concurrent phones/devices without additional submissions', async () =>
  fixture(async (ctx) => {
    const results = await Promise.allSettled(
      Array.from({ length: 9 }, (_, n) =>
        ctx.identity.requestOtp(
          {
            phone: '+770100000' + String(n + 11),
            delivery_consent: { privacy_version: version, accepted: true },
            device_id: randomUUID(),
            request_id: randomUUID(),
          },
          ip,
        ),
      ),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
    assert.equal(ctx.deliveries.length, 3);
    assert.equal(
      (await ctx.pool.query('SELECT reservations FROM identity_sms_daily_budget')).rows[0]
        .reservations,
      3,
    );
  }, 3));
test('unknown and thrown transport responses have one submission, no blind retry; rejection spends reservation', async () =>
  fixture(async (ctx) => {
    ctx.setOutcome(new Error('unsafe provider text must never surface'));
    const sent = await ctx.challenge();
    assert.equal(sent.requested.delivery_status, 'unknown');
    assert.equal(ctx.deliveries.length, 1);
    assert.equal((await ctx.make().verifyOtp(sent.request)).customer.phone, phone);
    await ctx.ageRequests();
    ctx.setOutcome({ kind: 'rejected', reason: 'provider_rejected', providerCode: 9 });
    await assert.rejects(
      ctx.identity.requestOtp(
        {
          phone,
          delivery_consent: { privacy_version: version, accepted: true },
          device_id: randomUUID(),
          request_id: randomUUID(),
        },
        ip,
      ),
      error('SERVICE_UNAVAILABLE'),
    );
    assert.equal(ctx.deliveries.length, 2);
    const rejected = (
      await ctx.pool.query("SELECT * FROM identity_otp_challenges WHERE state='rejected'")
    ).rows[0];
    assert.equal(rejected.code_hash, null);
    assert.equal(rejected.phone_cipher, null);
    assert.equal(
      (await ctx.pool.query('SELECT reservations FROM identity_sms_daily_budget')).rows[0]
        .reservations,
      2,
    );
  }));
test('five incorrect OTP attempts commit across concurrency and restart, locking out even the correct code', async () =>
  fixture(async (ctx) => {
    const { request } = await ctx.challenge();
    const wrong = request.code === '000000' ? '000001' : '000000';
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () => ctx.make().verifyOtp({ ...request, code: wrong })),
    );
    assert.ok(outcomes.every((r) => r.status === 'rejected' && error('UNAUTHORIZED')(r.reason)));
    assert.equal(
      (await ctx.pool.query('SELECT attempts FROM identity_otp_challenges')).rows[0].attempts,
      5,
    );
    await assert.rejects(ctx.identity.verifyOtp(request), error('UNAUTHORIZED'));
    assert.equal(
      (await ctx.pool.query('SELECT count(*) FROM identity_customers')).rows[0].count,
      '0',
    );
  }));
test('expired and superseded challenges never become verified; a resend invalidates the prior valid code', async () =>
  fixture(async (ctx) => {
    const first = await ctx.challenge();
    await ctx.pool.query(
      "UPDATE identity_otp_challenges SET created_at=created_at-interval '4 minutes',expires_at=expires_at-interval '4 minutes'",
    );
    await assert.rejects(ctx.identity.verifyOtp(first.request), error('UNAUTHORIZED'));
    const second = await ctx.challenge(first.device);
    await ctx.ageRequests();
    const third = await ctx.challenge(first.device);
    await assert.rejects(ctx.identity.verifyOtp(second.request), error('UNAUTHORIZED'));
    assert.equal((await ctx.identity.verifyOtp(third.request)).customer.phone, phone);
  }));
test('explicit matching consent and device binding are mandatory before consuming an OTP', async () =>
  fixture(async (ctx) => {
    const { request } = await ctx.challenge();
    await assert.rejects(
      ctx.identity.verifyOtp({
        ...request,
        consents: { ...consent, privacy_version: 'unapproved' },
      }),
      error('INVALID_REQUEST'),
    );
    await assert.rejects(
      ctx.identity.verifyOtp({ ...request, device_id: randomUUID(), request_id: randomUUID() }),
      error('UNAUTHORIZED'),
    );
    assert.equal(
      (await ctx.pool.query('SELECT attempts FROM identity_otp_challenges')).rows[0].attempts,
      0,
    );
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ctx.make().verifyOtp(request)),
    );
    assert.ok(results.every((r) => JSON.stringify(r) === JSON.stringify(results[0])));
    for (const table of ['identity_customers', 'identity_sessions'])
      assert.equal((await ctx.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count, '1');
    assert.equal(
      (await ctx.pool.query('SELECT count(*) FROM identity_consents')).rows[0].count,
      '3',
    );
    await assert.rejects(
      ctx.identity.verifyOtp({ ...request, request_id: randomUUID() }),
      error('CONFLICT'),
    );
  }));
test('lost verify response recovers exact tokens after restart, but never after session rotation or receipt expiry', async () =>
  fixture(async (ctx) => {
    const { request, session, device } = await ctx.login();
    await ctx.pool.query(
      "UPDATE identity_otp_challenges SET expires_at=created_at+interval '1 second',created_at=created_at-interval '2 hours'",
    );
    assert.deepEqual(await ctx.make().verifyOtp(request), session);
    await ctx.identity.refresh({
      refresh_token: session.refresh_token,
      device_id: device,
      request_id: randomUUID(),
    });
    await assert.rejects(ctx.make().verifyOtp(request), error('CONFLICT'));
    await ctx.ageRequests();
    const again = await ctx.login(randomUUID());
    await ctx.pool.query(
      "UPDATE identity_otp_challenges SET receipt_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [again.request.challenge_id],
    );
    await assert.rejects(ctx.make().verifyOtp(again.request), error('CONFLICT'));
  }));
test('concurrent refresh rotates once; lost response is recoverable after long offline only with exact request/device', async () =>
  fixture(async (ctx) => {
    const { session, device } = await ctx.login();
    const request = {
      refresh_token: session.refresh_token,
      device_id: device,
      request_id: randomUUID(),
    };
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => ctx.make().refresh(request)),
    );
    assert.ok(outcomes.every((r) => JSON.stringify(r) === JSON.stringify(outcomes[0])));
    const next = outcomes[0];
    assert.equal(
      (await ctx.pool.query('SELECT generation FROM identity_sessions')).rows[0].generation,
      '1',
    );
    await assert.rejects(
      ctx.identity.refresh({ ...request, request_id: randomUUID() }),
      error('CONFLICT'),
    );
    await assert.rejects(
      ctx.identity.refresh({ ...request, device_id: randomUUID(), request_id: randomUUID() }),
      error('UNAUTHORIZED'),
    );
    await ctx.pool.query(
      "UPDATE identity_sessions SET access_expires_at=clock_timestamp()-interval '400 days',created_at=created_at-interval '401 days',refreshed_at=refreshed_at-interval '400 days'",
    );
    await ctx.pool.query(
      "UPDATE identity_refresh_receipts SET created_at=created_at-interval '400 days'",
    );
    await ctx.make().cleanup();
    assert.deepEqual(await ctx.make().refresh(request), next);
    const newest = await ctx
      .make()
      .refresh({ refresh_token: next.refresh_token, device_id: device, request_id: randomUUID() });
    assert.equal(newest.customer.id, session.customer.id);
    assert.equal(ctx.deliveries.length, 1);
    await assert.rejects(ctx.identity.refresh(request), error('UNAUTHORIZED'));
    assert.equal(
      (await ctx.pool.query('SELECT count(*) FROM identity_refresh_receipts')).rows[0].count,
      '1',
    );
    assert.equal((await ctx.identity.me(newest.access_token)).customer.id, session.customer.id);
  }));
test('parallel distinct refresh request IDs cannot revoke the winning legitimate device', async () =>
  fixture(async (ctx) => {
    const { session, device } = await ctx.login();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        ctx.make().refresh({
          refresh_token: session.refresh_token,
          device_id: device,
          request_id: randomUUID(),
        }),
      ),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(
      results.filter((r) => r.status === 'rejected').every((r) => error('CONFLICT')(r.reason)),
    );
    const winner = results.find((r) => r.status === 'fulfilled').value;
    assert.equal((await ctx.identity.me(winner.access_token)).customer.id, session.customer.id);
    assert.equal(
      (await ctx.pool.query('SELECT revoked_at FROM identity_sessions')).rows[0].revoked_at,
      null,
    );
  }));
test('one phone maps to one customer across devices, while same-device reauthentication replaces only that session', async () =>
  fixture(async (ctx) => {
    const first = await ctx.login();
    const profile = { nickname: 'Synthetic profile', birth_date: '2000-02-29', gender: 'female' };
    await ctx.identity.patchMe(first.session.access_token, profile);
    await ctx.ageRequests();
    const second = await ctx.login();
    assert.equal(second.session.customer.id, first.session.customer.id);
    for (const [key, value] of Object.entries(profile))
      assert.equal(second.session.customer[key], value);
    await ctx.ageRequests();
    const replacement = await ctx.login(first.device);
    await assert.rejects(ctx.identity.me(first.session.access_token), error('UNAUTHORIZED'));
    assert.equal(
      (await ctx.identity.me(second.session.access_token)).customer.id,
      replacement.session.customer.id,
    );
    assert.equal(
      (await ctx.pool.query('SELECT count(*) FROM identity_customers')).rows[0].count,
      '1',
    );
  }));
test('profile updates validate calendar, preserve parallel fields and roll back completely on a storage failure', async () =>
  fixture(async (ctx) => {
    const { session } = await ctx.login();
    await Promise.all([
      ctx.identity.patchMe(session.access_token, { nickname: '  Two fields  ' }),
      ctx.identity.patchMe(session.access_token, { birth_date: '2000-02-29', gender: 'male' }),
    ]);
    const before = (await ctx.identity.me(session.access_token)).customer;
    assert.equal(before.nickname, 'Two fields');
    assert.equal(before.birth_date, '2000-02-29');
    for (const invalid of [
      { birth_date: '1900-02-29' },
      { birth_date: '2099-01-01' },
      { nickname: 'x'.repeat(33) },
      { phone: '+77010000002' },
    ])
      await assert.rejects(
        ctx.identity.patchMe(session.access_token, invalid),
        error('INVALID_REQUEST'),
      );
    await ctx.pool.query(
      "CREATE FUNCTION fail_consent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic storage failure'; END $$",
    );
    await ctx.pool.query(
      'CREATE TRIGGER fail_consent BEFORE INSERT ON identity_consents FOR EACH ROW EXECUTE FUNCTION fail_consent()',
    );
    await assert.rejects(
      ctx.identity.patchMe(session.access_token, {
        nickname: 'Must rollback',
        marketing_opt_in: true,
      }),
    );
    assert.deepEqual((await ctx.identity.me(session.access_token)).customer, before);
    await ctx.pool.query('DROP TRIGGER fail_consent ON identity_consents');
    const cleared = (
      await ctx.identity.patchMe(session.access_token, {
        nickname: '',
        birth_date: null,
        gender: 'male',
      })
    ).customer;
    assert.equal(cleared.nickname, '');
    assert.equal(cleared.birth_date, null);
    assert.equal(cleared.gender, 'male');
    const raw = JSON.stringify((await ctx.pool.query('SELECT * FROM identity_customers')).rows);
    assert.equal(raw.includes('2000-02-29'), false);
  }));
test('logout and deletion revoke refresh recovery and all customer devices; deletion scrubs identifying profile payloads', async () =>
  fixture(async (ctx) => {
    const first = await ctx.login();
    await ctx.ageRequests();
    const second = await ctx.login();
    const rotate = {
      refresh_token: first.session.refresh_token,
      device_id: first.device,
      request_id: randomUUID(),
    };
    const current = await ctx.identity.refresh(rotate);
    await ctx.identity.logout(current.access_token);
    await assert.rejects(ctx.identity.refresh(rotate), error('UNAUTHORIZED'));
    await assert.rejects(ctx.identity.me(current.access_token), error('UNAUTHORIZED'));
    await ctx.identity.patchMe(second.session.access_token, {
      nickname: 'Erase me',
      birth_date: '2001-01-01',
    });
    await ctx.identity.deleteMe(second.session.access_token);
    await assert.rejects(
      ctx.identity.refresh({
        refresh_token: second.session.refresh_token,
        device_id: second.device,
        request_id: randomUUID(),
      }),
      error('UNAUTHORIZED'),
    );
    await assert.rejects(ctx.identity.me(second.session.access_token), error('UNAUTHORIZED'));
    const row = (await ctx.pool.query('SELECT * FROM identity_customers')).rows[0];
    for (const key of ['phone_lookup', 'phone_cipher', 'profile_cipher', 'profile_completed_at'])
      assert.equal(row[key], null);
    assert.ok(row.deleted_at);
    assert.equal(
      (await ctx.pool.query('SELECT count(*) FROM identity_refresh_receipts')).rows[0].count,
      '0',
    );
    assert.equal(
      (await ctx.pool.query('SELECT count(*) FROM identity_consents')).rows[0].count,
      '0',
    );
    assert.equal(
      (await ctx.pool.query('SELECT count(*) FROM identity_deletions')).rows[0].count,
      '1',
    );
    assert.ok(
      (await ctx.pool.query('SELECT * FROM identity_otp_challenges')).rows.every(
        (r) => r.phone_cipher === null && r.code_hash === null && r.response_cipher === null,
      ),
    );
    await ctx.ageRequests();
    const rejoined = await ctx.login();
    assert.notEqual(rejoined.session.customer.id, first.session.customer.id);
    assert.equal(rejoined.session.customer.nickname, '');
  }));

test('lost request response replays the same challenge without spending budget or sending another SMS', async () =>
  fixture(async (ctx) => {
    const input = {
      phone,
      delivery_consent: { privacy_version: version, accepted: true },
      device_id: randomUUID(),
      request_id: randomUUID(),
    };
    const first = await ctx.identity.requestOtp(input, ip);
    assert.deepEqual(
      await ctx.make().requestOtp({ ...input, phone: '8 (701) 000-00-01' }, ip),
      first,
    );
    await assert.rejects(
      ctx.identity.requestOtp({ ...input, phone: '+77010000002' }, ip),
      error('CONFLICT'),
    );
    await assert.rejects(
      ctx.identity.requestOtp({ ...input, device_id: randomUUID() }, ip),
      error('CONFLICT'),
    );
    assert.equal(ctx.deliveries.length, 1);
    assert.equal(
      (await ctx.pool.query('SELECT reservations FROM identity_sms_daily_budget')).rows[0]
        .reservations,
      1,
    );
  }));
test('request replay while provider is still pending returns unknown without a second dispatch', async () =>
  fixture(async (ctx) => {
    let sent, finish;
    const started = new Promise((resolve) => {
      sent = resolve;
    });
    const complete = new Promise((resolve) => {
      finish = resolve;
    });
    let submissions = 0;
    const settings = config(100),
      input = {
        phone,
        delivery_consent: { privacy_version: version, accepted: true },
        device_id: randomUUID(),
        request_id: randomUUID(),
      };
    const identity = new CustomerIdentity(ctx.pool, settings, {
      provider: 'mobizon',
      async sendCode() {
        submissions++;
        sent();
        await complete;
        return { kind: 'unknown', reason: 'timeout' };
      },
    });
    const first = identity.requestOtp(input, ip);
    await started;
    const replay = await identity.requestOtp(input, ip);
    assert.equal(replay.delivery_status, 'unknown');
    assert.equal(submissions, 1);
    finish();
    assert.deepEqual(await first, replay);
  }));

test('cleanup purges private OTP payload and keeps a PII-free tombstone preventing an old key from sending again', async () =>
  fixture(async (ctx) => {
    const input = {
      phone,
      delivery_consent: { privacy_version: version, accepted: true },
      device_id: randomUUID(),
      request_id: randomUUID(),
    };
    await ctx.identity.requestOtp(input, ip);
    await ctx.pool.query(
      "UPDATE identity_otp_challenges SET created_at=created_at-interval '25 hours',expires_at=expires_at-interval '25 hours'",
    );
    await ctx.identity.cleanup();
    assert.equal(
      (await ctx.pool.query('SELECT count(*) FROM identity_otp_challenges')).rows[0].count,
      '0',
    );
    const tomb = (await ctx.pool.query('SELECT * FROM identity_otp_request_tombstones')).rows[0];
    assert.deepEqual(Object.keys(tomb).sort(), ['purged_at', 'request_id']);
    await assert.rejects(ctx.make().requestOtp(input, ip), error('CONFLICT'));
    assert.equal(ctx.deliveries.length, 1);
  }));
test('protective revocation invalidates current access and the only refresh recovery receipt without affecting another device', async () =>
  fixture(async (ctx) => {
    const first = await ctx.login();
    await ctx.ageRequests();
    const other = await ctx.login();
    const input = {
      refresh_token: first.session.refresh_token,
      device_id: first.device,
      request_id: randomUUID(),
    };
    const current = await ctx.identity.refresh(input);
    await ctx.make().revokeSession(first.session.session_id);
    await assert.rejects(ctx.identity.me(current.access_token), error('UNAUTHORIZED'));
    await assert.rejects(ctx.identity.refresh(input), error('UNAUTHORIZED'));
    assert.equal(
      (await ctx.identity.me(other.session.access_token)).customer.id,
      first.session.customer.id,
    );
  }));

test('phone, device and shared-IP rolling limits survive new request IDs without consuming another SMS', async () =>
  fixture(async (ctx) => {
    for (let n = 0; n < 5; n++) {
      await ctx.identity.requestOtp(
        {
          phone,
          delivery_consent: { privacy_version: version, accepted: true },
          device_id: randomUUID(),
          request_id: randomUUID(),
        },
        ip,
      );
      await ctx.ageRequests();
    }
    await assert.rejects(
      ctx.make().requestOtp(
        {
          phone,
          delivery_consent: { privacy_version: version, accepted: true },
          device_id: randomUUID(),
          request_id: randomUUID(),
        },
        ip,
      ),
      error('RATE_LIMITED'),
    );
    assert.equal(ctx.deliveries.length, 5);
    const device = randomUUID();
    for (let n = 10; n < 20; n++) {
      await ctx.identity.requestOtp(
        {
          phone: '+7701' + String(n).padStart(7, '0'),
          delivery_consent: { privacy_version: version, accepted: true },
          device_id: device,
          request_id: randomUUID(),
        },
        ip,
      );
      await ctx.ageRequests();
    }
    await assert.rejects(
      ctx.make().requestOtp(
        {
          phone: '+77010000021',
          delivery_consent: { privacy_version: version, accepted: true },
          device_id: device,
          request_id: randomUUID(),
        },
        ip,
      ),
      error('RATE_LIMITED'),
    );
    for (let n = 30; n < 45; n++)
      await ctx.identity.requestOtp(
        {
          phone: '+7701' + String(n).padStart(7, '0'),
          delivery_consent: { privacy_version: version, accepted: true },
          device_id: randomUUID(),
          request_id: randomUUID(),
        },
        ip,
      );
    await assert.rejects(
      ctx.make().requestOtp(
        {
          phone: '+77010000046',
          delivery_consent: { privacy_version: version, accepted: true },
          device_id: randomUUID(),
          request_id: randomUUID(),
        },
        ip,
      ),
      error('RATE_LIMITED'),
    );
    assert.equal(ctx.deliveries.length, 30);
  }));

test('HTTP controller exposes strict responses and sanitized errors with no-store; forged forwarding headers do not choose client IP', async () =>
  fixture(async (ctx) => {
    const { createRequire } = await import('node:module');
    const require = createRequire(new URL('../../services/api/package.json', import.meta.url));
    const { Module } = require('@nestjs/common');
    const { createHttpApplication, RESOURCE } = await import('@pickchick/platform');
    const { CustomerAuthController } =
      await import('../../services/api/dist/customer-auth-controller.js');
    const { CUSTOMER_IDENTITY } = await import('../../packages/customer-identity/dist/index.js');
    const addresses = [];
    const original = ctx.identity.requestOtp.bind(ctx.identity);
    ctx.identity.requestOtp = (input, clientIp) => {
      addresses.push(clientIp);
      return original(input, clientIp);
    };
    class AuthTestModule {}
    Module({
      controllers: [CustomerAuthController],
      providers: [
        { provide: CUSTOMER_IDENTITY, useValue: ctx.identity },
        {
          provide: RESOURCE,
          useValue: {
            config: {},
            admission: {
              intercept(_context, next) {
                return next.handle();
              },
            },
          },
        },
      ],
    })(AuthTestModule);
    const app = await createHttpApplication(AuthTestModule);
    try {
      await app.listen(0, '127.0.0.1');
      const url = await app.getUrl();
      const request = async (path, body, token) => {
        const response = await fetch(url + path, {
          method: body ? 'POST' : 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': '203.0.113.9',
            ...(token ? { Authorization: 'Bearer ' + token } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        assert.match(response.headers.get('cache-control'), /no-store/);
        return { status: response.status, body: await response.json() };
      };
      const configuration = await request('/v1/auth/config');
      assert.equal(configuration.body.enabled, true);
      assert.equal(configuration.body.terms_url, 'https://example.test/terms');
      const device = randomUUID();
      const challenge = await request('/v1/auth/otp/request', {
        phone,
        delivery_consent: { privacy_version: version, accepted: true },
        device_id: device,
        request_id: randomUUID(),
      });
      assert.equal(challenge.status, 202);
      OtpResponseSchema.parse(challenge.body);
      assert.ok(['127.0.0.1', '::ffff:127.0.0.1'].includes(addresses[0]));
      const verified = await request('/v1/auth/otp/verify', {
        challenge_id: challenge.body.challenge_id,
        code: ctx.deliveries[0].code,
        device_id: device,
        request_id: randomUUID(),
        consents: consent,
      });
      assert.equal(verified.status, 200);
      CustomerSessionSchema.parse(verified.body);
      const invalid = await request('/v1/customers/me', undefined, 'a'.repeat(64));
      assert.equal(invalid.status, 401);
      assert.equal(invalid.body.code, 'UNAUTHORIZED');
      assert.equal(JSON.stringify(invalid).includes(phone), false);
    } finally {
      await app.close();
    }
  }));

test('administrative cleanup and revocation stay available while public auth is disabled', async () =>
  fixture(async (ctx) => {
    const { session, device } = await ctx.login();
    const disabled = new CustomerIdentity(
      ctx.pool,
      { enabled: false },
      {
        provider: 'disabled',
        async sendCode() {
          throw Error('must not send');
        },
      },
    );
    await disabled.revokeSession(session.session_id);
    await disabled.cleanup();
    await assert.rejects(
      ctx.identity.refresh({
        refresh_token: session.refresh_token,
        device_id: device,
        request_id: randomUUID(),
      }),
      error('UNAUTHORIZED'),
    );
  }));
test('tampered encrypted recovery receipt fails safely without rotating or revoking the active successor', async () =>
  fixture(async (ctx) => {
    const { session, device } = await ctx.login();
    const request = {
      refresh_token: session.refresh_token,
      device_id: device,
      request_id: randomUUID(),
    };
    const successor = await ctx.identity.refresh(request);
    await ctx.pool.query(
      "UPDATE identity_refresh_receipts SET response_cipher='invalid.cipher.text'",
    );
    await assert.rejects(ctx.make().refresh(request), error('SERVICE_UNAVAILABLE'));
    assert.equal((await ctx.identity.me(successor.access_token)).customer.id, session.customer.id);
    const next = await ctx.identity.refresh({
      refresh_token: successor.refresh_token,
      device_id: device,
      request_id: randomUUID(),
    });
    assert.equal(next.session_id, session.session_id);
  }));

test('successful verify receipt survives a later policy update, while a new verification requires the new explicit versions', async () =>
  fixture(async (ctx) => {
    const initial = await ctx.login();
    const upgraded = ctx.make({ consentVersion: 'synthetic-legal-v2' });
    assert.deepEqual(await upgraded.verifyOtp(initial.request), initial.session);
    assert.equal(
      (await ctx.pool.query('SELECT count(*) FROM identity_consents')).rows[0].count,
      '3',
    );
    await ctx.ageRequests();
    const pending = await ctx.challenge();
    await assert.rejects(upgraded.verifyOtp(pending.request), error('INVALID_REQUEST'));
    assert.equal(
      (
        await ctx.pool.query('SELECT attempts FROM identity_otp_challenges WHERE id=$1', [
          pending.request.challenge_id,
        ])
      ).rows[0].attempts,
      0,
    );
    const accepted = await upgraded.verifyOtp({
      ...pending.request,
      consents: {
        terms_version: 'synthetic-legal-v2',
        privacy_version: 'synthetic-legal-v2',
        marketing_opt_in: false,
      },
    });
    assert.equal(accepted.customer.id, initial.session.customer.id);
    assert.equal(
      (
        await ctx.pool.query(
          "SELECT count(*) FROM identity_consents WHERE version='synthetic-legal-v2'",
        )
      ).rows[0].count,
      '3',
    );
  }));
test('repeated cleanup does not rewrite already scrubbed OTP rows and expiry candidates have partial indexes', async () =>
  fixture(async (ctx) => {
    await ctx.challenge();
    await ctx.pool.query(
      "UPDATE identity_otp_challenges SET created_at=created_at-interval '4 minutes', expires_at=expires_at-interval '4 minutes'",
    );
    await ctx.identity.cleanup();
    const before = (
      await ctx.pool.query(
        'SELECT xmin::text AS revision, phone_cipher,code_hash FROM identity_otp_challenges',
      )
    ).rows[0];
    assert.equal(before.phone_cipher, null);
    assert.equal(before.code_hash, null);
    await ctx.identity.cleanup();
    assert.deepEqual(
      (
        await ctx.pool.query(
          'SELECT xmin::text AS revision, phone_cipher,code_hash FROM identity_otp_challenges',
        )
      ).rows[0],
      before,
    );
    const indexes = (
      await ctx.pool.query(
        "SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexname IN ('identity_otp_payload_expiry_idx','identity_otp_cleanup_created_idx')",
      )
    ).rows;
    assert.equal(indexes.length, 2);
  }));

test('channel is durable and immutable for replay; fallback shares budget/cooldown and invalidates previous code', async () =>
  fixture(async (ctx) => {
    const calls = [];
    const delivery = {
      provider: 'channels',
      channels: ['telegram', 'sms'],
      async sendCode(input, channel) {
        calls.push({ ...input, channel });
        return {
          kind: 'submitted',
          provider: channel === 'telegram' ? 'telegram_gateway' : 'mobizon',
          submission: 'accepted',
          messageId: 'fixture',
          campaignId: 'fixture',
        };
      },
    };
    const identity = new CustomerIdentity(ctx.pool, ctx.settings, delivery);
    const body = {
      phone,
      delivery_consent: { privacy_version: version, accepted: true },
      device_id: randomUUID(),
      request_id: randomUUID(),
      channel: 'telegram',
    };
    assert.deepEqual(identity.config().channels, ['telegram', 'sms']);
    const first = await identity.requestOtp(body, ip);
    assert.equal(first.channel, 'telegram');
    assert.equal(first.code_length, 4);
    assert.match(calls[0].code, /^[0-9]{4}$/);
    const restart = new CustomerIdentity(ctx.pool, ctx.settings, delivery);
    assert.deepEqual(await restart.requestOtp(body, ip), first);
    assert.equal(calls.length, 1);
    await assert.rejects(restart.requestOtp({ ...body, channel: 'sms' }, ip), error('CONFLICT'));
    await assert.rejects(
      restart.requestOtp({ ...body, request_id: randomUUID(), channel: 'sms' }, ip),
      error('RATE_LIMITED'),
    );
    await ctx.ageRequests();
    const second = await restart.requestOtp(
      { ...body, request_id: randomUUID(), channel: 'sms' },
      ip,
    );
    assert.equal(second.channel, 'sms');
    assert.equal(second.code_length, 6);
    assert.match(calls[1].code, /^[0-9]{6}$/);
    assert.deepEqual(
      calls.map((c) => c.channel),
      ['telegram', 'sms'],
    );
    const rows = await ctx.pool.query(
      'SELECT delivery_channel, delivery_provider, delivery_reference, state FROM identity_otp_challenges ORDER BY created_at',
    );
    assert.equal(rows.rows[0].state, 'superseded');
    assert.equal(rows.rows[0].delivery_provider, 'telegram_gateway');
    assert.equal(rows.rows[0].delivery_reference, 'fixture');
    await assert.rejects(
      restart.verifyOtp({
        challenge_id: first.challenge_id,
        device_id: body.device_id,
        code: calls[0].code,
        request_id: randomUUID(),
        consents: consent,
      }),
      error('UNAUTHORIZED'),
    );
    const signedIn = await restart.verifyOtp({
      challenge_id: second.challenge_id,
      device_id: body.device_id,
      code: calls[1].code,
      request_id: randomUUID(),
      consents: consent,
    });
    assert.equal(signedIn.customer.phone, phone);
    assert.equal(
      (await ctx.pool.query('SELECT sum(reservations) AS count FROM identity_sms_daily_budget'))
        .rows[0].count,
      '2',
    );
  }));
test('automatic OTP accepts Telegram once, preserves actual channel and four-digit code on replay', async () =>
  fixture(async (ctx) => {
    const calls = [];
    const delivery = {
      provider: 'channels',
      channels: ['telegram', 'whatsapp'],
      async sendCode(input, channel) {
        calls.push({ ...input, channel });
        return {
          kind: 'submitted',
          provider: 'telegram_gateway',
          submission: 'accepted',
          messageId: 'tg-fixture',
        };
      },
    };
    const identity = new CustomerIdentity(ctx.pool, ctx.settings, delivery);
    assert.deepEqual(identity.config().channels, ['telegram']);
    assert.equal(identity.config().channel_selection, 'automatic');
    assert.equal(identity.config().whatsapp_fallback_enabled, true);
    const body = {
      phone,
      device_id: randomUUID(),
      request_id: randomUUID(),
      channel: 'auto',
      delivery_consent: { privacy_version: version, accepted: true },
    };
    const first = OtpResponseSchema.parse(await identity.requestOtp(body, ip));
    assert.equal(first.channel, 'telegram');
    assert.equal(first.code_length, 4);
    assert.match(calls[0].code, /^[0-9]{4}$/);
    assert.deepEqual(
      await new CustomerIdentity(ctx.pool, ctx.settings, delivery).requestOtp(
        { ...body, channel: 'auto' },
        ip,
      ),
      first,
    );
    assert.equal(calls.length, 1);
    await assert.rejects(
      identity.requestOtp({ ...body, channel: 'telegram' }, ip),
      error('CONFLICT'),
    );
    const row = (
      await ctx.pool.query(
        'SELECT requested_channel,delivery_channel,delivery_provider FROM identity_otp_challenges WHERE id=$1',
        [first.challenge_id],
      )
    ).rows[0];
    assert.deepEqual(row, {
      requested_channel: 'auto',
      delivery_channel: 'telegram',
      delivery_provider: 'telegram_gateway',
    });
  }));
test('definite Telegram recipient refusal reserves WhatsApp before one send and replays actual channel', async () =>
  fixture(async (ctx) => {
    const calls = [];
    let code;
    const delivery = {
      provider: 'channels',
      channels: ['telegram', 'whatsapp'],
      async sendCode(input, channel) {
        calls.push(channel);
        if (channel === 'telegram') {
          code = input.code;
          return { kind: 'rejected', reason: 'recipient_unavailable' };
        }
        assert.equal(input.code, code);
        const row = (
          await ctx.pool.query(
            'SELECT requested_channel,delivery_channel,state FROM identity_otp_challenges WHERE request_id=$1',
            [body.request_id],
          )
        ).rows[0];
        assert.deepEqual(row, {
          requested_channel: 'auto',
          delivery_channel: 'whatsapp',
          state: 'reserved',
        });
        const inFlight = await new CustomerIdentity(ctx.pool, ctx.settings, delivery).requestOtp(
          body,
          ip,
        );
        assert.equal(inFlight.channel, 'whatsapp');
        assert.equal(inFlight.delivery_status, 'unknown');
        assert.deepEqual(calls, ['telegram', 'whatsapp']);
        return {
          kind: 'submitted',
          provider: 'whatsapp_cloud',
          submission: 'accepted',
          messageId: 'wamid.fixture',
        };
      },
    };
    const body = {
      phone,
      device_id: randomUUID(),
      request_id: randomUUID(),
      channel: 'auto',
      delivery_consent: { privacy_version: version, accepted: true },
    };
    const identity = new CustomerIdentity(ctx.pool, ctx.settings, delivery);
    const first = OtpResponseSchema.parse(await identity.requestOtp(body, ip));
    assert.deepEqual(calls, ['telegram', 'whatsapp']);
    assert.equal(first.channel, 'whatsapp');
    assert.equal(first.delivery_status, 'submitted');
    assert.equal(first.code_length, 4);
    assert.deepEqual(
      await new CustomerIdentity(ctx.pool, ctx.settings, delivery).requestOtp(body, ip),
      first,
    );
    assert.deepEqual(calls, ['telegram', 'whatsapp']);
    const row = (
      await ctx.pool.query(
        'SELECT requested_channel,delivery_channel,delivery_provider,delivery_reference FROM identity_otp_challenges WHERE id=$1',
        [first.challenge_id],
      )
    ).rows[0];
    assert.deepEqual(row, {
      requested_channel: 'auto',
      delivery_channel: 'whatsapp',
      delivery_provider: 'whatsapp_cloud',
      delivery_reference: 'wamid.fixture',
    });
    assert.equal(
      (await ctx.pool.query('SELECT reservations FROM identity_sms_daily_budget')).rows[0]
        .reservations,
      1,
    );
    const session = await identity.verifyOtp({
      challenge_id: first.challenge_id,
      device_id: body.device_id,
      request_id: randomUUID(),
      code,
      consents: consent,
    });
    assert.equal(session.customer.phone, phone);
  }));
test('automatic OTP does not fallback on unknown Telegram outcome, and survives missing WhatsApp config', async () =>
  fixture(async (ctx) => {
    for (const channels of [['telegram', 'whatsapp'], ['telegram']]) {
      const calls = [];
      const delivery = {
        provider: channels.length === 1 ? 'telegram_gateway' : 'channels',
        channels,
        async sendCode(_input, channel) {
          calls.push(channel);
          return { kind: 'unknown', reason: 'timeout' };
        },
      };
      const identity = new CustomerIdentity(ctx.pool, ctx.settings, delivery);
      const body = {
        phone,
        device_id: randomUUID(),
        request_id: randomUUID(),
        channel: 'auto',
        delivery_consent: { privacy_version: version, accepted: true },
      };
      const first = await identity.requestOtp(body, ip);
      assert.equal(first.channel, 'telegram');
      assert.equal(first.delivery_status, 'unknown');
      assert.deepEqual(
        await new CustomerIdentity(ctx.pool, ctx.settings, delivery).requestOtp(body, ip),
        first,
      );
      assert.deepEqual(calls, ['telegram']);
      if (channels.length === 1)
        assert.equal(identity.config().whatsapp_fallback_enabled, undefined);
      await ctx.ageRequests();
    }
  }));
test('WhatsApp failure and process loss after reservation never dispatch another code', async () =>
  fixture(async (ctx) => {
    for (const failure of ['rejected', 'throw']) {
      const calls = [];
      const delivery = {
        provider: 'channels',
        channels: ['telegram', 'whatsapp'],
        async sendCode(_input, channel) {
          calls.push(channel);
          if (channel === 'telegram') return { kind: 'rejected', reason: 'recipient_unavailable' };
          const inFlight = await new CustomerIdentity(ctx.pool, ctx.settings, delivery).requestOtp(
            body,
            ip,
          );
          assert.equal(inFlight.channel, 'whatsapp');
          assert.equal(inFlight.delivery_status, 'unknown');
          assert.deepEqual(calls, ['telegram', 'whatsapp']);
          if (failure === 'throw') throw new Error('simulated process loss');
          return { kind: 'rejected', reason: 'channel_unavailable' };
        },
      };
      const identity = new CustomerIdentity(ctx.pool, ctx.settings, delivery);
      const body = {
        phone,
        device_id: randomUUID(),
        request_id: randomUUID(),
        channel: 'auto',
        delivery_consent: { privacy_version: version, accepted: true },
      };
      if (failure === 'rejected') {
        await assert.rejects(identity.requestOtp(body, ip), error('SERVICE_UNAVAILABLE'));
        await assert.rejects(identity.requestOtp(body, ip), error('SERVICE_UNAVAILABLE'));
      } else {
        const first = await identity.requestOtp(body, ip);
        assert.equal(first.channel, 'whatsapp');
        assert.equal(first.delivery_status, 'unknown');
        assert.deepEqual(
          await new CustomerIdentity(ctx.pool, ctx.settings, delivery).requestOtp(body, ip),
          first,
        );
      }
      assert.deepEqual(calls, ['telegram', 'whatsapp']);
      await ctx.ageRequests();
    }
  }));
test('supersession during WhatsApp send cannot report a submitted stale challenge', async () =>
  fixture(async (ctx) => {
    const calls = [];
    let waEntered = false;
    const delivery = {
      provider: 'channels',
      channels: ['telegram', 'whatsapp'],
      async sendCode(_input, channel) {
        calls.push(channel);
        if (channel === 'telegram')
          return waEntered
            ? {
                kind: 'submitted',
                provider: 'telegram_gateway',
                submission: 'accepted',
                messageId: 'newer',
              }
            : { kind: 'rejected', reason: 'recipient_unavailable' };
        waEntered = true;
        await ctx.ageRequests();
        await identity.requestOtp({ ...body, request_id: randomUUID() }, ip);
        return {
          kind: 'submitted',
          provider: 'whatsapp_cloud',
          submission: 'accepted',
          messageId: 'wamid.stale',
        };
      },
    };
    const body = {
      phone,
      device_id: randomUUID(),
      request_id: randomUUID(),
      channel: 'auto',
      delivery_consent: { privacy_version: version, accepted: true },
    };
    const identity = new CustomerIdentity(ctx.pool, ctx.settings, delivery);
    await assert.rejects(identity.requestOtp(body, ip), error('SERVICE_UNAVAILABLE'));
    assert.deepEqual(calls, ['telegram', 'whatsapp', 'telegram']);
    const old = (
      await ctx.pool.query(
        'SELECT state,delivery_channel FROM identity_otp_challenges WHERE request_id=$1',
        [body.request_id],
      )
    ).rows[0];
    assert.deepEqual(old, { state: 'superseded', delivery_channel: 'whatsapp' });
  }));
test('automatic fallback skips WhatsApp when a newer challenge superseded the Telegram attempt', async () =>
  fixture(async (ctx) => {
    let first = true;
    const calls = [];
    const delivery = {
      provider: 'channels',
      channels: ['telegram', 'whatsapp'],
      async sendCode(_input, channel) {
        calls.push(channel);
        if (first) {
          first = false;
          await ctx.ageRequests();
          await identity.requestOtp({ ...body, request_id: randomUUID() }, ip);
          return { kind: 'rejected', reason: 'recipient_unavailable' };
        }
        return {
          kind: 'submitted',
          provider: 'telegram_gateway',
          submission: 'accepted',
          messageId: 'newer',
        };
      },
    };
    const body = {
      phone,
      device_id: randomUUID(),
      request_id: randomUUID(),
      channel: 'auto',
      delivery_consent: { privacy_version: version, accepted: true },
    };
    const identity = new CustomerIdentity(ctx.pool, ctx.settings, delivery);
    await assert.rejects(identity.requestOtp(body, ip), error('SERVICE_UNAVAILABLE'));
    assert.deepEqual(calls, ['telegram', 'telegram']);
    const old = (
      await ctx.pool.query(
        'SELECT state,delivery_channel FROM identity_otp_challenges WHERE request_id=$1',
        [body.request_id],
      )
    ).rows[0];
    assert.deepEqual(old, { state: 'superseded', delivery_channel: 'telegram' });
  }));
test('Telegram-only configuration refuses legacy SMS requests before reservation or network', async () =>
  fixture(async (ctx) => {
    const delivery = {
      provider: 'telegram_gateway',
      async sendCode() {
        throw new Error('must not call');
      },
    };
    const identity = new CustomerIdentity(ctx.pool, ctx.settings, delivery);
    await assert.rejects(
      identity.requestOtp(
        {
          phone,
          delivery_consent: { privacy_version: version, accepted: true },
          device_id: randomUUID(),
          request_id: randomUUID(),
        },
        ip,
      ),
      error('SERVICE_UNAVAILABLE'),
    );
    assert.equal(
      (await ctx.pool.query('SELECT count(*) FROM identity_otp_challenges')).rows[0].count,
      '0',
    );
  }));

test('delivery consent is mandatory before any reservation or provider call and persists before dispatch', async () =>
  fixture(async (ctx) => {
    const base = { phone, device_id: randomUUID(), request_id: randomUUID(), channel: 'telegram' };
    let delivered = 0;
    const identity = new CustomerIdentity(ctx.pool, ctx.settings, {
      provider: 'telegram_gateway',
      async sendCode() {
        const row = (
          await ctx.pool.query(
            'SELECT delivery_consent_version, created_at FROM identity_otp_challenges WHERE request_id=$1',
            [base.request_id],
          )
        ).rows[0];
        assert.equal(row.delivery_consent_version, version);
        assert.ok(row.created_at);
        delivered++;
        return {
          kind: 'submitted',
          provider: 'telegram_gateway',
          submission: 'accepted',
          messageId: 'consent-fixture',
        };
      },
    });
    for (const delivery_consent of [
      undefined,
      { privacy_version: version, accepted: false },
      { privacy_version: 'old', accepted: true },
    ])
      await assert.rejects(
        identity.requestOtp({ ...base, ...(delivery_consent ? { delivery_consent } : {}) }, ip),
        error('INVALID_REQUEST'),
      );
    assert.equal(delivered, 0);
    assert.equal(
      (await ctx.pool.query('SELECT count(*) FROM identity_otp_challenges')).rows[0].count,
      '0',
    );
    assert.equal(
      (await ctx.pool.query('SELECT count(*) FROM identity_sms_daily_budget')).rows[0].count,
      '0',
    );
    const input = { ...base, delivery_consent: { privacy_version: version, accepted: true } };
    await identity.requestOtp(input, ip);
    await identity.requestOtp(input, ip);
    assert.equal(delivered, 1);
  }));

test('approved 1000 daily cap survives competing reservations and a service restart', async () =>
  fixture(async (ctx) => {
    await ctx.pool.query(
      "INSERT INTO identity_sms_daily_budget(budget_day,reservations) VALUES ((clock_timestamp() AT TIME ZONE 'UTC')::date,999)",
    );
    const requests = Array.from({ length: 3 }, (_, n) => ({
      phone: '+770100000' + String(n + 11),
      delivery_consent: { privacy_version: version, accepted: true },
      device_id: randomUUID(),
      request_id: randomUUID(),
    }));
    const outcomes = await Promise.allSettled(
      requests.map((body) => ctx.make().requestOtp(body, ip)),
    );
    assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
    for (const result of outcomes.filter((r) => r.status === 'rejected'))
      assert.equal(result.reason.code, 'RATE_LIMITED');
    assert.equal(ctx.deliveries.length, 1);
    const accepted = outcomes.findIndex((r) => r.status === 'fulfilled');
    await ctx.make().requestOtp(requests[accepted], ip);
    assert.equal(ctx.deliveries.length, 1);
    assert.equal(
      (await ctx.pool.query('SELECT reservations FROM identity_sms_daily_budget')).rows[0]
        .reservations,
      1000,
    );
  }, 1000));

test('four-digit Telegram challenge survives restart, enforces attempt budget and completes only once', async () =>
  fixture(async (ctx) => {
    let sent;
    const delivery = {
      provider: 'telegram_gateway',
      async sendCode(input) {
        sent = input.code;
        return {
          kind: 'submitted',
          provider: 'telegram_gateway',
          submission: 'accepted',
          messageId: 'fixture',
          campaignId: 'fixture',
        };
      },
    };
    const identity = new CustomerIdentity(ctx.pool, ctx.settings, delivery);
    const device_id = randomUUID();
    const request = {
      phone,
      device_id,
      request_id: randomUUID(),
      channel: 'telegram',
      delivery_consent: { privacy_version: version, accepted: true },
    };
    const first = await identity.requestOtp(request, ip);
    assert.equal(first.code_length, 4);
    assert.match(sent, /^\d{4}$/);
    const restart = new CustomerIdentity(ctx.pool, ctx.settings, delivery);
    assert.deepEqual(await restart.requestOtp(request, ip), first);
    const verify = {
      challenge_id: first.challenge_id,
      device_id,
      request_id: randomUUID(),
      code: sent,
      consents: consent,
    };
    await assert.rejects(
      restart.verifyOtp({ ...verify, code: sent + '00' }),
      error('UNAUTHORIZED'),
    );
    assert.equal(
      (
        await ctx.pool.query('SELECT attempts FROM identity_otp_challenges WHERE id=$1', [
          first.challenge_id,
        ])
      ).rows[0].attempts,
      1,
    );
    const session = await restart.verifyOtp(verify);
    assert.deepEqual(await restart.verifyOtp(verify), session);
    await restart.patchMe(session.access_token, { nickname: 'Имя' });
    assert.equal((await restart.me(session.access_token)).customer.profile_completed_at, null);
    await assert.rejects(
      restart.patchMe(session.access_token, { gender: null }),
      error('INVALID_REQUEST'),
    );
    await restart.patchMe(session.access_token, { gender: 'female' });
    assert.ok((await restart.me(session.access_token)).customer.profile_completed_at);
  }));
