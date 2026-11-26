import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { fixtureMenu } from '@pickchick/test-fixtures';
import { WebkassaClient } from '@pickchick/webkassa';
import {
  BASIS_MISSING_RETRY_MS,
  CommerceRepository,
  REFUSED_RETRY_MS,
  WebkassaCloudFiscalWorker,
  cloudFiscalLines,
  digest,
  webkassaCloudConfig,
} from '../dist/index.js';
import { readCheckoutOrder } from '../dist/order-view.js';

// Webkassa receipts of app and kiosk orders (stage 2) against a simulated Webkassa: only
// disposable schemas in explicitly local PostgreSQL, like postgres.test.mjs.
const connection =
  process.env.COMMERCE_TEST_DATABASE_URL ??
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55432/pickchick_cloud';
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection).hostname));
const migrationDir = fileURLToPath(new URL('../../../db/cloud/migrations/', import.meta.url));
const now = () => new Date().toISOString();

/** Webkassa as seen on devkkm 25.11: Authorize, check (Code 14 on a repeat), PrintFormat. */
function simulator() {
  const s = { calls: [], issued: new Map(), refuse: [], loseNext: false, number: 132524690 };
  s.transport = {
    async post(base, path, key, body) {
      s.calls.push([path, body]);
      if (path === 'api/v4/Authorize') return { kind: 'ok', data: { Token: 't' }, top: {} };
      if (path === 'api/v4/check') {
        if (s.refuse.length)
          return { kind: 'refused', httpStatus: 200, errors: [s.refuse.shift()], top: {} };
        const old = s.issued.get(body.ExternalCheckNumber);
        if (old)
          return {
            kind: 'refused',
            httpStatus: 200,
            errors: [{ code: 14, text: 'уже присутствует' }],
            top: { CheckNumber: old },
          };
        const number = String(s.number++);
        s.issued.set(body.ExternalCheckNumber, number);
        if (s.loseNext) {
          s.loseNext = false;
          return { kind: 'lost', reason: 'ANSWER' };
        }
        return {
          kind: 'ok',
          data: {
            CheckNumber: number,
            DateTime: '25.11.2026 14:34:29',
            OfflineMode: true,
            ShiftNumber: 1,
            Cashbox: { RegistrationNumber: '600400123456' },
            TicketUrl: `https://devkkm.webkassa.kz/Ticket?chb=SWK00036966&extnum=${number}`,
          },
          top: {},
        };
      }
      if (path === 'api/v4/Ticket/PrintFormat')
        return {
          kind: 'ok',
          data: {
            Lines: [
              { Order: 1, Type: 0, Value: 'PICK CHICK ALA AP', Style: 1 },
              { Order: 2, Type: 2, Value: 'https://consumer.oofd.kz?i=1', Style: 0 },
            ],
          },
          top: {},
        };
      if (path === 'api/v4/ZReport') return { kind: 'ok', data: {}, top: {} };
      throw new Error('unexpected ' + path);
    },
  };
  return s;
}

