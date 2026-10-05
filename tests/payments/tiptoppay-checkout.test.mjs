import { createApi } from '../../services/api/dist/index.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHmac } from 'node:crypto';
import { fileURLToPath, URLSearchParams } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { fixtureMenu } from '@pickchick/test-fixtures';
import {
  CommerceRepository,
  CustomerCheckout,
  digest,
  TipTopPayHostedSessions,
  TipTopPayTestCheckout,
  tipTopPayTestOptions,
  TipTopPayReceiver,
  tipTopPayCheckoutOptions,
  findTipTopPayPayment,
  tipTopPayHostedHtml,
} from '../../packages/commerce-core/dist/index.js';
import { checkoutRepresentation } from '../../services/api/dist/customer-checkout-response.js';
const connection = process.env.COMMERCE_TEST_DATABASE_URL;
assert.ok(connection && ['localhost', '127.0.0.1'].includes(new URL(connection).hostname));
const migrationDir = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));
const now = () => new Date().toISOString();
const observation = (attempt) => ({
  eventId: randomUUID(),
  attemptId: attempt.attemptId,
  outcome: 'captured',
  operationId: randomUUID(),
  amountMinor: attempt.amountMinor,
  occurredAt: now(),
});
async function fixture(run, options = {}) {
  const schema = 'commerce_' + randomUUID().replaceAll('-', '');
  const admin = createPool(connection, 12);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(connection);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = createPool(url.toString(), 12);
  try {
    await migrate(pool, migrationDir, 'cloud');
    const org = randomUUID(),
      legal = randomUUID(),
      branch = randomUUID(),
      device = randomUUID(),
      release = randomUUID(),
      payment = randomUUID(),
      fiscal = randomUUID();
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Commerce synthetic')", [org]);
    await pool.query(
      "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES($1,$2,'Synthetic','000000000000')",
      [legal, org],
    );
    await pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,'COMMERCE','Synthetic')",
      [branch, org, legal],
    );
    await pool.query(
      "INSERT INTO devices(id,branch_id,organization_id,kind,name,status) VALUES($1,$2,$3,'edge','Synthetic','active')",
      [device, branch, org],
    );
    await pool.query(
      "INSERT INTO cloud_branch_availability(branch_id,device_id,revision,stopped_ids) VALUES($1,$2,1,'{}')",
      [branch, device],
    );
    const menu = { ...fixtureMenu, branch_id: branch, release_id: release };
    await pool.query(
      'INSERT INTO menu_releases(id,branch_id,version,schema_version,payload,checksum,published_at) VALUES($1,$2,$3,1,$4,$5,clock_timestamp())',
      [release, branch, menu.version, menu, digest(menu)],
    );
    for (const [id, kind] of [
      [payment, 'payment'],
      [fiscal, 'fiscal'],
    ])
      await pool.query(
        'INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,kind,provider,external_reference,enabled,legal_entity_id) VALUES($1,$2,$3,$4,$7,$5,true,$6)',
        [
          id,
          org,
          branch,
          kind,
          kind === 'payment' ? (options.publicId ?? id) : id,
          legal,
          kind === 'payment' ? (options.paymentProvider ?? 'synthetic-test') : 'synthetic-test',
        ],
      );
    const scope = {
      organizationId: org,
      branchId: branch,
      principalId: randomUUID(),
      role: 'sales',
    };
    const manager = { ...scope, principalId: randomUUID(), role: 'manager' };
    const provider = { organizationId: org, branchId: branch, accountId: payment };
    const fiscalProvider = { ...provider, accountId: fiscal };
    const edge = { organizationId: org, branchId: branch, deviceId: device };
    const repo = new CommerceRepository(pool);
    const priced = () => ({
      releaseId: release,
      customerId: options.customerId ?? null,
      channel: 'mobile',
      serviceMode: 'takeaway',
      currency: 'KZT',
      ttlSeconds: 300,
      lines: [
        {
          lineId: randomUUID(),
          productId: 'synthetic-burger',
          title: 'Synthetic burger',
          quantity: 2,
          unitPriceMinor: '50000',
          discountMinor: '0',
          taxCode: 'TEST',
        },
      ],
    });
    async function create() {
      const quote = await repo.issueQuote(scope, randomUUID(), priced());
      const order = await repo.createOrder(scope, randomUUID(), {
        quoteId: quote.quoteId,
        fiscalAccountId: fiscal,
      });
      return { quote, order };
    }
    async function ready() {
      const value = await create();
      await repo.confirmAdmission(edge, {
        eventId: randomUUID(),
        orderId: value.order.orderId,
        reservationId: randomUUID(),
        quoteDigest: value.quote.digest,
      });
      const attempt = await repo.startPaymentAttempt(scope, randomUUID(), {
        orderId: value.order.orderId,
        providerAccountId: payment,
      });
      return { ...value, attempt };
    }
    async function captured() {
      const value = await ready();
      await repo.observePayment(provider, observation(value.attempt));
      const view = await repo.readOrder(scope, value.order.orderId);
      return { ...value, capture: view.captures[0], sale: view.fiscalDocuments[0] };
    }
    const issueSale = async (sale) =>
      repo.observeFiscal(fiscalProvider, {
        eventId: randomUUID(),
        documentId: sale.id,
        outcome: 'issued',
        providerDocumentId: randomUUID(),
        fiscalMark: 'synthetic-mark',
        receiptUrl: 'https://example.invalid/synthetic-receipt',
        amountMinor: sale.amount_minor,
        occurredAt: now(),
      });
    const count = async (table) =>
      Number((await pool.query(`SELECT COUNT(*) count FROM ${table}`)).rows[0].count);
    await run({
      pool,
      admin,
      url,
      schema,
      scope,
      manager,
      provider,
      fiscalProvider,
      edge,
      payment,
      fiscal,
      repo,
      priced,
      create,
      ready,
      captured,
      issueSale,
      count,
    });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

