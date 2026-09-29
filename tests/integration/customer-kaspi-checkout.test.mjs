import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { createApi } from '@pickchick/api';
import { CustomerIdentity } from '../../packages/customer-identity/dist/index.js';
import {
  CommerceRepository,
  KaspiRemoteProcessor,
} from '../../packages/commerce-core/dist/index.js';
import { publishCatalog } from '../../packages/commerce-core/tests/catalog-fixture.mjs';

// Cloud database only, disposable schema; the Kaspi bridge is a scripted fake.
const connection =
  process.env.CLOUD_DATABASE_URL ??
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55432/pickchick_cloud';
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection).hostname));
const migrations = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));

async function fixture(run) {
  const schema = 'kaspi_checkout_' + randomUUID().replaceAll('-', '');
  const admin = createPool(connection, 2);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(connection);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = createPool(url.toString(), 8);
  const keys = Object.fromEntries(
    ['LOOKUP', 'OTP', 'PII', 'RECEIPT'].map((k) => [k, randomBytes(32).toString('hex')]),
  );
  const ids = {
    org: randomUUID(),
    legal: randomUUID(),
    branch: randomUUID(),
    device: randomUUID(),
    payment: randomUUID(),
    fiscal: randomUUID(),
  };
  const env = {
    CUSTOMER_AUTH_CONSENT_VERSION: 'pilot-test',
    CUSTOMER_AUTH_TERMS_URL: 'https://example.test/terms',
    CUSTOMER_AUTH_PRIVACY_URL: 'https://example.test/privacy',
    CUSTOMER_AUTH_DAILY_SMS_BUDGET: '1000',
    PHONE_DELIVERY_PROVIDER: 'telegram_gateway',
    TELEGRAM_GATEWAY_TOKEN: 'synthetic-token-never-sent',
    PHONE_SMS_FALLBACK_ENABLED: 'false',
    ...Object.fromEntries(Object.entries(keys).map(([k, v]) => ['CUSTOMER_AUTH_' + k + '_KEY', v])),
    CUSTOMER_KASPI_CHECKOUT_ENABLED: 'true',
    CUSTOMER_CHECKOUT_ORGANIZATION_ID: ids.org,
    CUSTOMER_CHECKOUT_BRANCH_ID: ids.branch,
    CUSTOMER_CHECKOUT_FISCAL_ACCOUNT_ID: ids.fiscal,
    KASPI_REMOTE_ACCOUNT_ID: ids.payment,
    CUSTOMER_CHECKOUT_TAX_APPROVAL_REFERENCE: 'Synthetic approval only',
    CUSTOMER_CHECKOUT_TAX_VERSION: '1',
    CUSTOMER_CHECKOUT_TAX_CODE: 'SYNTHETIC-TAX',
  };
  const previous = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  let app;
  try {
    await migrate(pool, migrations, 'cloud');
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Checkout HTTP')", [ids.org]);
    await pool.query(
      "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES($1,$2,'Synthetic','000000000000')",
      [ids.legal, ids.org],
    );
    await pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,'KASPI-HTTP','Synthetic')",
      [ids.branch, ids.org, ids.legal],
    );
    await pool.query(
      "INSERT INTO devices(id,branch_id,organization_id,kind,name,status) VALUES($1,$2,$3,'edge','Synthetic','active')",
      [ids.device, ids.branch, ids.org],
    );
    for (const [id, kind, provider] of [
      [ids.payment, 'payment', 'kaspi-remote'],
      [ids.fiscal, 'fiscal', 'synthetic-test'],
    ])
      await pool.query(
        'INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,kind,provider,external_reference,enabled,legal_entity_id) VALUES($1,$2,$3,$4,$5,$7,true,$6)',
        [id, ids.org, ids.branch, kind, provider, ids.legal, String(id)],
      );
    await publishCatalog({
      pool,
      scope: {
        organizationId: ids.org,
        branchId: ids.branch,
        principalId: randomUUID(),
        role: 'sales',
      },
    });
    let otp;
    const options = {
      enabled: true,
      consentVersion: 'pilot-test',
      termsUrl: 'https://example.test/terms',
      privacyUrl: 'https://example.test/privacy',
      dailySmsBudget: 1000,
      lookupKey: Buffer.from(keys.LOOKUP, 'hex'),
      otpKey: Buffer.from(keys.OTP, 'hex'),
      piiKey: Buffer.from(keys.PII, 'hex'),
      receiptKey: Buffer.from(keys.RECEIPT, 'hex'),
    };
    const identity = new CustomerIdentity(pool, options, {
      provider: 'mobizon',
      async sendCode(input) {
        otp = input.code;
        return {
          kind: 'submitted',
          provider: 'mobizon',
          submission: 'accepted',
          messageId: randomUUID(),
          campaignId: '1',
        };
      },
    });
    const login = async (phone) => {
      await pool.query(
        "UPDATE identity_otp_challenges SET created_at=created_at-interval '61 seconds'",
      );
      const device_id = randomUUID();
      const sent = await identity.requestOtp(
        {
          phone,
          device_id,
          request_id: randomUUID(),
          delivery_consent: { privacy_version: 'pilot-test', accepted: true },
        },
        '192.0.2.10',
      );
      return identity.verifyOtp({
        challenge_id: sent.challenge_id,
        device_id,
        request_id: randomUUID(),
        code: otp,
        consents: {
          terms_version: 'pilot-test',
          privacy_version: 'pilot-test',
          marketing_opt_in: false,
        },
      });
    };
    Object.assign(process.env, env);
    app = await createApi({
      service: 'api',
      environment: 'test',
      port: 0,
      databaseUrl: url.toString(),
      customerAuthEnabled: true,
    });
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()) + '/v1/customer/checkout';
    const call = async (path, token, body, key = randomUUID()) => {
      const response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(key && body !== undefined ? { 'Idempotency-Key': key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    };
    const bridge = {
      calls: [],
      status: new Map(),
      async createInvoice(phone, amount, comment) {
        this.calls.push(['create', phone, amount]);
        this.status.set('800000', {
          Amount: amount,
          Comment: comment,
          Status: 'RemotePaymentCreated',
        });
        return { kind: 'ok', data: { QrOperationId: 800000, Status: 'RemotePaymentCreated' } };
      },
      async details(id) {
        return { kind: 'ok', data: { QrOperationId: Number(id), ...this.status.get(id) } };
      },
      async cancel() {
        return { kind: 'ok', data: {} };
      },
      async history() {
        return { kind: 'ok', data: { Items: [] } };
      },
    };
    // The worker resolves the phone from identity exactly as production does.
    const { readCustomerPaymentPhone } =
      await import('../../packages/customer-identity/dist/index.js');
    const worker = new KaspiRemoteProcessor(
      pool,
      {
        bridgeUrl: 'http://127.0.0.1:1',
        webhookSecret: 'x'.repeat(32),
        accountId: ids.payment,
        invoiceTtlSeconds: 600,
        requestTimeoutMs: 1000,
        session: null,
      },
      bridge,
      (customerId) => readCustomerPaymentPhone(pool, options, customerId),
    );
    const tick = async () => {
      await pool.query(
        "UPDATE commerce_kaspi_invoices SET next_check_at=clock_timestamp()-interval '1 second'",
      );
      await worker.tick();
    };
    const admit = async (orderId) => {
      const row = (
        await pool.query('SELECT quote_digest FROM commerce_orders WHERE id=$1', [orderId])
      ).rows[0];
      await new CommerceRepository(pool).confirmAdmission(
        { organizationId: ids.org, branchId: ids.branch, deviceId: ids.device },
        {
          eventId: randomUUID(),
          orderId,
          reservationId: randomUUID(),
          quoteDigest: row.quote_digest,
        },
      );
    };
    await run({ call, login, tick, admit, bridge });
  } finally {
    await app?.close();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

test('mobile Kaspi checkout over HTTP: verified phone, server price, invoice, paid', () =>
  fixture(async ({ call, login, tick, admit, bridge }) => {
    const session = await login('+77011234567');
    const token = session.access_token;
    assert.equal((await call('', undefined)).status, 401);
    assert.deepEqual((await call('', token)).body, {
      enabled: true,
      payment_method: 'kaspi',
      phone_masked: '+7 701 ••• •• 67',
    });
    const cart = {
      service_mode: 'takeaway',
      items: [{ sku: 'BURGER', quantity: 1, selections: [] }],
    };
    assert.equal((await call('/quotes', token, cart, 'not-a-key')).status, 400);
    const quote = await call('/quotes', token, cart);
    assert.equal(quote.status, 200);
    assert.equal(quote.body.total_minor, '10000');
    const unknown = await call('/quotes', token, {
      service_mode: 'takeaway',
      items: [{ sku: 'NOPE', quantity: 1, selections: [] }],
    });
    assert.ok([400, 409].includes(unknown.status));

    const order = await call('/orders', token, { quote_id: quote.body.quote_id });
    assert.equal(order.status, 200);
    assert.equal(order.body.stage, 'accepting');
    const id = order.body.order_id;

    // A second customer cannot see or pay this order.
    const stranger = (await login('+77019876543')).access_token;
    assert.equal((await call('/orders/' + id, stranger)).status, 404);
    assert.equal((await call('/orders/' + id + '/kaspi-payment', stranger, {})).status, 404);

    await admit(id);
    const paying = await call('/orders/' + id + '/kaspi-payment', token, {});
    assert.equal(paying.body.stage, 'sending_invoice');
    await tick();
    // Whole tenge to the phone from the verified account, never from the request.
    assert.deepEqual(bridge.calls, [['create', '77011234567', 100]]);
    assert.equal((await call('/orders/' + id, token)).body.stage, 'invoice_sent');
    bridge.status.set('800000', { ...bridge.status.get('800000'), Status: 'Processed' });
    await tick();
    const paid = (await call('/orders/' + id, token)).body;
    assert.equal(paid.stage, 'paid');
    assert.equal(JSON.stringify(paid).includes('800000'), false, 'bank ids stay private');
  }));

test('checkout endpoints are closed unless explicitly enabled', async () => {
  const previous = process.env.CUSTOMER_KASPI_CHECKOUT_ENABLED;
  process.env.CUSTOMER_KASPI_CHECKOUT_ENABLED = 'false';
  const app = await createApi({
    service: 'api',
    environment: 'test',
    port: 0,
    databaseUrl: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic',
  });
  try {
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()) + '/v1/customer/checkout';
    const status = await fetch(base);
    assert.deepEqual(await status.json(), { enabled: false });
    const quote = await fetch(base + '/quotes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: '{}',
    });
    assert.equal(quote.status, 503);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.CUSTOMER_KASPI_CHECKOUT_ENABLED;
    else process.env.CUSTOMER_KASPI_CHECKOUT_ENABLED = previous;
  }
});

