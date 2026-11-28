import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac, randomUUID } from 'node:crypto';
import { URLSearchParams, fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { orderRecipeGrants } from '../../../infra/staging/backoffice-grants.mjs';
import { fixtureMenu } from '@pickchick/test-fixtures';
import {
  CommerceRepository,
  CustomerCheckout,
  TipTopPayCheckout,
  TipTopPayReceiver,
  customerCheckoutOptions,
  digest,
} from '../dist/index.js';
import * as core from '../dist/index.js';

// One open TipTopPay payment per guest (owner, 28.11.2026): while a payment of order A is "in
// review" (answer lost / 3-D Secure / reconciling) the same guest gets no new order and no new
// charge for another order for 25 minutes. Disposable schemas in local PostgreSQL; the bank is a fake.
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

async function fixture(run) {
  const schema = 'ooo_' + randomUUID().replaceAll('-', '');
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
      kaspi = randomUUID(),
      tiptoppay = randomUUID();
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Synthetic')", [org]);
    await pool.query(
      "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES($1,$2,'Synthetic','000000000000')",
      [legal, org],
    );
    await pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name,ordering_enabled) VALUES($1,$2,$3,'OOO','Synthetic',true)",
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
    for (const [id, provider] of [
      [kaspi, 'kaspi-remote'],
      [tiptoppay, 'tiptoppay'],
    ])
      await pool.query(
        "INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,kind,provider,external_reference,enabled,legal_entity_id) VALUES($1,$2,$3,'payment',$4,$5,true,$6)",
        [id, org, branch, provider, id === tiptoppay ? PUBLIC_ID : id, legal],
      );
    await pool.query(
      'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
      [branch, org, device, randomUUID()],
    );
    await pool.query(
      "INSERT INTO cloud_branch_availability(branch_id,device_id,revision,stopped_ids) VALUES($1,$2,1,'{}')",
      [branch, device],
    );
    const edge = { organizationId: org, branchId: branch, deviceId: device };
    const base = { organizationId: org, branchId: branch, role: 'sales' };
    const scopeOf = (customerId) => ({ ...base, principalId: customerId });
    let number = 0;
    const repo = new CommerceRepository(pool, {
      organizationId: org,
      branchId: branch,
      approvalReference: 'Synthetic approval',
    });
    // TipTopPay is configured on this server unless the test says otherwise (Kaspi-only server).
    const checkoutFor = (customerIds, extra = {}, runtime = pool) =>
      new CustomerCheckout(runtime, {
        tipTopPayAccountId: tiptoppay,
        organizationId: org,
        branchId: branch,
        paymentAccountId: kaspi,
        customerIds,
        maxOrderMinor: '1000000',
        repeatOrdersEnabled: true,
        approvalReference: 'Synthetic approval',
        ...extra,
      });
    /** A fresh mobile quote of the customer (the same price every time). */
    const quote = async (customerId) => {
      await pool.query(
        'UPDATE cloud_branch_availability SET observed_at=clock_timestamp() WHERE branch_id=$1',
        [branch],
      );
      return repo.issueQuote(scopeOf(customerId), randomUUID(), {
        releaseId: release,
        customerId,
        channel: 'mobile',
        serviceMode: 'takeaway',
        currency: 'KZT',
        ttlSeconds: 600,
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
    };
    /** Server order of the customer through CustomerCheckout.create, admitted by the restaurant. */
    const place = async (checkout, customerId) => {
      const q = await quote(customerId);
      const key = randomUUID();
      const created = await checkout.create(customerId, { key, quoteId: q.quoteId });
      const orderId = created.orderId ?? created.id;
      const reservationId = randomUUID();
      await repo.confirmAdmission(edge, {
        eventId: randomUUID(),
        orderId,
        reservationId,
        quoteDigest: q.digest,
      });
      await pool.query(
        `INSERT INTO cloud_fulfillment_projection(order_id,branch_id,organization_id,device_id,reservation_id,quote_id,quote_hash,owner_hash,version,state,display_number,routing_version,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$7,1,'held',$8,1,'{}')`,
        [orderId, branch, org, device, reservationId, q.quoteId, q.digest, String(++number)],
      );
      return { orderId, quoteId: q.quoteId, key };
    };
    await run({
      pool,
      url,
      admin,
      schema,
      edge,
      org,
      branch,
      tiptoppay,
      kaspi,
      checkoutFor,
      quote,
      place,
      orderCount: async (customerId) =>
        (
          await pool.query('SELECT count(*)::int n FROM commerce_orders WHERE principal_id=$1', [
            customerId,
          ])
        ).rows[0].n,
      /** Time passes: the open attempts were sent this many minutes earlier (database clock). */
      ageAttempts: async (minutes) => {
        await pool.query(
          "UPDATE commerce_tiptoppay_sessions SET opened_at=opened_at-$1*interval '1 minute'",
          [minutes],
        );
      },
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
    bank.calls.push({ path, body });
    const handler = bank.handlers[path];
    if (!handler) throw new Error('unexpected ' + path);
    return new Response(JSON.stringify(await handler(body)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return bank;
}
const live = (f, bank, runtime = f.pool) =>
  new TipTopPayCheckout(
    runtime,
    {
      accountId: f.tiptoppay,
      publicId: PUBLIC_ID,
      apiSecret: SECRET,
      origin: 'https://api.example.test',
      methods: ['card', 'apple_pay'],
    },
    () => Date.now(),
    bank.fetch,
  );
const completed = (body, extra = {}) => ({
  Success: true,
  Message: null,
  Model: {
    TransactionId: 9200001,
    Status: 'Completed',
    InvoiceId: body.InvoiceId,
    Amount: body.Amount,
    TestMode: false,
    ...extra,
  },
});
const CARD = { method: 'card', cryptogram: 'c'.repeat(40) };
/** The charge of order A: the bank answer is lost, so the attempt is unknown. */
async function lostAnswer(f, checkout, bank, customerId, orderId) {
  bank.handlers['/payments/cards/charge'] = () => {
    throw new Error('socket hang up');
  };
  const attempt = await checkout.startTipTopPayAttempt(customerId, orderId, f.tiptoppay);
  await live(f, bank).charge(attempt, CARD, '1.1.1.1');
  const state = (
    await f.pool.query('SELECT state FROM commerce_payment_attempts WHERE id=$1', [
      attempt.attemptId,
    ])
  ).rows[0].state;
  assert.equal(state, 'unknown');
  return attempt;
}
const tryNewOrder = (f, checkout, customerId) =>
  f
    .quote(customerId)
    .then((q) => checkout.create(customerId, { key: randomUUID(), quoteId: q.quoteId }));

test('the window defaults to 25 minutes and is configured like the unpaid TTL', () => {
  assert.equal(core.OPEN_TIPTOPPAY_PAYMENT_WINDOW_MINUTES, 25);
  const env = {
    CUSTOMER_KASPI_PILOT_ENABLED: 'true',
    CUSTOMER_KASPI_ORGANIZATION_ID: randomUUID(),
    CUSTOMER_KASPI_BRANCH_ID: randomUUID(),
    KASPI_REMOTE_ACCOUNT_ID: randomUUID(),
    CUSTOMER_KASPI_PILOT_CUSTOMER_IDS: randomUUID(),
    CUSTOMER_KASPI_FISCAL_DEFERRAL_REFERENCE: 'Synthetic approval',
  };
  assert.equal(customerCheckoutOptions(env).openTipTopPayWindowMinutes, 25);
  // The rule reads TipTopPay tables, so it exists only where live TipTopPay is configured.
  assert.equal(customerCheckoutOptions(env).tipTopPayAccountId, undefined);
  const account = randomUUID();
  assert.equal(
    customerCheckoutOptions({
      ...env,
      TIPTOPPAY_CHECKOUT_ENABLED: 'true',
      TIPTOPPAY_ACCOUNT_ID: account,
    }).tipTopPayAccountId,
    account,
  );
  assert.equal(
    customerCheckoutOptions({ ...env, TIPTOPPAY_CHECKOUT_ENABLED: 'false' }).tipTopPayAccountId,
    undefined,
  );
  for (const [value, expected] of [
    ['', 25],
    ['0', 0],
    ['5', 5],
    ['1440', 1440],
  ])
    assert.equal(
      customerCheckoutOptions({ ...env, CUSTOMER_TIPTOPPAY_OPEN_PAYMENT_WINDOW_MINUTES: value })
        .openTipTopPayWindowMinutes,
      expected,
    );
  for (const broken of ['abc', '-1', '1.5', '1441', '99999'])
    assert.throws(() =>
      customerCheckoutOptions({ ...env, CUSTOMER_TIPTOPPAY_OPEN_PAYMENT_WINDOW_MINUTES: broken }),
    );
});

test('a lost bank answer on order A: a new order of the same guest is refused (CONFLICT)', () =>
  fixture(async (f) => {
    const customer = randomUUID();
    const checkout = f.checkoutFor([customer]);
    const bank = fakeBank();
    const a = await f.place(checkout, customer);
    await lostAnswer(f, checkout, bank, customer, a.orderId);
    await assert.rejects(tryNewOrder(f, checkout, customer), (error) => error.code === 'CONFLICT');
    assert.equal(await f.orderCount(customer), 1);
  }));

test('create again on the quote of order A still returns A (idempotent)', () =>
  fixture(async (f) => {
    const customer = randomUUID();
    const checkout = f.checkoutFor([customer]);
    const bank = fakeBank();
    const a = await f.place(checkout, customer);
    await lostAnswer(f, checkout, bank, customer, a.orderId);
    const again = await checkout.create(customer, { key: a.key, quoteId: a.quoteId });
    assert.equal(again.orderId ?? again.id, a.orderId);
    assert.equal(await f.orderCount(customer), 1);
  }));

test('after 25 minutes a new order is allowed again', () =>
  fixture(async (f) => {
    const customer = randomUUID();
    const checkout = f.checkoutFor([customer]);
    const bank = fakeBank();
    const a = await f.place(checkout, customer);
    await lostAnswer(f, checkout, bank, customer, a.orderId);
    await f.ageAttempts(24);
    await assert.rejects(tryNewOrder(f, checkout, customer), (error) => error.code === 'CONFLICT');
    await f.ageAttempts(2);
    const next = await tryNewOrder(f, checkout, customer);
    assert.notEqual(next.orderId ?? next.id, a.orderId);
    assert.equal(await f.orderCount(customer), 2);
  }));

test('an order that needs a manager (attention_required) does not block', () =>
  fixture(async (f) => {
    const customer = randomUUID();
    const checkout = f.checkoutFor([customer]);
    const bank = fakeBank();
    const a = await f.place(checkout, customer);
    await lostAnswer(f, checkout, bank, customer, a.orderId);
    await assert.rejects(tryNewOrder(f, checkout, customer), (error) => error.code === 'CONFLICT');
    await f.pool.query('UPDATE commerce_orders SET attention_required=true WHERE id=$1', [
      a.orderId,
    ]);
    await tryNewOrder(f, checkout, customer);
    assert.equal(await f.orderCount(customer), 2);
  }));

test('an attempt never sent to the bank does not block (nothing can be charged yet)', () =>
  fixture(async (f) => {
    const customer = randomUUID();
    const checkout = f.checkoutFor([customer]);
    const a = await f.place(checkout, customer);
    const attempt = await checkout.startTipTopPayAttempt(customer, a.orderId, f.tiptoppay);
    assert.ok(attempt);
    await tryNewOrder(f, checkout, customer);
    assert.equal(await f.orderCount(customer), 2);
  }));

test('an unfinished Kaspi payment of order A does not block (the rule is TipTopPay only)', () =>
  fixture(async (f) => {
    const customer = randomUUID();
    const checkout = f.checkoutFor([customer]);
    const a = await f.place(checkout, customer);
    await checkout.pay(customer, a.orderId);
    const kaspi = await f.pool.query(
      "SELECT state FROM commerce_payment_attempts WHERE order_id=$1 AND account_id=$2 AND state IN ('pending','unknown')",
      [a.orderId, f.kaspi],
    );
    assert.equal(kaspi.rowCount, 1);
    const b = await tryNewOrder(f, checkout, customer);
    assert.notEqual(b.orderId ?? b.id, a.orderId);
    assert.equal(await f.orderCount(customer), 2);
  }));

test('TipTopPay attempt and Kaspi invoice for order B are refused while A is in review', () =>
  fixture(async (f) => {
    const customer = randomUUID();
    const checkout = f.checkoutFor([customer]);
    const bank = fakeBank();
    const a = await f.place(checkout, customer);
    const b = await f.place(checkout, customer);
    const attemptA = await lostAnswer(f, checkout, bank, customer, a.orderId);
    await assert.rejects(
      checkout.startTipTopPayAttempt(customer, b.orderId, f.tiptoppay),
      (error) => error.code === 'CONFLICT',
    );
    await assert.rejects(checkout.pay(customer, b.orderId), (error) => error.code === 'CONFLICT');
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM commerce_payment_attempts WHERE order_id=$1',
          [b.orderId],
        )
      ).rows[0].n,
      0,
    );
    // The same order A takes its own path: its attempt is already sent, nothing to charge again.
    assert.equal(await checkout.startTipTopPayAttempt(customer, a.orderId, f.tiptoppay), null);
    // A is paid by reconciliation: B may be paid now.
    bank.handlers['/payments/find'] = () =>
      completed({ InvoiceId: attemptA.attemptId, Amount: 1000 }, { TransactionId: 9200002 });
    await f.pool.query('UPDATE commerce_tiptoppay_sessions SET next_check_at=NULL');
    assert.equal((await live(f, bank).reconcile()).settled, 1);
    assert.ok(await checkout.startTipTopPayAttempt(customer, b.orderId, f.tiptoppay));
  }));

test('a declined payment of A frees order B for TipTopPay and Kaspi', () =>
  fixture(async (f) => {
    const customer = randomUUID();
    const checkout = f.checkoutFor([customer]);
    const bank = fakeBank();
    const a = await f.place(checkout, customer);
    const b = await f.place(checkout, customer);
    const c = await f.place(checkout, customer);
    bank.handlers['/payments/cards/charge'] = (body) => ({
      Success: false,
      Message: null,
      Model: {
        TransactionId: 9200003,
        Status: 'Declined',
        ReasonCode: 5051,
        CardHolderMessage: 'Недостаточно средств на карте',
        InvoiceId: body.InvoiceId,
        TestMode: false,
      },
    });
    const attempt = await checkout.startTipTopPayAttempt(customer, a.orderId, f.tiptoppay);
    await live(f, bank).charge(attempt, CARD, '1.1.1.1');
    assert.ok(await checkout.startTipTopPayAttempt(customer, b.orderId, f.tiptoppay));
    // B is now "unsent pending" (not blocking); a Kaspi invoice for C is free too.
    await checkout.pay(customer, c.orderId);
  }));

test('another guest on the same branch is not affected', () =>
  fixture(async (f) => {
    const [one, two] = [randomUUID(), randomUUID()];
    const checkout = f.checkoutFor([one, two]);
    const bank = fakeBank();
    const a = await f.place(checkout, one);
    const b = await f.place(checkout, two);
    await lostAnswer(f, checkout, bank, one, a.orderId);
    await assert.rejects(tryNewOrder(f, checkout, one), (error) => error.code === 'CONFLICT');
    await tryNewOrder(f, checkout, two);
    assert.ok(await checkout.startTipTopPayAttempt(two, b.orderId, f.tiptoppay));
    assert.equal(await f.orderCount(two), 2);
  }));

test('window 0 turns the rule off', () =>
  fixture(async (f) => {
    const customer = randomUUID();
    const checkout = f.checkoutFor([customer], { openTipTopPayWindowMinutes: 0 });
    const bank = fakeBank();
    const a = await f.place(checkout, customer);
    const b = await f.place(checkout, customer);
    await lostAnswer(f, checkout, bank, customer, a.orderId);
    await tryNewOrder(f, checkout, customer);
    assert.ok(await checkout.startTipTopPayAttempt(customer, b.orderId, f.tiptoppay));
    assert.equal(await f.orderCount(customer), 3);
  }));

/** A runtime pool under a login-less role holding exactly the given grant statements. */
async function restricted(f, grants) {
  const role = 'ooo_' + randomUUID().replaceAll('-', '');
  await f.admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  await f.pool.query(`GRANT USAGE ON SCHEMA ${f.schema} TO ${role}`);
  for (const sql of grants(role)) await f.pool.query(sql);
  const url = new URL(f.url);
  url.searchParams.set('options', `-c search_path=${f.schema} -c role=${role}`);
  return createPool(url.toString(), 4);
}
async function serverGrants(withTipTopPay) {
  const { customerCheckoutGrants } = await import('../../../infra/staging/checkout-grants.mjs');
  const { fulfillmentTransportGrants } =
    await import('../../../infra/staging/fulfillment-transport-grants.mjs');
  const { tipTopPayApiGrants } = await import('../../../infra/staging/tiptoppay-live-grants.mjs');
  return (role) => [
    fulfillmentTransportGrants(role, true),
    orderRecipeGrants(role),
    customerCheckoutGrants(role, true),
    ...(withTipTopPay ? [tipTopPayApiGrants(role, true)] : []),
  ];
}

test('restricted role, TipTopPay not configured (Kaspi only): create and pay still work', () =>
  fixture(async (f) => {
    const customer = randomUUID();
    const runtime = await restricted(f, await serverGrants(false));
    try {
      // The server role of a Kaspi-only environment cannot read the TipTopPay tables at all.
      await assert.rejects(
        runtime.query('SELECT 1 FROM commerce_tiptoppay_sessions'),
        /permission denied/,
      );
      const checkout = f.checkoutFor([customer], { tipTopPayAccountId: undefined }, runtime);
      const a = await f.place(checkout, customer);
      const b = await f.place(checkout, customer);
      await checkout.pay(customer, a.orderId);
      assert.equal(await f.orderCount(customer), 2);
      assert.ok(b.orderId);
    } finally {
      await runtime.end();
    }
  }));

test('restricted role with the TipTopPay API grants: the rule works and the rights suffice', () =>
  fixture(async (f) => {
    const customer = randomUUID();
    const runtime = await restricted(f, await serverGrants(true));
    try {
      const checkout = f.checkoutFor([customer], {}, runtime);
      const bank = fakeBank();
      const a = await f.place(checkout, customer);
      const b = await f.place(checkout, customer);
      bank.handlers['/payments/cards/charge'] = () => {
        throw new Error('socket hang up');
      };
      const attempt = await checkout.startTipTopPayAttempt(customer, a.orderId, f.tiptoppay);
      await live(f, bank, runtime).charge(attempt, CARD, '1.1.1.1');
      await assert.rejects(
        tryNewOrder(f, checkout, customer),
        (error) => error.code === 'CONFLICT',
      );
      await assert.rejects(
        checkout.startTipTopPayAttempt(customer, b.orderId, f.tiptoppay),
        (error) => error.code === 'CONFLICT',
      );
      await assert.rejects(checkout.pay(customer, b.orderId), (error) => error.code === 'CONFLICT');
    } finally {
      await runtime.end();
    }
  }));

test('an attempt of B started before A went into review cannot be sent to the bank', () =>
  fixture(async (f) => {
    const customer = randomUUID();
    const checkout = f.checkoutFor([customer]);
    const bank = fakeBank();
    const a = await f.place(checkout, customer);
    const b = await f.place(checkout, customer);
    // Two devices: both attempts exist, neither was sent yet.
    const attemptA = await checkout.startTipTopPayAttempt(customer, a.orderId, f.tiptoppay);
    const attemptB = await checkout.startTipTopPayAttempt(customer, b.orderId, f.tiptoppay);
    bank.handlers['/payments/cards/charge'] = () => {
      throw new Error('socket hang up');
    };
    await live(f, bank).charge(attemptA, CARD, '1.1.1.1');
    await assert.rejects(
      live(f, bank).charge(attemptB, CARD, '1.1.1.1'),
      (error) => error.code === 'CONFLICT',
    );
    assert.equal(bank.calls.filter((c) => c.path === '/payments/cards/charge').length, 1);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM commerce_tiptoppay_sessions WHERE order_id=$1',
          [b.orderId],
        )
      ).rows[0].n,
      0,
    );
    // A repeat for the same order A is not blocked by its own payment.
    assert.equal(await checkout.startTipTopPayAttempt(customer, a.orderId, f.tiptoppay), null);
    assert.deepEqual(await live(f, bank).charge(attemptA, CARD, '1.1.1.1'), {});
    assert.equal(bank.calls.filter((c) => c.path === '/payments/cards/charge').length, 1);
  }));

