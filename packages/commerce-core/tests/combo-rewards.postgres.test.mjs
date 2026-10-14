import { priceCatalogSnapshot } from '@pickchick/catalog-pricing';
import { customerComboProgress } from '../dist/combo-reward-ledger.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { fixtureMenu } from '@pickchick/test-fixtures';
import { CommerceRepository, digest } from '../dist/index.js';
import { catalogPayload, publishCatalog } from './catalog-fixture.mjs';

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

const options = {
  startsAt: '2026-01-01T00:00:00.000Z',
  approvalReference: 'synthetic-owner-seven-plus-one',
};
async function programme(f, config = options) {
  const payload = catalogPayload();
  payload.products[0].kind = 'combo';
  payload.products.push({ ...payload.products[0], id: 'pick-combo', sku: 'PICK-COMBO' });
  const pub = await publishCatalog(f, { payload });
  const progress = () => customerComboProgress(f.pool, f.scope, config);
  await progress();
  const legal = (
    await f.pool.query('SELECT legal_entity_id FROM branches WHERE id=$1', [f.scope.branchId])
  ).rows[0].legal_entity_id;
  const repo = new CommerceRepository(f.pool, {
    ...f.scope,
    approvalReference: 'synthetic-deferral',
    repeatOrdersEnabled: true,
  });
  const quote = async (quantity, gift = false, extras = false) => {
    const priced = priceCatalogSnapshot(
      { reference: pub.reference, orderingEnabled: true, payload },
      {
        organizationId: f.scope.organizationId,
        branchId: f.scope.branchId,
        customerId: f.scope.principalId,
        channel: 'mobile',
      },
      {
        catalog_version: 1,
        service_mode: 'takeaway',
        items: [
          {
            sku: gift ? 'PICK-COMBO' : 'BURGER',
            quantity,
            selections: extras ? [{ group_id: 'extra', option_id: 'sauce', quantity: 1 }] : [],
          },
        ],
      },
    );
    return repo.issueQuote(
      f.scope,
      randomUUID(),
      {
        ...priced,
        taxBinding: { legalEntityId: legal, approvalReference: 'synthetic', version: 1 },
        lines: priced.lines.map((l) => ({ ...l, taxCode: 'TEST' })),
      },
      gift ? { lineIndex: 0, options: config } : undefined,
    );
  };
  const create = async (q) => repo.createDeferredFiscalOrder(f.scope, randomUUID(), q.quoteId);
  const admit = async (q, o) =>
    repo.confirmAdmission(f.edge, {
      eventId: randomUUID(),
      orderId: o.orderId,
      reservationId: randomUUID(),
      quoteDigest: q.digest,
    });
  const buy = async (quantity) => {
    const q = await quote(quantity),
      o = await create(q);
    await admit(q, o);
    const attempt = await repo.startPaymentAttempt(f.scope, randomUUID(), {
      orderId: o.orderId,
      providerAccountId: f.payment,
    });
    const confirmation = observation(attempt);
    await repo.observePayment(f.provider, confirmation);
    const view = await repo.readOrder(f.scope, o.orderId);
    return { q, o, attempt, confirmation, capture: view.captures[0] };
  };
  return { repo, quote, create, admit, buy, progress };
}
test('commercial 7+1: paid quantities, duplicate bank events, concurrent redemption and zero-total gift', () =>
  fixture(async (f) => {
    const p = await programme(f);
    const unpaid = await p.quote(7);
    await p.create(unpaid);
    assert.equal((await p.progress()).earnedUnits, 0);
    const a = await p.buy(2);
    assert.equal((await p.progress()).visibleStamps, 2);
    await p.repo.observePayment(f.provider, a.confirmation);
    await p.repo.observePayment(f.provider, { ...a.confirmation, eventId: randomUUID() });
    assert.equal((await p.progress()).earnedUnits, 2);
    await p.buy(5);
    assert.equal((await p.progress()).availableGifts, 1);
    const q1 = await p.quote(1, true),
      q2 = await p.quote(1, true);
    assert.equal(q1.snapshot.totalMinor, '0');
    const results = await Promise.allSettled([p.create(q1), p.create(q2)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const index = results.findIndex((r) => r.status === 'fulfilled'),
      o = results[index].value;
    assert.equal((await p.progress()).reservedGifts, 1);
    await p.admit([q1, q2][index], o);
    const state = await p.repo.readOrder(f.scope, o.orderId);
    assert.equal(state.totalMinor, '0');
    assert.equal(state.attempts.length, 0);
    assert.equal(state.captures.length, 0);
    assert.equal((await p.progress()).usedGifts, 1);
    assert.equal((await p.progress()).earnedUnits, 7);
    assert.equal((await p.progress()).availableGifts, 0);
    assert.ok(state.kitchenEffectId);
  }));
test('refund one of two combos removes one stamp only after bank confirmation; duplicate is harmless', () =>
  fixture(async (f) => {
    const p = await programme(f),
      two = await p.buy(2);
    await p.buy(5);
    const request = await p.repo.requestRefund(f.manager, randomUUID(), {
      orderId: two.o.orderId,
      captureId: two.capture.id,
      amountMinor: '10000',
      reason: 'Synthetic returned one combo',
      fulfillmentPolicy: 'manager_reviewed',
      items: [{ lineId: two.q.snapshot.lines[0].lineId, quantity: 1 }],
    });
    assert.equal((await p.progress()).earnedUnits, 7);
    assert.equal((await p.progress()).availableGifts, 0); // pending refund freezes redemption
    const confirmed = {
      eventId: randomUUID(),
      refundId: request.refundId,
      outcome: 'succeeded',
      operationId: randomUUID(),
      amountMinor: '10000',
      occurredAt: now(),
    };
    await p.repo.observeRefund(f.provider, confirmed);
    assert.equal((await p.progress()).earnedUnits, 6);
    assert.equal((await p.progress()).visibleStamps, 6);
    assert.equal((await p.progress()).availableGifts, 0);
    await p.repo.observeRefund(f.provider, { ...confirmed, eventId: randomUUID() });
    assert.equal((await p.progress()).earnedUnits, 6);
    await assert.rejects(
      p.repo.requestRefund(f.manager, randomUUID(), {
        orderId: two.o.orderId,
        captureId: two.capture.id,
        amountMinor: '10000',
        reason: 'Synthetic duplicate lines',
        fulfillmentPolicy: 'manager_reviewed',
        items: [{ lineId: two.q.snapshot.lines[0].lineId, quantity: 2 }],
      }),
    );
  }));
test('gift hold survives unknown payment; terminal failure releases it', () =>
  fixture(async (f) => {
    const p = await programme(f);
    await p.buy(7);
    const q = await p.quote(1, true, true);
    assert.equal(q.snapshot.totalMinor, '1000');
    const o = await p.create(q);
    await p.admit(q, o);
    const a = await p.repo.startPaymentAttempt(f.scope, randomUUID(), {
      orderId: o.orderId,
      providerAccountId: f.payment,
    });
    await p.repo.observePayment(f.provider, observation(a, 'unknown'));
    assert.equal((await p.progress()).reservedGifts, 1);
    assert.equal((await p.progress()).availableGifts, 0);
    await p.repo.observePayment(f.provider, observation(a, 'failed'));
    assert.equal((await p.progress()).availableGifts, 1);
    assert.equal((await p.progress()).reservedGifts, 0);
  }));
test('full refund revokes earned stamps, including after a gift was consumed; no automatic money charge', () =>
  fixture(async (f) => {
    const p = await programme(f),
      purchase = await p.buy(7),
      q = await p.quote(1, true),
      o = await p.create(q);
    await p.admit(q, o);
    const refund = await p.repo.requestRefund(f.manager, randomUUID(), {
      orderId: purchase.o.orderId,
      captureId: purchase.capture.id,
      amountMinor: '70000',
      reason: 'Synthetic full return',
      fulfillmentPolicy: 'manager_reviewed',
    });
    await p.repo.observeRefund(f.provider, {
      eventId: randomUUID(),
      refundId: refund.refundId,
      outcome: 'succeeded',
      operationId: randomUUID(),
      amountMinor: '70000',
      occurredAt: now(),
    });
    const progress = await p.progress();
    assert.equal(progress.earnedUnits, 0);
    assert.equal(progress.availableGifts, 0);
    assert.equal(progress.usedGifts, 1);
    assert.equal(progress.reconciliationRequired, true);
    assert.equal((await p.repo.readOrder(f.scope, o.orderId)).attempts.length, 0);
  }));
test('disabled programme, another account and unconfirmed orders cannot grant a gift', () =>
  fixture(async (f) => {
    assert.deepEqual(await customerComboProgress(f.pool, f.scope, null), { enabled: false });
    const p = await programme(f);
    await p.buy(7);
    const other = { ...f.scope, principalId: randomUUID() };
    assert.equal((await customerComboProgress(f.pool, other, options)).availableGifts, 0);
    const q = await p.quote(1, true);
    await assert.rejects(p.repo.createDeferredFiscalOrder(other, randomUUID(), q.quoteId));
  }));

test('paid upgrades consume one gift without earning an extra stamp', () =>
  fixture(async (f) => {
    const p = await programme(f);
    await p.buy(7);
    const q = await p.quote(1, true, true),
      o = await p.create(q);
    await p.admit(q, o);
    const a = await p.repo.startPaymentAttempt(f.scope, randomUUID(), {
      orderId: o.orderId,
      providerAccountId: f.payment,
    });
    await p.repo.observePayment(f.provider, observation(a));
    const progress = await p.progress();
    assert.equal(progress.earnedUnits, 7);
    assert.equal(progress.usedGifts, 1);
    assert.equal(progress.availableGifts, 0);
  }));
test('payment received before programme start never earns commercial stamps', () =>
  fixture(async (f) => {
    const p = await programme(f, { ...options, startsAt: '2099-01-01T00:00:00.000Z' });
    await p.buy(7);
    assert.equal((await p.progress()).earnedUnits, 0);
    await assert.rejects(p.quote(1, true));
  }));
test('unallocated partial refund requires review instead of inventing which combo was returned', () =>
  fixture(async (f) => {
    const p = await programme(f),
      purchase = await p.buy(7);
    const request = await p.repo.requestRefund(f.manager, randomUUID(), {
      orderId: purchase.o.orderId,
      captureId: purchase.capture.id,
      amountMinor: '5000',
      reason: 'Synthetic amount-only correction',
      fulfillmentPolicy: 'manager_reviewed',
    });
    await p.repo.observeRefund(f.provider, {
      eventId: randomUUID(),
      refundId: request.refundId,
      outcome: 'succeeded',
      operationId: randomUUID(),
      amountMinor: '5000',
      occurredAt: now(),
    });
    const progress = await p.progress();
    assert.equal(progress.earnedUnits, 7);
    assert.equal(progress.availableGifts, 0);
    assert.equal(progress.reconciliationRequired, true);
  }));
test('item return must match the immutable purchase price before any bank request is queued', () =>
  fixture(async (f) => {
    const p = await programme(f),
      purchase = await p.buy(2),
      before = await f.count('commerce_refunds');
    await assert.rejects(
      p.repo.requestRefund(f.manager, randomUUID(), {
        orderId: purchase.o.orderId,
        captureId: purchase.capture.id,
        amountMinor: '1',
        reason: 'Synthetic mismatched amount',
        fulfillmentPolicy: 'manager_reviewed',
        items: [{ lineId: purchase.q.snapshot.lines[0].lineId, quantity: 1 }],
      }),
    );
    assert.equal(await f.count('commerce_refunds'), before);
    assert.equal((await p.progress()).earnedUnits, 2);
  }));
