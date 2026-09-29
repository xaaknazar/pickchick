import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { fixtureMenu } from '@pickchick/test-fixtures';
import {
  CommerceRepository,
  KaspiRemoteProcessor,
  digest,
  hintKaspiInvoice,
} from '../dist/index.js';

// Disposable schemas in local PostgreSQL only; the bridge is a scripted fake.
const connection =
  process.env.COMMERCE_TEST_DATABASE_URL ??
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55432/pickchick_cloud';
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection).hostname),
  'Commerce tests require localhost PostgreSQL',
);
const migrationDir = fileURLToPath(new URL('../../../db/cloud/migrations/', import.meta.url));

/** Scripted stand-in for the local bridge. Records every call. */
class FakeBridge {
  constructor() {
    this.calls = [];
    this.invoices = new Map();
    this.nextId = 700000;
    this.create = null; // optional override: (phone, amount, comment) => BridgeResult
    this.status = new Map();
  }
  async createInvoice(phone, amount, comment) {
    this.calls.push(['create', phone, amount, comment]);
    if (this.create) return this.create(phone, amount, comment);
    return this.issue(amount, comment);
  }
  issue(amount, comment) {
    const id = String(this.nextId++);
    this.invoices.set(id, { QrOperationId: Number(id), Amount: amount, Comment: comment });
    this.status.set(id, 'RemotePaymentCreated');
    return { kind: 'ok', data: { QrOperationId: Number(id), Status: 'RemotePaymentCreated' } };
  }
  async details(id) {
    this.calls.push(['details', id]);
    if (!this.invoices.has(id)) return { kind: 'uncertain' };
    const status = this.status.get(id);
    if (typeof status === 'object') return status;
    return { kind: 'ok', data: { ...this.invoices.get(id), Status: status } };
  }
  async cancel(id) {
    this.calls.push(['cancel', id]);
    if (this.cancelAnswer) return this.cancelAnswer;
    this.status.set(id, 'RemotePaymentCanceled');
    return { kind: 'ok', data: {} };
  }
  async history(maxResult) {
    this.calls.push(['history', maxResult]);
    return { kind: 'ok', data: { Items: [...this.invoices.values()] } };
  }
  count(kind) {
    return this.calls.filter((c) => c[0] === kind).length;
  }
}

async function fixture(run) {
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
      fiscal = randomUUID();
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Kaspi synthetic')", [org]);
    await pool.query(
      "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES($1,$2,'Synthetic','000000000000')",
      [legal, org],
    );
    await pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,'KASPI','Synthetic')",
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
    ])
      await pool.query(
        'INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,kind,provider,external_reference,enabled,legal_entity_id) VALUES($1,$2,$3,$4,$5,$7,true,$6)',
        [id, org, branch, kind, provider, legal, id],
      );
    const scope = {
      organizationId: org,
      branchId: branch,
      principalId: randomUUID(),
      role: 'sales',
    };
    const edge = { organizationId: org, branchId: branch, deviceId: device };
    const repo = new CommerceRepository(pool);
    const phones = new Map();
    let clock = Date.now();
    const bridge = new FakeBridge();
    const config = {
      bridgeUrl: 'http://127.0.0.1:1',
      webhookSecret: 'x'.repeat(32),
      accountId: payment,
      invoiceTtlSeconds: 600,
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
    async function order({ unitPriceMinor = '50000', phone = '+77011234567' } = {}) {
      const customerId = randomUUID();
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
            productId: 'synthetic-burger',
            title: 'Synthetic burger',
            quantity: 2,
            unitPriceMinor,
            discountMinor: '0',
            taxCode: 'TEST',
          },
        ],
      });
      const created = await repo.createOrder(scope, randomUUID(), {
        quoteId: quote.quoteId,
        fiscalAccountId: fiscal,
      });
      await repo.confirmAdmission(edge, {
        eventId: randomUUID(),
        orderId: created.orderId,
        reservationId: randomUUID(),
        quoteDigest: quote.digest,
      });
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
    const age = (seconds) =>
      pool.query(
        `UPDATE commerce_kaspi_invoices SET issue_started_at=issue_started_at-$1*interval '1 second',
         next_check_at=clock_timestamp()-interval '1 second'`,
        [seconds],
      );
    await run({
      pool,
      repo,
      scope,
      payment,
      bridge,
      processor,
      order,
      view,
      invoice,
      due,
      age,
      advance: (ms) => (clock += ms),
    });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

