import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { fixtureMenu } from '@pickchick/test-fixtures';
import { CommerceRepository, digest } from '../dist/index.js';

// Only disposable schemas in explicitly local development PostgreSQL. Never
// load a private .env or infer the live VPS connection from application config.
const connection =
  process.env.COMMERCE_TEST_DATABASE_URL ??
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55432/pickchick_cloud';
const checked = new URL(connection);
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(checked.hostname),
  'Commerce tests require localhost PostgreSQL',
);
const migrationDir = fileURLToPath(new URL('../../../db/cloud/migrations/', import.meta.url));
const now = () => new Date().toISOString();
const observation = (attempt, outcome = 'captured', extra = {}) => ({
  eventId: randomUUID(),
  attemptId: attempt.attemptId,
  outcome,
  occurredAt: now(),
  ...(outcome === 'captured'
    ? { operationId: randomUUID(), amountMinor: attempt.amountMinor }
    : {}),
  ...extra,
});

async function fixture(run) {
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
        "INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,kind,provider,external_reference,enabled,legal_entity_id) VALUES($1,$2,$3,$4,'synthetic-test',$5,true,$6)",
        [id, org, branch, kind, id, legal],
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

test('quote/order command replays serialize; changed bodies and snapshot mutation fail', () =>
  fixture(async (f) => {
    const key = randomUUID(),
      priced = f.priced();
    const quotes = await Promise.all(
      Array.from({ length: 8 }, () => f.repo.issueQuote(f.scope, key, priced)),
    );
    assert.equal(new Set(quotes.map((q) => q.quoteId)).size, 1);
    assert.equal(await f.count('commerce_quotes'), 1);
    await assert.rejects(f.repo.issueQuote(f.scope, key, { ...priced, ttlSeconds: 301 }), {
      code: 'CONFLICT',
    });
    const quote = quotes[0];
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        f.repo.createOrder(f.scope, randomUUID(), {
          quoteId: quote.quoteId,
          fiscalAccountId: f.fiscal,
        }),
      ),
    );
    assert.equal(new Set(results.map((o) => o.orderId)).size, 1);
    assert.equal(await f.count('commerce_payment_intents'), 1);
    await assert.rejects(f.pool.query('UPDATE commerce_quotes SET total_minor=1'), {
      code: '23514',
    });
    await assert.rejects(f.pool.query('UPDATE commerce_orders SET snapshot=$1', [{}]), {
      code: '23514',
    });
    await assert.rejects(f.pool.query('DELETE FROM commerce_orders'), { code: '23514' });
    await assert.rejects(
      f.repo.readOrder({ ...f.scope, principalId: randomUUID() }, results[0].orderId),
      { code: 'NOT_FOUND' },
    );
  }));

test('fresh expired quote fails; a committed command still replays after quote expiry', () =>
  fixture(async (f) => {
    const key = randomUUID(),
      quote = await f.repo.issueQuote(f.scope, randomUUID(), { ...f.priced(), ttlSeconds: 1 });
    const expired = await f.repo.issueQuote(f.scope, randomUUID(), {
      ...f.priced(),
      ttlSeconds: 1,
    });
    const request = { quoteId: quote.quoteId, fiscalAccountId: f.fiscal };
    const result = await f.repo.createOrder(f.scope, key, request);
    await f.pool.query('SELECT pg_sleep(1.05)');
    assert.deepEqual(await f.repo.createOrder(f.scope, key, request), result);
    await assert.rejects(
      f.repo.createOrder(f.scope, randomUUID(), {
        quoteId: expired.quoteId,
        fiscalAccountId: f.fiscal,
      }),
      { code: 'EXPIRED' },
    );
  }));

