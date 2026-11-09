import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApi } from '@pickchick/api';
import {
  CustomerIdentity,
  createCustomerIdentityOptions,
  reviewCodeDigest,
} from '@pickchick/customer-identity';
import { loadConfig } from '@pickchick/platform';
import { TEST_BRANCH_ID, TEST_CATALOG_VERSION } from '@pickchick/test-order-flow';
import { running, request, withSyncDatabases } from '../helpers/sync.mjs';

// Synthetic fixtures only. All outbound fetches except loopback are refused.
const reviewPhone = '+77010000991';
const reviewCode = '5831';
const version = 'cutover-fixture-v1';
const consents = { terms_version: version, privacy_version: version, marketing_opt_in: false };

test('C8: disabling TEST routes preserves identity, App Review and stored TEST history', async (t) => {
  const originalFetch = globalThis.fetch;
  let externalRequests = 0;
  t.mock.method(globalThis, 'fetch', (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
      externalRequests++;
      throw new Error('External requests are forbidden in the cutover fixture');
    }
    return originalFetch(input, init);
  });
  await withSyncDatabases(async ({ cloud, org, legal }) => {
    const env = {
      CUSTOMER_AUTH_CONSENT_VERSION: version,
      CUSTOMER_AUTH_TERMS_URL: 'https://example.test/terms',
      CUSTOMER_AUTH_PRIVACY_URL: 'https://example.test/privacy',
      CUSTOMER_AUTH_DAILY_SMS_BUDGET: '1000',
      CUSTOMER_REVIEW_ACCOUNT_ENABLED: 'true',
      CUSTOMER_REVIEW_ACCOUNT_PHONE: reviewPhone,
      CUSTOMER_REVIEW_ACCOUNT_CODE_SHA256: reviewCodeDigest(reviewCode),
      CUSTOMER_KASPI_PILOT_ENABLED: 'false',
      PHONE_DELIVERY_PROVIDER: 'telegram_gateway',
      TELEGRAM_GATEWAY_TOKEN: 'synthetic-token-never-sent',
      PHONE_SMS_FALLBACK_ENABLED: 'false',
    };
    for (const name of ['LOOKUP', 'OTP', 'PII', 'RECEIPT'])
      env[`CUSTOMER_AUTH_${name}_KEY`] = randomBytes(32).toString('hex');
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    let api;
    const switchGate = async (enabled) => {
      await api?.app.close();
      api = undefined;
      // Use the actual flag parser and production API module, not a test-only controller list.
      const config = loadConfig('api', {
        ...process.env,
        CUSTOMER_AUTH_ENABLED: 'true',
        TEST_ORDER_FLOW_ENABLED: String(enabled),
      });
      api = await running(createApi, { ...config, databaseUrl: cloud.config.databaseUrl });
    };
    const call = async (path, status, { method = 'GET', body, token } = {}) => {
      const response = await request(api.url + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': randomUUID(),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(response.status, status, `${method} ${path}`);
      return response.json();
    };
    const reviewLogin = async () => {
      const device = randomUUID();
      const challenge = await call('/v1/auth/otp/request', 202, {
        method: 'POST',
        body: {
          phone: reviewPhone,
          channel: 'telegram',
          device_id: device,
          request_id: randomUUID(),
          delivery_consent: { privacy_version: version, accepted: true },
        },
      });
      assert.equal(challenge.code_length, 4);
      const session = await call('/v1/auth/otp/verify', 200, {
        method: 'POST',
        body: {
          challenge_id: challenge.challenge_id,
          device_id: device,
          request_id: randomUUID(),
          code: reviewCode,
          consents,
        },
      });
      return { ...session, device };
    };
    const snapshot = async () => {
      const result = {};
      for (const table of ['test_orders', 'test_quotes', 'test_outbox', 'schema_migrations'])
        result[table] = (
          await cloud.pool.query(`SELECT * FROM ${table} AS row ORDER BY row_to_json(row)::text`)
        ).rows;
      return result;
    };
    try {
      Object.assign(process.env, env);
      await cloud.pool.query(
        "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES ($1,$2,$3,'TEST-ALMATY-01','Synthetic cutover')",
        [TEST_BRANCH_ID, org, legal],
      );
      await switchGate(true);
      const before = await reviewLogin();
      // Seed a normal customer's session with a local fake delivery, then check it over HTTP.
      let normalCode;
      const identity = new CustomerIdentity(
        cloud.pool,
        createCustomerIdentityOptions({ ...env, CUSTOMER_AUTH_ENABLED: 'true' }),
        {
          provider: 'mobizon',
          async sendCode(input) {
            normalCode = input.code;
            return {
              kind: 'submitted',
              provider: 'mobizon',
              submission: 'accepted',
              messageId: 'fixture',
            };
          },
        },
      );
      const normalDevice = randomUUID();
      const challenge = await identity.requestOtp(
        {
          phone: '+77010000992',
          device_id: normalDevice,
          request_id: randomUUID(),
          delivery_consent: { privacy_version: version, accepted: true },
        },
        '192.0.2.1',
      );
      const normal = await identity.verifyOtp({
        challenge_id: challenge.challenge_id,
        device_id: normalDevice,
        code: normalCode,
        request_id: randomUUID(),
        consents,
      });
      let guest, order, saved;
      await t.test(
        'enabled control creates TEST history and already refuses review orders',
        async () => {
          await call('/v1/test/catalog', 200);
          guest = await call('/v1/test/sessions', 201, {
            method: 'POST',
            body: { channel: 'kiosk' },
          });
          const quote = await call('/v1/test/quotes', 201, {
            method: 'POST',
            token: guest.token,
            body: {
              catalog_version: TEST_CATALOG_VERSION,
              service_mode: 'takeaway',
              items: [{ product_id: 'cola', quantity: 1 }],
            },
          });
          order = await call('/v1/test/orders', 201, {
            method: 'POST',
            token: guest.token,
            body: { quote_id: quote.quote_id },
          });
          assert.equal(order.payment_state, 'not_started');
          assert.equal(
            (
              await call('/v1/test/sessions', 403, {
                method: 'POST',
                token: before.access_token,
                body: { channel: 'mobile' },
              })
            ).code,
            'FORBIDDEN',
          );
          saved = await snapshot();
        },
      );
      assert.ok(saved, 'the enabled control must pass before the cutover');
      await switchGate(false);
      await t.test(
        'off rejects old tokens, simulated payments and unpaid TEST submissions without changing history',
        async () => {
          const caps = await call('/v1/capabilities', 200);
          assert.equal(caps.features.test_order_flow, false);
          assert.equal(caps.features.unpaid_test_orders, false);
          assert.equal(caps.features.phone_auth, true);
          await call('/health/ready', 200);
          for (const token of [undefined, guest.token, normal.access_token, before.access_token]) {
            for (const path of [
              '/v1/test/catalog',
              '/v1/test/orders',
              `/v1/test/orders/${order.order_id}`,
              '/v1/test/kitchen',
              '/v1/test/display',
            ])
              await call(path, 404, { token });
            for (const [path, body] of [
              ['/v1/test/sessions', { channel: 'mobile' }],
              ['/v1/test/quotes', {}],
              ['/v1/test/orders', { quote_id: randomUUID(), execution_mode: 'unpaid_test' }],
              [
                `/v1/test/orders/${order.order_id}/simulated-payment`,
                { expected_version: order.version, outcome: 'approved' },
              ],
              [`/v1/test/orders/${order.order_id}/handoff`, { expected_version: order.version }],
            ])
              await call(path, 404, { method: 'POST', token, body });
          }
          assert.deepEqual(await snapshot(), saved);
        },
      );
      await t.test(
        'normal sessions and fresh App Review login survive; review payment stays forbidden and deletion works',
        async () => {
          for (const session of [before, normal])
            assert.equal(
              (await call('/v1/customers/me', 200, { token: session.access_token })).customer.id,
              session.customer.id,
            );
          // Advance only this fixture's challenge cooldown, not the application's rate limits.
          await cloud.pool.query(
            "UPDATE identity_otp_challenges SET created_at=created_at-interval '61 seconds'",
          );
          const fresh = await reviewLogin();
          assert.equal(fresh.customer.id, before.customer.id);
          const refreshed = await call('/v1/auth/refresh', 200, {
            method: 'POST',
            body: {
              refresh_token: fresh.refresh_token,
              device_id: fresh.device,
              request_id: randomUUID(),
            },
          });
          for (const path of [
            '/v1/customer-checkout/orders',
            `/v1/customer-checkout/orders/${randomUUID()}/payment`,
          ])
            assert.equal(
              (await call(path, 403, { method: 'POST', token: refreshed.access_token, body: {} }))
                .code,
              'FORBIDDEN',
            );
          for (const table of [
            'commerce_orders',
            'commerce_payment_attempts',
            'commerce_kaspi_invoices',
          ])
            assert.equal(
              (await cloud.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count,
              '0',
            );
          await call('/v1/customers/me', 200, { method: 'DELETE', token: refreshed.access_token });
          await call('/v1/customers/me', 401, { token: before.access_token });
          await call('/v1/customers/me', 200, { token: normal.access_token });
          assert.deepEqual(await snapshot(), saved);
        },
      );
      await switchGate(true);
      assert.equal(
        (await call(`/v1/test/orders/${order.order_id}`, 200, { token: guest.token })).order_id,
        order.order_id,
      );
      assert.deepEqual(await snapshot(), saved);
      assert.equal(externalRequests, 0, 'review sign-in must never call the phone provider');
    } finally {
      await api?.app.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