test('restricted API role can run checkout with the documented grants only', async () => {
  const { customerCheckoutGrants } =
    await import('../../infra/staging/customer-checkout-grants.mjs');
  const { CustomerCheckout } = await import('../../packages/commerce-core/dist/index.js');
  assert.throws(() => customerCheckoutGrants('bad-role', true));
  const schema = 'kaspi_grants_' + randomUUID().replaceAll('-', '');
  const role = 'checkout_runtime_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const admin = createPool(connection, 2);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(connection);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = createPool(url.toString(), 4);
  const restrictedUrl = new URL(connection);
  restrictedUrl.searchParams.set('options', `-c search_path=${schema} -c role=${role}`);
  let restricted;
  try {
    await migrate(pool, migrations, 'cloud');
    const org = randomUUID(),
      legal = randomUUID(),
      branch = randomUUID(),
      device = randomUUID(),
      payment = randomUUID(),
      fiscal = randomUUID();
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Grants')", [org]);
    await pool.query(
      "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES($1,$2,'Synthetic','000000000000')",
      [legal, org],
    );
    await pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,'GRANTS','Synthetic')",
      [branch, org, legal],
    );
    await pool.query(
      "INSERT INTO devices(id,branch_id,organization_id,kind,name,status) VALUES($1,$2,$3,'edge','Synthetic','active')",
      [device, branch, org],
    );
    for (const [id, kind, provider] of [
      [payment, 'payment', 'kaspi-remote'],
      [fiscal, 'fiscal', 'synthetic-test'],
    ])
      await pool.query(
        'INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,kind,provider,external_reference,enabled,legal_entity_id) VALUES($1,$2,$3,$4,$5,$7,true,$6)',
        [id, org, branch, kind, provider, legal, String(id)],
      );
    await publishCatalog({
      pool,
      scope: { organizationId: org, branchId: branch, principalId: randomUUID(), role: 'sales' },
    });
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await pool.query(customerCheckoutGrants(role, true));
    restricted = createPool(restrictedUrl.toString(), 4);
    const checkout = new CustomerCheckout(restricted, new CommerceRepository(restricted), {
      organizationId: org,
      branchId: branch,
      fiscalAccountId: fiscal,
      paymentAccountId: payment,
      taxApprovalReference: 'Synthetic approval only',
      taxVersion: 1,
      taxCode: 'SYNTHETIC-TAX',
    });
    const me = randomUUID();
    const quote = await checkout.quote(me, randomUUID(), {
      service_mode: 'takeaway',
      items: [{ sku: 'BURGER', quantity: 1, selections: [] }],
    });
    const order = await checkout.createOrder(me, randomUUID(), { quote_id: quote.quote_id });
    const digest = (
      await pool.query('SELECT quote_digest FROM commerce_orders WHERE id=$1', [order.order_id])
    ).rows[0].quote_digest;
    await new CommerceRepository(pool).confirmAdmission(
      { organizationId: org, branchId: branch, deviceId: device },
      {
        eventId: randomUUID(),
        orderId: order.order_id,
        reservationId: randomUUID(),
        quoteDigest: digest,
      },
    );
    const paying = await checkout.pay(me, randomUUID(), order.order_id);
    assert.equal(paying.stage, 'sending_invoice');
    // No authority to record money or touch provider accounts.
    await assert.rejects(
      restricted.query('UPDATE commerce_payment_attempts SET state=$1', ['succeeded']),
      /permission denied/,
    );
    await assert.rejects(
      restricted.query('UPDATE commerce_provider_accounts SET enabled=true'),
      /permission denied/,
    );
    await pool.query(customerCheckoutGrants(role, false));
    await assert.rejects(
      checkout.quote(me, randomUUID(), {
        service_mode: 'takeaway',
        items: [{ sku: 'BURGER', quantity: 1, selections: [] }],
      }),
      /permission denied/,
    );
  } finally {
    await restricted?.end();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  }
});
