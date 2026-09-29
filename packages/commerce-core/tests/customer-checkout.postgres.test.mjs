import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import {
  CommerceError,
  CommerceRepository,
  CustomerCheckout,
  KaspiRemoteProcessor,
  customerCheckoutError,
} from '../dist/index.js';
import { publishCatalog } from './catalog-fixture.mjs';

// Disposable schemas in local PostgreSQL only; the Kaspi bridge is a scripted fake.
const connection =
  process.env.COMMERCE_TEST_DATABASE_URL ??
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55432/pickchick_cloud';
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection).hostname),
  'Commerce tests require localhost PostgreSQL',
);
const migrationDir = fileURLToPath(new URL('../../../db/cloud/migrations/', import.meta.url));

class FakeBridge {
  constructor() {
    this.calls = [];
    this.status = new Map();
    this.nextId = 900000;
    this.create = null;
  }
  async createInvoice(phone, amount, comment) {
    this.calls.push(['create', phone, amount, comment]);
    if (this.create) return this.create(phone, amount, comment);
    const id = String(this.nextId++);
    this.status.set(id, { Amount: amount, Comment: comment, Status: 'RemotePaymentCreated' });
    return { kind: 'ok', data: { QrOperationId: Number(id), Status: 'RemotePaymentCreated' } };
  }
  async details(id) {
    this.calls.push(['details', id]);
    const invoice = this.status.get(id);
    if (!invoice) return { kind: 'uncertain' };
    return { kind: 'ok', data: { QrOperationId: Number(id), ...invoice } };
  }
  async cancel(id) {
    this.calls.push(['cancel', id]);
    this.set(id, 'RemotePaymentCanceled');
    return { kind: 'ok', data: {} };
  }
  async history() {
    this.calls.push(['history']);
    return {
      kind: 'ok',
      data: {
        Items: [...this.status.entries()].map(([id, v]) => ({ QrOperationId: Number(id), ...v })),
      },
    };
  }
  set(id, status) {
    this.status.set(id, { ...this.status.get(id), Status: status });
  }
  count(kind) {
    return this.calls.filter((call) => call[0] === kind).length;
  }
}

async function fixture(run) {
  const schema = 'checkout_' + randomUUID().replaceAll('-', '');
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
      payment = randomUUID(),
      fiscal = randomUUID();
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Checkout synthetic')", [org]);
    await pool.query(
      "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES($1,$2,'Synthetic','000000000000')",
      [legal, org],
    );
    await pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,'CHECKOUT','Synthetic')",
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
        [id, org, branch, kind, provider, legal, id],
      );
    const repo = new CommerceRepository(pool);
    const scope = {
      organizationId: org,
      branchId: branch,
      principalId: randomUUID(),
      role: 'sales',
    };
    await publishCatalog({ pool, scope });
    const checkout = new CustomerCheckout(pool, repo, {
      organizationId: org,
      branchId: branch,
      fiscalAccountId: fiscal,
      paymentAccountId: payment,
      taxApprovalReference: 'Synthetic approval only',
      taxVersion: 1,
      taxCode: 'SYNTHETIC-TAX',
    });
    const phones = new Map();
    const bridge = new FakeBridge();
    let clock = Date.now();
    const worker = new KaspiRemoteProcessor(
      pool,
      {
        bridgeUrl: 'http://127.0.0.1:1',
        webhookSecret: 'x'.repeat(32),
        accountId: payment,
        invoiceTtlSeconds: 600,
        requestTimeoutMs: 1000,
        session: null,
      },
      bridge,
      async (id) => phones.get(id) ?? null,
      () => new Date(clock),
    );
    const customer = (phone = '+77011234567') => {
      const id = randomUUID();
      phones.set(id, phone);
      return id;
    };
    const cart = {
      service_mode: 'takeaway',
      items: [
        {
          sku: 'BURGER',
          quantity: 2,
          selections: [{ group_id: 'extra', option_id: 'sauce', quantity: 1 }],
        },
      ],
    };
    // The restaurant edge reserves the order, as the fulfillment transport would.
    const admit = async (orderId) => {
      const row = (
        await pool.query('SELECT quote_digest FROM commerce_orders WHERE id=$1', [orderId])
      ).rows[0];
      await repo.confirmAdmission(
        { organizationId: org, branchId: branch, deviceId: device },
        {
          eventId: randomUUID(),
          orderId,
          reservationId: randomUUID(),
          quoteDigest: row.quote_digest,
        },
      );
    };
    const due = () =>
      pool.query(
        "UPDATE commerce_kaspi_invoices SET next_check_at=clock_timestamp()-interval '1 second'",
      );
    const tick = async () => {
      await due();
      return worker.tick();
    };
    const attempts = async (orderId) =>
      (await pool.query('SELECT state FROM commerce_payment_attempts WHERE order_id=$1', [orderId]))
        .rows;
    await run({
      pool,
      checkout,
      bridge,
      customer,
      cart,
      admit,
      tick,
      attempts,
      advance: (ms) => (clock += ms),
    });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

async function ordered(f, customerId) {
  const quote = await f.checkout.quote(customerId, randomUUID(), f.cart);
  return f.checkout.createOrder(customerId, randomUUID(), { quote_id: quote.quote_id });
}