test('payment requires immutable admission; unknown blocks a new attempt and stale pending', () =>
  fixture(async (f) => {
    const { order, quote } = await f.create();
    const request = { orderId: order.orderId, providerAccountId: f.payment };
    await assert.rejects(f.repo.startPaymentAttempt(f.scope, randomUUID(), request), {
      code: 'NOT_READY',
    });
    const admission = {
      eventId: randomUUID(),
      orderId: order.orderId,
      reservationId: randomUUID(),
      quoteDigest: quote.digest,
    };
    await assert.rejects(
      f.repo.confirmAdmission(f.edge, { ...admission, quoteDigest: '0'.repeat(64) }),
      { code: 'CONFLICT' },
    );
    const admitted = await f.repo.confirmAdmission(f.edge, admission);
    assert.deepEqual(await f.repo.confirmAdmission(f.edge, admission), admitted);
    await assert.rejects(
      f.repo.confirmAdmission(f.edge, {
        ...admission,
        eventId: randomUUID(),
        reservationId: randomUUID(),
      }),
      { code: 'CONFLICT' },
    );
    const key = randomUUID();
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => f.repo.startPaymentAttempt(f.scope, key, request)),
    );
    assert.equal(new Set(attempts.map((a) => a.attemptId)).size, 1);
    const attempt = attempts[0];
    await f.repo.observePayment(f.provider, observation(attempt, 'unknown'));
    await f.repo.observePayment(f.provider, observation(attempt, 'pending'));
    assert.equal((await f.repo.readOrder(f.scope, order.orderId)).attempts[0].state, 'unknown');
    await assert.rejects(f.repo.startPaymentAttempt(f.scope, randomUUID(), request), {
      code: 'NOT_READY',
    });
    assert.equal(await f.count('commerce_captures'), 0);
  }));

test('duplicate and out-of-order bank/KKM callbacks admit the kitchen exactly once after issued sale', () =>
  fixture(async (f) => {
    const value = await f.ready(),
      event = observation(value.attempt);
    await Promise.all(Array.from({ length: 8 }, () => f.repo.observePayment(f.provider, event)));
    await Promise.all(
      Array.from({ length: 8 }, () =>
        f.repo.observePayment(f.provider, { ...event, eventId: randomUUID() }),
      ),
    );
    await f.repo.observePayment(f.provider, observation(value.attempt, 'failed'));
    await f.repo.observePayment(f.provider, observation(value.attempt, 'pending'));
    let view = await f.repo.readOrder(f.scope, value.order.orderId);
    assert.equal(view.captures.length, 1);
    assert.equal(view.money.captured, '100000');
    assert.equal(view.attempts[0].state, 'succeeded');
    assert.equal(view.kitchenEffectId, null);
    assert.equal(view.fiscalDocuments.length, 1);
    const sale = view.fiscalDocuments[0];
    await f.repo.observeFiscal(f.fiscalProvider, {
      eventId: randomUUID(),
      documentId: sale.id,
      outcome: 'unknown',
      occurredAt: now(),
    });
    assert.equal((await f.repo.readOrder(f.scope, value.order.orderId)).kitchenEffectId, null);
    const issued = {
      eventId: randomUUID(),
      documentId: sale.id,
      outcome: 'issued',
      providerDocumentId: randomUUID(),
      fiscalMark: 'synthetic',
      receiptUrl: 'https://example.invalid/receipt',
      amountMinor: sale.amount_minor,
      occurredAt: now(),
    };
    await Promise.all(
      Array.from({ length: 8 }, () => f.repo.observeFiscal(f.fiscalProvider, issued)),
    );
    await f.repo.observeFiscal(f.fiscalProvider, { ...issued, eventId: randomUUID() });
    await f.repo.observeFiscal(f.fiscalProvider, {
      eventId: randomUUID(),
      documentId: sale.id,
      outcome: 'failed',
      occurredAt: now(),
    });
    view = await f.repo.readOrder(f.scope, value.order.orderId);
    assert.ok(view.kitchenEffectId);
    assert.equal(view.state, 'paid_pending_acceptance');
    assert.equal(view.fiscalDocuments[0].state, 'issued');
    assert.equal(
      Number(
        (
          await f.pool.query(
            "SELECT COUNT(*) count FROM commerce_outbox WHERE effect_key='kitchen-admission'",
          )
        ).rows[0].count,
      ),
      1,
    );
    await assert.rejects(f.repo.observePayment(f.provider, { ...event, amountMinor: '1' }), {
      code: 'CONFLICT',
    });
  }));

test('two actual captures remain two ledger effects even after failed attempt and excess capture', () =>
  fixture(async (f) => {
    const first = await f.ready();
    await f.repo.observePayment(f.provider, observation(first.attempt, 'failed'));
    const second = await f.repo.startPaymentAttempt(f.scope, randomUUID(), {
      orderId: first.order.orderId,
      providerAccountId: f.payment,
    });
    await Promise.all([
      f.repo.observePayment(f.provider, observation(first.attempt)),
      f.repo.observePayment(f.provider, observation(second)),
    ]);
    const view = await f.repo.readOrder(f.scope, first.order.orderId);
    assert.equal(view.captures.length, 2);
    assert.equal(view.money.captured, '200000');
    assert.equal(view.attentionRequired, true);
    assert.equal(view.kitchenEffectId, null);
    assert.ok(view.issues.some((i) => i.code === 'CAPTURE_EXCEEDS_INTENT'));
    const claimed = await f.repo.claimOutbox(f.manager, {
      workerId: randomUUID(),
      limit: 100,
      leaseSeconds: 30,
    });
    assert.equal(claimed.filter((e) => e.event_type === 'fiscal.submit_requested').length, 0);
  }));