test('invoice to the customer phone, Processed status records exactly one capture', () =>
  fixture(async (f) => {
    const { orderId, attempt } = await f.order();
    const worker = f.processor();
    const first = await worker.tick();
    assert.equal(first.submitted, 1);
    assert.deepEqual(f.bridge.calls[0], ['create', '77011234567', 1000, f.bridge.calls[0][3]]);
    assert.match(f.bridge.calls[0][3], /^PickChick [A-Z0-9]{10}$/);
    const issued = await f.invoice(attempt.attemptId);
    assert.equal(issued.state, 'issued');
    assert.equal(issued.operation_id, '700000');
    assert.equal((await f.view(orderId)).attempts[0].state, 'pending');
    const acked = await f.pool.query(
      "SELECT acknowledged_at FROM commerce_outbox WHERE event_type='payment.submit_requested'",
    );
    assert.ok(acked.rows[0].acknowledged_at);

    await f.due();
    await worker.tick();
    assert.equal((await f.invoice(attempt.attemptId)).state, 'issued');
    f.bridge.status.set('700000', 'Processed');
    await f.due();
    await worker.tick();
    const paid = await f.invoice(attempt.attemptId);
    assert.equal(paid.state, 'paid');
    assert.equal(paid.paid_minor, '100000');
    let order = await f.view(orderId);
    assert.equal(order.attempts[0].state, 'succeeded');
    assert.equal(order.captures.length, 1);
    assert.equal(order.captures[0].amount_minor, '100000');
    // Replays after success change nothing and do not issue again.
    await f.due();
    await worker.tick();
    await f.processor().tick();
    order = await f.view(orderId);
    assert.equal(order.captures.length, 1);
    assert.equal(f.bridge.count('create'), 1);
  }));

test('customer rejection and Kaspi expiry fail the attempt without capture', () =>
  fixture(async (f) => {
    const a = await f.order();
    const b = await f.order();
    const worker = f.processor();
    await worker.tick();
    const [ia, ib] = [await f.invoice(a.attempt.attemptId), await f.invoice(b.attempt.attemptId)];
    f.bridge.status.set(ia.operation_id, 'RemotePaymentRejected');
    f.bridge.status.set(ib.operation_id, 'Expired');
    await f.due();
    await worker.tick();
    for (const value of [a, b]) {
      assert.equal((await f.invoice(value.attempt.attemptId)).state, 'failed');
      const order = await f.view(value.orderId);
      assert.equal(order.attempts[0].state, 'failed');
      assert.equal(order.captures.length, 0);
    }
  }));

test('unfamiliar statuses keep waiting; after the TTL the invoice is cancelled once', () =>
  fixture(async (f) => {
    const { orderId, attempt } = await f.order();
    const worker = f.processor();
    await worker.tick();
    const id = (await f.invoice(attempt.attemptId)).operation_id;
    f.bridge.status.set(id, 'SomethingNew');
    await f.due();
    await worker.tick();
    assert.equal((await f.invoice(attempt.attemptId)).state, 'issued');
    assert.equal((await f.view(orderId)).attempts[0].state, 'pending');
    f.advance(601_000);
    await f.due();
    await worker.tick();
    await f.due();
    f.bridge.status.set(id, 'SomethingNew');
    await worker.tick();
    assert.equal(f.bridge.count('cancel'), 1);
    f.bridge.status.set(id, 'RemotePaymentCanceled');
    await f.due();
    await worker.tick();
    assert.equal((await f.invoice(attempt.attemptId)).state, 'failed');
    assert.equal((await f.view(orderId)).attempts[0].state, 'failed');
  }));

test('a payment racing the cancellation is still captured', () =>
  fixture(async (f) => {
    const { orderId, attempt } = await f.order();
    const worker = f.processor();
    await worker.tick();
    const id = (await f.invoice(attempt.attemptId)).operation_id;
    f.advance(601_000);
    await f.due();
    await worker.tick();
    assert.equal(f.bridge.count('cancel'), 1);
    f.bridge.status.set(id, 'Processed');
    await f.due();
    await worker.tick();
    assert.equal((await f.view(orderId)).captures.length, 1);
  }));

