import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, migrate, transaction } from '@pickchick/database';
import { localSelectionIds } from '@pickchick/menu-sync';
import { fixtureMenu } from '@pickchick/test-fixtures';
import {
  CommerceRepository,
  CustomerCheckout,
  KaspiRemoteProcessor,
  TipTopPayCheckout,
  TipTopPayReceiver,
  tipTopPayCheckoutOptions,
  digest,
} from '../dist/index.js';

// Disposable schemas in local PostgreSQL only; TipTopPay is a scripted fake (no network).
const connection =
  process.env.COMMERCE_TEST_DATABASE_URL ??
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55432/pickchick_cloud';
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection).hostname),
  'Commerce tests require localhost PostgreSQL',
);
const migrationDir = fileURLToPath(new URL('../../../db/cloud/migrations/', import.meta.url));
const PUBLIC_ID = 'pk_livesynthetic0001';
const SECRET = 'synthetic-live-api-secret-0001';
class FakeBridge {
  constructor() {
    this.calls = [];
    this.invoices = new Map();
    this.status = new Map();
  }
  async checkSession() {
    return true;
  }
  count(kind) {
    return this.calls.filter((c) => c[0] === kind).length;
  }
}
async function fixture(run, deferred = false) {
  const schema = 'kaspi_' + randomUUID().replaceAll('-', '');
  const admin = createPool(connection, 4);
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
      fiscal = randomUUID(),
      tiptoppay = randomUUID();
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Kaspi synthetic')", [org]);
    await pool.query(
      "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES($1,$2,'Synthetic','000000000000')",
      [legal, org],
    );
    await pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name,ordering_enabled) VALUES($1,$2,$3,'KASPI','Synthetic',true)",
      [branch, org, legal],
    );
    await pool.query(
      "INSERT INTO devices(id,branch_id,organization_id,kind,name,status) VALUES($1,$2,$3,'edge','Synthetic','active')",
      [device, branch, org],
    );
    const menu = { ...fixtureMenu, branch_id: branch, release_id: release };
    await pool.query(
      'INSERT INTO menu_releases(id,branch_id,version,schema_version,payload,checksum,published_at) VALUES($1,$2,$3,1,$4,$5,clock_timestamp())',
      [release, branch, menu.version, menu, digest(menu)],
    );
    for (const [id, kind, provider] of [
      [payment, 'payment', 'kaspi-remote'],
      [fiscal, 'fiscal', 'synthetic-test'],
      [tiptoppay, 'payment', 'tiptoppay'],
    ])
      await pool.query(
        'INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,kind,provider,external_reference,enabled,legal_entity_id) VALUES($1,$2,$3,$4,$5,$7,true,$6)',
        [id, org, branch, kind, provider, legal, id === tiptoppay ? PUBLIC_ID : id],
      );
    const scope = {
      organizationId: org,
      branchId: branch,
      principalId: randomUUID(),
      role: 'sales',
    };
    const edge = { organizationId: org, branchId: branch, deviceId: device };
    const repo = new CommerceRepository(
      pool,
      deferred
        ? { organizationId: org, branchId: branch, approvalReference: 'Synthetic approved pilot' }
        : undefined,
    );
    await pool.query(
      'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
      [branch, org, device, randomUUID()],
    );
    await pool.query(
      "INSERT INTO cloud_branch_availability(branch_id,device_id,revision,stopped_ids) VALUES($1,$2,1,'{}')",
      [branch, device],
    );
    let number = 0;
    const phones = new Map();
    let clock = Date.now();
    const bridge = new FakeBridge();
    const config = {
      bridgeUrl: 'http://127.0.0.1:1',
      webhookSecret: 'x'.repeat(32),
      accountId: payment,
      invoiceTtlSeconds: 180,
      requestTimeoutMs: 1000,
      session: null,
    };
    const processor = (client = bridge) =>
      new KaspiRemoteProcessor(
        pool,
        config,
        client,
        async (id) => {
          const value = phones.get(id);
          if (value instanceof Error) throw value;
          return value ?? null;
        },
        () => new Date(clock),
      );
    async function order({
      unitPriceMinor = '50000',
      phone = '+77011234567',
      customerId = randomUUID(),
      productId = 'synthetic-burger',
      pay = true,
    } = {}) {
      await pool.query(
        'UPDATE cloud_branch_availability SET observed_at=clock_timestamp() WHERE branch_id=$1',
        [branch],
      );
      if (phone) phones.set(customerId, phone);
      if (phone === 'throw') phones.set(customerId, new Error('PII key unavailable'));
      const quote = await repo.issueQuote(scope, randomUUID(), {
        releaseId: release,
        customerId,
        channel: 'mobile',
        serviceMode: 'takeaway',
        currency: 'KZT',
        ttlSeconds: 300,
        lines: [
          {
            lineId: randomUUID(),
            productId,
            title: 'Synthetic burger',
            quantity: 2,
            unitPriceMinor,
            discountMinor: '0',
            taxCode: 'TEST',
          },
        ],
      });
      const created = deferred
        ? await repo.createDeferredFiscalOrder(scope, randomUUID(), quote.quoteId)
        : await repo.createOrder(scope, randomUUID(), {
            quoteId: quote.quoteId,
            fiscalAccountId: fiscal,
          });
      const reservationId = randomUUID();
      await repo.confirmAdmission(edge, {
        eventId: randomUUID(),
        orderId: created.orderId,
        reservationId,
        quoteDigest: quote.digest,
      });
      await pool.query(
        `INSERT INTO cloud_fulfillment_projection(order_id,branch_id,organization_id,device_id,reservation_id,quote_id,quote_hash,owner_hash,version,state,display_number,routing_version,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7,$7,1,'held',$8,1,'{}')`,
        [
          created.orderId,
          branch,
          org,
          device,
          reservationId,
          quote.quoteId,
          quote.digest,
          String(++number),
        ],
      );
      if (!pay) return { orderId: created.orderId, attempt: null };
      const attempt = await repo.startPaymentAttempt(scope, randomUUID(), {
        orderId: created.orderId,
        providerAccountId: payment,
      });
      return { orderId: created.orderId, attempt };
    }
    const view = (orderId) => repo.readOrder(scope, orderId);
    const invoice = async (attemptId) =>
      (
        await pool.query(
          'SELECT *,amount_minor::text amount_minor,paid_minor::text paid_minor FROM commerce_kaspi_invoices WHERE attempt_id=$1',
          [attemptId],
        )
      ).rows[0];
    // Make every invoice due now, as if time had passed.
    const due = () =>
      pool.query(
        "UPDATE commerce_kaspi_invoices SET next_check_at=clock_timestamp()-interval '1 second'",
      );
    const age = (seconds) => {
      for (const invoice of bridge.invoices.values())
        invoice.OrderRegDate = new Date(
          Date.parse(invoice.OrderRegDate) - seconds * 1000,
        ).toISOString();
      return pool.query(
        `UPDATE commerce_kaspi_invoices SET issue_started_at=issue_started_at-$1*interval '1 second',
         next_check_at=clock_timestamp()-interval '1 second'`,
        [seconds],
      );
    };
    // Simulate time passing for outbox leases (order-level and bank deferrals).
    const releaseLeases = () =>
      pool.query(
        "UPDATE commerce_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE acknowledged_at IS NULL",
      );
    const stop = (productIds) =>
      pool.query('UPDATE cloud_branch_availability SET stopped_ids=$2::uuid[] WHERE branch_id=$1', [
        branch,
        productIds.map((id) => localSelectionIds(branch, id, [])[0]),
      ]);
    await run({
      schema,
      url,
      admin,
      config,
      pool,
      repo,
      scope,
      payment,
      tiptoppay,
      fiscal,
      bridge,
      processor,
      order,
      view,
      invoice,
      due,
      age,
      releaseLeases,
      stop,
      branch,
      advance: (ms) => (clock += ms),
      now: () => clock,
    });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