test('provider operation reuse against a different attempt is visible and never double counted', () =>
  fixture(async (f) => {
    const first = await f.ready(),
      event = observation(first.attempt);
    await f.repo.observePayment(f.provider, event);
    const second = await f.ready();
    await f.repo.observePayment(f.provider, {
      ...event,
      eventId: randomUUID(),
      attemptId: second.attempt.attemptId,
    });
    assert.equal(await f.count('commerce_captures'), 1);
    const view = await f.repo.readOrder(f.scope, second.order.orderId);
    assert.equal(view.attentionRequired, true);
    assert.equal(view.money.captured, '0');
    assert.ok(view.issues.some((i) => i.code === 'CAPTURE_REFERENCE_CONFLICT'));
  }));

test('partial capture uses exact money and blocks another charge until resolved', () =>
  fixture(async (f) => {
    const value = await f.ready();
    await f.repo.observePayment(
      f.provider,
      observation(value.attempt, 'captured', { amountMinor: '40000' }),
    );
    let view = await f.repo.readOrder(f.scope, value.order.orderId);
    assert.equal(view.money.captured, '40000');
    assert.equal(view.fiscalDocuments.length, 0);
    await assert.rejects(
      f.repo.startPaymentAttempt(f.scope, randomUUID(), {
        orderId: value.order.orderId,
        providerAccountId: f.payment,
      }),
      { code: 'NOT_READY' },
    );
    await f.repo.observePayment(
      f.provider,
      observation(value.attempt, 'captured', { amountMinor: '60000' }),
    );
    view = await f.repo.readOrder(f.scope, value.order.orderId);
    assert.equal(view.money.captured, '100000');
    assert.equal(view.fiscalDocuments.length, 1);
  }));

