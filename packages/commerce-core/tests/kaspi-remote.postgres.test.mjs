import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, migrate, transaction } from '@pickchick/database';
import { localSelectionIds } from '@pickchick/menu-sync';
import { fixtureMenu } from '@pickchick/test-fixtures';
import {
  AvailabilityError,
  CommerceRepository,
  CustomerCheckout,
  KaspiRemoteProcessor,
  digest,
  hintKaspiInvoice,
} from '../dist/index.js';
import { publishCatalog } from './catalog-fixture.mjs';

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
    this.sessionChecks = 0;
    this.invoices = new Map();
    this.nextId = 700000;
    this.create = null; // optional override: (phone, amount, comment) => BridgeResult
    this.status = new Map();
  }
  async checkSession() {
    this.sessionChecks++;
    if (this.beforeSessionReply) await this.beforeSessionReply();
    return this.sessionReady !== false;
  }
  async createInvoice(phone, amount, comment) {
    this.calls.push(['create', phone, amount, comment]);
    if (this.create) return this.create(phone, amount, comment);
    return this.issue(amount, comment);
  }
  issue(amount, comment) {
    const id = String(this.nextId++);
    this.invoices.set(id, {
      QrOperationId: Number(id),
      Amount: amount,
      Comment: comment,
      OrderRegDate: new Date().toISOString(),
      ClientMobile: '87011234567',
    });
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
      fiscal = randomUUID();
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

test('unavailable bank defers the same durable submission and keeps existing invoice reconciliation active', () =>
  fixture(async (f) => {
    const firstOrder = await f.order();
    await f.processor().tick();
    const secondOrder = await f.order();
    f.bridge.sessionReady = false;
    f.bridge.status.set('700000', 'Processed');
    await f.due();
    const blockedWorker = f.processor();
    const blocked = await blockedWorker.tick();
    assert.equal(blocked.submitted, 0);
    assert.equal(f.bridge.count('create'), 1);
    assert.equal((await f.invoice(firstOrder.attempt.attemptId)).state, 'paid');
    const pending = await f.pool.query(
      'SELECT state FROM commerce_kaspi_invoices WHERE attempt_id=$1',
      [secondOrder.attempt.attemptId],
    );
    assert.equal(pending.rowCount, 0);
    const checks = f.bridge.sessionChecks;
    await blockedWorker.tick();
    assert.equal(f.bridge.sessionChecks, checks);
    assert.equal(f.bridge.count('create'), 1);
    await f.pool.query(
      "UPDATE commerce_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE acknowledged_at IS NULL",
    );
    f.bridge.sessionReady = true;
    await f.processor().tick();
    assert.equal(f.bridge.count('create'), 2);
    assert.equal((await f.invoice(secondOrder.attempt.attemptId)).state, 'issued');
  }));

test('restaurant freshness is checked after the bank probe and the same attempt waits for recovery', () =>
  fixture(async (f) => {
    const { attempt } = await f.order();
    f.bridge.beforeSessionReply = () =>
      f.pool.query(
        "UPDATE cloud_branch_availability SET observed_at=clock_timestamp()-interval '31 seconds'",
      );
    assert.equal((await f.processor().tick()).submitted, 0);
    assert.equal(f.bridge.count('create'), 0);
    assert.equal(await f.invoice(attempt.attemptId), undefined);
    f.bridge.beforeSessionReply = null;
    await f.pool.query('UPDATE cloud_branch_availability SET observed_at=clock_timestamp()');
    await f.pool.query(
      "UPDATE commerce_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE acknowledged_at IS NULL",
    );
    await f.processor().tick();
    assert.equal(f.bridge.count('create'), 1);
    assert.equal((await f.invoice(attempt.attemptId)).state, 'issued');
  }));

test('restaurant admission released after payment request prevents a new invoice', () =>
  fixture(async (f) => {
    const { attempt, orderId } = await f.order();
    await f.pool.query("UPDATE cloud_fulfillment_projection SET state='released'");
    const result = await f.processor().tick();
    assert.equal(result.submitted, 0);
    assert.equal(f.bridge.count('create'), 0);
    assert.equal(await f.invoice(attempt.attemptId), undefined);
    // Finding 0.0: the held order can never come back, so the attempt fails at once (no money).
    assert.equal(result.notSent, 1);
    assert.equal((await f.view(orderId)).attempts[0].state, 'failed');
    const inbox = await f.pool.query(
      "SELECT 1 FROM commerce_provider_inbox WHERE event_id=$1 AND observation->>'outcome'='failed'",
      [`kaspi-remote:${attempt.attemptId}:not-sent:order_not_held`],
    );
    assert.equal(inbox.rowCount, 1);
  }));

test('one blocked attempt never stalls later ready invoices (per-attempt deferral)', () =>
  fixture(async (f) => {
    // A: no current held admission yet (transient), B and C ready behind it.
    const a = await f.order();
    const b = await f.order();
    const c = await f.order();
    const held = (
      await f.pool.query('SELECT * FROM cloud_fulfillment_projection WHERE order_id=$1', [
        a.orderId,
      ])
    ).rows[0];
    await f.pool.query('DELETE FROM cloud_fulfillment_projection WHERE order_id=$1', [a.orderId]);
    const worker = f.processor();
    const first = await worker.tick();
    assert.equal((await f.invoice(b.attempt.attemptId))?.state, 'issued');
    assert.equal((await f.invoice(c.attempt.attemptId))?.state, 'issued');
    assert.equal(await f.invoice(a.attempt.attemptId), undefined);
    assert.equal(first.deferred, 1);
    assert.equal(first.submitted, 2);
    assert.equal(first.pendingUnsent, 1);
    assert.equal(first.sessionProblem, false);
    // The deferred attempt keeps its own retry time and is sent once its order is ready.
    await f.pool.query(
      `INSERT INTO cloud_fulfillment_projection(order_id,branch_id,organization_id,device_id,reservation_id,quote_id,quote_hash,owner_hash,version,state,display_number,routing_version,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        held.order_id,
        held.branch_id,
        held.organization_id,
        held.device_id,
        held.reservation_id,
        held.quote_id,
        held.quote_hash,
        held.owner_hash,
        held.version,
        held.state,
        held.display_number,
        held.routing_version,
        held.payload,
      ],
    );
    assert.equal((await worker.tick()).submitted, 0); // still inside its own back-off
    await f.releaseLeases();
    assert.equal((await worker.tick()).submitted, 1);
    assert.equal((await f.invoice(a.attempt.attemptId)).state, 'issued');
    assert.equal(f.bridge.count('create'), 3);
  }));

test('a stop-listed item defers only its own order; others are invoiced in the same tick', () =>
  fixture(async (f) => {
    const blocked = await f.order({ productId: 'synthetic-fries' });
    const b = await f.order();
    const c = await f.order();
    await f.stop(['synthetic-fries']);
    const worker = f.processor();
    for (let round = 0; round < 3; round++) {
      await f.releaseLeases();
      await worker.tick();
    }
    assert.equal((await f.invoice(b.attempt.attemptId)).state, 'issued');
    assert.equal((await f.invoice(c.attempt.attemptId)).state, 'issued');
    assert.equal(await f.invoice(blocked.attempt.attemptId), undefined);
    assert.equal(f.bridge.count('create'), 2);
    // Still on stop past the maximum age: it fails, it is never invoiced later.
    f.advance(601_000);
    await f.releaseLeases();
    const expired = await worker.tick();
    assert.equal(expired.notSent, 1);
    assert.equal((await f.view(blocked.orderId)).attempts[0].state, 'failed');
    await f.stop([]);
    await f.releaseLeases();
    await f.processor().tick();
    assert.equal(f.bridge.count('create'), 2);
    assert.equal(await f.invoice(blocked.attempt.attemptId), undefined);
  }));

test('a lost cashier session is reported and never-sent attempts expire without a late invoice', () =>
  fixture(async (f) => {
    const { orderId, attempt } = await f.order();
    f.bridge.sessionReady = false;
    const worker = f.processor();
    const blocked = await worker.tick();
    assert.equal(blocked.sessionProblem, true);
    assert.equal(blocked.sessionReason, 'session_inactive');
    assert.equal(blocked.deferred, 1);
    assert.equal(blocked.pendingUnsent, 1);
    assert.equal((await f.view(orderId)).attempts[0].state, 'pending');
    // Ten minutes later the session is still down: the attempt fails, nothing was sent.
    f.advance(601_000);
    await f.releaseLeases();
    const expired = await worker.tick();
    assert.equal(expired.sessionProblem, true);
    assert.equal(expired.notSent, 1);
    assert.equal(expired.pendingUnsent, 0);
    assert.equal((await f.view(orderId)).attempts[0].state, 'failed');
    assert.equal(await f.invoice(attempt.attemptId), undefined);
    // Re-login and worker restart: the abandoned attempt is never invoiced hours later.
    f.bridge.sessionReady = true;
    await f.releaseLeases();
    const restarted = await f.processor().tick();
    assert.equal(restarted.submitted, 0);
    assert.equal(f.bridge.count('create'), 0);
  }));

test('the oldest unsent attempt age is reported while the bank is down', () =>
  fixture(async (f) => {
    await f.order();
    f.bridge.sessionReady = false;
    const worker = f.processor();
    await worker.tick();
    f.advance(150_000);
    const later = await worker.tick();
    assert.equal(later.sessionProblem, true);
    assert.equal(later.pendingUnsent, 1);
    assert.ok(later.oldestUnsentSeconds >= 149, String(later.oldestUnsentSeconds));
  }));

test('a recovered session resumes invoices without a worker restart and reports recovery', () =>
  fixture(async (f) => {
    const { attempt } = await f.order();
    f.bridge.sessionReady = false;
    const worker = f.processor();
    assert.equal((await worker.tick()).sessionProblem, true);
    const probes = f.bridge.sessionChecks;
    assert.equal((await worker.tick()).sessionProblem, true);
    assert.equal(f.bridge.sessionChecks, probes); // back-off between probes
    f.bridge.sessionReady = true;
    f.advance(6_000);
    await f.releaseLeases();
    const recovered = await worker.tick();
    assert.equal(recovered.sessionRecovered, true);
    assert.equal(recovered.sessionProblem, false);
    assert.equal(recovered.submitted, 1);
    assert.equal((await f.invoice(attempt.attemptId)).state, 'issued');
  }));

test('a long session outage re-probes with a growing back-off, at most once a minute', () =>
  fixture(async (f) => {
    await f.order();
    f.bridge.sessionReady = false;
    const worker = f.processor();
    await worker.tick();
    assert.equal(f.bridge.sessionChecks, 1);
    const probes = [0];
    // Advance one second per tick for ten minutes and record when the worker probed.
    for (let second = 1; second <= 600; second++) {
      f.advance(1000);
      const before = f.bridge.sessionChecks;
      await worker.tick();
      if (f.bridge.sessionChecks > before) probes.push(second);
    }
    const gaps = probes.slice(1).map((at, i) => at - probes[i]);
    assert.deepEqual(gaps.slice(0, 5), [5, 10, 20, 40, 60]);
    assert.ok(gaps.every((gap) => gap <= 60));
    assert.ok(probes.length < 20, String(probes.length));
  }));

test('a bank session rejection pauses new invoices and resumes after a successful re-probe', () =>
  fixture(async (f) => {
    const rejected = await f.order();
    const next = await f.order();
    f.bridge.create = () => ({ kind: 'session' });
    const worker = f.processor();
    const first = await worker.tick();
    assert.equal(first.sessionProblem, true);
    assert.equal(first.sessionReason, 'session_rejected');
    assert.equal((await f.view(rejected.orderId)).attempts[0].state, 'failed');
    f.bridge.create = null;
    assert.equal((await worker.tick()).submitted, 0);
    f.advance(31_000);
    const resumed = await worker.tick();
    assert.equal(resumed.sessionRecovered, true);
    assert.equal(resumed.submitted, 1);
    assert.equal((await f.invoice(next.attempt.attemptId)).state, 'issued');
  }));

test('invoice to the customer phone, Processed status records exactly one capture', () =>
  fixture(async (f) => {
    const { orderId, attempt } = await f.order();
    const worker = f.processor();
    const first = await worker.tick();
    assert.equal(first.submitted, 1);
    assert.deepEqual(f.bridge.calls[0], ['create', '77011234567', 1000, f.bridge.calls[0][3]]);
    assert.equal(f.bridge.calls[0][3], 'Заказ №1: Synthetic burger - 2 шт.');
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

test('displayed KZT bank amount recovers an issued invoice exactly once', () =>
  fixture(async (f) => {
    const { orderId, attempt } = await f.order();
    const worker = f.processor();
    await worker.tick();
    const id = (await f.invoice(attempt.attemptId)).operation_id;
    f.bridge.invoices.get(id).Amount = '1 000 ₸';
    f.bridge.status.set(id, 'Processed');
    await f.due();
    assert.equal((await worker.tick()).errors, 0);
    assert.equal((await f.invoice(attempt.attemptId)).state, 'paid');
    assert.equal((await f.view(orderId)).captures[0].amount_minor, '100000');
    await f.due();
    await f.processor().tick();
    assert.equal((await f.view(orderId)).captures.length, 1);
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
    f.advance(181_000);
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
    f.advance(181_000);
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

test('legacy marker-only invoices remain recoverable after the readable-message upgrade', () =>
  fixture(async (f) => {
    const { attempt, orderId } = await f.order();
    await f.pool.query(
      `INSERT INTO commerce_kaspi_invoices(attempt_id,order_id,account_id,amount_minor,state,reference)
      VALUES($1,$2,$3,100000,'unknown','ABCDEFGH23')`,
      [attempt.attemptId, orderId, f.payment],
    );
    f.bridge.issue(1000, 'PickChick ABCDEFGH23');
    await f.processor().tick();
    assert.equal((await f.invoice(attempt.attemptId)).state, 'issued');
    assert.equal(f.bridge.count('create'), 0);
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
    let worker = f.processor();
    const rejected = await f.order();
    f.bridge.create = () => ({ kind: 'rejected', statusCode: 5 });
    await worker.tick();
    assert.equal((await f.view(rejected.orderId)).attempts[0].state, 'failed');
    const session = await f.order();
    f.bridge.create = () => ({ kind: 'session' });
    assert.equal((await worker.tick()).sessionProblem, true);
    assert.equal((await f.view(session.orderId)).attempts[0].state, 'failed');
    f.bridge.create = null;
    worker = f.processor(); // session re-login and worker restart
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
    f.advance(181_000);
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

test('terminal payment survives a crash between invoice state and ledger delivery', () =>
  fixture(async (f) => {
    const { orderId, attempt } = await f.order();
    await f.processor().tick();
    const id = (await f.invoice(attempt.attemptId)).operation_id;
    f.bridge.status.set(id, 'Processed');
    await f.pool.query(`CREATE FUNCTION interrupt_capture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic ledger outage'; END; $$;
      CREATE TRIGGER interrupt_capture BEFORE INSERT ON commerce_captures
      FOR EACH ROW EXECUTE FUNCTION interrupt_capture()`);
    await f.due();
    assert.equal((await f.processor().tick()).errors, 1);
    assert.equal((await f.invoice(attempt.attemptId)).state, 'paid');
    assert.equal((await f.invoice(attempt.attemptId)).delivered_at, null);
    assert.equal((await f.view(orderId)).captures.length, 0);
    await f.pool.query('DROP TRIGGER interrupt_capture ON commerce_captures');
    await f.due();
    await f.processor().tick();
    assert.equal((await f.view(orderId)).captures.length, 1);
    assert.ok((await f.invoice(attempt.attemptId)).delivered_at);
    // Simulate loss of delivery acknowledgement after the ledger commit as well.
    await f.pool.query('UPDATE commerce_kaspi_invoices SET delivered_at=NULL');
    await f.due();
    await f.processor().tick();
    assert.equal((await f.view(orderId)).captures.length, 1);
    assert.equal(f.bridge.count('create'), 1);
  }));

test('Processed without a valid bank amount never fabricates a capture', () =>
  fixture(async (f) => {
    const { orderId, attempt } = await f.order();
    await f.processor().tick();
    const id = (await f.invoice(attempt.attemptId)).operation_id;
    f.bridge.status.set(id, 'Processed');
    for (const amount of [undefined, null, 'invalid', -1, 0]) {
      f.bridge.invoices.get(id).Amount = amount;
      await f.pool.query('UPDATE commerce_kaspi_invoices SET lease_until=NULL');
      await f.due();
      assert.equal((await f.processor().tick()).errors, 1);
      assert.equal((await f.view(orderId)).captures.length, 0);
      assert.equal((await f.invoice(attempt.attemptId)).state, 'issued');
    }
  }));

test('recovery requires an exact reference and bank amount, and preserves original expiry', () =>
  fixture(async (f) => {
    const { attempt } = await f.order();
    f.bridge.create = (phone, amount, comment) => {
      const reply = f.bridge.issue(amount, comment);
      delete f.bridge.invoices.get(String(reply.data.QrOperationId)).Amount;
      return { kind: 'uncertain' };
    };
    await f.processor().tick();
    await f.age(500);
    await f.processor().tick();
    assert.equal((await f.invoice(attempt.attemptId)).state, 'unknown');
    f.bridge.invoices.get('700000').Amount = 1000;
    await f.due();
    await f.processor().tick();
    const row = await f.invoice(attempt.attemptId);
    assert.equal(row.state, 'issued');
    assert.equal(row.expires_at.getTime() - row.issue_started_at.getTime(), 180_000);
  }));

test('a crash after cancellation does not cause another cancellation', () =>
  fixture(async (f) => {
    const { attempt } = await f.order();
    await f.processor().tick();
    const id = (await f.invoice(attempt.attemptId)).operation_id;
    f.bridge.cancel = async (op) => {
      f.bridge.calls.push(['cancel', op]);
      throw new Error('process stopped after sending cancel');
    };
    f.advance(181_000);
    await f.due();
    assert.equal((await f.processor().tick()).errors, 1);
    await f.pool.query('UPDATE commerce_kaspi_invoices SET lease_until=NULL');
    await f.due();
    await f.processor().tick();
    assert.equal(f.bridge.count('cancel'), 1);
    f.bridge.status.set(id, 'RemotePaymentCanceled');
    await f.due();
    await f.processor().tick();
    assert.equal((await f.invoice(attempt.attemptId)).state, 'failed');
  }));

test('stale worker cannot overwrite a newer leased result or send cancellation', () =>
  fixture(async (f) => {
    const { orderId, attempt } = await f.order();
    await f.processor().tick();
    let respond, started;
    const waiting = new Promise((r) => {
      started = r;
    });
    const details = f.bridge.details.bind(f.bridge);
    f.bridge.details = async () => {
      started();
      return new Promise((r) => {
        respond = r;
      });
    };
    await f.due();
    const first = f.processor().tick(1);
    await waiting;
    await f.pool.query(
      "UPDATE commerce_kaspi_invoices SET lease_until=clock_timestamp()-interval '1 second'",
    );
    f.bridge.details = details;
    const id = (await f.invoice(attempt.attemptId)).operation_id;
    f.bridge.status.set(id, 'Processed');
    await f.processor().tick(1);
    respond({ kind: 'ok', data: { Status: 'RemotePaymentRejected' } });
    await first;
    assert.equal((await f.invoice(attempt.attemptId)).state, 'paid');
    assert.equal((await f.view(orderId)).captures.length, 1);
    assert.equal(f.bridge.count('cancel'), 0);
  }));

test('an answer for a different operation cannot pay this order', () =>
  fixture(async (f) => {
    const { orderId, attempt } = await f.order();
    await f.processor().tick();
    const id = (await f.invoice(attempt.attemptId)).operation_id;
    f.bridge.status.set(id, {
      kind: 'ok',
      data: { QrOperationId: 123, Status: 'Processed', Amount: 1000 },
    });
    await f.due();
    assert.equal((await f.processor().tick()).errors, 1);
    assert.equal((await f.view(orderId)).captures.length, 0);
  }));

test('session eviction pauses new invoices; a restarted worker resumes at once', () =>
  fixture(async (f) => {
    await f.order();
    await f.order();
    f.bridge.create = () => ({ kind: 'session' });
    const worker = f.processor();
    assert.equal((await worker.tick()).submitted, 1);
    assert.equal((await worker.tick()).submitted, 0);
    assert.equal(f.bridge.count('create'), 1);
    f.bridge.create = null;
    assert.equal((await f.processor().tick()).submitted, 1);
    assert.equal(f.bridge.count('create'), 2);
  }));

test('explicit deferred pilot: trusted capture admits once, without a fictional fiscal document', () =>
  fixture(async (f) => {
    const { orderId, attempt } = await f.order();
    assert.equal((await f.view(orderId)).kitchenEffectId, null);
    const worker = f.processor();
    await worker.tick();
    const invoice = await f.invoice(attempt.attemptId);
    f.bridge.status.set(invoice.operation_id, 'Processed');
    await f.due();
    await worker.tick();
    await f.due();
    await worker.tick();
    const paid = await f.view(orderId);
    assert.equal(paid.fiscalPolicy, 'deferred_pilot');
    assert.equal(paid.captures.length, 1);
    assert.equal(paid.fiscalDocuments.length, 0);
    assert.ok(paid.kitchenEffectId);
    assert.equal(f.bridge.count('create'), 1);
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int count FROM commerce_outbox WHERE order_id=$1 AND event_type='edge.kitchen_admission_requested'",
          [orderId],
        )
      ).rows[0].count,
      1,
    );
    await assert.rejects(
      f.pool.query("UPDATE commerce_orders SET fiscal_deferral_reference='changed' WHERE id=$1", [
        orderId,
      ]),
      /Fiscal policy cannot change/,
    );
    await assert.rejects(
      new CommerceRepository(f.pool).createDeferredFiscalOrder(f.scope, randomUUID(), randomUUID()),
      /FORBIDDEN/,
    );
  }, true));

test('ordinary Kaspi orders still wait for a real fiscal receipt before kitchen admission', () =>
  fixture(async (f) => {
    const { orderId, attempt } = await f.order();
    const worker = f.processor();
    await worker.tick();
    f.bridge.status.set((await f.invoice(attempt.attemptId)).operation_id, 'Processed');
    await f.due();
    await worker.tick();
    const paid = await f.view(orderId);
    assert.equal(paid.fiscalPolicy, 'required');
    assert.equal(paid.fiscalDocuments.length, 1);
    assert.equal(paid.kitchenEffectId, null);
  }));

test('restricted bank worker records one capture and cannot rewrite money or customer sessions', () =>
  fixture(async (f) => {
    const { kaspiWorkerGrants } = await import('../../../infra/staging/checkout-grants.mjs');
    const role = 'kaspi_worker_' + randomUUID().replaceAll('-', '');
    await f.admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    let runtime;
    try {
      await f.pool.query(`GRANT USAGE ON SCHEMA ${f.schema} TO ${role}`);
      await f.pool.query(kaspiWorkerGrants(role, true));
      const url = new URL(f.url);
      url.searchParams.set('options', `-c search_path=${f.schema} -c role=${role}`);
      runtime = createPool(url.toString(), 2);
      const { orderId, attempt } = await f.order();
      const worker = new KaspiRemoteProcessor(
        runtime,
        f.config,
        f.bridge,
        async () => '+77011234567',
      );
      const submitted = await worker.tick();
      assert.equal(submitted.errors, 0);
      assert.equal(submitted.submitted, 1);
      assert.equal((await f.invoice(attempt.attemptId)).state, 'issued');
      f.bridge.status.set('700000', 'Processed');
      await f.due();
      assert.equal((await worker.tick()).errors, 0);
      assert.equal((await f.view(orderId)).captures.length, 1);
      assert.equal((await f.view(orderId)).fiscalDocuments.length, 0);
      await worker.tick();
      assert.equal(f.bridge.count('create'), 1);
      for (const sql of [
        'UPDATE commerce_captures SET amount_minor=1',
        'DELETE FROM commerce_captures',
        'INSERT INTO commerce_orders DEFAULT VALUES',
        'UPDATE commerce_orders SET total_minor=1',
        'UPDATE commerce_provider_accounts SET enabled=false',
        'SELECT * FROM identity_sessions',
        'SELECT * FROM identity_customers',
        'UPDATE identity_customers SET deleted_at=clock_timestamp()',
        'INSERT INTO commerce_refund_effects DEFAULT VALUES',
      ])
        await assert.rejects(runtime.query(sql), /permission denied/);
      await f.pool.query(kaspiWorkerGrants(role, false));
      await assert.rejects(
        runtime.query('SELECT phone_cipher FROM identity_customers'),
        /permission denied/,
      );
      await assert.rejects(worker.tick(), /permission denied/);
    } finally {
      await runtime?.end();
      await f.pool.query(`DROP OWNED BY ${role}`);
      await f.admin.query(`DROP ROLE ${role}`);
    }
  }, true));

test('three-minute expiry cancels at the deadline, hides only confirmed unpaid orders and keeps the ledger', () =>
  fixture(async (f) => {
    const { orderId, attempt } = await f.order({ customerId: f.scope.principalId });
    const checkout = new CustomerCheckout(f.pool, {
      ...f.scope,
      paymentAccountId: f.payment,
      customerIds: [f.scope.principalId],
      maxOrderMinor: '1000000',
      repeatOrdersEnabled: true,
      approvalReference: 'Synthetic approval',
    });
    const worker = f.processor();
    await worker.tick();
    const invoice = await f.invoice(attempt.attemptId);
    assert.equal(invoice.expires_at.getTime() - invoice.issue_started_at.getTime(), 180000);
    f.advance(invoice.expires_at.getTime() - 1 - f.now());
    await f.due();
    await worker.tick();
    assert.equal(f.bridge.count('cancel'), 0);
    assert.equal((await checkout.list(f.scope.principalId)).orders.length, 1);
    const scheduled = await f.invoice(attempt.attemptId);
    assert.ok(scheduled.next_check_at.getTime() - Date.now() <= 1100);
    f.advance(1);
    await f.due();
    await worker.tick();
    assert.equal(f.bridge.count('cancel'), 1);
    // A sent cancellation is not a bank confirmation, so the order is still visible.
    assert.equal((await checkout.list(f.scope.principalId)).orders.length, 1);
    await f.due();
    await worker.tick();
    assert.equal((await checkout.list(f.scope.principalId)).orders.length, 0);
    assert.equal((await checkout.read(f.scope.principalId, orderId)).phase, 'failed');
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM commerce_orders')).rows[0].n, 1);
    assert.equal(
      (await f.pool.query('SELECT count(*)::int n FROM commerce_kaspi_invoices')).rows[0].n,
      1,
    );
    assert.equal((await f.view(orderId)).money.captured, '0');
    await f.due();
    await worker.tick();
    assert.equal(f.bridge.count('cancel'), 1);
    // A later trusted money observation must restore visibility, even if partial.
    await f.repo.observePayment(
      { organizationId: f.scope.organizationId, branchId: f.scope.branchId, accountId: f.payment },
      {
        eventId: randomUUID(),
        attemptId: attempt.attemptId,
        outcome: 'captured',
        operationId: 'synthetic-late',
        amountMinor: '100',
        occurredAt: new Date().toISOString(),
      },
    );
    const visible = (await checkout.list(f.scope.principalId)).orders;
    assert.equal(visible.length, 1);
    assert.equal(visible[0].phase, 'attention');
  }));

test('readable recovery rejects wrong phone, time, ambiguous message and preserves one invoice', () =>
  fixture(async (f) => {
    const { attempt, orderId } = await f.order();
    f.bridge.create = (_phone, amount, comment) => {
      f.bridge.issue(amount, comment);
      return { kind: 'uncertain' };
    };
    await f.processor().tick();
    const bank = f.bridge.invoices.get('700000');
    const createdAt = bank.OrderRegDate;
    for (const patch of [
      { ClientMobile: '87019999999' },
      { ClientMobile: '8701***4567' },
      { OrderRegDate: '2000-01-01T00:00:00Z' },
      { OrderRegDate: '2026-10-01 12:00:00' },
      { Comment: bank.Comment + ' extra' },
    ]) {
      const original = { ...bank };
      Object.assign(bank, patch);
      await f.due();
      await f.processor().tick();
      assert.equal((await f.invoice(attempt.attemptId)).state, 'unknown');
      Object.assign(bank, original);
    }
    assert.equal((await f.view(orderId)).captures.length, 0);
    assert.equal(f.bridge.count('create'), 1);
    bank.OrderRegDate = createdAt;
    await assert.rejects(
      f.pool.query('UPDATE commerce_kaspi_invoices SET invoice_comment=$1', ['changed']),
    );
    await f.due();
    await f.processor().tick();
    assert.equal((await f.invoice(attempt.attemptId)).state, 'issued');
    assert.equal(f.bridge.count('create'), 1);
  }));

test('legacy reference invoices still recover and are never reissued', () =>
  fixture(async (f) => {
    const { attempt, orderId } = await f.order();
    await f.pool.query(
      `INSERT INTO commerce_kaspi_invoices(attempt_id,order_id,account_id,amount_minor,state,reference)
      VALUES($1,$2,$3,100000,'unknown','ABCDEFGH23')`,
      [attempt.attemptId, orderId, f.payment],
    );
    f.bridge.issue(1000, 'PickChick ABCDEFGH23: Synthetic burger ×2');
    await f.processor().tick();
    assert.equal((await f.invoice(attempt.attemptId)).state, 'issued');
    assert.equal(f.bridge.count('create'), 0);
  }));

test('identical saved messages block automatic history adoption instead of guessing', () =>
  fixture(async (f) => {
    const first = await f.order(),
      second = await f.order();
    const comment = 'Заказ №1: Synthetic burger - 2 шт.';
    for (const [index, item] of [first, second].entries())
      await f.pool.query(
        `INSERT INTO commerce_kaspi_invoices(attempt_id,order_id,account_id,amount_minor,state,reference,invoice_comment)
       VALUES($1,$2,$3,100000,'unknown',$4,$5)`,
        [
          item.attempt.attemptId,
          item.orderId,
          f.payment,
          index ? 'ABCDEFGH24' : 'ABCDEFGH23',
          comment,
        ],
      );
    f.bridge.issue(1000, comment);
    await f.processor().tick();
    assert.equal((await f.invoice(first.attempt.attemptId)).state, 'unknown');
    assert.equal((await f.invoice(second.attempt.attemptId)).state, 'unknown');
    assert.equal(f.bridge.count('create'), 0);
    assert.equal((await f.view(first.orderId)).captures.length, 0);
  }));

test('commercial review persists only for the authenticated owner of a paid handed-over order', () =>
  fixture(async (f) => {
    const other = randomUUID();
    const options = {
      ...f.scope,
      paymentAccountId: f.payment,
      customerIds: [f.scope.principalId, other],
      maxOrderMinor: '1000000',
      repeatOrdersEnabled: true,
      approvalReference: 'Synthetic approval',
    };
    const checkout = new CustomerCheckout(f.pool, options);
    const { orderId, attempt } = await f.order({ customerId: f.scope.principalId });
    assert.equal((await checkout.feedback(f.scope.principalId, orderId)).enabled, false);
    await assert.rejects(
      checkout.submitFeedback(f.scope.principalId, orderId, { rating: 5 }),
      /CONFLICT/,
    );
    // Completion alone cannot turn an unpaid order into an eligible review.
    await f.pool.query(
      "UPDATE cloud_fulfillment_projection SET state='handed_over' WHERE order_id=$1",
      [orderId],
    );
    assert.equal((await checkout.feedback(f.scope.principalId, orderId)).enabled, false);
    // New invoices require a current held admission; complete only after bank submission.
    await f.pool.query("UPDATE cloud_fulfillment_projection SET state='held' WHERE order_id=$1", [
      orderId,
    ]);
    const worker = f.processor();
    await worker.tick();
    f.bridge.status.set((await f.invoice(attempt.attemptId)).operation_id, 'Processed');
    await f.due();
    await worker.tick();
    await f.pool.query(
      "UPDATE cloud_fulfillment_projection SET state='handed_over' WHERE order_id=$1",
      [orderId],
    );
    await assert.rejects(checkout.feedback(other, orderId), /NOT_FOUND/);
    await assert.rejects(checkout.submitFeedback(other, orderId, { rating: 1 }), /NOT_FOUND/);
    assert.deepEqual((await checkout.listFeedback(other)).feedback, []);
    for (const input of [
      { rating: 0 },
      { rating: 6 },
      { rating: 2.5 },
      { rating: '5' },
      { rating: 5, comment: 'x'.repeat(501) },
      { rating: 5, orderId },
    ])
      await assert.rejects(checkout.submitFeedback(f.scope.principalId, orderId, input), /INVALID/);
    await assert.rejects(checkout.feedback(f.scope.principalId, 'not-a-uuid'), /INVALID/);
    await f.pool.query("UPDATE cloud_fulfillment_projection SET state='ready' WHERE order_id=$1", [
      orderId,
    ]);
    await assert.rejects(
      checkout.submitFeedback(f.scope.principalId, orderId, { rating: 5 }),
      /CONFLICT/,
    );
    await f.pool.query(
      "UPDATE cloud_fulfillment_projection SET state='handed_over' WHERE order_id=$1",
      [orderId],
    );
    const first = await checkout.submitFeedback(f.scope.principalId, orderId, {
      rating: 5,
      comment: '  Good food  ',
    });
    assert.equal(first.enabled, true);
    assert.equal(first.feedback.comment, 'Good food');
    assert.equal(first.preparationStartedAt, null);
    assert.equal(first.readyAt, null);
    const retries = await Promise.all(
      Array.from({ length: 4 }, () =>
        checkout.submitFeedback(f.scope.principalId, orderId, { rating: 5, comment: 'Good food' }),
      ),
    );
    for (const value of retries) assert.deepEqual(value.feedback, first.feedback);
    const recovered = await new CustomerCheckout(f.pool, options).feedback(
      f.scope.principalId,
      orderId,
    );
    assert.deepEqual(recovered.feedback, first.feedback);
    assert.equal((await checkout.listFeedback(f.scope.principalId)).feedback[0].rating, 5);
    const edited = await checkout.submitFeedback(f.scope.principalId, orderId, {
      rating: 3,
      comment: '  ',
    });
    assert.equal(edited.feedback.rating, 3);
    assert.equal(edited.feedback.comment, null);
    assert.equal(edited.feedback.createdAt, first.feedback.createdAt);
    assert.ok(edited.feedback.updatedAt >= first.feedback.updatedAt);
    assert.equal(
      (await f.pool.query('SELECT count(*)::int n FROM commerce_order_feedback')).rows[0].n,
      1,
    );
    await f.pool.query('UPDATE commerce_orders SET attention_required=true WHERE id=$1', [orderId]);
    assert.equal((await checkout.feedback(f.scope.principalId, orderId)).enabled, false);
    await assert.rejects(
      checkout.submitFeedback(f.scope.principalId, orderId, { rating: 1 }),
      /CONFLICT/,
    );
    assert.equal((await f.view(orderId)).captures.length, 1);
    // Review storage cannot fabricate or modify fiscal/payment effects.
    assert.equal((await f.view(orderId)).fiscalDocuments.length, 0);
    await f.pool.query('UPDATE commerce_orders SET attention_required=false WHERE id=$1', [
      orderId,
    ]);
    const capture = (await f.view(orderId)).captures[0];
    const refund = await f.repo.requestRefund({ ...f.scope, role: 'manager' }, randomUUID(), {
      orderId,
      captureId: capture.id,
      amountMinor: '100',
      reason: 'Synthetic review refund',
      fulfillmentPolicy: 'manager_reviewed',
    });
    assert.equal((await checkout.feedback(f.scope.principalId, orderId)).enabled, false);
    await assert.rejects(
      checkout.submitFeedback(f.scope.principalId, orderId, { rating: 1 }),
      /CONFLICT/,
    );
    await f.repo.observeRefund(
      { organizationId: f.scope.organizationId, branchId: f.scope.branchId, accountId: f.payment },
      {
        eventId: randomUUID(),
        refundId: refund.refundId,
        outcome: 'succeeded',
        operationId: 'synthetic-review-refund',
        amountMinor: '100',
        occurredAt: new Date().toISOString(),
      },
    );
    assert.equal((await checkout.feedback(f.scope.principalId, orderId)).enabled, false);
    assert.equal((await checkout.feedback(f.scope.principalId, orderId)).feedback.rating, 3);
  }, true));

test('restricted checkout role can persist reviews but cannot move their owner or timestamps', () =>
  fixture(async (f) => {
    const { customerCheckoutGrants } = await import('../../../infra/staging/checkout-grants.mjs');
    const role = 'review_api_' + randomUUID().replaceAll('-', '');
    await f.admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    let runtime;
    try {
      const { orderId, attempt } = await f.order({ customerId: f.scope.principalId });
      const worker = f.processor();
      await worker.tick();
      f.bridge.status.set((await f.invoice(attempt.attemptId)).operation_id, 'Processed');
      await f.due();
      await worker.tick();
      await f.pool.query(
        "UPDATE cloud_fulfillment_projection SET state='handed_over' WHERE order_id=$1",
        [orderId],
      );
      await f.pool.query(`GRANT USAGE ON SCHEMA ${f.schema} TO ${role}`);
      await f.pool.query(customerCheckoutGrants(role, true));
      const url = new URL(f.url);
      url.searchParams.set('options', `-c search_path=${f.schema} -c role=${role}`);
      runtime = createPool(url.toString(), 2);
      const checkout = new CustomerCheckout(runtime, {
        ...f.scope,
        paymentAccountId: f.payment,
        customerIds: [f.scope.principalId],
        maxOrderMinor: '1000000',
        approvalReference: 'Synthetic approval',
      });
      const saved = await checkout.submitFeedback(f.scope.principalId, orderId, { rating: 4 });
      assert.equal(saved.feedback.rating, 4);
      assert.equal((await checkout.listFeedback(f.scope.principalId)).feedback.length, 1);
      assert.equal(
        (
          await checkout.submitFeedback(f.scope.principalId, orderId, {
            rating: 2,
            comment: 'Changed',
          })
        ).feedback.rating,
        2,
      );
      for (const sql of [
        'DELETE FROM commerce_order_feedback',
        'UPDATE commerce_order_feedback SET order_id=gen_random_uuid()',
        'UPDATE commerce_order_feedback SET created_at=clock_timestamp()',
        'UPDATE commerce_orders SET total_minor=1',
        'UPDATE commerce_captures SET amount_minor=1',
      ])
        await assert.rejects(runtime.query(sql), /permission denied/);
      await assert.rejects(
        runtime.query('UPDATE commerce_order_feedback SET rating=6'),
        /check constraint/,
      );
      await assert.rejects(
        runtime.query("UPDATE commerce_order_feedback SET comment=repeat('a',501)"),
        /check constraint/,
      );
      await f.pool.query(customerCheckoutGrants(role, false));
      await assert.rejects(checkout.feedback(f.scope.principalId, orderId), /permission denied/);
    } finally {
      await runtime?.end();
      await f.pool.query(`DROP OWNED BY ${role}`);
      await f.admin.query(`DROP ROLE ${role}`);
    }
  }, true));

test('a restaurant cancellation of a held order cancels its open Kaspi invoice at once', () =>
  fixture(async (f) => {
    const { orderId, attempt } = await f.order();
    const worker = f.processor();
    await worker.tick();
    const id = (await f.invoice(attempt.attemptId)).operation_id;
    // Well inside the 3-minute window: the cashier cancels the held order.
    await f.pool.query(
      "UPDATE cloud_fulfillment_projection SET state='cancelled' WHERE order_id=$1",
      [orderId],
    );
    await f.due();
    await worker.tick();
    assert.equal(f.bridge.count('cancel'), 1);
    assert.ok((await f.invoice(attempt.attemptId)).cancel_requested_at);
    f.bridge.status.set(id, 'RemotePaymentCanceled');
    await f.due();
    await worker.tick();
    assert.equal((await f.view(orderId)).attempts[0].state, 'failed');
    assert.equal((await f.view(orderId)).captures.length, 0);
  }));

test('a payment that races the restaurant cancellation is flagged for refund, never cooked', () =>
  fixture(async (f) => {
    const { orderId, attempt } = await f.order();
    const worker = f.processor();
    await worker.tick();
    const id = (await f.invoice(attempt.attemptId)).operation_id;
    await f.pool.query(
      "UPDATE cloud_fulfillment_projection SET state='cancelled' WHERE order_id=$1",
      [orderId],
    );
    f.bridge.status.set(id, 'Processed');
    await f.due();
    await worker.tick();
    const order = await f.view(orderId);
    assert.equal(order.captures.length, 1);
    assert.equal(order.attentionRequired, true);
    assert.deepEqual(
      order.issues.map((i) => i.code),
      ['PAID_AFTER_RESTAURANT_CANCEL'],
    );
    assert.equal(order.kitchenEffectId, null);
    const admissions = await f.pool.query(
      "SELECT 1 FROM commerce_outbox WHERE order_id=$1 AND event_type='edge.kitchen_admission_requested'",
      [orderId],
    );
    assert.equal(admissions.rowCount, 0);
  }, true));

/** Paid order whose kitchen admission is queued; then the cashier's projection says `state`. */
async function paidThenCashierCancels(f, { delivered = false, state = 'cancelled' } = {}) {
  const { orderId, attempt } = await f.order();
  const worker = f.processor();
  await worker.tick();
  f.bridge.status.set((await f.invoice(attempt.attemptId)).operation_id, 'Processed');
  await f.due();
  await worker.tick();
  const paid = await f.view(orderId);
  assert.equal(paid.captures.length, 1);
  assert.equal(paid.attentionRequired, false);
  assert.ok(paid.kitchenEffectId);
  if (delivered)
    await f.pool.query('UPDATE commerce_outbox SET acknowledged_at=clock_timestamp() WHERE id=$1', [
      paid.kitchenEffectId,
    ]);
  await f.pool.query(
    'UPDATE cloud_fulfillment_projection SET state=$2,version=version+1 WHERE order_id=$1',
    [orderId, state],
  );
  // The transport's projection observation runs this hook inside its own transaction.
  await transaction(f.pool, (client) =>
    f.repo.scheduleUnpaidCancellation(client, f.scope, orderId),
  );
  return orderId;
}

test('a paid order the cashier cancels before its kitchen admission arrives is flagged for refund', () =>
  fixture(async (f) => {
    // The cashier was offline: the payment arrived, the admission was still queued, and the
    // cashier cancelled the held order. The transport never delivers that admission.
    const orderId = await paidThenCashierCancels(f);
    const flagged = await f.view(orderId);
    assert.equal(flagged.attentionRequired, true);
    assert.equal(flagged.state, 'attention_required');
    assert.deepEqual(
      flagged.issues.map((i) => i.code),
      ['PAID_AFTER_RESTAURANT_CANCEL'],
    );
    // Repeated projection events add nothing.
    await transaction(f.pool, (client) =>
      f.repo.scheduleUnpaidCancellation(client, f.scope, orderId),
    );
    assert.equal((await f.view(orderId)).issues.length, 1);
  }, true));

test('a cancellation after the kitchen admission was delivered is not a paid-after-cancel case', () =>
  fixture(async (f) => {
    const orderId = await paidThenCashierCancels(f, { delivered: true });
    const order = await f.view(orderId);
    assert.equal(order.attentionRequired, false);
    assert.deepEqual(order.issues, []);
  }, true));

test('recovery finds its own invoice although an older invoice had the same readable message', () =>
  fixture(async (f) => {
    // Daily order numbers restart: yesterday's order No 1 had exactly the same message.
    const old = await f.order();
    const worker = f.processor();
    await worker.tick();
    const previous = await f.invoice(old.attempt.attemptId);
    f.bridge.status.set(previous.operation_id, 'Processed');
    await f.due();
    await worker.tick();
    assert.equal((await f.invoice(old.attempt.attemptId)).state, 'paid');
    await f.pool.query(
      "UPDATE commerce_kaspi_invoices SET issue_started_at=issue_started_at-interval '1 day' WHERE attempt_id=$1",
      [old.attempt.attemptId],
    );
    const bankOld = f.bridge.invoices.get(previous.operation_id);
    bankOld.OrderRegDate = new Date(Date.parse(bankOld.OrderRegDate) - 86_400_000).toISOString();
    const today = await f.order();
    await f.pool.query(
      "UPDATE cloud_fulfillment_projection SET display_number='1' WHERE order_id=$1",
      [today.orderId],
    );
    f.bridge.create = (_phone, amount, comment) => {
      f.bridge.issue(amount, comment); // Kaspi created it, the answer was lost.
      return { kind: 'uncertain' };
    };
    await worker.tick();
    const lost = await f.invoice(today.attempt.attemptId);
    assert.equal(lost.state, 'unknown');
    assert.equal(lost.invoice_comment, previous.invoice_comment);
    f.bridge.create = null;
    await f.due();
    await worker.tick();
    const adopted = await f.invoice(today.attempt.attemptId);
    assert.equal(adopted.state, 'issued');
    assert.notEqual(adopted.operation_id, previous.operation_id);
    f.bridge.status.set(adopted.operation_id, 'Processed');
    await f.due();
    await worker.tick();
    assert.equal((await f.view(today.orderId)).captures.length, 1);
    assert.equal(f.bridge.count('create'), 2);
  }));

const checkoutFor = (f, extra = {}, now = undefined) =>
  new CustomerCheckout(
    f.pool,
    {
      ...f.scope,
      paymentAccountId: f.payment,
      customerIds: [f.scope.principalId],
      maxOrderMinor: '1000000',
      repeatOrdersEnabled: true,
      approvalReference: 'Synthetic approval',
      ...extra,
    },
    now,
  );
const intentOf = async (f, orderId) =>
  (
    await f.pool.query('SELECT reason,state FROM commerce_cancellation_intents WHERE order_id=$1', [
      orderId,
    ])
  ).rows[0];

test('an order refused at payment for a stopped item is cancelled unpaid; the error code is kept', () =>
  fixture(async (f) => {
    const { orderId } = await f.order({ customerId: f.scope.principalId, pay: false });
    const checkout = checkoutFor(f);
    assert.equal((await checkout.read(f.scope.principalId, orderId)).phase, 'ready_to_pay');
    await f.stop(['synthetic-burger']);
    await assert.rejects(
      checkout.pay(f.scope.principalId, orderId),
      (e) => e instanceof AvailabilityError && e.code === 'ITEM_STOPPED',
    );
    assert.equal((await intentOf(f, orderId)).reason, 'ITEM_STOPPED_BEFORE_PAYMENT');
    // A later GET shows the order as ended, so installed builds stop re-sending /payment.
    assert.equal((await checkout.read(f.scope.principalId, orderId)).phase, 'failed');
    await f.stop([]);
    await assert.rejects(checkout.pay(f.scope.principalId, orderId), { code: 'NOT_READY' });
    assert.equal((await f.view(orderId)).attempts.length, 0);
    assert.equal(f.bridge.count('create'), 0);
  }));

test('an order refused at payment after closing time is cancelled unpaid', () =>
  fixture(async (f) => {
    const { orderId } = await f.order({ customerId: f.scope.principalId, pay: false });
    const closed = checkoutFor(
      f,
      { hours: { openingTime: '10:00', closingTime: '00:00', timeZone: 'Asia/Almaty' } },
      () => new Date('2026-10-19T20:30:00Z'), // 01:30 in Almaty
    );
    await assert.rejects(closed.pay(f.scope.principalId, orderId), { code: 'RESTAURANT_CLOSED' });
    assert.equal((await intentOf(f, orderId)).reason, 'RESTAURANT_CLOSED_BEFORE_PAYMENT');
    assert.equal((await closed.read(f.scope.principalId, orderId)).phase, 'failed');
  }));

test('an order whose held admission the restaurant released is cancelled at payment', () =>
  fixture(async (f) => {
    const { orderId } = await f.order({ customerId: f.scope.principalId, pay: false });
    await f.pool.query(
      "UPDATE cloud_fulfillment_projection SET state='released' WHERE order_id=$1",
      [orderId],
    );
    const checkout = checkoutFor(f);
    await assert.rejects(checkout.pay(f.scope.principalId, orderId), { code: 'NOT_READY' });
    assert.equal((await intentOf(f, orderId)).reason, 'ORDER_RELEASED_BEFORE_PAYMENT');
    assert.equal((await checkout.read(f.scope.principalId, orderId)).phase, 'failed');
  }));

test('a transient payment refusal keeps the order payable', () =>
  fixture(async (f) => {
    const { orderId } = await f.order({ customerId: f.scope.principalId, pay: false });
    await f.pool.query(
      "UPDATE cloud_branch_availability SET observed_at=clock_timestamp()-interval '31 seconds'",
    );
    const checkout = checkoutFor(f);
    await assert.rejects(checkout.pay(f.scope.principalId, orderId), {
      code: 'AVAILABILITY_STALE',
    });
    assert.equal(await intentOf(f, orderId), undefined);
    await f.pool.query('UPDATE cloud_branch_availability SET observed_at=clock_timestamp()');
    const paid = await checkout.pay(f.scope.principalId, orderId);
    assert.equal(paid.phase, 'sending');
  }));

test('unpaid orders without an attempt expire after the TTL; attempted ones stay', () =>
  fixture(async (f) => {
    const old = await f.order({ customerId: f.scope.principalId, pay: false });
    const attempted = await f.order({ customerId: f.scope.principalId });
    const later = () => new Date(Date.now() + 31 * 60_000);
    const second = await f.order({ customerId: f.scope.principalId, pay: false });
    const sweeper = checkoutFor(f, {}, later);
    // Nothing is 30 minutes old yet; half an hour later both never-billed orders expire.
    assert.equal(await checkoutFor(f).expireUnpaid(), 0);
    assert.equal(await sweeper.expireUnpaid(), 2);
    assert.equal((await intentOf(f, old.orderId)).reason, 'UNPAID_ORDER_EXPIRED');
    assert.equal((await intentOf(f, second.orderId)).reason, 'UNPAID_ORDER_EXPIRED');
    assert.equal(await intentOf(f, attempted.orderId), undefined);
    assert.equal((await sweeper.read(f.scope.principalId, old.orderId)).phase, 'failed');
    assert.equal(await sweeper.expireUnpaid(), 0);
    assert.equal(await checkoutFor(f, { unpaidOrderTtlMinutes: 0 }, later).expireUnpaid(), 0);
  }));

test('the server sales switch closes new mobile Kaspi payments; in-flight ones are kept', () =>
  fixture(async (f) => {
    await publishCatalog(f);
    const inFlight = await f.order({ customerId: f.scope.principalId });
    const ready = await f.order({ customerId: f.scope.principalId, pay: false });
    assert.equal((await checkoutFor(f).config(f.scope.principalId)).enabled, true);
    const closed = checkoutFor(f, { salesEnabled: false });
    assert.equal((await closed.config(f.scope.principalId)).enabled, false);
    await assert.rejects(closed.pay(f.scope.principalId, ready.orderId), { code: 'NOT_READY' });
    assert.equal((await intentOf(f, ready.orderId)).reason, 'SALES_DISABLED_BEFORE_PAYMENT');
    assert.equal((await f.view(ready.orderId)).attempts.length, 0);
    // An attempt that already exists is only read back and still gets its invoice.
    assert.equal((await closed.pay(f.scope.principalId, inFlight.orderId)).phase, 'sending');
    await f.processor().tick();
    assert.equal((await f.invoice(inFlight.attempt.attemptId)).state, 'issued');
  }));

// QA 20.10 (release-fixes-1019): adversarial checks of audit S1 (0.0) and S2 (0.1/5.1).

test('QA S1: more blocked attempts than one tick serves never starve a later ready invoice', () =>
  fixture(async (f) => {
    // Twelve attempts for a stopped product queue ahead of one ready order (tick limit is 10).
    const blocked = [];
    for (let i = 0; i < 12; i++) blocked.push(await f.order({ productId: 'synthetic-fries' }));
    const ready = await f.order();
    await f.stop(['synthetic-fries']);
    const worker = f.processor();
    const first = await worker.tick();
    assert.equal(first.deferred, 10);
    assert.equal(first.sessionProblem, false);
    // No lease is released by hand: the next tick alone must reach the ready order.
    const second = await worker.tick();
    assert.equal(second.submitted, 1);
    assert.equal((await f.invoice(ready.attempt.attemptId))?.state, 'issued');
    assert.equal(f.bridge.count('create'), 1);
    // Leases lapse while the stop lasts: the blocked ones keep deferring, never invoiced.
    await f.releaseLeases();
    const third = await worker.tick();
    assert.equal(third.submitted, 0);
    assert.equal(third.pendingUnsent, 12);
    for (const b of blocked) assert.equal(await f.invoice(b.attempt.attemptId), undefined);
    // A new ready order arriving behind the re-deferred ones is served first (least tried).
    const late = await f.order();
    await f.releaseLeases();
    assert.equal((await worker.tick()).submitted, 1);
    assert.equal((await f.invoice(late.attempt.attemptId))?.state, 'issued');
    // Past the maximum age every blocked attempt fails; the stop lifting later sends nothing.
    f.advance(601_000);
    await f.releaseLeases();
    let notSent = 0;
    for (let round = 0; round < 3; round++) notSent += (await worker.tick()).notSent;
    assert.equal(notSent, 12);
    await f.stop([]);
    await f.releaseLeases();
    await worker.tick();
    assert.equal(f.bridge.count('create'), 2);
  }));

test('QA S1+S2: a session outage with a stop in between: ready orders go first after re-login', () =>
  fixture(async (f) => {
    const { KaspiAttention } = await import('../dist/index.js');
    const attention = new KaspiAttention();
    f.bridge.sessionReady = false;
    const stopped = await f.order({ productId: 'synthetic-fries' });
    const ready = await f.order();
    const worker = f.processor();
    const down = await worker.tick();
    assert.equal(down.sessionProblem, true);
    assert.equal(down.submitted, 0);
    const lost = attention.next(down, f.now());
    assert.equal(lost?.sessionProblem, true);
    assert.equal(lost?.reason, 'session_inactive');
    // While the bank is down the fries run out; three minutes later the cashier logs in again.
    await f.stop(['synthetic-fries']);
    for (let s = 0; s < 180; s += 10) {
      f.advance(10_000);
      await worker.tick();
    }
    f.bridge.sessionReady = true;
    f.advance(60_000);
    await f.releaseLeases();
    const back = await worker.tick();
    assert.equal(back.sessionProblem, false);
    assert.equal(back.sessionRecovered, true);
    assert.equal((await f.invoice(ready.attempt.attemptId))?.state, 'issued');
    assert.equal(await f.invoice(stopped.attempt.attemptId), undefined);
    assert.equal(back.pendingUnsent, 1);
    // The session change is reported at once; the stopped order still waits over 120 s.
    const signal = attention.next(back, f.now());
    assert.equal(signal?.sessionProblem, false);
    assert.equal(signal?.reason, 'invoice_not_sent');
    // Ten minutes after its tap the stopped order fails without an invoice, and the alert clears.
    f.advance(400_000);
    await f.releaseLeases();
    const ended = await worker.tick();
    assert.equal(ended.notSent, 1);
    assert.equal(ended.pendingUnsent, 0);
    assert.equal((await f.view(stopped.orderId)).attempts[0].state, 'failed');
    assert.deepEqual(attention.next(ended, f.now()), {
      event: 'kaspi_remote_attention',
      recovered: true,
      sessionProblem: false,
    });
    assert.equal(f.bridge.count('create'), 1);
  }));

test('QA S2: a bridge that is down is reported as such and nothing is sent until it is back', () =>
  fixture(async (f) => {
    let status = 'unreachable';
    const client = Object.create(f.bridge);
    client.sessionStatus = async () => status;
    const { attempt } = await f.order();
    const worker = f.processor(client);
    const down = await worker.tick();
    assert.equal(down.sessionProblem, true);
    assert.equal(down.sessionReason, 'bridge_unreachable');
    assert.equal(f.bridge.count('create'), 0);
    status = 'missing';
    f.advance(6_000);
    assert.equal((await worker.tick()).sessionReason, 'session_missing');
    status = 'active';
    f.advance(11_000);
    await f.releaseLeases();
    const back = await worker.tick();
    assert.equal(back.sessionProblem, false);
    assert.equal((await f.invoice(attempt.attemptId))?.state, 'issued');
  }));