/** Scripted TipTopPay API: one handler per path; records every call. */
function fakeBank() {
  const bank = { calls: [], handlers: {} };
  bank.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    bank.calls.push({ path, body, headers: init.headers ?? {} });
    const handler = bank.handlers[path];
    if (!handler) throw new Error('unexpected ' + path);
    const answer = await handler(body);
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  bank.count = (path) => bank.calls.filter((c) => c.path === path).length;
  return bank;
}
const options = (f) => ({
  accountId: f.tiptoppay,
  publicId: PUBLIC_ID,
  apiSecret: SECRET,
  origin: 'https://api.example.test',
  methods: ['card', 'apple_pay'],
});
const checkoutFor = (f) =>
  new CustomerCheckout(f.pool, {
    ...f.scope,
    paymentAccountId: f.payment,
    customerIds: [f.scope.principalId],
    maxOrderMinor: '1000000',
    repeatOrdersEnabled: true,
    approvalReference: 'Synthetic approval',
  });
async function liveOrder(f, bank) {
  const { orderId } = await f.order({ customerId: f.scope.principalId, pay: false });
  const checkout = checkoutFor(f);
  const live = new TipTopPayCheckout(f.pool, options(f), f.now, bank.fetch);
  const start = () => checkout.startTipTopPayAttempt(f.scope.principalId, orderId, f.tiptoppay);
  return { orderId, checkout, live, start };
}
const kitchenJobs = async (f, orderId) =>
  (
    await f.pool.query(
      "SELECT count(*)::int count FROM commerce_outbox WHERE order_id=$1 AND event_type='edge.kitchen_admission_requested'",
      [orderId],
    )
  ).rows[0].count;