test('uncertain create becomes unknown, then the invoice is adopted from history by reference', () =>
  fixture(async (f) => {
    const { orderId, attempt } = await f.order();
    f.bridge.create = (phone, amount, comment) => {
      f.bridge.issue(amount, comment); // Kaspi created it, the answer was lost.
      return { kind: 'uncertain' };
    };
    const worker = f.processor();
    await worker.tick();
    assert.equal((await f.invoice(attempt.attemptId)).state, 'unknown');
    assert.equal((await f.view(orderId)).attempts[0].state, 'unknown');
    f.bridge.create = null;
    await f.due();
    await worker.tick();
    const adopted = await f.invoice(attempt.attemptId);
    assert.equal(adopted.state, 'issued');
    assert.equal(adopted.operation_id, '700000');
    f.bridge.status.set('700000', 'Processed');
    await f.due();
    await worker.tick();
    const order = await f.view(orderId);
    assert.equal(order.captures.length, 1);
    assert.equal(f.bridge.count('create'), 1);
  }));

test('a worker crash after the request left is recovered without a second invoice', () =>
  fixture(async (f) => {
    const { orderId, attempt } = await f.order();
    f.bridge.create = (phone, amount, comment) => {
      f.bridge.issue(amount, comment);
      throw new Error('process died before storing the answer');
    };
    assert.equal((await f.processor().tick()).errors, 1);
    const stuck = await f.invoice(attempt.attemptId);
    assert.equal(stuck.state, 'issuing');
    f.bridge.create = null;
    // The event lease expires; the replacement worker must not issue again.
    await f.pool.query(
      "UPDATE commerce_outbox SET lease_until=clock_timestamp()-interval '1 second'",
    );
    await f.age(120);
    const worker = f.processor();
    await worker.tick();
    assert.equal(f.bridge.count('create'), 1);
    assert.equal((await f.invoice(attempt.attemptId)).state, 'issued');
    f.bridge.status.set('700000', 'Processed');
    await f.due();
    await worker.tick();
    assert.equal((await f.view(orderId)).captures.length, 1);
  }));

test('unknown invoice not present in history stays unknown for manual resolution', () =>
  fixture(async (f) => {
    const { orderId, attempt } = await f.order();
    f.bridge.create = () => ({ kind: 'uncertain' });
    const worker = f.processor();
    await worker.tick();
    for (let i = 0; i < 3; i++) {
      await f.due();
      await worker.tick();
    }
    assert.equal((await f.invoice(attempt.attemptId)).state, 'unknown');
    const order = await f.view(orderId);
    assert.equal(order.attempts[0].state, 'unknown');
    assert.equal(order.captures.length, 0);
  }));

test('definite refusals fail at once: rejected create, lost session, missing phone, tiyn total', () =>
  fixture(async (f) => {
    const worker = f.processor();
    const rejected = await f.order();
    f.bridge.create = () => ({ kind: 'rejected', statusCode: 5 });
    await worker.tick();
    assert.equal((await f.view(rejected.orderId)).attempts[0].state, 'failed');
    const session = await f.order();
    f.bridge.create = () => ({ kind: 'session' });
    assert.equal((await worker.tick()).sessionProblem, true);
    assert.equal((await f.view(session.orderId)).attempts[0].state, 'failed');
    f.bridge.create = null;
    const noPhone = await f.order({ phone: null });
    await worker.tick();
    assert.equal((await f.view(noPhone.orderId)).attempts[0].state, 'failed');
    const tiyn = await f.order({ unitPriceMinor: '50025' });
    await worker.tick();
    assert.equal((await f.view(tiyn.orderId)).attempts[0].state, 'failed');
    assert.equal(await f.invoice(tiyn.attempt.attemptId), undefined);
    assert.equal(f.bridge.count('create'), 2);
  }));

test('concurrent workers issue a single invoice per attempt', () =>
  fixture(async (f) => {
    const orders = await Promise.all([f.order(), f.order(), f.order()]);
    await Promise.all(Array.from({ length: 6 }, () => f.processor().tick()));
    assert.equal(f.bridge.count('create'), 3);
    for (const value of orders)
      assert.equal((await f.invoice(value.attempt.attemptId)).state, 'issued');
  }));