test('two simultaneous sends of one guest: exactly one reaches the bank', () =>
  fixture(async (f) => {
    const customer = randomUUID();
    const checkout = f.checkoutFor([customer]);
    const bank = fakeBank();
    const a = await f.place(checkout, customer);
    const b = await f.place(checkout, customer);
    const attemptA = await checkout.startTipTopPayAttempt(customer, a.orderId, f.tiptoppay);
    const attemptB = await checkout.startTipTopPayAttempt(customer, b.orderId, f.tiptoppay);
    bank.handlers['/payments/cards/charge'] = async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      throw new Error('socket hang up');
    };
    const results = await Promise.allSettled([
      live(f, bank).charge(attemptA, CARD, '1.1.1.1'),
      live(f, bank).charge(attemptB, CARD, '1.1.1.1'),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const refused = results.find((r) => r.status === 'rejected');
    assert.equal(refused.reason.code, 'CONFLICT');
    assert.equal(bank.calls.filter((c) => c.path === '/payments/cards/charge').length, 1);
  }));

test('3-D Secure waiting on order A blocks a new order', () =>
  fixture(async (f) => {
    const customer = randomUUID();
    const checkout = f.checkoutFor([customer]);
    const bank = fakeBank();
    const a = await f.place(checkout, customer);
    bank.handlers['/payments/cards/charge'] = (body) => ({
      Success: false,
      Message: null,
      Model: {
        TransactionId: 9200010,
        AcsUrl: 'https://acs.bank.test/3ds',
        PaReq: 'pareq-synthetic',
        InvoiceId: body.InvoiceId,
        TestMode: false,
      },
    });
    const attempt = await checkout.startTipTopPayAttempt(customer, a.orderId, f.tiptoppay);
    const hint = await live(f, bank).charge(attempt, CARD, '1.1.1.1');
    assert.ok(hint.threeDsUrl);
    const state = (
      await f.pool.query('SELECT state FROM commerce_payment_attempts WHERE id=$1', [
        attempt.attemptId,
      ])
    ).rows[0].state;
    assert.equal(state, 'pending');
    await assert.rejects(tryNewOrder(f, checkout, customer), (error) => error.code === 'CONFLICT');
  }));

test('a Pay notification that arrives after the attempt failed is not seen by the rule', () =>
  fixture(async (f) => {
    const customer = randomUUID();
    const checkout = f.checkoutFor([customer]);
    const bank = fakeBank();
    const a = await f.place(checkout, customer);
    bank.handlers['/payments/cards/charge'] = (body) => ({
      Success: false,
      Message: null,
      Model: {
        TransactionId: 9200011,
        Status: 'Declined',
        ReasonCode: 5051,
        CardHolderMessage: 'Недостаточно средств на карте',
        InvoiceId: body.InvoiceId,
        TestMode: false,
      },
    });
    const attempt = await checkout.startTipTopPayAttempt(customer, a.orderId, f.tiptoppay);
    await live(f, bank).charge(attempt, CARD, '1.1.1.1');
    // The attempt is failed: the rule frees the guest, who may open and pay order B.
    const b = await tryNewOrder(f, checkout, customer);
    assert.equal(await f.orderCount(customer), 2);
    const form = Buffer.from(
      new URLSearchParams({
        TransactionId: '9200011',
        Amount: '1000.00',
        Currency: 'KZT',
        DateTime: new Date().toISOString().slice(0, 19).replace('T', ' '),
        InvoiceId: attempt.attemptId,
        AccountId: customer,
        OperationType: 'Payment',
        Status: 'Completed',
        TestMode: '0',
      }).toString(),
    );
    const signature = createHmac('sha256', SECRET).update(form).digest('base64');
    const answer = await new TipTopPayReceiver(f.pool, {
      publicId: PUBLIC_ID,
      apiSecret: SECRET,
      accountId: f.tiptoppay,
      acceptNewPayments: true,
    }).receive('pay', form, signature);
    const after = (
      await f.pool.query(
        'SELECT (SELECT state FROM commerce_payment_attempts WHERE id=$1) state,(SELECT count(*)::int FROM commerce_captures WHERE order_id=$2) captures',
        [attempt.attemptId, a.orderId],
      )
    ).rows[0];
    // Current behaviour, deliberately recorded (residual risk, not fixed here): the bank's late
    // Pay still settles the failed attempt and pays order A, although the guest may now pay B.
    assert.deepEqual(answer, { code: 0 });
    assert.deepEqual(after, { state: 'succeeded', captures: 1 });
    assert.ok(b.orderId ?? b.id);
  }));