const attemptState = async (f, attemptId) =>
  (await f.pool.query('SELECT state FROM commerce_payment_attempts WHERE id=$1', [attemptId]))
    .rows[0].state;
const completed = (body, extra = {}) => ({
  Success: true,
  Message: null,
  Model: {
    TransactionId: 9100001,
    Status: 'Completed',
    InvoiceId: body.InvoiceId,
    Amount: body.Amount,
    TestMode: false,
    ...extra,
  },
});

test('options: live checkout needs the live receiver, keys, account and never the TEST sandbox', () => {
  const env = {
    TIPTOPPAY_CHECKOUT_ENABLED: 'true',
    TIPTOPPAY_MODE: 'live',
    TIPTOPPAY_WEBHOOKS_ENABLED: 'true',
    TIPTOPPAY_PUBLIC_ID: PUBLIC_ID,
    TIPTOPPAY_API_SECRET: SECRET,
    TIPTOPPAY_ACCOUNT_ID: randomUUID(),
    TIPTOPPAY_CHECKOUT_ORIGIN: 'https://api.pickchick.kz',
    TIPTOPPAY_CHECKOUT_METHODS: 'card,apple_pay,google_pay',
    TIPTOPPAY_APPLE_PAY_CERTIFICATE_READY: 'true',
  };
  assert.equal(tipTopPayCheckoutOptions({}), null);
  assert.equal(tipTopPayCheckoutOptions({ ...env, TIPTOPPAY_CHECKOUT_ENABLED: 'false' }), null);
  assert.deepEqual(tipTopPayCheckoutOptions(env).methods, ['card', 'apple_pay', 'google_pay']);
  for (const broken of [
    { TIPTOPPAY_MODE: 'test' },
    { TIPTOPPAY_WEBHOOKS_ENABLED: 'false' },
    { TIPTOPPAY_TEST_CHECKOUT_ENABLED: 'true' },
    { TIPTOPPAY_APPLE_PAY_CERTIFICATE_READY: 'false' },
    { TIPTOPPAY_API_SECRET: 'short' },
    { TIPTOPPAY_CHECKOUT_ENABLED: 'yes' },
  ])
    assert.throws(() => tipTopPayCheckoutOptions({ ...env, ...broken }));
});