test('rollout fails closed and TEST cannot enable hosted checkout', () => {
  assert.equal(tipTopPayCheckoutOptions({}), null);
  assert.throws(() =>
    tipTopPayCheckoutOptions({ TIPTOPPAY_CHECKOUT_ENABLED: 'true', TIPTOPPAY_MODE: 'test' }),
  );
  assert.ok(tipTopPayHostedHtml.includes('https://widget.tiptoppay.kz/bundles/widget.js'));
});
test('old strict response profiles strip wallet fields including order lists', () => {
  const value = {
    paymentMethods: ['card'],
    kitchenComment: 'x',
    orders: [{ paymentMethod: 'card', kitchenComment: 'y' }],
  };
  assert.deepEqual(checkoutRepresentation(value), { orders: [{}] });
  assert.deepEqual(
    checkoutRepresentation(value, 'application/json; profile=pickchick.checkout-comments-v1'),
    { kitchenComment: 'x', orders: [{ kitchenComment: 'y' }] },
  );
  assert.deepEqual(
    checkoutRepresentation(value, 'application/json; profile=pickchick.checkout-wallets-v1'),
    value,
  );
});
test('hosted capabilities rotate before open, allow one widget, bind Check and deduplicate late Pay', () =>
  fixture(
    async (f) => {
      const customer = f.scope.principalId;
      const repo = new CommerceRepository(f.pool, {
        organizationId: f.scope.organizationId,
        branchId: f.scope.branchId,
        approvalReference: 'TipTop synthetic approved',
      });
      const quote = await repo.issueQuote(f.scope, randomUUID(), {
        ...f.priced(),
        customerId: customer,
      });
      const order = await repo.createDeferredFiscalOrder(f.scope, randomUUID(), quote.quoteId);
      await repo.confirmAdmission(f.edge, {
        eventId: randomUUID(),
        orderId: order.orderId,
        reservationId: randomUUID(),
        quoteDigest: quote.digest,
      });
      await f.pool.query(
        'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
        [f.scope.branchId, f.scope.organizationId, f.edge.deviceId, randomUUID()],
      );
      await f.pool.query(
        `INSERT INTO cloud_fulfillment_projection(order_id,branch_id,organization_id,device_id,reservation_id,quote_id,quote_hash,owner_hash,version,state,display_number,routing_version,payload)
        SELECT id,branch_id,organization_id,admission_device_id,admission_reservation_id,quote_id,quote_digest,quote_digest,1,'held','1',1,'{}' FROM commerce_orders WHERE id=$1`,
        [order.orderId],
      );
      const opts = {
        accountId: f.payment,
        publicId: 'pk_synthetic',
        origin: 'https://checkout.example',
        approvalReference: 'TipTop synthetic approved',
        methods: ['card', 'google_pay'],
      };
      const checkout = new CustomerCheckout(
        f.pool,
        {
          organizationId: f.scope.organizationId,
          branchId: f.scope.branchId,
          paymentAccountId: randomUUID(),
          customerIds: [customer],
          maxOrderMinor: '100000',
          approvalReference: opts.approvalReference,
        },
        undefined,
        opts,
      );
      await checkout.paymentMethod(customer, order.orderId, { method: 'card' });
      await assert.rejects(checkout.paymentMethod(randomUUID(), order.orderId, { method: 'card' }));
      const first = await checkout.hostedPayment(customer, order.orderId);
      const attempt = { attemptId: first.attemptId, amountMinor: '100000' };
      await assert.rejects(checkout.paymentMethod(customer, order.orderId, { method: 'kaspi' }), {
        code: 'CONFLICT',
      });
      const hosted = new TipTopPayHostedSessions(f.pool, opts);
      const second = await checkout.hostedPayment(customer, order.orderId);
      assert.equal(first.attemptId, second.attemptId);
      assert.equal(second.attemptId, attempt.attemptId);
      assert.equal(await f.count('commerce_payment_attempts'), 1);
      const disabledCheckout = new CustomerCheckout(f.pool, {
        organizationId: f.scope.organizationId,
        branchId: f.scope.branchId,
        paymentAccountId: randomUUID(),
        customerIds: [customer],
        maxOrderMinor: '100000',
        approvalReference: opts.approvalReference,
      });
      const recovered = await disabledCheckout.read(customer, order.orderId);
      assert.equal(recovered.paymentMethod, 'card');
      assert.equal(recovered.phase, 'awaiting_payment');
      assert.equal(recovered.expiresAt, second.expiresAt);

      await assert.rejects(hosted.open(new URL(first.checkoutUrl).hash.slice(1)));
      const token = new URL(second.checkoutUrl).hash.slice(1);
      const otherLegal = randomUUID();
      await f.pool.query(
        "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES($1,$2,'Other synthetic','000000000001')",
        [otherLegal, f.scope.organizationId],
      );
      await f.pool.query('UPDATE branches SET legal_entity_id=$2 WHERE id=$1', [
        f.scope.branchId,
        otherLegal,
      ]);
      await assert.rejects(hosted.open(token));
      await f.pool.query(
        'UPDATE branches SET legal_entity_id=(SELECT legal_entity_id FROM commerce_provider_accounts WHERE id=$2) WHERE id=$1',
        [f.scope.branchId, f.payment],
      );
      await assert.rejects(
        new TipTopPayHostedSessions(f.pool, { ...opts, publicId: 'pk_wrong' }).open(token),
      );
      const params = await hosted.open(token);
      assert.equal(params.externalId, attempt.attemptId);
      assert.equal(params.amount, 1000);
      assert.equal(params.userInfo.accountId, customer);
      assert.deepEqual(params.restrictedPaymentMethods, ['ApplePay', 'GooglePay', 'InstallmentKz']);
      await assert.rejects(hosted.open(token));
      await assert.rejects(hosted.issue(customer, order.orderId));
      const secret = 'synthetic-secret-no-production';
      const receiver = new TipTopPayReceiver(f.pool, {
        ...opts,
        apiSecret: secret,
        acceptNewPayments: true,
      });
      const fields = {
        TransactionId: '123456',
        InvoiceId: attempt.attemptId,
        AccountId: customer,
        Amount: '1000',
        Currency: 'KZT',
        TestMode: '0',
        Status: 'Completed',
        OperationType: 'Payment',
        DateTime: '2026-10-05 10:00:00',
      };
      const send = (event, patch = {}) => {
        const raw = Buffer.from(new URLSearchParams({ ...fields, ...patch }).toString());
        return receiver.receive(
          event,
          raw,
          createHmac('sha256', secret).update(raw).digest('base64'),
        );
      };
      assert.deepEqual(await send('check'), { code: 0 });
      assert.deepEqual(await send('check'), { code: 0 });
      assert.deepEqual(await send('check', { TransactionId: '123457' }), { code: 13 });
      await assert.rejects(send('pay', { TestMode: '1' }));
      assert.equal(await f.count('commerce_captures'), 0);
      await f.pool.query(
        "UPDATE commerce_tiptoppay_sessions SET expires_at=clock_timestamp()-interval '1 minute'",
      );
      assert.deepEqual(await send('check'), { code: 13 });
      assert.equal((await disabledCheckout.read(customer, order.orderId)).phase, 'checking');
      assert.deepEqual(await send('fail', { ReasonCode: '5206' }), { code: 0 });
      assert.equal((await repo.readOrder(f.scope, order.orderId)).attempts[0].state, 'unknown');
      await f.pool.query('UPDATE commerce_provider_accounts SET enabled=false WHERE id=$1', [
        f.payment,
      ]);
      await f.pool.query('UPDATE branches SET legal_entity_id=$2 WHERE id=$1', [
        f.scope.branchId,
        otherLegal,
      ]);
      await Promise.all(Array.from({ length: 5 }, () => send('pay')));
      assert.deepEqual(await hosted.status(token), { status: 'observed' });
      assert.equal(await f.count('commerce_captures'), 1);
      assert.equal(await f.count('commerce_provider_inbox'), 2);
      assert.equal(await f.count('commerce_fiscal_documents'), 0);
      assert.equal((await repo.readOrder(f.scope, order.orderId)).money.captured, '100000');
    },
    { paymentProvider: 'tiptoppay', publicId: 'pk_synthetic' },
  ));