async function fixture(run) {
  const schema = 'webkassa_' + randomUUID().replaceAll('-', '');
  const admin = createPool(connection, 4);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(connection);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = createPool(url.toString(), 6);
  try {
    await migrate(pool, migrationDir, 'cloud');
    const org = randomUUID(),
      legal = randomUUID(),
      branch = randomUUID(),
      device = randomUUID(),
      release = randomUUID(),
      payment = randomUUID(),
      fiscal = randomUUID();
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Webkassa synthetic')", [org]);
    await pool.query(
      "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES($1,$2,'Synthetic','000000000000')",
      [legal, org],
    );
    await pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,'WK','Synthetic')",
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
    for (const [id, kind, provider] of [
      [payment, 'payment', 'tiptoppay'],
      [fiscal, 'fiscal', 'webkassa'],
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
    const provider = { organizationId: org, branchId: branch, accountId: payment };
    const edge = { organizationId: org, branchId: branch, deviceId: device };
    const repo = new CommerceRepository(pool);
    async function paid(lines) {
      const quote = await repo.issueQuote(scope, randomUUID(), {
        releaseId: release,
        customerId: null,
        channel: 'mobile',
        serviceMode: 'takeaway',
        currency: 'KZT',
        ttlSeconds: 300,
        lines,
      });
      const order = await repo.createOrder(scope, randomUUID(), {
        quoteId: quote.quoteId,
        fiscalAccountId: fiscal,
      });
      await repo.confirmAdmission(edge, {
        eventId: randomUUID(),
        orderId: order.orderId,
        reservationId: randomUUID(),
        quoteDigest: quote.digest,
      });
      const attempt = await repo.startPaymentAttempt(scope, randomUUID(), {
        orderId: order.orderId,
        providerAccountId: payment,
      });
      await repo.observePayment(provider, {
        eventId: randomUUID(),
        attemptId: attempt.attemptId,
        outcome: 'captured',
        occurredAt: now(),
        operationId: randomUUID(),
        amountMinor: attempt.amountMinor,
      });
      return order.orderId;
    }
    const wk = simulator();
    const logs = [];
    const worker = new WebkassaCloudFiscalWorker(
      pool,
      {
        accountId: fiscal,
        account: {
          baseUrl: 'https://devkkm.webkassa.kz',
          apiKey: 'k',
          login: 'l',
          password: 'p',
          cashboxUniqueNumber: 'SWK00036966',
        },
      },
      new WebkassaClient(
        {
          baseUrl: 'https://devkkm.webkassa.kz',
          apiKey: 'k',
          login: 'l',
          password: 'p',
          cashboxUniqueNumber: 'SWK00036966',
        },
        { transport: wk.transport },
      ),
      (entry) => logs.push(entry),
    );
    const manager = { ...scope, principalId: randomUUID(), role: 'manager' };
    await run({
      pool,
      repo,
      scope,
      manager,
      provider,
      paid,
      wk,
      worker,
      logs,
      fiscal,
      admin,
      schema,
      url: url.toString(),
    });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

const burger = (quantity = 2) => ({
  lineId: randomUUID(),
  productId: 'synthetic-burger',
  title: 'Бургер',
  quantity,
  unitPriceMinor: '50000',
  discountMinor: '0',
  taxCode: 'TEST',
});

test('a paid app order gets one Webkassa receipt, its link, and then reaches the kitchen', () =>
  fixture(async (f) => {
    const orderId = await f.paid([burger()]);
    let view = await f.repo.readOrder(f.scope, orderId);
    assert.equal(view.fiscalDocuments[0].state, 'queued');
    assert.equal(view.kitchenEffectId, null, 'no kitchen before the receipt');
    assert.deepEqual(await f.worker.tick(), { issued: 1, refused: 0, retry: 0, errors: 0 });
    const check = f.wk.calls.find(([p]) => p === 'api/v4/check')[1];
    assert.equal(check.ExternalCheckNumber, orderId, 'the desk prints a kiosk receipt by it');
    assert.deepEqual(check.Payments, [{ Sum: 1000, PaymentType: 1 }], 'TipTopPay is a card');
    assert.equal(check.Positions[0].PositionName, 'Бургер');
    assert.equal(check.Positions[0].Count, 2);
    assert.equal(check.Positions[0].Price, 500);
    view = await f.repo.readOrder(f.scope, orderId);
    assert.equal(view.fiscalDocuments[0].state, 'issued');
    assert.ok(view.kitchenEffectId, 'the kitchen gets the order once the receipt is issued');
    const shown = await readCheckoutOrder(f.pool, f.repo, f.scope, orderId);
    assert.equal(shown.receipt, 'issued');
    assert.equal(
      shown.receiptUrl,
      'https://devkkm.webkassa.kz/Ticket?chb=SWK00036966&extnum=132524690',
    );
    // Nothing left: the next tick sends nothing.
    const before = f.wk.calls.length;
    assert.deepEqual(await f.worker.tick(), { issued: 0, refused: 0, retry: 0, errors: 0 });
    assert.equal(f.wk.calls.length, before);
  }));

test('a lost answer resolves to the same receipt; a refusal (busy cashbox) waits and retries', () =>
  fixture(async (f) => {
    const first = await f.paid([burger()]);
    f.wk.loseNext = true;
    assert.deepEqual(await f.worker.tick(), { issued: 0, refused: 0, retry: 1, errors: 0 });
    // The lease runs out; the repeat under the same number is Code 14: issued, not a second one.
    await f.pool.query("UPDATE commerce_outbox SET lease_until=clock_timestamp()-interval '1 s'");
    assert.deepEqual(await f.worker.tick(), { issued: 1, refused: 0, retry: 0, errors: 0 });
    assert.equal(f.wk.issued.size, 1);
    const shown = await readCheckoutOrder(f.pool, f.repo, f.scope, first);
    assert.equal(shown.receiptUrl, 'https://consumer.oofd.kz?i=1', 'link from the print form QR');

    await f.paid([burger(1)]);
    f.wk.refuse.push({ code: 11, text: 'Смена больше 24 часов' });
    assert.deepEqual(await f.worker.tick(), { issued: 0, refused: 1, retry: 0, errors: 0 });
    assert.ok(
      f.wk.calls.some(([p]) => p === 'api/v4/ZReport'),
      'an old shift is closed once',
    );
    assert.equal(f.logs.at(-1).event, 'webkassa_cloud_refused');
    const lease = (
      await f.pool.query(
        "SELECT lease_until-clock_timestamp() > interval '4 minutes' later FROM commerce_outbox WHERE event_type='fiscal.submit_requested' AND acknowledged_at IS NULL",
      )
    ).rows[0];
    assert.equal(lease.later, true, `held about ${REFUSED_RETRY_MS} ms`);
    assert.deepEqual(await f.worker.tick(), { issued: 0, refused: 0, retry: 0, errors: 0 });
    await f.pool.query("UPDATE commerce_outbox SET lease_until=clock_timestamp()-interval '1 s'");
    assert.deepEqual(await f.worker.tick(), { issued: 1, refused: 0, retry: 0, errors: 0 });
    assert.equal(f.wk.issued.size, 2);
  }));

/** A manager's refund of the order's capture, confirmed by the bank. */
async function refunded(f, orderId, amountMinor) {
  const view = await f.repo.readOrder(f.scope, orderId);
  const refund = await f.repo.requestRefund(f.manager, randomUUID(), {
    orderId,
    captureId: view.captures[0].id,
    amountMinor,
    reason: 'Синтетический возврат',
    fulfillmentPolicy: 'manager_reviewed',
  });
  await f.repo.observeRefund(f.provider, {
    eventId: randomUUID(),
    refundId: refund.refundId,
    outcome: 'succeeded',
    operationId: randomUUID(),
    amountMinor,
    occurredAt: now(),
  });
  return refund.refundId;
}

test('a refund gets a Webkassa refund receipt that names the sale receipt (P0-1)', () =>
  fixture(async (f) => {
    const orderId = await f.paid([burger()]);
    assert.equal((await f.worker.tick()).issued, 1);
    const kept = (await f.pool.query('SELECT * FROM commerce_webkassa_receipts')).rows;
    assert.equal(kept.length, 1);
    assert.equal(kept[0].check_number, '132524690');
    assert.equal(kept[0].issued_at, '25.11.2026 14:34:29');
    assert.equal(kept[0].registration_number, '600400123456');
    await assert.rejects(
      f.pool.query("UPDATE commerce_webkassa_receipts SET check_number='1'"),
      /immutable/,
    );
    await refunded(f, orderId, '40000');
    assert.deepEqual(await f.worker.tick(), { issued: 1, refused: 0, retry: 0, errors: 0 });
    const checks = f.wk.calls.filter(([p]) => p === 'api/v4/check').map(([, b]) => b);
    const back = checks.at(-1);
    assert.equal(back.OperationType, 3, 'a refund');
    assert.notEqual(back.ExternalCheckNumber, orderId, 'its own number, not the sale');
    assert.deepEqual(back.Payments, [{ Sum: 400, PaymentType: 1 }]);
    assert.equal(
      back.Positions.reduce((sum, l) => sum + l.Price * l.Count - (l.Discount ?? 0), 0),
      400,
    );
    assert.deepEqual(back.ReturnBasisDetails, {
      CheckNumber: '132524690',
      DateTime: '2026-11-25 14:34:29',
      Total: 1000,
      RegistrationNumber: '600400123456',
      IsOffline: true,
    });
    const view = await f.repo.readOrder(f.scope, orderId);
    assert.deepEqual(view.fiscalDocuments.map((d) => [d.kind, d.state]).sort(), [
      ['refund', 'issued'],
      ['sale', 'issued'],
    ]);
    assert.equal(
      (await f.pool.query('SELECT count(*)::int n FROM commerce_webkassa_receipts')).rows[0].n,
      1,
      'only sale receipts are kept',
    );
    assert.deepEqual(await f.worker.tick(), { issued: 0, refused: 0, retry: 0, errors: 0 });
  }));

test('a refund of a sale whose receipt data are unknown waits and is logged', () =>
  fixture(async (f) => {
    const orderId = await f.paid([burger()]);
    // A lost answer, then Code 14: the sale is issued without its date and registration number.
    f.wk.loseNext = true;
    await f.worker.tick();
    await f.pool.query("UPDATE commerce_outbox SET lease_until=clock_timestamp()-interval '1 s'");
    assert.equal((await f.worker.tick()).issued, 1);
    assert.equal((await f.pool.query('SELECT 1 FROM commerce_webkassa_receipts')).rowCount, 0);
    await refunded(f, orderId, '100000');
    const before = f.wk.calls.length;
    assert.deepEqual(await f.worker.tick(), { issued: 0, refused: 0, retry: 1, errors: 0 });
    assert.equal(f.wk.calls.length, before, 'no guessed refund receipt');
    assert.equal(f.logs.at(-1).event, 'webkassa_cloud_refund_basis_missing');
    const lease = (
      await f.pool.query(
        "SELECT lease_until-clock_timestamp() > interval '50 minutes' later FROM commerce_outbox WHERE event_type='fiscal.submit_requested' AND acknowledged_at IS NULL",
      )
    ).rows[0];
    assert.equal(lease.later, true, `held about ${BASIS_MISSING_RETRY_MS} ms`);
  }));

test('restricted role: the Webkassa worker issues sale and refund receipts with its own grants', () =>
  fixture(async (f) => {
    const { webkassaWorkerGrants } =
      await import('../../../infra/staging/webkassa-worker-grants.mjs');
    const role = 'wk_worker_' + randomUUID().replaceAll('-', '');
    await f.admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    let pool;
    try {
      await f.pool.query(`GRANT USAGE ON SCHEMA ${f.schema} TO ${role}`);
      await f.pool.query(webkassaWorkerGrants(role, true));
      const url = new URL(f.url);
      url.searchParams.set('options', `-c search_path=${f.schema} -c role=${role}`);
      pool = createPool(url.toString(), 2);
      const account = {
        baseUrl: 'https://devkkm.webkassa.kz',
        apiKey: 'k',
        login: 'l',
        password: 'p',
        cashboxUniqueNumber: 'SWK00036966',
      };
      const worker = new WebkassaCloudFiscalWorker(
        pool,
        { accountId: f.fiscal, account },
        new WebkassaClient(account, { transport: f.wk.transport }),
        (entry) => f.logs.push(entry),
      );
      const orderId = await f.paid([burger()]);
      assert.deepEqual(await worker.tick(), { issued: 1, refused: 0, retry: 0, errors: 0 });
      assert.ok((await f.repo.readOrder(f.scope, orderId)).kitchenEffectId, 'kitchen admitted');
      await refunded(f, orderId, '100000');
      assert.deepEqual(await worker.tick(), { issued: 1, refused: 0, retry: 0, errors: 0 });
      for (const sql of [
        'UPDATE commerce_captures SET amount_minor=1',
        'DELETE FROM commerce_fiscal_documents',
        'INSERT INTO commerce_refunds(id) VALUES(gen_random_uuid())',
      ])
        await assert.rejects(pool.query(sql), /permission denied/);
      await f.pool.query(webkassaWorkerGrants(role, false));
      await assert.rejects(pool.query('SELECT 1 FROM commerce_outbox'), /permission denied/);
    } finally {
      await pool?.end();
      await f.admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
      await f.admin.query(`DROP ROLE ${role}`).catch(() => undefined);
    }
  }));

test('receipt lines: gifts are left out, an order discount comes off the largest line', () => {
  assert.deepEqual(
    cloudFiscalLines(
      [
        { title: 'Комбо', quantity: 3, totalMinor: '100000' },
        { title: 'Подарок', quantity: 1, totalMinor: '0' },
        { title: 'Соус', quantity: 1, totalMinor: '30000' },
      ],
      120000n,
    ).map((l) => [l.name, l.quantity, l.unitPriceMinor, l.discountMinor]),
    [
      ['Комбо', 3, 33334n, 10002n],
      ['Соус', 1, 30000n, 0n],
    ],
  );
  assert.throws(() => cloudFiscalLines([{ title: 'x', quantity: 1, totalMinor: '5' }], 6n));
  assert.throws(() => cloudFiscalLines([], 1n));
  assert.equal(webkassaCloudConfig({}), null);
  assert.throws(() => webkassaCloudConfig({ WEBKASSA_FISCAL_ACCOUNT_ID: randomUUID() }));
});