test('a completed charge pays the real order once and hands it to the kitchen', () =>
  fixture(async (f) => {
    const bank = fakeBank();
    bank.handlers['/payments/cards/charge'] = (body) => completed(body);
    const { orderId, live, start, checkout } = await liveOrder(f, bank);
    const attempt = await start();
    assert.equal(attempt.amountMinor, '100000');
    assert.deepEqual(
      await live.charge(attempt, { method: 'apple_pay', cryptogram: 'x'.repeat(40) }, '10.0.0.7'),
      {},
    );
    const call = bank.calls[0];
    assert.equal(call.body.InvoiceId, attempt.attemptId);
    assert.equal(call.body.AccountId, f.scope.principalId);
    assert.equal(call.body.Amount, 1000);
    assert.equal(call.body.Currency, 'KZT');
    assert.equal(call.headers['X-Request-ID'], attempt.attemptId);
    assert.match(call.headers.Authorization, /^Basic /);
    const paid = await f.view(orderId);
    assert.equal(paid.captures.length, 1);
    assert.equal(
      paid.captures[0].operationId ?? paid.captures[0].operation_id ?? '9100001',
      '9100001',
    );
    assert.ok(paid.kitchenEffectId);
    assert.equal(await kitchenJobs(f, orderId), 1);
    assert.equal(await attemptState(f, attempt.attemptId), 'succeeded');
    // The cryptogram is never stored.
    const stored = JSON.stringify(
      (await f.pool.query('SELECT * FROM commerce_tiptoppay_sessions')).rows,
    );
    assert.ok(!stored.includes('x'.repeat(40)));
    // A repeated tap never charges again, and a paid order offers nothing to charge.
    assert.deepEqual(
      await live.charge(attempt, { method: 'apple_pay', cryptogram: 'y'.repeat(40) }, '10.0.0.7'),
      {},
    );
    assert.equal(bank.count('/payments/cards/charge'), 1);
    assert.equal(await start(), null);
    assert.notEqual((await checkout.read(f.scope.principalId, orderId)).phase, 'failed');
    // The submission was handled in the request: no other worker sees it.
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int count FROM commerce_outbox WHERE order_id=$1 AND event_type='payment.submit_requested' AND acknowledged_at IS NULL",
          [orderId],
        )
      ).rows[0].count,
      0,
    );
  }, true));

test('a declined charge fails the attempt with the bank words; the customer may try again', () =>
  fixture(async (f) => {
    const bank = fakeBank();
    let tries = 0;
    bank.handlers['/payments/cards/charge'] = (body) =>
      ++tries === 1
        ? {
            Success: false,
            Message: null,
            Model: {
              TransactionId: 9100002,
              Status: 'Declined',
              ReasonCode: 5051,
              CardHolderMessage: 'Недостаточно средств на карте',
              InvoiceId: body.InvoiceId,
              TestMode: false,
            },
          }
        : completed(body, { TransactionId: 9100003 });
    const { orderId, live, start } = await liveOrder(f, bank);
    const first = await start();
    assert.deepEqual(
      await live.charge(first, { method: 'card', cryptogram: 'c'.repeat(40) }, '1.1.1.1'),
      {
        message: 'Недостаточно средств на карте',
      },
    );
    assert.equal(await attemptState(f, first.attemptId), 'failed');
    assert.equal(await kitchenJobs(f, orderId), 0);
    const second = await start();
    assert.notEqual(second.attemptId, first.attemptId);
    await live.charge(second, { method: 'card', cryptogram: 'c'.repeat(40) }, '1.1.1.1');
    assert.equal((await f.view(orderId)).captures.length, 1);
    assert.equal(await kitchenJobs(f, orderId), 1);
  }, true));

test('3-D Secure: the app opens our page, post3ds completes the same attempt', () =>
  fixture(async (f) => {
    const bank = fakeBank();
    bank.handlers['/payments/cards/charge'] = (body) => ({
      Success: false,
      Message: null,
      Model: {
        TransactionId: 9100004,
        AcsUrl: 'https://acs.bank.test/3ds',
        PaReq: 'pareq-synthetic',
        InvoiceId: body.InvoiceId,
        TestMode: false,
      },
    });
    const { orderId, live, start } = await liveOrder(f, bank);
    const attempt = await start();
    const hint = await live.charge(
      attempt,
      { method: 'card', cryptogram: 'c'.repeat(40) },
      '1.1.1.1',
    );
    assert.match(
      hint.threeDsUrl,
      /^https:\/\/api\.example\.test\/v1\/integrations\/tiptoppay\/3ds#/,
    );
    assert.equal(await attemptState(f, attempt.attemptId), 'pending');
    bank.handlers['/payments/cards/post3ds'] = (body) => {
      assert.equal(body.TransactionId, 9100004);
      return completed({ InvoiceId: attempt.attemptId, Amount: 1000 }, { TransactionId: 9100004 });
    };
    await assert.rejects(live.complete3ds('9999999', 'pares'), /NOT_FOUND/);
    assert.equal(await live.complete3ds('9100004', 'pares-synthetic'), 'paid');
    assert.equal(await live.complete3ds('9100004', 'pares-synthetic'), 'paid');
    assert.equal(bank.count('/payments/cards/post3ds'), 1);
    assert.equal(await kitchenJobs(f, orderId), 1);
  }, true));