test('cart priced from the published menu, invoice to the verified phone, paid only by capture', () =>
  fixture(async (f) => {
    const me = f.customer();
    const quote = await f.checkout.quote(me, randomUUID(), f.cart);
    // 2 × (10 000 + 1 000 sauce) tiyn from the publication, not from the client.
    assert.equal(quote.total_minor, '22000');
    assert.deepEqual(quote.lines, [
      { title: 'Synthetic burger', quantity: 2, total_minor: '22000' },
    ]);

    let view = await f.checkout.createOrder(me, randomUUID(), { quote_id: quote.quote_id });
    assert.equal(view.stage, 'accepting');
    assert.equal(view.total_minor, '22000');
    // Paying before the restaurant accepted only reports that; no attempt is created.
    view = await f.checkout.pay(me, randomUUID(), view.order_id);
    assert.equal(view.stage, 'accepting');
    assert.equal((await f.attempts(view.order_id)).length, 0);

    await f.admit(view.order_id);
    assert.equal((await f.checkout.read(me, view.order_id)).stage, 'ready_to_pay');
    view = await f.checkout.pay(me, randomUUID(), view.order_id);
    assert.equal(view.stage, 'sending_invoice');
    assert.equal(view.invoice, null);

    await f.tick();
    assert.deepEqual(f.bridge.calls[0].slice(0, 3), ['create', '77011234567', 220]);
    view = await f.checkout.read(me, view.order_id);
    assert.equal(view.stage, 'invoice_sent');
    assert.ok(Date.parse(view.invoice.expires_at) > Date.now());

    // Repeating pay while an invoice is open never issues a second one.
    await f.checkout.pay(me, randomUUID(), view.order_id);
    await f.tick();
    assert.equal(f.bridge.count('create'), 1);
    assert.equal((await f.attempts(view.order_id)).length, 1);

    f.bridge.set('900000', 'Processed');
    await f.tick();
    view = await f.checkout.read(me, view.order_id);
    assert.equal(view.stage, 'paid');
    assert.equal(view.can_retry, false);
    // Kitchen admission still waits for the fiscal receipt (separate adapter).
    assert.equal(view.kitchen_queued, false);
  }));

test('expired or rejected invoice allows exactly one new invoice per new request key', () =>
  fixture(async (f) => {
    const me = f.customer();
    let view = await ordered(f, me);
    await f.admit(view.order_id);
    const firstKey = randomUUID();
    await f.checkout.pay(me, firstKey, view.order_id);
    await f.tick();
    f.bridge.set('900000', 'Expired');
    await f.tick();
    view = await f.checkout.read(me, view.order_id);
    assert.equal(view.stage, 'invoice_closed');
    assert.equal(view.invoice.closed_reason, 'expired');
    assert.equal(view.can_retry, true);

    // Replaying the old request is idempotent and creates nothing.
    view = await f.checkout.pay(me, firstKey, view.order_id);
    assert.equal(view.stage, 'invoice_closed');
    assert.equal((await f.attempts(view.order_id)).length, 1);

    view = await f.checkout.pay(me, randomUUID(), view.order_id);
    assert.equal(view.stage, 'sending_invoice');
    await f.tick();
    assert.equal(f.bridge.count('create'), 2);
    f.bridge.set('900001', 'RemotePaymentRejected');
    await f.tick();
    view = await f.checkout.read(me, view.order_id);
    assert.equal(view.invoice.closed_reason, 'rejected');
  }));

test('an unconfirmed result never leads to another invoice', () =>
  fixture(async (f) => {
    const me = f.customer();
    let view = await ordered(f, me);
    await f.admit(view.order_id);
    f.bridge.create = () => ({ kind: 'uncertain' });
    await f.checkout.pay(me, randomUUID(), view.order_id);
    await f.tick();
    view = await f.checkout.read(me, view.order_id);
    assert.equal(view.stage, 'checking');
    // After the recovery window the invoice is not in history: unknown, manual resolution.
    await f.pool.query(
      "UPDATE commerce_kaspi_invoices SET issue_started_at=issue_started_at-interval '10 minutes'",
    );
    await f.tick();
    await f.tick();
    view = await f.checkout.read(me, view.order_id);
    assert.equal(view.stage, 'unconfirmed');
    assert.equal(view.can_retry, false);
    view = await f.checkout.pay(me, randomUUID(), view.order_id);
    assert.equal(view.stage, 'unconfirmed');
    assert.equal((await f.attempts(view.order_id)).length, 1);
  }));

test('orders are private to their customer and carts are validated by the menu', () =>
  fixture(async (f) => {
    const me = f.customer(),
      other = f.customer('+77019876543');
    const view = await ordered(f, me);
    await assert.rejects(f.checkout.read(other, view.order_id), (error) => {
      assert.ok(error instanceof CommerceError);
      assert.deepEqual(customerCheckoutError(error), { status: 404, code: 'NOT_FOUND' });
      return true;
    });
    await assert.rejects(f.checkout.pay(other, randomUUID(), view.order_id), CommerceError);
    await assert.rejects(
      f.checkout.quote(me, randomUUID(), {
        service_mode: 'takeaway',
        items: [{ sku: 'NOT-ON-MENU', quantity: 1, selections: [] }],
      }),
      (error) => {
        assert.ok(customerCheckoutError(error));
        assert.equal(customerCheckoutError(error).status, 409);
        return true;
      },
    );
    await assert.rejects(
      f.checkout.quote(me, randomUUID(), { ...f.cart, total_minor: '1' }),
      (error) => customerCheckoutError(error)?.code === 'INVALID_REQUEST',
    );
    // The same idempotency key with a different cart is a conflict, not a new quote.
    const key = randomUUID();
    await f.checkout.quote(me, key, f.cart);
    await assert.rejects(
      f.checkout.quote(me, key, { ...f.cart, service_mode: 'dine_in' }),
      (error) => customerCheckoutError(error)?.code === 'CONFLICT',
    );
  }));
