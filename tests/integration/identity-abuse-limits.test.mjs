// Audit 19.10: 5.3/2.6 (OTP budget and shared addresses), 5.4 (4-digit guessing),
// 5.7 (refresh lifetime and reuse), 2.3 (App Review account). Synthetic numbers only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  CustomerIdentity,
  CustomerIdentityError,
  OTP_LIMITS,
  clientNetworks,
  createCustomerIdentityOptions,
  readCustomerPaymentPhone,
  reviewCodeDigest,
} from '../../packages/customer-identity/dist/index.js';
import { CustomerCheckoutController } from '../../services/api/dist/customer-checkout-controller.js';
import { TestOrderController } from '../../services/api/dist/test-order-controller.js';
import { withSyncDatabases } from '../helpers/sync.mjs';

const version = 'abuse-fixture-v1';
const consents = { terms_version: version, privacy_version: version, marketing_opt_in: false };
const failsWith = (code) => (e) => e instanceof CustomerIdentityError && e.code === code;
const phoneOf = (n) => '+7701' + String(n).padStart(7, '0');
const submitted = {
  kind: 'submitted',
  provider: 'telegram_gateway',
  submission: 'accepted',
  messageId: 'fixture',
};
const REVIEW_PHONE = phoneOf(9999);
const REVIEW_CODE = '4826';

async function fixture(run, { budget = 1000, overrides = {} } = {}) {
  await withSyncDatabases(async ({ cloud }) => {
    const settings = {
      enabled: true,
      consentVersion: version,
      termsUrl: 'https://example.test/terms',
      privacyUrl: 'https://example.test/privacy',
      dailySmsBudget: budget,
      lookupKey: randomBytes(32),
      otpKey: randomBytes(32),
      piiKey: randomBytes(32),
      receiptKey: randomBytes(32),
      ...overrides,
    };
    const sent = [],
      events = [];
    let outcome = submitted;
    const delivery = {
      provider: 'telegram_gateway',
      async sendCode(input, channel) {
        sent.push({ ...input, channel });
        return outcome;
      },
    };
    const make = (extra = {}) =>
      new CustomerIdentity(cloud.pool, { ...settings, ...extra }, delivery, (e) => events.push(e));
    const identity = make();
    async function request(
      number,
      { ip = '192.0.2.1', device = randomUUID(), id = identity } = {},
    ) {
      const before = sent.length;
      const response = await id.requestOtp(
        {
          phone: number,
          device_id: device,
          request_id: randomUUID(),
          channel: 'auto',
          delivery_consent: { privacy_version: version, accepted: true },
        },
        ip,
      );
      return { response, device, code: sent.length > before ? sent.at(-1).code : null };
    }
    const verify = (challenge, code, id = identity) =>
      id.verifyOtp({
        challenge_id: challenge.response.challenge_id,
        device_id: challenge.device,
        request_id: randomUUID(),
        code,
        consents,
      });
    const login = async (number, options) => {
      const challenge = await request(number, options);
      return { ...challenge, session: await verify(challenge, challenge.code) };
    };
    // Lets the same phone/device ask again (60 s cooldown) without waiting.
    const age = () =>
      cloud.pool.query(
        "UPDATE identity_otp_challenges SET created_at=created_at-interval '61 seconds'",
      );
    const wrong = (code) => String((Number(code) + 1) % 10_000).padStart(4, '0');
    const reservations = async () =>
      (
        await cloud.pool.query(
          'SELECT coalesce(sum(reservations),0)::int AS total, coalesce(sum(new_phone_reservations),0)::int AS fresh FROM identity_sms_daily_budget',
        )
      ).rows[0];
    await run({
      pool: cloud.pool,
      settings,
      make,
      identity,
      sent,
      events,
      request,
      verify,
      login,
      age,
      wrong,
      reservations,
      setOutcome: (value) => {
        outcome = value;
      },
    });
  });
}

// --- 5.4: four-digit codes ----------------------------------------------------------------

test('a four-digit challenge allows three guesses; the correct code after that is refused', async () =>
  fixture(async (ctx) => {
    const challenge = await ctx.request(phoneOf(1));
    assert.equal(challenge.response.code_length, 4);
    for (let i = 0; i < 3; i++)
      await assert.rejects(
        ctx.verify(challenge, ctx.wrong(challenge.code)),
        failsWith('UNAUTHORIZED'),
      );
    await assert.rejects(ctx.verify(challenge, challenge.code), failsWith('UNAUTHORIZED'));
    assert.equal(OTP_LIMITS.attemptsFourDigit, 3);
  }));