test('a lost answer stays unknown until payments/find settles it; never a second charge', () =>
  fixture(async (f) => {
    const bank = fakeBank();
    bank.handlers['/payments/cards/charge'] = () => {
      throw new Error('socket hang up');
    };
    const { orderId, live, start } = await liveOrder(f, bank);
    const attempt = await start();
    assert.deepEqual(
      await live.charge(attempt, { method: 'card', cryptogram: 'c'.repeat(40) }, '1.1.1.1'),
      {},
    );
    assert.equal(await attemptState(f, attempt.attemptId), 'unknown');
    // An unknown attempt blocks a new one: the money may already be taken.
    assert.equal(await start(), null);
    bank.handlers['/payments/find'] = (body) => {
      assert.equal(body.InvoiceId, attempt.attemptId);
      return completed({ InvoiceId: attempt.attemptId, Amount: 1000 }, { TransactionId: 9100005 });
    };
    await f.pool.query('UPDATE commerce_tiptoppay_sessions SET next_check_at=NULL');
    const result = await live.reconcile();
    assert.equal(result.settled, 1);
    assert.equal(await attemptState(f, attempt.attemptId), 'succeeded');
    assert.equal(await kitchenJobs(f, orderId), 1);
    assert.equal(bank.count('/payments/cards/charge'), 1);
  }, true));

test('find answers a foreign amount: unknown for a manager, never paid', () =>
  fixture(async (f) => {
    const bank = fakeBank();
    bank.handlers['/payments/cards/charge'] = () => {
      throw new Error('timeout');
    };
    bank.handlers['/payments/find'] = () =>
      completed({ InvoiceId: attempt.attemptId, Amount: 1 }, { TransactionId: 9100006 });
    const { orderId, live, start } = await liveOrder(f, bank);
    const attempt = await start();
    await live.charge(attempt, { method: 'card', cryptogram: 'c'.repeat(40) }, '1.1.1.1');
    await f.pool.query('UPDATE commerce_tiptoppay_sessions SET next_check_at=NULL');
    await live.reconcile();
    assert.equal(await attemptState(f, attempt.attemptId), 'unknown');
    assert.equal((await f.view(orderId)).captures.length, 0);
    assert.equal(await kitchenJobs(f, orderId), 0);
  }, true));

test('not found long after sending fails it; an attempt never sent fails after its window', () =>
  fixture(async (f) => {
    const bank = fakeBank();
    bank.handlers['/payments/cards/charge'] = () => {
      throw new Error('timeout');
    };
    bank.handlers['/payments/find'] = () => ({ Success: false, Message: 'Not found' });
    const { live, start } = await liveOrder(f, bank);
    const attempt = await start();
    await live.charge(attempt, { method: 'card', cryptogram: 'c'.repeat(40) }, '1.1.1.1');
    await f.pool.query('UPDATE commerce_tiptoppay_sessions SET next_check_at=NULL');
    await live.reconcile();
    assert.equal(await attemptState(f, attempt.attemptId), 'unknown');
    f.advance(21 * 60_000);
    await f.pool.query('UPDATE commerce_tiptoppay_sessions SET next_check_at=NULL');
    await live.reconcile();
    assert.equal(await attemptState(f, attempt.attemptId), 'failed');

    assert.equal(bank.count('/payments/cards/charge'), 1);
  }, true));

test('an attempt never sent to the bank (the request died) fails after its window', () =>
  fixture(async (f) => {
    const bank = fakeBank();
    const { live, start } = await liveOrder(f, bank);
    const unsent = await start();
    await live.reconcile();
    assert.equal(await attemptState(f, unsent.attemptId), 'pending');
    f.advance(16 * 60_000);
    await live.reconcile();
    assert.equal(await attemptState(f, unsent.attemptId), 'failed');
    assert.equal(bank.calls.length, 0);
  }, true));

test('a Kaspi invoice in flight blocks a TipTopPay charge of the same order', () =>
  fixture(async (f) => {
    const bank = fakeBank();
    const { orderId, start, checkout } = await liveOrder(f, bank);
    await checkout.pay(f.scope.principalId, orderId);
    await assert.rejects(start(), /NOT_READY/);
  }, true));