test('reconciliation uses only fixed read-only endpoint and rejects TEST/foreign observations', async () => {
  const id = randomUUID(),
    config = { publicId: 'pk_synthetic', apiSecret: 'synthetic-only' };
  const fake = async (url, options) => {
    assert.equal(url, 'https://api.tiptoppay.kz/payments/find');
    assert.equal(JSON.parse(options.body).InvoiceId, id);
    assert.equal(options.redirect, 'error');
    return new Response(
      JSON.stringify({
        Success: true,
        Model: {
          PublicId: config.publicId,
          InvoiceId: id,
          AccountId: randomUUID(),
          TestMode: false,
          Type: 0,
          Status: 'Completed',
          Currency: 'KZT',
          Amount: 1.01,
          TransactionId: 123,
          CreatedDateIso: '2026-10-05T10:00:00',
        },
      }),
    );
  };
  assert.equal((await findTipTopPayPayment(config, id, fake)).Amount, '1.01');
  await assert.rejects(
    findTipTopPayPayment(
      config,
      id,
      async () => new Response(JSON.stringify({ Model: { TestMode: true } })),
    ),
  );
});

test('hosted HTTP page uses official script and rejects disabled capabilities without database access', async () => {
  const app = await createApi({
    service: 'api',
    environment: 'test',
    port: 0,
    databaseUrl: 'postgresql://synthetic@127.0.0.1:1/unavailable',
  });
  try {
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const page = await fetch(origin + '/v1/integrations/tiptoppay/checkout');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.ok((await page.text()).includes('https://widget.tiptoppay.kz/bundles/widget.js'));
    const post = (type, body) =>
      fetch(origin + '/v1/integrations/tiptoppay/checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': type },
        body,
      });
    assert.equal(
      (await post('application/json', JSON.stringify({ token: 'a'.repeat(64) }))).status,
      400,
    );
    assert.equal(
      (await post('application/x-www-form-urlencoded', 'token=' + 'a'.repeat(64))).status,
      404,
    );
    assert.equal((await post('application/x-www-form-urlencoded', 'token=a&token=b')).status, 400);
  } finally {
    await app.close();
  }
});