test('wrong codes lock the phone across challenges and restarts; existing sessions keep working', async () =>
  fixture(async (ctx) => {
    const owner = await ctx.login(phoneOf(2));
    await ctx.age();
    // An attacker with fresh devices, addresses and challenges, three wrong guesses each.
    const guessRound = async (ip) => {
      const challenge = await ctx.request(phoneOf(2), { ip });
      for (let i = 0; i < 3; i++)
        await assert.rejects(
          ctx.verify(challenge, ctx.wrong(challenge.code), ctx.make()),
          failsWith('UNAUTHORIZED'),
        );
      await ctx.age();
    };
    const dayLater = async () => {
      await ctx.pool.query(
        "UPDATE identity_otp_failures SET failure_hour=failure_hour-interval '25 hours'",
      );
      await ctx.pool.query(
        "UPDATE identity_otp_challenges SET created_at=created_at-interval '25 hours',expires_at=expires_at-interval '25 hours'",
      );
    };
    await guessRound('198.51.100.10');
    await guessRound('198.51.100.11');
    // Six failures in a day: no new code is sent to this phone (survives a restart).
    const sends = ctx.sent.length;
    await assert.rejects(ctx.request(phoneOf(2), { id: ctx.make() }), failsWith('RATE_LIMITED'));
    assert.equal(ctx.sent.length, sends);
    // The owner's existing device session is untouched; another phone is unaffected.
    assert.equal((await ctx.make().me(owner.session.access_token)).customer.phone, phoneOf(2));
    await ctx.login(phoneOf(3), { ip: '198.51.100.12' });
    // A day later guessing resumes, but the 30-day budget keeps counting.
    await dayLater();
    await guessRound('198.51.100.20');
    await dayLater();
    await guessRound('198.51.100.21');
    await dayLater();
    await assert.rejects(ctx.request(phoneOf(2)), failsWith('RATE_LIMITED'));
    // At most 12 four-digit guesses per phone per 30 days: 0.12% instead of 13.9%.
    assert.equal(OTP_LIMITS.phoneFailuresMonth, 12);
    await ctx.pool.query(
      "UPDATE identity_otp_failures SET failure_hour=failure_hour-interval '30 days'",
    );
    const recovered = await ctx.login(phoneOf(2));
    assert.equal(recovered.session.customer.id, owner.session.customer.id);
    await ctx.make().cleanup();
    assert.equal(
      (await ctx.pool.query('SELECT count(*)::int AS n FROM identity_otp_failures')).rows[0].n,
      0,
    );
  }));

test('a locked phone refuses the correct code of a live challenge', async () =>
  fixture(async (ctx) => {
    const victim = phoneOf(4);
    const first = await ctx.request(victim);
    for (let i = 0; i < 3; i++)
      await assert.rejects(ctx.verify(first, ctx.wrong(first.code)), failsWith('UNAUTHORIZED'));
    await ctx.age();
    const second = await ctx.request(victim);
    for (let i = 0; i < 2; i++)
      await assert.rejects(ctx.verify(second, ctx.wrong(second.code)), failsWith('UNAUTHORIZED'));
    await ctx.age();
    const third = await ctx.request(victim);
    await assert.rejects(ctx.verify(third, ctx.wrong(third.code)), failsWith('UNAUTHORIZED'));
    await assert.rejects(ctx.verify(third, third.code), failsWith('RATE_LIMITED'));
  }));