test('refunds: a manager refund is sent once to payments/refund and settles', () =>
  fixture(async (f) => {
    const bank = fakeBank();
    bank.handlers['/payments/cards/charge'] = (body) => completed(body, { TransactionId: 9100007 });
    let refunds = 0;
    bank.handlers['/payments/refund'] = (body) => {
      refunds++;
      assert.deepEqual(body, { TransactionId: 9100007, Amount: 1000 });
      return { Success: true, Message: null, Model: { TransactionId: 9100008 } };
    };
    const { orderId, live, start } = await liveOrder(f, bank);
    const attempt = await start();
    await live.charge(attempt, { method: 'card', cryptogram: 'c'.repeat(40) }, '1.1.1.1');
    const capture = (await f.view(orderId)).captures[0];
    const manager = { ...f.scope, role: 'manager' };
    const refund = await f.repo.requestRefund(manager, randomUUID(), {
      orderId,
      captureId: capture.id,
      amountMinor: '100000',
      reason: 'Синтетический возврат',
      fulfillmentPolicy: 'manager_reviewed',
    });
    const sent = await live.refunds();
    assert.equal(sent.sent, 1);
    assert.equal(refunds, 1);
    assert.equal(bank.calls.at(-1).headers['X-Request-ID'], refund.refundId);
    const after = await f.view(orderId);
    assert.equal(after.money.refunded, '100000');
    assert.equal((await live.refunds()).sent, 0);
    assert.equal(refunds, 1);
  }, true));

test('refunds: no answer marks the refund unknown for a manager, never sent again', () =>
  fixture(async (f) => {
    const bank = fakeBank();
    bank.handlers['/payments/cards/charge'] = (body) => completed(body, { TransactionId: 9100009 });
    bank.handlers['/payments/refund'] = () => {
      throw new Error('timeout');
    };
    const { orderId, live, start } = await liveOrder(f, bank);
    await live.charge(await start(), { method: 'card', cryptogram: 'c'.repeat(40) }, '1.1.1.1');
    const capture = (await f.view(orderId)).captures[0];
    const refund = await f.repo.requestRefund({ ...f.scope, role: 'manager' }, randomUUID(), {
      orderId,
      captureId: capture.id,
      amountMinor: '50000',
      reason: 'Синтетический возврат',
      fulfillmentPolicy: 'manager_reviewed',
    });
    await live.refunds();
    await f.releaseLeases();
    await live.refunds();
    assert.equal(bank.count('/payments/refund'), 1);
    const state = (
      await f.pool.query('SELECT state FROM commerce_refunds WHERE id=$1', [refund.refundId])
    ).rows[0].state;
    assert.equal(state, 'unknown');
  }, true));

test('signed notifications: Check admits only with the live checkout on; Fail declines the attempt', () =>
  fixture(async (f) => {
    const bank = fakeBank();
    bank.handlers['/payments/cards/charge'] = (body) => ({
      Success: false,
      Message: null,
      Model: {
        TransactionId: 9100010,
        AcsUrl: 'https://acs.bank.test/',
        PaReq: 'p',
        InvoiceId: body.InvoiceId,
        TestMode: false,
      },
    });
    const { orderId, live, start } = await liveOrder(f, bank);
    const attempt = await start();
    await live.charge(attempt, { method: 'card', cryptogram: 'c'.repeat(40) }, '1.1.1.1');
    const form = (extra) =>
      Buffer.from(
        new URLSearchParams({
          TransactionId: '9100010',
          Amount: '1000.00',
          Currency: 'KZT',
          DateTime: new Date().toISOString().slice(0, 19).replace('T', ' '),
          InvoiceId: attempt.attemptId,
          AccountId: f.scope.principalId,
          OperationType: 'Payment',
          Status: 'Completed',
          TestMode: '0',
          ...extra,
        }).toString(),
      );
    const sign = (raw) => createHmac('sha256', SECRET).update(raw).digest('base64');
    const config = (accept) => ({
      publicId: PUBLIC_ID,
      apiSecret: SECRET,
      accountId: f.tiptoppay,
      acceptNewPayments: accept,
    });
    const raw = form({});
    assert.deepEqual(
      await new TipTopPayReceiver(f.pool, config(false)).receive('check', raw, sign(raw)),
      { code: 13 },
    );
    assert.deepEqual(
      await new TipTopPayReceiver(f.pool, config(true)).receive('check', raw, sign(raw)),
      { code: 0 },
    );
    const fail = form({ Status: 'Declined', ReasonCode: '5051' });
    assert.deepEqual(
      await new TipTopPayReceiver(f.pool, config(true)).receive('fail', fail, sign(fail)),
      { code: 0 },
    );
    assert.equal(await attemptState(f, attempt.attemptId), 'failed');
    assert.equal(await kitchenJobs(f, orderId), 0);
  }, true));