test('signed TipTop TEST sandbox flow is durable and never touches commercial orders, ledger, kitchen or fiscal outbox', () =>
  fixture(async (f) => {
    const customer = f.scope.principalId;
    const quote = await f.repo.issueQuote(f.scope, randomUUID(), {
      ...f.priced(),
      customerId: customer,
    });
    const options = {
      organizationId: f.scope.organizationId,
      branchId: f.scope.branchId,
      maxMinor: '100000',
      publicId: 'pk_sandbox',
      apiSecret: 'synthetic-sandbox-secret',
      origin: 'https://checkout.example',
      methods: ['card'],
      routingVerified: false,
    };
    const sandbox = new TipTopPayTestCheckout(f.pool, options);
    const tables = [
      'commerce_orders',
      'commerce_payment_attempts',
      'commerce_provider_inbox',
      'commerce_captures',
      'commerce_fiscal_documents',
      'commerce_outbox',
      'cloud_fulfillment_projection',
    ];
    const baseline = await Promise.all(tables.map((table) => f.count(table)));
    await assert.rejects(sandbox.create(randomUUID(), { quoteId: quote.quoteId, method: 'card' }));
    await assert.rejects(
      new TipTopPayTestCheckout(f.pool, { ...options, maxMinor: '1' }).create(customer, {
        quoteId: quote.quoteId,
        method: 'card',
      }),
    );
    const first = await sandbox.create(customer, { quoteId: quote.quoteId, method: 'card' });
    const second = await sandbox.create(customer, { quoteId: quote.quoteId, method: 'card' });
    assert.equal(first.id, second.id);
    assert.equal(await f.count('commerce_tiptoppay_test_payments'), 1);
    assert.equal(new URL(second.checkoutUrl).pathname, '/v1/integrations/tiptoppay/test-checkout');
    await assert.rejects(sandbox.open(new URL(first.checkoutUrl).hash.slice(1)));
    const token = new URL(second.checkoutUrl).hash.slice(1);
    const params = await sandbox.open(token);
    assert.equal(params.externalId, second.id);
    assert.equal(params.amount, 1000);
    assert.equal(params.userInfo.accountId, customer);
    assert.ok(!('restrictedPaymentMethods' in params));
    await assert.rejects(sandbox.open(token));
    assert.ok(
      !(
        'checkoutUrl' in
        (await sandbox.create(customer, { quoteId: quote.quoteId, method: 'card' }))
      ),
    );
    await assert.rejects(sandbox.read(randomUUID(), first.id));
    const fields = {
      TransactionId: '70001',
      InvoiceId: first.id,
      AccountId: customer,
      Amount: '1000',
      Currency: 'KZT',
      TestMode: '1',
      Status: 'Completed',
      OperationType: 'Payment',
      DateTime: '2026-10-05 12:00:00',
    };
    const send = (event, patch = {}) => {
      const raw = Buffer.from(new URLSearchParams({ ...fields, ...patch }).toString());
      return sandbox.receive(
        event,
        raw,
        createHmac('sha256', options.apiSecret).update(raw).digest('base64'),
      );
    };
    await assert.rejects(send('pay'), { code: 'BINDING' });
    const testEnv = {
      TIPTOPPAY_TEST_CHECKOUT_ENABLED: 'true',
      TIPTOPPAY_TEST_WEBHOOKS_ENABLED: 'true',
      TIPTOPPAY_MODE: 'test',
      TIPTOPPAY_PUBLIC_ID: options.publicId,
      TIPTOPPAY_API_SECRET: options.apiSecret,
      TIPTOPPAY_CHECKOUT_ORIGIN: options.origin,
      CUSTOMER_KASPI_ORGANIZATION_ID: options.organizationId,
      CUSTOMER_KASPI_BRANCH_ID: options.branchId,
      TIPTOPPAY_WEBHOOKS_ENABLED: 'false',
      TIPTOPPAY_CHECKOUT_ENABLED: 'false',
    };
    const previous = Object.fromEntries(Object.keys(testEnv).map((key) => [key, process.env[key]]));
    Object.assign(process.env, testEnv);
    const app = await createApi({
      service: 'api',
      environment: 'test',
      port: 0,
      databaseUrl: f.url.toString(),
    });
    try {
      await app.listen(0, '127.0.0.1');
      const origin = await app.getUrl();
      const page = await fetch(origin + '/v1/integrations/tiptoppay/test-checkout');
      assert.equal(page.status, 200);
      assert.ok((await page.text()).includes('Тестовый терминал'));
      const raw = Buffer.from(new URLSearchParams(fields).toString());
      const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-HMAC': createHmac('sha256', options.apiSecret).update(raw).digest('base64'),
      };
      const response = await fetch(origin + '/v1/integrations/tiptoppay/test-check', {
        method: 'POST',
        headers,
        body: raw,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { code: 0 });
      assert.equal(
        (
          await fetch(origin + '/v1/integrations/tiptoppay/test-pay', {
            method: 'POST',
            headers: { ...headers, 'Content-HMAC': 'invalid' },
            body: raw,
          })
        ).status,
        401,
      );
      assert.equal(
        (await fetch(origin + '/v1/customer-checkout/test-payments/' + first.id)).status,
        401,
      );
    } finally {
      await app.close();
      for (const key of Object.keys(testEnv)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
    await assert.rejects(send('pay', { TestMode: '0' }));
    await assert.rejects(send('pay', { Amount: '1001' }));
    await assert.rejects(send('pay', { AccountId: randomUUID() }));
    assert.deepEqual(await send('check'), { code: 0 });
    await assert.rejects(send('pay', { TransactionId: '70002' }), { code: 'BINDING' });
    await assert.rejects(send('fail', { TransactionId: '70002', ReasonCode: '5206' }), {
      code: 'BINDING',
    });
    assert.deepEqual(await send('check', { TransactionId: '70002' }), { code: 13 });
    await f.pool.query(
      "UPDATE commerce_tiptoppay_test_payments SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
      [first.id],
    );
    assert.equal((await sandbox.read(customer, first.id)).state, 'expired');
    assert.deepEqual(await send('check'), { code: 13 });
    await send('fail', { ReasonCode: '5206' });
    assert.equal((await sandbox.read(customer, first.id)).state, 'failed');
    await Promise.all(Array.from({ length: 5 }, () => send('pay')));
    assert.equal((await sandbox.read(customer, first.id)).state, 'paid');
    await send('fail', { ReasonCode: '5206' });
    assert.equal((await sandbox.read(customer, first.id)).state, 'paid');
    assert.deepEqual(await sandbox.status(token), { status: 'observed' });
    assert.deepEqual(await Promise.all(tables.map((table) => f.count(table))), baseline);
    const stored = (
      await f.pool.query('SELECT token_hash FROM commerce_tiptoppay_test_payments WHERE id=$1', [
        first.id,
      ])
    ).rows[0];
    assert.notEqual(stored.token_hash, token);
    const nextQuote = await f.repo.issueQuote(f.scope, randomUUID(), {
      ...f.priced(),
      customerId: customer,
    });
    const runtimeRole = 'ttp_test_' + randomUUID().replaceAll('-', '');
    await f.admin.query(`CREATE ROLE ${runtimeRole} LOGIN`);
    const runtimeUrl = new URL(f.url.toString());
    runtimeUrl.username = runtimeRole;
    const runtimePool = createPool(runtimeUrl.toString(), 8);
    try {
      await f.admin.query(`GRANT USAGE ON SCHEMA ${f.schema} TO ${runtimeRole}`);
      await f.admin.query(`GRANT SELECT ON ${f.schema}.commerce_quotes TO ${runtimeRole}`);
      await f.admin.query(
        `GRANT SELECT,INSERT,UPDATE ON ${f.schema}.commerce_tiptoppay_test_payments TO ${runtimeRole}`,
      );
      const runtime = new TipTopPayTestCheckout(runtimePool, options);
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          runtime.create(customer, { quoteId: nextQuote.quoteId, method: 'card' }),
        ),
      );
      assert.equal(new Set(results.map((result) => result.id)).size, 1);
      assert.equal(
        (
          await runtimePool.query(
            "SELECT has_table_privilege(current_user,'commerce_quotes','UPDATE') allowed",
          )
        ).rows[0].allowed,
        false,
      );
      assert.equal((await runtime.read(customer, results[0].id)).state, 'pending');
      assert.equal(await f.count('commerce_tiptoppay_test_payments'), 2);
    } finally {
      await runtimePool.end();
      await f.admin.query(`DROP OWNED BY ${runtimeRole}`);
      await f.admin.query(`DROP ROLE ${runtimeRole}`);
    }
  }));