test("guessing cannot lock the owner out of the device that already held the owner's session", async () =>
  fixture(async (ctx) => {
    const victim = phoneOf(5);
    const owner = await ctx.login(victim, { ip: '198.51.100.40' });
    // Signed out (or the session lifetime ended): the owner will need a new code here.
    await ctx.make().logout(owner.session.access_token);
    await ctx.age();
    // Someone else guesses from fresh devices until the phone is locked (six wrong codes).
    for (const ip of ['203.0.113.40', '203.0.113.41']) {
      const challenge = await ctx.request(victim, { ip });
      for (let i = 0; i < 3; i++)
        await assert.rejects(
          ctx.verify(challenge, ctx.wrong(challenge.code), ctx.make()),
          failsWith('UNAUTHORIZED'),
        );
      await ctx.age();
    }
    await assert.rejects(ctx.request(victim, { ip: '203.0.113.42' }), failsWith('RATE_LIMITED'));
    // The owner's own device (its device_id never left it) still gets a code and signs in;
    // its own typo still counts as a failure.
    const again = await ctx.request(victim, { ip: '198.51.100.40', device: owner.device });
    assert.ok(again.code);
    await assert.rejects(ctx.verify(again, ctx.wrong(again.code)), failsWith('UNAUTHORIZED'));
    const session = await ctx.verify(again, again.code);
    assert.equal(session.customer.id, owner.session.customer.id);
    assert.equal(
      (
        await ctx.pool.query(
          'SELECT coalesce(sum(failures),0)::int AS n FROM identity_otp_failures',
        )
      ).rows[0].n,
      7,
    );
    // Every other device stays locked.
    await ctx.age();
    await assert.rejects(ctx.request(victim, { ip: '203.0.113.43' }), failsWith('RATE_LIMITED'));
  }));

// --- 5.3 / 2.6: budget and shared addresses -------------------------------------------------

test('returning customers keep a reserve when new numbers use up their share of the day', async () =>
  fixture(
    async (ctx) => {
      const returning = await ctx.login(phoneOf(100), { ip: '192.0.2.200' });
      await ctx.age();
      // 8 of 10 units may go to new phones; one returning login already used one of them.
      for (let n = 0; n < 7; n++) await ctx.request(phoneOf(200 + n), { ip: `192.0.2.${n + 1}` });
      assert.deepEqual(await ctx.reservations(), { total: 8, fresh: 8 });
      await assert.rejects(
        ctx.request(phoneOf(300), { ip: '192.0.2.99' }),
        failsWith('RATE_LIMITED'),
      );
      const again = await ctx.login(phoneOf(100), { ip: '192.0.2.201', device: returning.device });
      assert.equal(again.session.customer.id, returning.session.customer.id);
      assert.deepEqual(await ctx.reservations(), { total: 9, fresh: 8 });
      assert.deepEqual(
        ctx.events.map((e) => [e.event, e.pool, e.percent]),
        [
          ['customer_otp_budget_attention', 'all', 50],
          ['customer_otp_budget_attention', 'new_phones', 80],
          ['customer_otp_budget_attention', 'all', 80],
          ['customer_otp_budget_attention', 'new_phones', 100],
        ],
      );
    },
    { budget: 10 },
  ));

test('a shared carrier address is limited only by requests nobody verified', async () =>
  fixture(async (ctx) => {
    const carrier = '192.0.2.50';
    // Thirty real customers behind one address verify their codes: none is refused.
    for (let n = 0; n < 30; n++) await ctx.login(phoneOf(400 + n), { ip: carrier });
    // An attacker spraying numbers from one address stops after 20 unverified requests.
    const attacker = '203.0.113.7';
    for (let n = 0; n < OTP_LIMITS.addressOpenHour; n++)
      await ctx.request(phoneOf(500 + n), { ip: attacker });
    await assert.rejects(ctx.request(phoneOf(599), { ip: attacker }), failsWith('RATE_LIMITED'));
    // The carrier address still serves real customers.
    await ctx.login(phoneOf(600), { ip: carrier });
  }));

test('a whole /24 (or IPv6 /48) shares one budget for unverified requests', async () =>
  fixture(async (ctx) => {
    let n = 0;
    for (let host = 1; n < OTP_LIMITS.networkOpenHour; host++)
      for (let i = 0; i < 5 && n < OTP_LIMITS.networkOpenHour; i++, n++)
        await ctx.request(phoneOf(700 + n), { ip: `198.51.100.${host}` });
    await assert.rejects(
      ctx.request(phoneOf(799), { ip: '198.51.100.250' }),
      failsWith('RATE_LIMITED'),
    );
    await ctx.request(phoneOf(798), { ip: '198.51.101.1' });
    assert.deepEqual(clientNetworks('2001:db8:1:2:aaaa::1'), {
      address: '2001:db8:1:2::/64',
      network: '2001:db8:1::/48',
    });
    assert.deepEqual(clientNetworks('2001:db8:1:2::ffff:1.2.3.4'), {
      address: '2001:db8:1:2::/64',
      network: '2001:db8:1::/48',
    });
    assert.deepEqual(clientNetworks('203.0.113.9'), {
      address: '203.0.113.9',
      network: '203.0.113.0/24',
    });
  }));