test('restricted roles: the API role charges and records the bank answer; the worker role refunds', () =>
  fixture(async (f) => {
    const { customerCheckoutGrants } = await import('../../../infra/staging/checkout-grants.mjs');
    const { tipTopPayApiGrants, tipTopPayWorkerGrants } =
      await import('../../../infra/staging/tiptoppay-live-grants.mjs');
    const suffix = randomUUID().replaceAll('-', '');
    const api = 'ttp_api_' + suffix,
      worker = 'ttp_worker_' + suffix;
    const pools = [];
    for (const role of [api, worker])
      await f.admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    try {
      await f.pool.query(`GRANT USAGE ON SCHEMA ${f.schema} TO ${api},${worker}`);
      await f.pool.query(customerCheckoutGrants(api, true));
      await f.pool.query(tipTopPayApiGrants(api, true));
      await f.pool.query(tipTopPayWorkerGrants(worker, true));
      const as = (role) => {
        const url = new URL(f.url);
        url.searchParams.set('options', `-c search_path=${f.schema} -c role=${role}`);
        const pool = createPool(url.toString(), 2);
        pools.push(pool);
        return pool;
      };
      const bank = fakeBank();
      bank.handlers['/payments/cards/charge'] = (body) =>
        completed(body, { TransactionId: 9100020 });
      bank.handlers['/payments/refund'] = () => ({
        Success: true,
        Model: { TransactionId: 9100021 },
      });
      const { orderId } = await f.order({ customerId: f.scope.principalId, pay: false });
      const apiPool = as(api);
      const checkout = new CustomerCheckout(apiPool, {
        ...f.scope,
        paymentAccountId: f.payment,
        customerIds: [f.scope.principalId],
        maxOrderMinor: '1000000',
        approvalReference: 'Synthetic approval',
      });
      const live = new TipTopPayCheckout(apiPool, options(f), f.now, bank.fetch);
      const attempt = await checkout.startTipTopPayAttempt(
        f.scope.principalId,
        orderId,
        f.tiptoppay,
      );
      await live.charge(attempt, { method: 'card', cryptogram: 'c'.repeat(40) }, '1.1.1.1');
      assert.equal(await attemptState(f, attempt.attemptId), 'succeeded');
      assert.equal(await kitchenJobs(f, orderId), 1);
      // The API role cannot rewrite money or sessions beyond the schedule columns.
      for (const sql of [
        'UPDATE commerce_captures SET amount_minor=1',
        'DELETE FROM commerce_tiptoppay_sessions',
        'UPDATE commerce_tiptoppay_sessions SET order_id=gen_random_uuid()',
      ])
        await assert.rejects(apiPool.query(sql), /permission denied/);
      const capture = (await f.view(orderId)).captures[0];
      const refund = await f.repo.requestRefund({ ...f.scope, role: 'manager' }, randomUUID(), {
        orderId,
        captureId: capture.id,
        amountMinor: '100000',
        reason: 'Синтетический возврат',
        fulfillmentPolicy: 'manager_reviewed',
      });
      const workerLive = new TipTopPayCheckout(as(worker), options(f), f.now, bank.fetch);
      assert.equal((await workerLive.refunds()).sent, 1);
      assert.equal(
        (await f.pool.query('SELECT state FROM commerce_refunds WHERE id=$1', [refund.refundId]))
          .rows[0].state,
        'succeeded',
      );
      assert.equal((await workerLive.reconcile()).errors, 0);
    } finally {
      for (const pool of pools) await pool.end();
      for (const role of [api, worker]) {
        await f.admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
        await f.admin.query(`DROP ROLE ${role}`).catch(() => undefined);
      }
    }
  }, true));