test('a different paid amount is captured as reported and never silently completes the order', () =>
  fixture(async (f) => {
    const { orderId, attempt } = await f.order();
    const worker = f.processor();
    await worker.tick();
    const id = (await f.invoice(attempt.attemptId)).operation_id;
    f.bridge.invoices.get(id).Amount = 900;
    f.bridge.status.set(id, 'Processed');
    await f.due();
    await worker.tick();
    const order = await f.view(orderId);
    assert.equal(order.captures[0].amount_minor, '90000');
    const reconcile = await f.pool.query(
      "SELECT 1 FROM commerce_outbox WHERE event_type='payment.reconcile_requested'",
    );
    assert.equal(reconcile.rowCount, 1);
  }));

test('webhook hint makes only a matching invoice of this account due', () =>
  fixture(async (f) => {
    const { attempt } = await f.order();
    await f.processor().tick();
    await f.pool.query(
      "UPDATE commerce_kaspi_invoices SET next_check_at=clock_timestamp()+interval '1 hour'",
    );
    const id = (await f.invoice(attempt.attemptId)).operation_id;
    assert.equal(await hintKaspiInvoice(f.pool, randomUUID(), id), false);
    assert.equal(await hintKaspiInvoice(f.pool, f.payment, '1'), false);
    assert.equal(await hintKaspiInvoice(f.pool, f.payment, id), true);
    const row = await f.invoice(attempt.attemptId);
    assert.ok(row.next_check_at <= new Date());
  }));

test('an uncertain cancel is sent once; later checks only read the status', () =>
  fixture(async (f) => {
    const { orderId, attempt } = await f.order();
    const worker = f.processor();
    await worker.tick();
    const id = (await f.invoice(attempt.attemptId)).operation_id;
    f.bridge.cancelAnswer = { kind: 'uncertain' };
    f.advance(601_000);
    for (let i = 0; i < 4; i++) {
      await f.due();
      await worker.tick();
    }
    assert.equal(f.bridge.count('cancel'), 1);
    assert.equal((await f.view(orderId)).attempts[0].state, 'pending');
    f.bridge.status.set(id, 'Expired');
    await f.due();
    await worker.tick();
    assert.equal((await f.view(orderId)).attempts[0].state, 'failed');
  }));

test('a failed phone lookup is a definite failure; one broken check does not stall others', () =>
  fixture(async (f) => {
    const broken = await f.order({ phone: 'throw' });
    const good = await f.order();
    const worker = f.processor();
    const first = await worker.tick();
    assert.equal((await f.view(broken.orderId)).attempts[0].state, 'failed');
    assert.equal(first.errors, 0);
    const id = (await f.invoice(good.attempt.attemptId)).operation_id;
    const other = await f.order();
    await worker.tick();
    const otherId = (await f.invoice(other.attempt.attemptId)).operation_id;
    const details = f.bridge.details.bind(f.bridge);
    f.bridge.details = async (op) => {
      if (op === id) throw new Error('unexpected bridge crash');
      return details(op);
    };
    f.bridge.status.set(otherId, 'Processed');
    await f.due();
    const result = await worker.tick();
    assert.equal(result.errors, 1);
    assert.equal((await f.view(other.orderId)).captures.length, 1);
  }));

test('history is searched deeply and long-unknown invoices are reported for manual check', () =>
  fixture(async (f) => {
    const { attempt } = await f.order();
    f.bridge.create = () => ({ kind: 'uncertain' });
    const worker = f.processor();
    await worker.tick();
    await f.due();
    await worker.tick();
    assert.ok(f.bridge.calls.some((c) => c[0] === 'history' && c[1] >= 100));
    assert.equal((await worker.tick()).unknownOverdue, 0);
    await f.age(600);
    assert.equal((await worker.tick()).unknownOverdue, 1);
    assert.equal((await f.invoice(attempt.attemptId)).state, 'unknown');
  }));

test('a webhook hint never releases an invoice leased by another worker', () =>
  fixture(async (f) => {
    const { attempt } = await f.order();
    await f.processor().tick();
    const id = (await f.invoice(attempt.attemptId)).operation_id;
    await f.pool.query(
      "UPDATE commerce_kaspi_invoices SET lease_until=clock_timestamp()+interval '60 seconds',next_check_at=clock_timestamp()+interval '60 seconds'",
    );
    assert.equal(await hintKaspiInvoice(f.pool, f.payment, id), true);
    const before = f.bridge.count('details');
    await f.processor().tick();
    assert.equal(f.bridge.count('details'), before);
  }));