test('a number Telegram cannot reach returns its reservation; other refusals still spend it', async () =>
  fixture(async (ctx) => {
    ctx.setOutcome({ kind: 'rejected', reason: 'recipient_unavailable' });
    await assert.rejects(ctx.request(phoneOf(800)), failsWith('SERVICE_UNAVAILABLE'));
    await assert.rejects(ctx.request(phoneOf(801)), failsWith('SERVICE_UNAVAILABLE'));
    assert.deepEqual(await ctx.reservations(), { total: 0, fresh: 0 });
    ctx.setOutcome(submitted);
    await ctx.request(phoneOf(802));
    assert.deepEqual(await ctx.reservations(), { total: 1, fresh: 1 });
    ctx.setOutcome({ kind: 'rejected', reason: 'recipient_unavailable' });
    await assert.rejects(ctx.request(phoneOf(804)), failsWith('SERVICE_UNAVAILABLE'));
    assert.deepEqual(await ctx.reservations(), { total: 1, fresh: 1 });
    ctx.setOutcome({ kind: 'rejected', reason: 'channel_unavailable' });
    await assert.rejects(ctx.request(phoneOf(805)), failsWith('SERVICE_UNAVAILABLE'));
    assert.deepEqual(await ctx.reservations(), { total: 2, fresh: 2 });
    // Refused numbers still count as unverified requests of that address.
    assert.equal(
      (
        await ctx.pool.query(
          "SELECT count(*)::int AS n FROM identity_otp_challenges WHERE state='rejected'",
        )
      ).rows[0].n,
      4,
    );
  }));

test('a refund waits for the budget lock before it touches the challenge (no deadlock)', async () =>
  fixture(async (ctx) => {
    let answer;
    ctx.setOutcome(new Promise((resolve) => (answer = resolve)));
    const pending = ctx.request(phoneOf(840));
    while (ctx.sent.length === 0) await new Promise((r) => setTimeout(r, 20));
    // Another request holds the budget lock and is about to supersede this phone's challenge.
    const other = await ctx.pool.connect();
    try {
      await other.query('BEGIN');
      await other.query('SELECT pg_advisory_xact_lock(90827001)');
      answer({ kind: 'rejected', reason: 'recipient_unavailable' });
      await new Promise((r) => setTimeout(r, 500));
      const superseded = await other.query(
        "UPDATE identity_otp_challenges SET state='superseded',code_hash=NULL,phone_cipher=NULL WHERE state='reserved'",
      );
      assert.equal(superseded.rowCount, 1);
      await other.query('COMMIT');
    } catch (error) {
      await other.query('ROLLBACK');
      throw error;
    } finally {
      other.release();
    }
    // The superseded challenge is not finalized and its reservation is not returned twice.
    await assert.rejects(pending, failsWith('SERVICE_UNAVAILABLE'));
    assert.deepEqual(await ctx.reservations(), { total: 1, fresh: 1 });
  }));

test('a refusal that stops every login (Gateway balance, token) is reported once per 5 minutes', async () =>
  fixture(async (ctx) => {
    const attention = () =>
      ctx.events
        .filter((e) => e.event === 'customer_otp_delivery_attention')
        .map((e) => [e.channel, e.reason]);
    // A number Telegram cannot reach is that customer's problem, not an outage.
    ctx.setOutcome({ kind: 'rejected', reason: 'recipient_unavailable' });
    await assert.rejects(ctx.request(phoneOf(820)), failsWith('SERVICE_UNAVAILABLE'));
    assert.deepEqual(attention(), []);
    ctx.setOutcome({ kind: 'rejected', reason: 'channel_unavailable' });
    for (let n = 0; n < 3; n++)
      await assert.rejects(
        ctx.request(phoneOf(821 + n), { ip: `192.0.2.${30 + n}` }),
        failsWith('SERVICE_UNAVAILABLE'),
      );
    assert.deepEqual(attention(), [['telegram', 'channel_unavailable']]);
    ctx.setOutcome({ kind: 'rejected', reason: 'provider_rejected', providerCode: 500 });
    await assert.rejects(ctx.request(phoneOf(830)), failsWith('SERVICE_UNAVAILABLE'));
    assert.deepEqual(attention(), [
      ['telegram', 'channel_unavailable'],
      ['telegram', 'provider_rejected'],
    ]);
    // Events never carry the number, the code or the provider's raw answer.
    assert.ok(ctx.events.every((e) => !JSON.stringify(e).includes('+7701')));
  }));