test('TEST configuration is explicit, defaults to generic card without unverified routing, rejects LIVE', () => {
  const env = {
    TIPTOPPAY_TEST_CHECKOUT_ENABLED: 'true',
    TIPTOPPAY_TEST_WEBHOOKS_ENABLED: 'true',
    TIPTOPPAY_MODE: 'test',
    TIPTOPPAY_PUBLIC_ID: 'pk_sandbox',
    TIPTOPPAY_API_SECRET: 'synthetic-sandbox-secret',
    TIPTOPPAY_CHECKOUT_ORIGIN: 'https://checkout.example',
    CUSTOMER_KASPI_ORGANIZATION_ID: randomUUID(),
    CUSTOMER_KASPI_BRANCH_ID: randomUUID(),
    TIPTOPPAY_TEST_CHECKOUT_METHODS: 'card,google_pay',
  };
  assert.deepEqual(tipTopPayTestOptions(env).methods, ['card']);
  assert.deepEqual(
    tipTopPayTestOptions({ ...env, TIPTOPPAY_METHOD_ROUTING_VERIFIED: 'true' }).methods,
    ['card', 'google_pay'],
  );
  assert.throws(() => tipTopPayTestOptions({ ...env, TIPTOPPAY_MODE: 'live' }));
  assert.equal(tipTopPayTestOptions({}), null);
});
