import { orderRecipeGrants } from '../../../infra/staging/backoffice-grants.mjs';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, URLSearchParams } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { fixtureMenu } from '@pickchick/test-fixtures';
import { CommerceRepository, CustomerCheckout, digest } from '../dist/index.js';
import { publishCatalog } from './catalog-fixture.mjs';

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
      GRANT SELECT ON branches,devices,menu_releases,commerce_provider_accounts,catalog_publications,catalog_branch_heads TO ${role};
      GRANT UPDATE(lock_anchor) ON catalog_branch_heads TO ${role};
      -- Commerce reads the transport-owned admission guard; it cannot configure it.
      GRANT SELECT ON fulfillment_transport_bindings,cloud_fulfillment_projection,commerce_cancellation_intents TO ${role};
      GRANT UPDATE(lock_anchor) ON fulfillment_transport_bindings TO ${role};
      GRANT SELECT,INSERT ON commerce_quotes,commerce_orders,commerce_payment_intents,commerce_payment_attempts,
        commerce_captures,commerce_refunds,commerce_refund_effects,commerce_fiscal_documents,commerce_fiscal_effects,
        commerce_commands,commerce_provider_inbox,commerce_edge_inbox,commerce_reconciliation_issues,commerce_outbox TO ${role};
      GRANT UPDATE ON commerce_orders,commerce_payment_intents,commerce_payment_attempts,commerce_refunds,commerce_fiscal_documents,commerce_outbox TO ${role};
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${f.schema} TO ${role}`);
      await f.pool.query(orderRecipeGrants(role));
      const url = new URL(f.url);
      url.searchParams.set('options', `-c search_path=${f.schema} -c role=${role}`);
      runtime = createPool(url.toString(), 5);
      const repo = new CommerceRepository(runtime);
      const legacy = await repo.issueQuote(f.scope, randomUUID(), f.priced());
      assert.ok(legacy.snapshot.releaseId);
      const pub = await publishCatalog(f);
      const quote = await repo.issueQuote(f.scope, randomUUID(), pub.priced);
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
      await assert.rejects(
        runtime.query('UPDATE catalog_branch_heads SET published_version=NULL'),
        { code: '42501' },
      );
      await assert.rejects(
        runtime.query('UPDATE catalog_publications SET payload_hash=payload_hash'),
        { code: '42501' },
      );
      await assert.rejects(runtime.query('UPDATE catalog_branch_heads SET lock_anchor=false'), {
        code: '23514',
      });
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

test('published quote verifies PG reference and full price/selection snapshot, no arbitrary tax defaults', () =>
  fixture(async (f) => {
    const pub = await publishCatalog(f);
    const commandKey = randomUUID();
    const duplicates = await Promise.all(
      Array.from({ length: 4 }, () => f.repo.issueQuote(f.scope, commandKey, pub.priced)),
    );
    const issued = duplicates[0];
    for (const duplicate of duplicates) assert.deepEqual(duplicate, issued);
    assert.deepEqual(issued.snapshot.catalogReference, pub.reference);
    assert.equal(issued.snapshot.totalMinor, '32000');
    assert.equal(issued.snapshot.releaseId, undefined);
    const row = (
      await f.pool.query(
        'SELECT release_id,catalog_version,catalog_payload_hash,catalog_published_at FROM commerce_quotes WHERE id=$1',
        [issued.quoteId],
      )
    ).rows[0];
    assert.equal(row.release_id, null);
    assert.equal(row.catalog_version, 1);
    assert.equal(row.catalog_payload_hash, pub.reference.payloadHash);
    assert.equal(row.catalog_published_at.toISOString(), pub.reference.publishedAt);
    const missing = globalThis.structuredClone(pub.priced);
    delete missing.taxBinding;
    await assert.rejects(f.repo.issueQuote(f.scope, randomUUID(), missing), { code: 'INVALID' });
    const wrongTax = {
      ...pub.priced,
      taxBinding: { ...pub.priced.taxBinding, legalEntityId: randomUUID() },
    };
    await assert.rejects(f.repo.issueQuote(f.scope, randomUUID(), wrongTax), { code: 'FORBIDDEN' });
    for (const [field, value] of [
      ['payloadHash', '0'.repeat(64)],
      ['publishedAt', '2000-01-01T00:00:00.000Z'],
      ['version', 2],
    ])
      await assert.rejects(
        f.repo.issueQuote(f.scope, randomUUID(), {
          ...pub.priced,
          catalogReference: { ...pub.reference, [field]: value },
        }),
        { code: 'CONFLICT' },
      );
    await assert.rejects(
      f.repo.issueQuote(f.scope, randomUUID(), {
        ...pub.priced,
        catalogReference: { ...pub.reference, organizationId: randomUUID() },
      }),
      { code: 'FORBIDDEN' },
    );
    for (const mutate of [
      (q) => {
        q.lines[0].selectedDetails.ingredients.ru = 'Forged';
      },
      (q) => {
        q.lines[0].selectedDetails.nutrition.declaration.energy_kcal = 99;
      },
      (q) => {
        q.lines.find(
          (l) => l.selectedDetails.modifiers.length,
        ).selectedDetails.modifiers[0].label.ru = 'Forged';
      },
      (q) => {
        q.lines.find(
          (l) => l.selectedDetails.components.length,
        ).selectedDetails.components[0].ingredients.ru = 'Forged';
      },
      (q) => {
        q.lines[0].productId = 'other';
      },
      (q) => {
        q.lines[0].lineId = randomUUID();
      },
    ]) {
      const bad = globalThis.structuredClone(pub.priced);
      mutate(bad);
      await assert.rejects(f.repo.issueQuote(f.scope, randomUUID(), bad), { code: 'INVALID' });
    }
    const underpriced = globalThis.structuredClone(pub.priced),
      changed = underpriced.lines.find((l) => l.selectedDetails.modifiers.length);
    changed.baseUnitPriceMinor = '9000';
    changed.unitPriceMinor = '10000';
    changed.grossMinor = (10000n * BigInt(changed.quantity)).toString();
    changed.totalMinor = changed.grossMinor;
    underpriced.totalMinor = underpriced.lines
      .reduce((sum, l) => sum + BigInt(l.totalMinor), 0n)
      .toString();
    underpriced.subtotalMinor = underpriced.totalMinor;
    await assert.rejects(f.repo.issueQuote(f.scope, randomUUID(), underpriced), {
      code: 'INVALID',
    });
    assert.equal(await f.count('commerce_quotes'), 1);
  }));

test('new publication rejects stale issuance but valid pinned quote and idempotent replay survive', () =>
  fixture(async (f) => {
    const pub = await publishCatalog(f),
      key = randomUUID();
    const quote = await f.repo.issueQuote(f.scope, key, pub.priced);
    const newer = await publishCatalog(f, { version: 2, price: '20000' });
    await assert.rejects(f.repo.issueQuote(f.scope, randomUUID(), pub.priced), {
      code: 'CONFLICT',
    });
    assert.deepEqual(await f.repo.issueQuote(f.scope, key, pub.priced), quote);
    await assert.rejects(f.repo.issueQuote(f.scope, key, newer.priced), { code: 'CONFLICT' });
    const order = await f.repo.createOrder(f.scope, randomUUID(), {
      quoteId: quote.quoteId,
      fiscalAccountId: f.fiscal,
    });
    const view = await f.repo.readOrder(f.scope, order.orderId);
    assert.equal(view.snapshot.catalogReference.version, 1);
    assert.equal(view.snapshot.totalMinor, '32000');
    const next = await f.repo.issueQuote(f.scope, randomUUID(), newer.priced);
    assert.equal(next.snapshot.totalMinor, '62000');
    await f.pool.query('UPDATE branches SET ordering_enabled=false WHERE id=$1', [
      f.scope.branchId,
    ]);
    await assert.rejects(f.repo.issueQuote(f.scope, randomUUID(), newer.priced), {
      code: 'NOT_READY',
    });
  }));

test('publication lock is observed by concurrent issuance, with no stale quote committed', () =>
  fixture(async (f) => {
    const pub = await publishCatalog(f),
      publisher = await f.pool.connect();
    let started;
    try {
      await publisher.query('BEGIN');
      const pid = (await publisher.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await publisher.query('SELECT 1 FROM catalog_branch_heads WHERE branch_id=$1 FOR UPDATE', [
        f.scope.branchId,
      ]);
      started = f.repo.issueQuote(f.scope, randomUUID(), pub.priced).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      let waiting = false;
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        waiting = !!(
          await f.pool.query(
            'SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) LIMIT 1',
            [pid],
          )
        ).rowCount;
        if (waiting) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(waiting, true, 'issueQuote must wait on the actual publication head lock');
      await publishCatalog(f, { version: 2, db: publisher });
      await publisher.query('COMMIT');
      const result = await started;
      assert.equal(result.error?.code, 'CONFLICT');
      assert.equal(await f.count('commerce_quotes'), 0);
    } finally {
      await publisher.query('ROLLBACK');
      publisher.release();
      await started;
    }
  }));

test('original selected options/nutrition/tax binding survive order, sale and refund after publication changes', () =>
  fixture(async (f) => {
    const pub = await publishCatalog(f),
      quote = await f.repo.issueQuote(f.scope, randomUUID(), pub.priced),
      order = await f.repo.createOrder(f.scope, randomUUID(), {
        quoteId: quote.quoteId,
        fiscalAccountId: f.fiscal,
      });
    await publishCatalog(f, { version: 2, price: '20000' });
    await f.repo.confirmAdmission(f.edge, {
      eventId: randomUUID(),
      orderId: order.orderId,
      reservationId: randomUUID(),
      quoteDigest: quote.digest,
    });
    const attempt = await f.repo.startPaymentAttempt(f.scope, randomUUID(), {
      orderId: order.orderId,
      providerAccountId: f.payment,
    });
    await f.repo.observePayment(f.provider, observation(attempt));
    let view = await f.repo.readOrder(f.scope, order.orderId);
    assert.deepEqual(view.snapshot, quote.snapshot);
    assert.deepEqual(view.fiscalDocuments[0].request.snapshot, quote.snapshot);
    const refund = await f.repo.requestRefund(f.manager, randomUUID(), {
      orderId: order.orderId,
      captureId: view.captures[0].id,
      amountMinor: '32000',
      reason: 'Synthetic full refund',
    });
    await f.repo.observeRefund(f.provider, {
      eventId: randomUUID(),
      refundId: refund.refundId,
      outcome: 'succeeded',
      operationId: randomUUID(),
      amountMinor: '32000',
      occurredAt: now(),
    });
    view = await f.repo.readOrder(f.scope, order.orderId);
    assert.equal(view.fiscalDocuments.length, 2);
    for (const document of view.fiscalDocuments)
      assert.deepEqual(document.request.snapshot, quote.snapshot);
    assert.deepEqual(view.snapshot.taxBinding, pub.priced.taxBinding);
    assert.ok(view.snapshot.lines.some((l) => l.selectedDetails.modifiers.length));
    assert.ok(view.snapshot.lines.some((l) => l.selectedDetails.components.length));
    await assert.rejects(
      f.pool.query("UPDATE catalog_publications SET payload_hash=repeat('0',64)"),
    );
    await assert.rejects(
      f.pool.query(
        "UPDATE commerce_orders SET snapshot=jsonb_set(snapshot,'{lines,0,selectedDetails,name,ru}','\"Changed\"')",
      ),
    );
  }));

test('catalog quote command rollback is atomic and database reference guards reject forged dates', () =>
  fixture(async (f) => {
    const pub = await publishCatalog(f);
    await f.pool.query(
      "CREATE FUNCTION reject_catalog_quote_command() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation='quote' THEN RAISE EXCEPTION 'synthetic rollback'; END IF; RETURN NEW; END $$",
    );
    await f.pool.query(
      'CREATE TRIGGER reject_catalog_quote_command BEFORE INSERT ON commerce_commands FOR EACH ROW EXECUTE FUNCTION reject_catalog_quote_command()',
    );
    await assert.rejects(f.repo.issueQuote(f.scope, randomUUID(), pub.priced));
    assert.equal(await f.count('commerce_quotes'), 0);
    assert.equal(await f.count('commerce_commands'), 0);
    await f.pool.query('DROP TRIGGER reject_catalog_quote_command ON commerce_commands');
    const issued = await f.repo.issueQuote(f.scope, randomUUID(), pub.priced);
    await assert.rejects(
      f.pool.query(
        "INSERT INTO commerce_quotes(id,organization_id,branch_id,principal_id,customer_id,release_id,total_minor,currency,snapshot,digest,created_at,expires_at,catalog_version,catalog_payload_hash,catalog_published_at) SELECT $1,organization_id,branch_id,principal_id,customer_id,NULL,total_minor,currency,jsonb_set(snapshot,'{catalogReference,publishedAt}','\"2000-01-01T00:00:00.000Z\"'),digest,created_at,expires_at,catalog_version,catalog_payload_hash,'2000-01-01' FROM commerce_quotes WHERE id=$2",
        [randomUUID(), issued.quoteId],
      ),
      { code: '23514' },
    );
    for (const mutate of [
      (snapshot) => {
        delete snapshot.taxBinding;
      },
      (snapshot) => {
        snapshot.lines[0].taxCode = ' ';
      },
      (snapshot) => {
        snapshot.taxBinding.legalEntityId = randomUUID();
      },
    ]) {
      const snapshot = globalThis.structuredClone(issued.snapshot);
      mutate(snapshot);
      await assert.rejects(
        f.pool.query(
          'INSERT INTO commerce_quotes(id,organization_id,branch_id,principal_id,customer_id,release_id,total_minor,currency,snapshot,digest,created_at,expires_at,catalog_version,catalog_payload_hash,catalog_published_at) SELECT $1,organization_id,branch_id,principal_id,customer_id,NULL,total_minor,currency,$3,digest,created_at,expires_at,catalog_version,catalog_payload_hash,catalog_published_at FROM commerce_quotes WHERE id=$2',
          [randomUUID(), issued.quoteId, snapshot],
        ),
        { code: '23514' },
      );
    }
    assert.equal(await f.count('commerce_quotes'), 1);
  }));

test('TipTopPay signed callbacks commit one capture and one fiscal document under concurrent retries', async () => {
  const { createHmac } = await import('node:crypto');
  const { TipTopPayReceiver } = await import('../dist/index.js');
  const customer = randomUUID();
  await fixture(
    async ({ pool, payment, ready, count, repo, scope }) => {
      const value = await ready();
      const secret = 'synthetic-test-secret-only';
      const receiver = new TipTopPayReceiver(pool, {
        publicId: 'pk_synthetic',
        apiSecret: secret,
        accountId: payment,
        acceptNewPayments: false,
      });
      const fields = {
        TransactionId: '87654321',
        Amount: '1000.00',
        Currency: 'KZT',
        TestMode: '0',
        Status: 'Completed',
        OperationType: 'Payment',
        DateTime: '2026-09-28 08:00:00',
        InvoiceId: value.attempt.attemptId,
        AccountId: customer,
      };
      const send = async (patch = {}, kind = 'pay') => {
        const raw = Buffer.from(new URLSearchParams({ ...fields, ...patch }).toString());
        return receiver.receive(
          kind,
          raw,
          createHmac('sha256', secret).update(raw).digest('base64'),
        );
      };
      for (const patch of [
        { TestMode: '1' },
        { AccountId: randomUUID() },
        { Amount: '1000.01' },
        { Currency: 'USD' },
      ])
        await assert.rejects(send(patch));
      assert.equal(await count('commerce_captures'), 0);
      assert.deepEqual(await send({}, 'check'), { code: 13 });
      const replies = await Promise.all(Array.from({ length: 5 }, () => send()));
      assert.ok(replies.every((r) => r.code === 0));
      assert.equal(await count('commerce_captures'), 1);
      assert.equal(await count('commerce_provider_inbox'), 1);
      assert.equal(await count('commerce_fiscal_documents'), 1);
      const before = await count('commerce_outbox');
      await pool.query('UPDATE commerce_provider_accounts SET enabled=false WHERE id=$1', [
        payment,
      ]);
      assert.deepEqual(
        await send(),
        { code: 0 },
        'late retry after account disabled remains acknowledged',
      );
      assert.equal(await count('commerce_outbox'), before);
      const view = await repo.readOrder(scope, value.order.orderId);
      assert.equal(view.captures.length, 1);
      assert.equal(
        view.fiscalDocuments[0].state,
        'queued',
        'bank capture does not invent a receipt',
      );
    },
    { customerId: customer, paymentProvider: 'tiptoppay', publicId: 'pk_synthetic' },
  );
});

test('customer checkout uses published prices, enforces ownership, and recovers the same order', () =>
  fixture(
    async (f) => {
      await publishCatalog(f);
      await f.pool.query(
        'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
        [f.scope.branchId, f.scope.organizationId, f.edge.deviceId, randomUUID()],
      );
      const customer = f.scope.principalId;
      const otherCustomer = randomUUID();
      const service = new CustomerCheckout(f.pool, {
        ...f.scope,
        paymentAccountId: f.payment,
        customerIds: [customer, otherCustomer],
        maxOrderMinor: '1000000',
        approvalReference: 'Synthetic approved pilot',
      });
      assert.equal((await service.config(customer)).enabled, true);
      const commentQuoteRequest = {
        key: randomUUID(),
        branchId: f.scope.branchId,
        serviceMode: 'dine_in',
        kitchenComment: '  Без лука; подписать пакет  ',
        items: [
          {
            productId: 'burger',
            quantity: 1,
            selections: [{ group_id: 'extra', option_id: 'sauce', quantity: 1 }],
          },
        ],
      };
      const quote = await service.quote(customer, commentQuoteRequest);
      assert.equal(quote.totalMinor, '11000');
      assert.equal((await service.quote(customer, commentQuoteRequest)).quoteId, quote.quoteId);
      await assert.rejects(
        service.quote(customer, { ...commentQuoteRequest, kitchenComment: 'Другой текст' }),
        /CONFLICT/,
      );
      const savedQuote = (
        await f.pool.query('SELECT snapshot,digest FROM commerce_quotes WHERE id=$1', [
          quote.quoteId,
        ])
      ).rows[0];
      assert.equal(savedQuote.snapshot.kitchenComment, 'Без лука; подписать пакет');
      assert.equal(savedQuote.digest, digest(savedQuote.snapshot));
      const capped = new CustomerCheckout(f.pool, {
        ...f.scope,
        paymentAccountId: f.payment,
        customerIds: [customer, otherCustomer],
        maxOrderMinor: '10000',
        approvalReference: 'Synthetic approved pilot',
      });
      await assert.rejects(
        capped.quote(customer, {
          key: randomUUID(),
          branchId: f.scope.branchId,
          serviceMode: 'takeaway',
          items: [{ productId: 'burger', quantity: 2, selections: [] }],
        }),
        /NOT_READY/,
      );
      const request = { key: randomUUID(), quoteId: quote.quoteId };
      await assert.rejects(capped.create(customer, request), /NOT_READY/);
      const [a, b] = await Promise.all([
        service.create(customer, request),
        service.create(customer, request),
      ]);
      assert.equal(a.orderId, b.orderId);
      assert.equal(a.kitchenComment, 'Без лука; подписать пакет');
      assert.equal(b.kitchenComment, a.kitchenComment);
      assert.equal((await service.read(customer, a.orderId)).kitchenComment, a.kitchenComment);
      assert.equal((await service.list(customer)).orders[0].kitchenComment, a.kitchenComment);
      assert.equal(
        (await f.pool.query('SELECT snapshot FROM commerce_orders WHERE id=$1', [a.orderId]))
          .rows[0].snapshot.kitchenComment,
        a.kitchenComment,
      );
      assert.equal(a.phase, 'awaiting_restaurant');
      assert.equal(a.receipt, 'deferred');
      assert.equal(a.branchId, f.scope.branchId);
      assert.equal(a.items[0].totalMinor, '11000');
      assert.equal(a.kitchenStage, null);
      assert.ok(Number.isFinite(Date.parse(a.createdAt)));
      assert.ok(Number.isFinite(Date.parse(a.updatedAt)));
      assert.deepEqual(a.items[0].modifiers, ['Synthetic sauce']);
      await assert.rejects(service.read(randomUUID(), a.orderId), /FORBIDDEN/);
      await assert.rejects(service.read(otherCustomer, a.orderId), /NOT_FOUND/);
      assert.equal((await service.list(otherCustomer)).orders.length, 0);
      await assert.rejects(service.pay(customer, a.orderId), /NOT_READY/);
      assert.equal(await f.count('commerce_payment_attempts'), 0);
      assert.equal((await service.list(customer)).orders.length, 1);
      const otherQuote = await service.quote(customer, {
        key: randomUUID(),
        branchId: f.scope.branchId,
        serviceMode: 'takeaway',
        items: [{ productId: 'burger', quantity: 1, selections: [] }],
      });
      await assert.rejects(
        service.create(customer, { key: randomUUID(), quoteId: otherQuote.quoteId }),
        /NOT_READY/,
      );
      const repeat = new CustomerCheckout(f.pool, {
        ...f.scope,
        paymentAccountId: f.payment,
        customerIds: [customer],
        maxOrderMinor: '1000000',
        approvalReference: 'Synthetic approved repeated owner pilot',
        repeatOrdersEnabled: true,
      });
      const repeatedRequest = { key: randomUUID(), quoteId: otherQuote.quoteId };
      const [second, replay] = await Promise.all([
        repeat.create(customer, repeatedRequest),
        repeat.create(customer, repeatedRequest),
      ]);
      assert.notEqual(second.orderId, a.orderId);
      assert.equal(second.orderId, replay.orderId);
      assert.equal(second.totalMinor, '10000');
      assert.equal(second.kitchenComment, null);
      assert.equal((await repeat.list(customer)).orders.length, 2);
      assert.equal(await f.count('commerce_payment_attempts'), 0);
      await assert.rejects(repeat.config(otherCustomer), /FORBIDDEN/);
      // A client cannot opt itself into the repeated-order server policy.
      await assert.rejects(
        service.create(customer, { ...repeatedRequest, repeatOrdersEnabled: true }),
        /INVALID/,
      );
      const forged = {
        key: randomUUID(),
        branchId: f.scope.branchId,
        serviceMode: 'dine_in',
        items: [{ productId: 'burger', quantity: 1, selections: [] }],
        totalMinor: '100',
      };
      await assert.rejects(service.quote(customer, forged), /INVALID/);
      await assert.rejects(
        service.quote(customer, { ...forged, totalMinor: undefined }),
        /INVALID/,
      );
      await assert.rejects(
        service.quote(customer, {
          ...commentQuoteRequest,
          key: randomUUID(),
          kitchenComment: 'x'.repeat(61),
        }),
        /INVALID/,
      );
      const blankQuote = await service.quote(customer, {
        key: randomUUID(),
        branchId: f.scope.branchId,
        serviceMode: 'takeaway',
        kitchenComment: '  ',
        items: [{ productId: 'burger', quantity: 1, selections: [] }],
      });
      const blankSnapshot = (
        await f.pool.query('SELECT snapshot FROM commerce_quotes WHERE id=$1', [blankQuote.quoteId])
      ).rows[0].snapshot;
      assert.equal(Object.hasOwn(blankSnapshot, 'kitchenComment'), false);
      const disabled = new CustomerCheckout(f.pool, null);
      await assert.rejects(disabled.config(customer), /FORBIDDEN/);
    },
    { paymentProvider: 'kaspi-remote' },
  ));

test('checkout recovers old create commands after rollout approval changes without new financial effects', () =>
  fixture(
    async (f) => {
      await publishCatalog(f);
      await f.pool.query(
        'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
        [f.scope.branchId, f.scope.organizationId, f.edge.deviceId, randomUUID()],
      );
      const customer = f.scope.principalId;
      const other = randomUUID();
      const options = {
        ...f.scope,
        paymentAccountId: f.payment,
        customerIds: [customer, other],
        maxOrderMinor: '1000000',
        repeatOrdersEnabled: true,
        approvalReference: 'Synthetic owner approval',
      };
      const original = new CustomerCheckout(f.pool, options);
      const input = {
        key: randomUUID(),
        branchId: f.scope.branchId,
        serviceMode: 'takeaway',
        items: [{ productId: 'burger', quantity: 1, selections: [] }],
      };
      const quote = await original.quote(customer, input);
      const request = { key: randomUUID(), quoteId: quote.quoteId };
      const created = await original.create(customer, request);
      const before = (
        await f.pool.query(
          "SELECT request_digest,result FROM commerce_commands WHERE operation='order'",
        )
      ).rows;
      const updated = new CustomerCheckout(f.pool, {
        ...options,
        approvalReference: 'Synthetic public approval',
      });
      const replies = await Promise.all([
        updated.create(customer, request),
        updated.create(customer, request),
      ]);
      assert.ok(replies.every((r) => r.orderId === created.orderId));
      assert.deepEqual(
        (
          await f.pool.query(
            "SELECT request_digest,result FROM commerce_commands WHERE operation='order'",
          )
        ).rows,
        before,
      );
      assert.equal(await f.count('commerce_orders'), 1);
      assert.equal(await f.count('commerce_payment_attempts'), 0);
      assert.equal(await f.count('commerce_kaspi_invoices'), 0);
      assert.equal(await f.count('commerce_captures'), 0);
      await assert.rejects(updated.create(other, request), /NOT_FOUND/);
      const nextQuote = await updated.quote(customer, { ...input, key: randomUUID() });
      await assert.rejects(
        updated.create(customer, { ...request, quoteId: nextQuote.quoteId }),
        /CONFLICT/,
      );
      const next = await updated.create(customer, {
        key: randomUUID(),
        quoteId: nextQuote.quoteId,
      });
      const policies = (
        await f.pool.query('SELECT id,fiscal_deferral_reference FROM commerce_orders')
      ).rows;
      assert.equal(
        policies.find((r) => r.id === created.orderId).fiscal_deferral_reference,
        options.approvalReference,
      );
      assert.equal(
        policies.find((r) => r.id === next.orderId).fiscal_deferral_reference,
        'Synthetic public approval',
      );
    },
    { paymentProvider: 'kaspi-remote' },
  ));

test('checkout runtime can quote/create/read but cannot forge payment or publish prices', () =>
  fixture(
    async (f) => {
      const { customerCheckoutGrants } = await import('../../../infra/staging/checkout-grants.mjs');
      const { customerAuthGrants } =
        await import('../../../infra/staging/customer-auth-grants.mjs');
      await publishCatalog(f);
      await f.pool.query(
        'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
        [f.scope.branchId, f.scope.organizationId, f.edge.deviceId, randomUUID()],
      );
      const role = 'checkout_' + randomUUID().replaceAll('-', '');
      await f.admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      let runtime;
      try {
        await f.pool.query(`GRANT USAGE ON SCHEMA ${f.schema} TO ${role}`);
        const { fulfillmentTransportGrants } =
          await import('../../../infra/staging/fulfillment-transport-grants.mjs');
        const { backofficeGrants } = await import('../../../infra/staging/backoffice-grants.mjs');
        await f.pool.query(fulfillmentTransportGrants(role, true));
        await f.pool.query(backofficeGrants(role, false));
        await f.pool.query(customerCheckoutGrants(role, true));
        await f.pool.query(customerAuthGrants(role, true));
        await f.pool.query(
          "INSERT INTO identity_customers(id,phone_lookup,phone_cipher,profile_cipher,created_at) VALUES($1,$2,'synthetic-cipher','synthetic-profile',clock_timestamp())",
          [f.scope.principalId, digest(f.scope.principalId)],
        );
        await f.pool.query(orderRecipeGrants(role));
        const url = new URL(f.url);
        url.searchParams.set('options', `-c search_path=${f.schema} -c role=${role}`);
        runtime = createPool(url.toString(), 2);
        const service = new CustomerCheckout(runtime, {
          ...f.scope,
          paymentAccountId: f.payment,
          customerIds: [randomUUID()],
          allVerifiedCustomers: true,
          maxOrderMinor: '10000',
          approvalReference: 'Synthetic pilot',
        });
        const customer = f.scope.principalId;
        assert.equal((await service.config(customer)).enabled, true);
        const quote = await service.quote(customer, {
          key: randomUUID(),
          branchId: f.scope.branchId,
          serviceMode: 'takeaway',
          items: [{ productId: 'burger', quantity: 1, selections: [] }],
        });
        const request = { key: randomUUID(), quoteId: quote.quoteId };
        const a = await service.create(customer, request);
        assert.equal(a.phase, 'awaiting_restaurant');
        assert.equal((await service.create(customer, request)).orderId, a.orderId);
        const upgraded = new CustomerCheckout(runtime, {
          ...f.scope,
          paymentAccountId: f.payment,
          customerIds: [randomUUID()],
          allVerifiedCustomers: true,
          maxOrderMinor: '10000',
          approvalReference: 'Synthetic expanded approval',
        });
        assert.equal((await upgraded.create(customer, request)).orderId, a.orderId);
        assert.equal((await service.list(customer)).orders.length, 1);
        await assert.rejects(service.pay(customer, a.orderId), /NOT_READY/);
        // Trusted edge fixture; the customer role cannot assert admission.
        const stored = await f.repo.readOrder(f.scope, a.orderId);
        const reservationId = randomUUID();
        await f.repo.confirmAdmission(f.edge, {
          eventId: randomUUID(),
          orderId: a.orderId,
          reservationId,
          quoteDigest: digest(stored.snapshot),
        });
        await f.pool.query(
          `INSERT INTO cloud_fulfillment_projection(order_id,branch_id,organization_id,device_id,reservation_id,quote_id,quote_hash,owner_hash,version,state,routing_version,payload)
          VALUES($1,$2,$3,$4,$5,$6,$7,$7,1,'held',1,'{}')`,
          [
            a.orderId,
            f.scope.branchId,
            f.scope.organizationId,
            f.edge.deviceId,
            reservationId,
            quote.quoteId,
            digest(stored.snapshot),
          ],
        );
        assert.equal((await service.pay(customer, a.orderId)).phase, 'sending');
        await service.pay(customer, a.orderId);
        assert.equal(await f.count('commerce_payment_attempts'), 1);
        for (const sql of [
          'DELETE FROM commerce_orders',
          'UPDATE commerce_quotes SET total_minor=1',
          'UPDATE commerce_provider_accounts SET enabled=false',
          'INSERT INTO commerce_captures DEFAULT VALUES',
          'INSERT INTO commerce_provider_inbox DEFAULT VALUES',
          'UPDATE catalog_branch_heads SET published_version=1',
          "UPDATE commerce_kaspi_invoices SET state='paid'",
        ])
          await assert.rejects(runtime.query(sql), /permission denied/);
        await f.pool.query(customerCheckoutGrants(role, false));
        await assert.rejects(
          service.quote(customer, {
            key: randomUUID(),
            branchId: f.scope.branchId,
            serviceMode: 'takeaway',
            items: [{ productId: 'burger', quantity: 1, selections: [] }],
          }),
          /permission denied/,
        );
      } finally {
        await runtime?.end();
        await f.pool.query(`DROP OWNED BY ${role}`);
        await f.admin.query(`DROP ROLE ${role}`);
      }
    },
    { paymentProvider: 'kaspi-remote' },
  ));

test('all-customer checkout admits active verified identities but isolates each customer', () =>
  fixture(
    async (f) => {
      await publishCatalog(f);
      await f.pool.query(
        'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
        [f.scope.branchId, f.scope.organizationId, f.edge.deviceId, randomUUID()],
      );
      const first = randomUUID(),
        second = randomUUID(),
        deleted = randomUUID();
      for (const id of [first, second])
        await f.pool.query(
          "INSERT INTO identity_customers(id,phone_lookup,phone_cipher,profile_cipher,created_at) VALUES($1,$2,'synthetic-cipher','synthetic-profile',clock_timestamp())",
          [id, digest(id)],
        );
      await f.pool.query(
        'INSERT INTO identity_customers(id,created_at,deleted_at) VALUES($1,clock_timestamp(),clock_timestamp())',
        [deleted],
      );
      const options = {
        ...f.scope,
        paymentAccountId: f.payment,
        customerIds: [f.scope.principalId],
        maxOrderMinor: '1000000',
        approvalReference: 'Synthetic all-customer approval',
        repeatOrdersEnabled: true,
      };
      const limited = new CustomerCheckout(f.pool, options);
      await assert.rejects(limited.config(first), /FORBIDDEN/);
      const service = new CustomerCheckout(f.pool, { ...options, allVerifiedCustomers: true });
      for (const id of [first, second]) assert.equal((await service.config(id)).enabled, true);
      for (const id of [randomUUID(), deleted, f.scope.principalId]) {
        await assert.rejects(service.config(id), /FORBIDDEN/);
        await assert.rejects(service.list(id), /FORBIDDEN/);
      }
      const request = () => ({
        key: randomUUID(),
        branchId: f.scope.branchId,
        serviceMode: 'takeaway',
        items: [{ productId: 'burger', quantity: 1, selections: [] }],
      });
      const quote = await service.quote(first, request());
      await assert.rejects(
        service.create(second, { key: randomUUID(), quoteId: quote.quoteId }),
        /NOT_FOUND/,
      );
      const order = await service.create(first, { key: randomUUID(), quoteId: quote.quoteId });
      await assert.rejects(service.read(second, order.orderId), /NOT_FOUND/);
      assert.equal((await service.list(second)).orders.length, 0);
      const nextQuote = await service.quote(first, request());
      const again = await service.create(first, { key: randomUUID(), quoteId: nextQuote.quoteId });
      assert.notEqual(order.orderId, again.orderId);
      const secondQuote = await service.quote(second, request());
      assert.equal(secondQuote.totalMinor, '10000');
      for (const extra of [{ allVerifiedCustomers: true }, { customerId: first }])
        await assert.rejects(service.quote(second, { ...request(), ...extra }), /INVALID/);
      assert.equal(await f.count('commerce_payment_attempts'), 0);
      assert.equal(await f.count('commerce_captures'), 0);
    },
    { paymentProvider: 'kaspi-remote' },
  ));

test('cashier stop rejects base and modifier; stale or inactive device fails closed', () =>
  fixture(async (f) => {
    const { assertBranchItemsAvailable, AvailabilityError } = await import('../dist/index.js');
    const { localSelectionIds } = await import('@pickchick/menu-sync');
    await publishCatalog(f);
    await f.pool.query(
      'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
      [f.scope.branchId, f.scope.organizationId, f.edge.deviceId, randomUUID()],
    );
    const item = {
      productId: 'pick-combo',
      selections: [{ group_id: 'drink', option_id: 'cola', quantity: 1 }],
    };
    const ids = localSelectionIds(f.scope.branchId, item.productId, item.selections);
    for (const id of ids) {
      await f.pool.query(
        'UPDATE cloud_branch_availability SET stopped_ids=$1::uuid[],observed_at=now()',
        [[id]],
      );
      await assert.rejects(
        assertBranchItemsAvailable(f.pool, f.scope.branchId, [item]),
        (e) => e instanceof AvailabilityError && e.code === 'ITEM_STOPPED',
      );
    }
    await f.pool.query(
      "UPDATE cloud_branch_availability SET stopped_ids='{}',observed_at=now()-interval '1 minute'",
    );
    await assert.rejects(
      assertBranchItemsAvailable(f.pool, f.scope.branchId, [item]),
      (e) => e.code === 'AVAILABILITY_STALE',
    );
    await f.pool.query('UPDATE cloud_branch_availability SET observed_at=now()');
    await assertBranchItemsAvailable(f.pool, f.scope.branchId, [item]);
    await f.pool.query('UPDATE fulfillment_transport_bindings SET active=false');
    await assert.rejects(
      assertBranchItemsAvailable(f.pool, f.scope.branchId, [item]),
      (e) => e.code === 'AVAILABILITY_STALE',
    );
  }));

test('mobile quote and new payment reject a stopped product using product id rather than SKU', () =>
  fixture(
    async (f) => {
      const { localSelectionIds } = await import('@pickchick/menu-sync');
      await publishCatalog(f);
      await f.pool.query(
        'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
        [f.scope.branchId, f.scope.organizationId, f.edge.deviceId, randomUUID()],
      );
      const service = new CustomerCheckout(f.pool, {
        ...f.scope,
        paymentAccountId: f.payment,
        customerIds: [f.scope.principalId],
        maxOrderMinor: '1000000',
        approvalReference: 'Synthetic stop verification',
        repeatOrdersEnabled: true,
      });
      const item = { productId: 'burger', quantity: 1, selections: [] };
      const req = () => ({
        key: randomUUID(),
        branchId: f.scope.branchId,
        serviceMode: 'takeaway',
        items: [item],
      });
      const quote = await service.quote(f.scope.principalId, req());
      const order = await service.create(f.scope.principalId, {
        key: randomUUID(),
        quoteId: quote.quoteId,
      });
      const ids = localSelectionIds(f.scope.branchId, item.productId, []);
      await f.pool.query(
        'UPDATE cloud_branch_availability SET stopped_ids=$1::uuid[],observed_at=now()',
        [ids],
      );
      await assert.rejects(
        service.quote(f.scope.principalId, req()),
        (e) => e.code === 'ITEM_STOPPED',
      );
      await assert.rejects(
        service.pay(f.scope.principalId, order.orderId),
        (e) => e.code === 'ITEM_STOPPED',
      );
      assert.equal(await f.count('commerce_payment_attempts'), 0);
      const availability = await service.availability();
      assert.equal(availability.products.find((p) => p.id === 'burger').available, false);
      await f.pool.query("UPDATE cloud_branch_availability SET stopped_ids='{}',observed_at=now()");
      assert.equal((await service.quote(f.scope.principalId, req())).totalMinor, quote.totalMinor);
    },
    { paymentProvider: 'kaspi-remote' },
  ));

test('pending back-office stop blocks quote at once; a pending unstop never unblocks', () =>
  fixture(
    async (f) => {
      const { localSelectionIds } = await import('@pickchick/menu-sync');
      const { branchAvailability } = await import('../dist/index.js');
      await publishCatalog(f);
      await f.pool.query(
        'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
        [f.scope.branchId, f.scope.organizationId, f.edge.deviceId, randomUUID()],
      );
      const service = new CustomerCheckout(f.pool, {
        ...f.scope,
        paymentAccountId: f.payment,
        customerIds: [f.scope.principalId],
        maxOrderMinor: '1000000',
        approvalReference: 'Synthetic remote stop verification',
        repeatOrdersEnabled: true,
      });
      const req = () => ({
        key: randomUUID(),
        branchId: f.scope.branchId,
        serviceMode: 'takeaway',
        items: [{ productId: 'burger', quantity: 1, selections: [] }],
      });
      const [variant] = localSelectionIds(f.scope.branchId, 'burger', []);
      const actor = (await f.pool.query('SELECT id FROM catalog_managers LIMIT 1')).rows[0].id;
      const command = async (stopped, expected) => {
        const id = randomUUID();
        await f.pool.query(
          `INSERT INTO cloud_stop_commands(id,organization_id,branch_id,variant_id,catalog_ref,stopped,duration,reason,expected_version,actor_id,actor_label)
          VALUES($1,$2,$3,$4,'burger',$5,'manual','Synthetic',$6,$7,'Synthetic manager')`,
          [id, f.scope.organizationId, f.scope.branchId, variant, stopped, expected, actor],
        );
        return id;
      };
      const quote = await service.quote(f.scope.principalId, req());
      const stop = await command(true, 0);
      await assert.rejects(
        service.quote(f.scope.principalId, req()),
        (e) => e.code === 'ITEM_STOPPED',
      );
      assert.equal(
        (await service.availability()).products.find((p) => p.id === 'burger').available,
        false,
      );
      // The edge applied it: the projection now carries the stop, the command no longer does.
      await f.pool.query(
        "UPDATE cloud_stop_commands SET state='applied',result_version=1,resolved_at=clock_timestamp() WHERE id=$1",
        [stop],
      );
      await f.pool.query(
        'UPDATE cloud_branch_availability SET stopped_ids=$1::uuid[],observed_at=now()',
        [[variant]],
      );
      await command(false, 1);
      await assert.rejects(
        service.quote(f.scope.principalId, req()),
        (e) => e.code === 'ITEM_STOPPED',
      );
      assert.deepEqual((await branchAvailability(f.pool, f.scope.branchId)).stoppedIds, [variant]);
      // ITEM_STOPPED still wins over a stale heartbeat.
      await f.pool.query(
        "UPDATE cloud_branch_availability SET stopped_ids='{}',observed_at=now()-interval '1 minute'",
      );
      const lapse = () =>
        f.pool.query(
          "UPDATE cloud_stop_commands SET state='expired',resolved_at=clock_timestamp() WHERE state='pending'",
        );
      await lapse();
      await command(true, 0);
      await assert.rejects(
        service.quote(f.scope.principalId, req()),
        (e) => e.code === 'ITEM_STOPPED',
      );
      // A lapsed command no longer blocks; an unanswered one stops counting after 120 s.
      await lapse();
      await f.pool.query('UPDATE cloud_branch_availability SET observed_at=now()');
      assert.equal((await service.quote(f.scope.principalId, req())).totalMinor, quote.totalMinor);
    },
    { paymentProvider: 'kaspi-remote' },
  ));

test('restaurant hours reject new business operations while closed and preserve existing financial recovery', () =>
  fixture(
    async (f) => {
      await publishCatalog(f);
      await f.pool.query(
        'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
        [f.scope.branchId, f.scope.organizationId, f.edge.deviceId, randomUUID()],
      );
      const options = {
        ...f.scope,
        paymentAccountId: f.payment,
        customerIds: [f.scope.principalId],
        maxOrderMinor: '1000000',
        repeatOrdersEnabled: true,
        approvalReference: 'Synthetic hours approval',
        hours: { openingTime: '10:00', closingTime: '00:00', timeZone: 'Asia/Almaty' },
      };
      let clock = new Date('2026-10-02T04:59:59.999Z');
      const service = new CustomerCheckout(f.pool, options, () => clock);
      const request = () => ({
        key: randomUUID(),
        branchId: f.scope.branchId,
        serviceMode: 'takeaway',
        items: [{ productId: 'burger', quantity: 1, selections: [] }],
      });
      const before = await service.availability();
      assert.equal(before.fresh, true);
      assert.equal(before.orderingOpen, false);
      assert.deepEqual(before.hours, options.hours);
      await assert.rejects(
        service.quote(f.scope.principalId, request()),
        (e) => e.code === 'RESTAURANT_CLOSED',
      );
      assert.equal(await f.count('commerce_quotes'), 0);
      clock = new Date('2026-10-02T05:00:00Z');
      const opened = await service.availability();
      assert.equal(opened.orderingOpen, true);
      assert.equal(opened.fresh, true);
      assert.notEqual(opened.signature, before.signature);
      const quote = await service.quote(f.scope.principalId, request());
      const uncreated = await service.quote(f.scope.principalId, request());
      const createRequest = { key: randomUUID(), quoteId: quote.quoteId };
      const order = await service.create(f.scope.principalId, createRequest);
      const stored = await f.repo.readOrder(f.scope, order.orderId);
      await f.repo.confirmAdmission(f.edge, {
        eventId: randomUUID(),
        orderId: order.orderId,
        reservationId: randomUUID(),
        quoteDigest: digest(stored.snapshot),
      });
      const admission = await f.repo.readOrder(f.scope, order.orderId);
      const reservation = (
        await f.pool.query('SELECT admission_reservation_id FROM commerce_orders WHERE id=$1', [
          order.orderId,
        ])
      ).rows[0].admission_reservation_id;
      await f.pool.query(
        `INSERT INTO cloud_fulfillment_projection(order_id,branch_id,organization_id,device_id,reservation_id,quote_id,quote_hash,owner_hash,version,state,routing_version,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7,1,'held',1,'{}')`,
        [
          order.orderId,
          f.scope.branchId,
          f.scope.organizationId,
          f.edge.deviceId,
          reservation,
          quote.quoteId,
          digest(admission.snapshot),
        ],
      );
      clock = new Date('2026-10-02T19:00:00Z');
      assert.equal((await service.availability()).fresh, true);
      assert.equal((await service.availability()).orderingOpen, false);
      await assert.rejects(
        service.create(f.scope.principalId, { key: randomUUID(), quoteId: uncreated.quoteId }),
        (e) => e.code === 'RESTAURANT_CLOSED',
      );
      assert.equal(
        (await service.create(f.scope.principalId, createRequest)).orderId,
        order.orderId,
      );
      await assert.rejects(
        service.pay(f.scope.principalId, order.orderId),
        (e) => e.code === 'RESTAURANT_CLOSED',
      );
      assert.equal(await f.count('commerce_orders'), 1);
      assert.equal(await f.count('commerce_payment_attempts'), 0);
      assert.equal((await service.list(f.scope.principalId)).orders.length, 1);
      clock = new Date('2026-10-03T05:00:00Z');
      const pending = await service.pay(f.scope.principalId, order.orderId);
      assert.equal(pending.phase, 'sending');
      const attempt = (await f.repo.readOrder(f.scope, order.orderId)).attempts[0];
      clock = new Date('2026-10-03T19:00:00Z');
      assert.equal((await service.pay(f.scope.principalId, order.orderId)).phase, 'sending');
      assert.equal(await f.count('commerce_payment_attempts'), 1);
      // Trusted bank settlement may complete an invoice issued before closing.
      await f.repo.observePayment(f.provider, {
        eventId: randomUUID(),
        attemptId: attempt.id,
        outcome: 'captured',
        operationId: randomUUID(),
        amountMinor: stored.totalMinor,
        occurredAt: new Date().toISOString(),
      });
      assert.equal((await service.read(f.scope.principalId, order.orderId)).phase, 'paid');
      assert.equal((await service.pay(f.scope.principalId, order.orderId)).phase, 'paid');
      assert.equal(await f.count('commerce_captures'), 1);
      assert.equal(await f.count('commerce_payment_attempts'), 1);
      const legacy = new CustomerCheckout(f.pool, { ...options, hours: undefined });
      const availability = await legacy.availability();
      assert.equal(Object.hasOwn(availability, 'orderingOpen'), false);
      assert.equal(Object.hasOwn(availability, 'hours'), false);
    },
    { paymentProvider: 'kaspi-remote' },
  ));