test('environment defaults: reserve 20%, 90-day sessions, 30-day idle; review account off', () => {
  const env = {
    CUSTOMER_AUTH_ENABLED: 'true',
    CUSTOMER_AUTH_CONSENT_VERSION: 'test-only-v1',
    CUSTOMER_AUTH_DAILY_SMS_BUDGET: '1000',
    CUSTOMER_AUTH_TERMS_URL: 'https://example.test/terms',
    CUSTOMER_AUTH_PRIVACY_URL: 'https://example.test/privacy',
  };
  for (const name of ['LOOKUP', 'OTP', 'PII', 'RECEIPT'])
    env['CUSTOMER_AUTH_' + name + '_KEY'] = randomBytes(32).toString('hex');
  const options = createCustomerIdentityOptions(env);
  assert.equal(options.newPhoneBudgetPercent, 80);
  assert.equal(options.sessionMaxDays, 90);
  assert.equal(options.sessionIdleDays, 30);
  assert.equal(options.reviewAccount, null);
  const review = createCustomerIdentityOptions({
    ...env,
    CUSTOMER_REVIEW_ACCOUNT_ENABLED: 'true',
    CUSTOMER_REVIEW_ACCOUNT_PHONE: '8 (701) 000-99-99',
    CUSTOMER_REVIEW_ACCOUNT_CODE_SHA256: reviewCodeDigest(REVIEW_CODE),
  }).reviewAccount;
  assert.deepEqual(review, {
    enabled: true,
    phone: REVIEW_PHONE,
    codeDigest: reviewCodeDigest(REVIEW_CODE),
  });
  // Phone alone (disabled) still marks the account so it can never pay.
  assert.deepEqual(
    createCustomerIdentityOptions({ CUSTOMER_REVIEW_ACCOUNT_PHONE: REVIEW_PHONE }).reviewAccount,
    { enabled: false, phone: REVIEW_PHONE, codeDigest: null },
  );
  for (const extra of [
    { CUSTOMER_REVIEW_ACCOUNT_ENABLED: 'true' },
    { CUSTOMER_REVIEW_ACCOUNT_ENABLED: 'true', CUSTOMER_REVIEW_ACCOUNT_PHONE: REVIEW_PHONE },
    { CUSTOMER_REVIEW_ACCOUNT_ENABLED: 'yes', CUSTOMER_REVIEW_ACCOUNT_PHONE: REVIEW_PHONE },
    { CUSTOMER_REVIEW_ACCOUNT_PHONE: '+79120000001' },
    { CUSTOMER_AUTH_NEW_PHONE_BUDGET_PERCENT: '0' },
    { CUSTOMER_AUTH_NEW_PHONE_BUDGET_PERCENT: '101' },
    { CUSTOMER_AUTH_SESSION_MAX_DAYS: '10', CUSTOMER_AUTH_SESSION_IDLE_DAYS: '30' },
  ])
    assert.throws(
      () => createCustomerIdentityOptions({ ...env, ...extra }),
      /CUSTOMER_AUTH_CONFIGURATION_INVALID/,
    );
});

// --- 5.7: refresh lifetime and reuse ----------------------------------------------------------