test('parallel partial refunds cannot over-reserve; unknown holds funds and failure releases reservation', () =>
  fixture(async (f) => {
    const value = await f.captured();
    const request = {
      orderId: value.order.orderId,
      captureId: value.capture.id,
      amountMinor: '60000',
      reason: 'Synthetic partial refund',
    };
    await assert.rejects(f.repo.requestRefund(f.scope, randomUUID(), request), {
      code: 'FORBIDDEN',
    });
    const results = await Promise.allSettled([
      f.repo.requestRefund(f.manager, randomUUID(), request),
      f.repo.requestRefund(f.manager, randomUUID(), request),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'REFUND_LIMIT');
    const refund = results.find((r) => r.status === 'fulfilled').value;
    await f.repo.observeRefund(f.provider, {
      eventId: randomUUID(),
      refundId: refund.refundId,
      outcome: 'unknown',
      occurredAt: now(),
    });
    await assert.rejects(
      f.repo.requestRefund(f.manager, randomUUID(), { ...request, amountMinor: '50000' }),
      { code: 'REFUND_LIMIT' },
    );
    await f.repo.requestRefund(f.manager, randomUUID(), { ...request, amountMinor: '40000' });
    assert.equal((await f.repo.readOrder(f.scope, value.order.orderId)).money.reserved, '100000');
    await f.repo.observeRefund(f.provider, {
      eventId: randomUUID(),
      refundId: refund.refundId,
      outcome: 'failed',
      occurredAt: now(),
    });
    await f.repo.requestRefund(f.manager, randomUUID(), { ...request, amountMinor: '60000' });
    assert.equal((await f.repo.readOrder(f.scope, value.order.orderId)).money.reserved, '100000');
  }));

test('full refund does not undo capture; fiscal refund waits for original sale and never admits refunded food', () =>
  fixture(async (f) => {
    const value = await f.captured();
    const request = {
      orderId: value.order.orderId,
      captureId: value.capture.id,
      amountMinor: '100000',
      reason: 'Synthetic full refund',
    };
    const key = randomUUID(),
      refund = await f.repo.requestRefund(f.manager, key, request);
    assert.deepEqual(await f.repo.requestRefund(f.manager, key, request), refund);
    const event = {
      eventId: randomUUID(),
      refundId: refund.refundId,
      outcome: 'succeeded',
      operationId: randomUUID(),
      amountMinor: '100000',
      occurredAt: now(),
    };
    await Promise.all(Array.from({ length: 6 }, () => f.repo.observeRefund(f.provider, event)));
    await f.repo.observeRefund(f.provider, { ...event, eventId: randomUUID() });
    await f.repo.observeRefund(f.provider, {
      eventId: randomUUID(),
      refundId: refund.refundId,
      outcome: 'failed',
      occurredAt: now(),
    });
    let view = await f.repo.readOrder(f.scope, value.order.orderId);
    assert.equal(view.money.captured, '100000');
    assert.equal(view.money.refunded, '100000');
    assert.equal(view.money.reserved, '0');
    assert.equal(view.refunds[0].state, 'succeeded');
    assert.equal(view.fiscalDocuments.length, 2);
    assert.equal(view.kitchenEffectId, null);
    assert.equal(
      Number(
        (
          await f.pool.query(
            "SELECT COUNT(*) count FROM commerce_outbox WHERE event_type='fiscal.submit_requested'",
          )
        ).rows[0].count,
      ),
      1,
    );
    await f.issueSale(value.sale);
    view = await f.repo.readOrder(f.scope, value.order.orderId);
    assert.equal(view.kitchenEffectId, null);
    assert.equal(
      Number(
        (
          await f.pool.query(
            "SELECT COUNT(*) count FROM commerce_outbox WHERE event_type='fiscal.submit_requested'",
          )
        ).rows[0].count,
      ),
      2,
    );
    await assert.rejects(
      f.repo.requestRefund(f.manager, randomUUID(), { ...request, amountMinor: '1' }),
      { code: 'REFUND_LIMIT' },
    );
  }));

test('late actual refund after failure is retained with reconciliation when replacement funds were reserved', () =>
  fixture(async (f) => {
    const value = await f.captured();
    const request = {
      orderId: value.order.orderId,
      captureId: value.capture.id,
      amountMinor: '100000',
      reason: 'Synthetic failure sequence',
    };
    const first = await f.repo.requestRefund(f.manager, randomUUID(), request);
    await f.repo.observeRefund(f.provider, {
      eventId: randomUUID(),
      refundId: first.refundId,
      outcome: 'failed',
      occurredAt: now(),
    });
    await f.repo.requestRefund(f.manager, randomUUID(), request);
    await f.repo.observeRefund(f.provider, {
      eventId: randomUUID(),
      refundId: first.refundId,
      outcome: 'succeeded',
      operationId: randomUUID(),
      amountMinor: '100000',
      occurredAt: now(),
    });
    const view = await f.repo.readOrder(f.scope, value.order.orderId);
    assert.equal(view.money.refunded, '100000');
    assert.equal(view.money.reserved, '100000');
    assert.equal(view.attentionRequired, true);
    assert.ok(view.issues.some((i) => i.code === 'REFUND_EXPOSURE_EXCEEDS_CAPTURE'));
  }));

test('a distinct second actual refund or fiscal document is preserved and flagged', () =>
  fixture(async (f) => {
    const value = await f.captured();
    await f.issueSale(value.sale);
    await f.issueSale(value.sale);
    let view = await f.repo.readOrder(f.scope, value.order.orderId);
    const kitchenId = view.kitchenEffectId;
    assert.equal(await f.count('commerce_fiscal_effects'), 2);
    assert.equal(view.attentionRequired, true);
    const request = {
      orderId: value.order.orderId,
      captureId: value.capture.id,
      amountMinor: '30000',
      reason: 'Synthetic correction',
    };
    await assert.rejects(f.repo.requestRefund(f.manager, randomUUID(), request), {
      code: 'NOT_READY',
    });
    const refund = await f.repo.requestRefund(f.manager, randomUUID(), {
      ...request,
      fulfillmentPolicy: 'manager_reviewed',
    });
    for (let i = 0; i < 2; i++)
      await f.repo.observeRefund(f.provider, {
        eventId: randomUUID(),
        refundId: refund.refundId,
        outcome: 'succeeded',
        operationId: randomUUID(),
        amountMinor: '30000',
        occurredAt: now(),
      });
    view = await f.repo.readOrder(f.scope, value.order.orderId);
    assert.equal(view.money.refunded, '60000');
    assert.equal(view.kitchenEffectId, kitchenId);
    assert.ok(view.issues.some((i) => i.code === 'UNEXPECTED_REFUND_EFFECT'));
  }));

test('capture + inbox + fiscal + outbox roll back together on a late transaction failure', () =>
  fixture(async (f) => {
    const value = await f.ready(),
      event = observation(value.attempt);
    await f.pool
      .query(`CREATE FUNCTION injected_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='payment.capture_recorded' THEN RAISE EXCEPTION 'synthetic rollback'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER injected_failure BEFORE INSERT ON commerce_outbox FOR EACH ROW EXECUTE FUNCTION injected_failure()`);
    await assert.rejects(f.repo.observePayment(f.provider, event), /synthetic rollback/);
    assert.equal(await f.count('commerce_captures'), 0);
    assert.equal(await f.count('commerce_provider_inbox'), 0);
    assert.equal(await f.count('commerce_fiscal_documents'), 0);
    assert.equal(
      (await f.repo.readOrder(f.scope, value.order.orderId)).attempts[0].state,
      'pending',
    );
    await f.pool.query('DROP TRIGGER injected_failure ON commerce_outbox');
    await f.repo.observePayment(f.provider, event);
    assert.equal(await f.count('commerce_captures'), 1);
  }));

test('refund reservation/command/outbox roll back atomically and can retry unchanged', () =>
  fixture(async (f) => {
    const value = await f.captured(),
      key = randomUUID(),
      request = {
        orderId: value.order.orderId,
        captureId: value.capture.id,
        amountMinor: '50000',
        reason: 'Synthetic rollback',
      };
    await f.pool
      .query(`CREATE FUNCTION injected_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='refund.submit_requested' THEN RAISE EXCEPTION 'synthetic rollback'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER injected_failure BEFORE INSERT ON commerce_outbox FOR EACH ROW EXECUTE FUNCTION injected_failure()`);
    await assert.rejects(f.repo.requestRefund(f.manager, key, request), /synthetic rollback/);
    assert.equal(await f.count('commerce_refunds'), 0);
    assert.equal((await f.repo.readOrder(f.scope, value.order.orderId)).money.reserved, '0');
    await f.pool.query('DROP TRIGGER injected_failure ON commerce_outbox');
    await f.repo.requestRefund(f.manager, key, request);
    assert.equal(await f.count('commerce_refunds'), 1);
  }));

test('wrong organization/account cannot observe money or read another principal order', () =>
  fixture(async (f) => {
    const value = await f.ready();
    const event = observation(value.attempt);
    await assert.rejects(
      f.repo.observePayment({ ...f.provider, organizationId: randomUUID() }, event),
      { code: 'FORBIDDEN' },
    );
    await assert.rejects(f.repo.observePayment(f.fiscalProvider, event), { code: 'FORBIDDEN' });
    await assert.rejects(
      f.repo.readOrder({ ...f.scope, branchId: randomUUID() }, value.order.orderId),
      { code: 'NOT_FOUND' },
    );
    await f.pool.query('UPDATE commerce_provider_accounts SET enabled=false WHERE id=$1', [
      f.payment,
    ]);
    await f.repo.observePayment(f.provider, event);
    assert.equal(await f.count('commerce_captures'), 1);
  }));

test('parallel outbox leases are disjoint; expired leases need a fresh token and ACK is idempotent', () =>
  fixture(async (f) => {
    const value = await f.captured();
    await f.issueSale(value.sale);
    const workerA = randomUUID(),
      workerB = randomUUID();
    const [a, b] = await Promise.all([
      f.repo.claimOutbox(f.manager, { workerId: workerA, limit: 2, leaseSeconds: 30 }),
      f.repo.claimOutbox(f.manager, { workerId: workerB, limit: 100, leaseSeconds: 30 }),
    ]);
    const ids = [...a, ...b].map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(a.length > 0 && b.length > 0);
    const event = a[0];
    const ack = { eventId: event.id, workerId: workerA, leaseToken: event.lease_token };
    await assert.rejects(
      f.repo.acknowledgeOutbox(f.manager, { ...ack, leaseToken: randomUUID() }),
      { code: 'CONFLICT' },
    );
    await f.pool.query(
      "UPDATE commerce_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [event.id],
    );
    const next = await f.repo.claimOutbox(f.manager, {
      workerId: workerB,
      limit: 100,
      leaseSeconds: 30,
    });
    assert.equal(next.length, 1);
    await assert.rejects(f.repo.acknowledgeOutbox(f.manager, ack), { code: 'CONFLICT' });
    const good = { eventId: event.id, workerId: workerB, leaseToken: next[0].lease_token };
    assert.deepEqual(
      await f.repo.acknowledgeOutbox(f.manager, good),
      await f.repo.acknowledgeOutbox(f.manager, good),
    );
  }));

test('restricted runtime DML role completes commerce without DDL, deletes or account changes', () =>
  fixture(async (f) => {
    const role = 'commerce_runtime_' + randomUUID().replaceAll('-', '');
    await f.admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    let runtime;
    try {
      await f.pool.query(`GRANT USAGE ON SCHEMA ${f.schema} TO ${role};
      GRANT SELECT ON branches,devices,menu_releases,commerce_provider_accounts TO ${role};
      GRANT SELECT,INSERT ON commerce_quotes,commerce_orders,commerce_payment_intents,commerce_payment_attempts,
        commerce_captures,commerce_refunds,commerce_refund_effects,commerce_fiscal_documents,commerce_fiscal_effects,
        commerce_commands,commerce_provider_inbox,commerce_edge_inbox,commerce_reconciliation_issues,commerce_outbox TO ${role};
      GRANT UPDATE ON commerce_orders,commerce_payment_intents,commerce_payment_attempts,commerce_refunds,commerce_fiscal_documents,commerce_outbox TO ${role};
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${f.schema} TO ${role}`);
      const url = new URL(f.url);
      url.searchParams.set('options', `-c search_path=${f.schema} -c role=${role}`);
      runtime = createPool(url.toString(), 5);
      const repo = new CommerceRepository(runtime);
      const quote = await repo.issueQuote(f.scope, randomUUID(), f.priced());
      const order = await repo.createOrder(f.scope, randomUUID(), {
        quoteId: quote.quoteId,
        fiscalAccountId: f.fiscal,
      });
      await repo.confirmAdmission(f.edge, {
        eventId: randomUUID(),
        orderId: order.orderId,
        reservationId: randomUUID(),
        quoteDigest: quote.digest,
      });
      const attempt = await repo.startPaymentAttempt(f.scope, randomUUID(), {
        orderId: order.orderId,
        providerAccountId: f.payment,
      });
      await repo.observePayment(f.provider, observation(attempt));
      const view = await repo.readOrder(f.scope, order.orderId);
      const sale = view.fiscalDocuments[0];
      await repo.observeFiscal(f.fiscalProvider, {
        eventId: randomUUID(),
        documentId: sale.id,
        outcome: 'issued',
        providerDocumentId: randomUUID(),
        fiscalMark: 'synthetic',
        receiptUrl: 'https://example.invalid/receipt',
        amountMinor: sale.amount_minor,
        occurredAt: now(),
      });
      assert.ok((await repo.readOrder(f.scope, order.orderId)).kitchenEffectId);
      await assert.rejects(runtime.query('DELETE FROM commerce_captures'), { code: '42501' });
      await assert.rejects(runtime.query('UPDATE commerce_provider_accounts SET enabled=false'), {
        code: '42501',
      });
      await assert.rejects(runtime.query('CREATE TABLE should_not_exist(id int)'), {
        code: '42501',
      });
    } finally {
      await runtime?.end();
      await f.admin.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
    }
  }));

test('database guard independently blocks excess refund inserts and mutable account identity', () =>
  fixture(async (f) => {
    const value = await f.captured();
    await f.repo.requestRefund(f.manager, randomUUID(), {
      orderId: value.order.orderId,
      captureId: value.capture.id,
      amountMinor: '60000',
      reason: 'Synthetic reserved',
    });
    await assert.rejects(
      f.pool.query(
        "INSERT INTO commerce_refunds(id,order_id,capture_id,account_id,principal_id,amount_minor,reason) VALUES($1,$2,$3,$4,$5,50000,'Synthetic direct excess')",
        [randomUUID(), value.order.orderId, value.capture.id, f.payment, f.manager.principalId],
      ),
      { code: '23514' },
    );
    await assert.rejects(
      f.pool.query(
        "UPDATE commerce_provider_accounts SET external_reference='replacement' WHERE id=$1",
        [f.payment],
      ),
      { code: '23514' },
    );
    assert.equal((await f.repo.readOrder(f.scope, value.order.orderId)).money.reserved, '60000');
  }));