test('sessions end after 90 days or 30 idle days; inside both they rotate', async () =>
  fixture(async (ctx) => {
    const refresh = (who, id = ctx.identity) =>
      id.refresh({
        refresh_token: who.session.refresh_token,
        device_id: who.device,
        request_id: randomUUID(),
      });
    const alive = await ctx.login(phoneOf(900));
    await ctx.pool.query(
      "UPDATE identity_sessions SET created_at=created_at-interval '89 days',refreshed_at=refreshed_at-interval '29 days' WHERE customer_id=$1",
      [alive.session.customer.id],
    );
    const rotated = await refresh(alive);
    assert.equal(rotated.customer.id, alive.session.customer.id);
    const old = await ctx.login(phoneOf(901));
    await ctx.pool.query(
      "UPDATE identity_sessions SET created_at=created_at-interval '91 days' WHERE customer_id=$1",
      [old.session.customer.id],
    );
    await assert.rejects(refresh(old), failsWith('UNAUTHORIZED'));
    const idle = await ctx.login(phoneOf(902));
    await ctx.pool.query(
      "UPDATE identity_sessions SET refreshed_at=refreshed_at-interval '31 days' WHERE customer_id=$1",
      [idle.session.customer.id],
    );
    await assert.rejects(refresh(idle, ctx.make()), failsWith('UNAUTHORIZED'));
    const ended = (
      await ctx.pool.query(
        'SELECT count(*)::int AS n FROM identity_sessions WHERE revoked_at IS NOT NULL AND refresh_hash IS NULL AND access_hash IS NULL',
      )
    ).rows[0].n;
    assert.equal(ended, 2);
    // The ended customer signs in again with a new code (the installed app's 401 path).
    await ctx.age();
    const back = await ctx.login(phoneOf(901), { device: old.device });
    assert.equal(back.session.customer.id, old.session.customer.id);
  }));

test('a thief who rotates first is cut off when the owner presents the rotated-away token', async () =>
  fixture(async (ctx) => {
    const owner = await ctx.login(phoneOf(910));
    const stolen = { ...owner.session };
    // The thief refreshes three times with the stolen token and device id.
    let thief = stolen;
    for (let i = 0; i < 3; i++)
      thief = await ctx.identity.refresh({
        refresh_token: thief.refresh_token,
        device_id: owner.device,
        request_id: randomUUID(),
      });
    assert.equal((await ctx.identity.me(thief.access_token)).customer.phone, phoneOf(910));
    // Later the owner's app refreshes with its (three rotations old) token.
    await ctx.pool.query(
      "UPDATE identity_refresh_receipts SET created_at=created_at-interval '2 minutes'",
    );
    await assert.rejects(
      ctx.make().refresh({
        refresh_token: owner.session.refresh_token,
        device_id: owner.device,
        request_id: randomUUID(),
      }),
      failsWith('UNAUTHORIZED'),
    );
    await assert.rejects(ctx.identity.me(thief.access_token), failsWith('UNAUTHORIZED'));
    await assert.rejects(
      ctx.identity.refresh({
        refresh_token: thief.refresh_token,
        device_id: owner.device,
        request_id: randomUUID(),
      }),
      failsWith('UNAUTHORIZED'),
    );
    const row = (await ctx.pool.query('SELECT * FROM identity_sessions')).rows[0];
    assert.ok(row.revoked_at);
    assert.deepEqual(row.retired_refresh_hashes, []);
  }));

test('the just-rotated token used again after the grace period ends the session; within it, CONFLICT', async () =>
  fixture(async (ctx) => {
    const { session, device } = await ctx.login(phoneOf(920));
    const next = await ctx.identity.refresh({
      refresh_token: session.refresh_token,
      device_id: device,
      request_id: randomUUID(),
    });
    const again = () =>
      ctx.identity.refresh({
        refresh_token: session.refresh_token,
        device_id: device,
        request_id: randomUUID(),
      });
    await assert.rejects(again(), failsWith('CONFLICT'));
    assert.equal((await ctx.identity.me(next.access_token)).customer.id, session.customer.id);
    await ctx.pool.query(
      "UPDATE identity_refresh_receipts SET created_at=created_at-interval '61 seconds'",
    );
    await assert.rejects(again(), failsWith('UNAUTHORIZED'));
    await assert.rejects(ctx.identity.me(next.access_token), failsWith('UNAUTHORIZED'));
  }));

// --- 2.3: App Review account -------------------------------------------------------------------

const reviewOptions = (enabled = true) => ({
  reviewAccount: {
    enabled,
    phone: REVIEW_PHONE,
    codeDigest: enabled ? reviewCodeDigest(REVIEW_CODE) : null,
  },
});

test('App Review signs in with the fixed code; nothing is sent or budgeted; limits still apply', async () =>
  fixture(
    async (ctx) => {
      const review = await ctx.request(REVIEW_PHONE);
      assert.equal(review.code, null);
      assert.equal(ctx.sent.length, 0);
      assert.equal(review.response.code_length, 4);
      assert.equal(review.response.delivery_status, 'submitted');
      assert.deepEqual(await ctx.reservations(), { total: 0, fresh: 0 });
      await assert.rejects(ctx.verify(review, '0000'), failsWith('UNAUTHORIZED'));
      const { customer } = await ctx.verify(review, REVIEW_CODE);
      assert.equal(customer.phone, REVIEW_PHONE);
      assert.equal(ctx.identity.isReviewCustomer(customer), true);
      // Cooldown/rate limits apply to the review phone like any other.
      await assert.rejects(ctx.request(REVIEW_PHONE), failsWith('RATE_LIMITED'));
      // Other numbers still get a real code.
      await ctx.login(phoneOf(930));
      assert.equal(ctx.sent.length, 1);
      assert.equal(ctx.identity.isReviewCustomer({ phone: phoneOf(930) }), false);
    },
    { overrides: reviewOptions() },
  ));

test('App Review account never gets a Kaspi phone, an order, a payment or a TEST session; deletion works', async () =>
  fixture(
    async (ctx) => {
      const review = await ctx.request(REVIEW_PHONE);
      const session = await ctx.verify(review, REVIEW_CODE);
      assert.equal(
        await readCustomerPaymentPhone(ctx.pool, ctx.settings, session.customer.id),
        null,
      );
      const other = await ctx.login(phoneOf(940));
      assert.equal(
        await readCustomerPaymentPhone(ctx.pool, ctx.settings, other.session.customer.id),
        phoneOf(940),
      );
      const controller = new CustomerCheckoutController(
        ctx.identity,
        { pool: {} },
        { revision: 0 },
      );
      const calls = [];
      controller.checkout = {
        quote: async () => (calls.push('quote'), { ok: true }),
        create: async () => (calls.push('create'), { ok: true }),
        pay: async () => (calls.push('pay'), { ok: true }),
      };
      const bearer = (s) => 'Bearer ' + s.access_token;
      await controller.quote({}, bearer(session), 'application/json');
      for (const call of [
        () => controller.create({}, bearer(session), 'application/json'),
        () => controller.pay(randomUUID(), bearer(session), 'application/json'),
      ])
        await assert.rejects(
          call(),
          (e) => e.getStatus() === 403 && e.getResponse().code === 'FORBIDDEN',
        );
      await controller.create({}, bearer(other.session), 'application/json');
      assert.deepEqual(calls, ['quote', 'create']);
      const tests = new TestOrderController(
        { config: { databaseUrl: 'postgres://unused.invalid/none' } },
        ctx.identity,
      );
      const flowCalls = [];
      tests.flow = () => ({
        issueSession: async () => flowCalls.push('issue'),
        continueSession: async () => flowCalls.push('continue'),
      });
      for (const call of [
        () => tests.session({ channel: 'mobile' }, bearer(session)),
        () => tests.continueSession({}, bearer(session)),
      ])
        await assert.rejects(
          call(),
          (e) => e.getStatus() === 403 && e.getResponse().code === 'FORBIDDEN',
        );
      assert.deepEqual(flowCalls, []);
      await tests.onModuleDestroy();
      // In-app account deletion works and a later review sign-in starts a fresh account.
      await ctx.identity.deleteMe(session.access_token);
      await ctx.age();
      const next = await ctx.request(REVIEW_PHONE);
      const fresh = await ctx.verify(next, REVIEW_CODE);
      assert.notEqual(fresh.customer.id, session.customer.id);
    },
    { overrides: reviewOptions() },
  ));

test('switching the review login off sends real codes again but keeps the payment bar', async () =>
  fixture(
    async (ctx) => {
      const review = await ctx.request(REVIEW_PHONE);
      const off = ctx.make(reviewOptions(false));
      await assert.rejects(ctx.verify(review, REVIEW_CODE, off), failsWith('UNAUTHORIZED'));
      await ctx.age();
      const real = await ctx.request(REVIEW_PHONE, { id: off });
      assert.match(real.code, /^[0-9]{4}$/);
      const session = await ctx.verify(real, real.code, off);
      assert.equal(off.isReviewCustomer(session.customer), true);
      assert.equal(
        await readCustomerPaymentPhone(
          ctx.pool,
          { ...ctx.settings, ...reviewOptions(false) },
          session.customer.id,
        ),
        null,
      );
    },
    { overrides: reviewOptions() },
  ));
