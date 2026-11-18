import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath, URLSearchParams } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { fixtureMenu } from '@pickchick/test-fixtures';
import {
  CommerceRepository,
  TipTopPayTestCheckout,
  tipTopPayTestOptions,
  digest,
} from '../dist/index.js';

// Only disposable schemas in explicitly local development PostgreSQL.
const connection =
  process.env.COMMERCE_TEST_DATABASE_URL ??
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55432/pickchick_cloud';
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection).hostname),
  'Commerce tests require localhost PostgreSQL',
);
const migrationDir = fileURLToPath(new URL('../../../db/cloud/migrations/', import.meta.url));

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
      release = randomUUID();
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Commerce synthetic')", [org]);
    await pool.query(
      "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES($1,$2,'Synthetic','000000000000')",
      [legal, org],
    );
    await pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,'COMMERCE','Synthetic')",
      [branch, org, legal],
    );
    const menu = { ...fixtureMenu, branch_id: branch, release_id: release };
    await pool.query(
      'INSERT INTO menu_releases(id,branch_id,version,schema_version,payload,checksum,published_at) VALUES($1,$2,$3,1,$4,$5,clock_timestamp())',
      [release, branch, menu.version, menu, digest(menu)],
    );
    const customer = randomUUID();
    const scope = { organizationId: org, branchId: branch, principalId: customer, role: 'sales' };
    const repo = new CommerceRepository(pool);
    const quote = () =>
      repo.issueQuote(scope, randomUUID(), {
        releaseId: release,
        customerId: customer,
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
    const count = async (table) =>
      Number((await pool.query(`SELECT COUNT(*) count FROM ${table}`)).rows[0].count);
    await run({ pool, admin, url, schema, org, branch, customer, quote, count });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

/** A scripted TipTopPay API: records every call and answers from a queue. */
function fakeApi(answers) {
  const calls = [];
  const request = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next), { status: 200 });
  };
  return { calls, request };
}
const approved = (id, transaction) => ({
  Success: true,
  Message: null,
  Model: {
    TransactionId: transaction,
    ReasonCode: 0,
    Status: 'Completed',
    TestMode: true,
    InvoiceId: id,
  },
});

test('TEST charge of a card cryptogram: once per quote, 3-D Secure, declines and signed notifications, never commercial effects', () =>
  fixture(async (f) => {
    const options = {
      organizationId: f.org,
      branchId: f.branch,
      maxMinor: '100000',
      publicId: 'pk_sandbox',
      apiSecret: 'synthetic-sandbox-secret',
      origin: 'https://checkout.example',
      methods: ['card', 'google_pay'],
      routingVerified: false,
    };
    const tables = [
      'commerce_orders',
      'commerce_payment_attempts',
      'commerce_provider_inbox',
      'commerce_captures',
      'commerce_fiscal_documents',
      'commerce_outbox',
    ];
    const baseline = await Promise.all(tables.map((table) => f.count(table)));
    const cryptogram = 'synthetic-cryptogram-packet-0123456789';

    // 1. Approved at once.
    const quote = await f.quote();
    const api = fakeApi([]);
    const sandbox = new TipTopPayTestCheckout(f.pool, options, Date.now, api.request);
    const input = { quoteId: quote.quoteId, method: 'card', cryptogram };
    await assert.rejects(sandbox.charge(randomUUID(), input, '10.0.0.1'), { code: 'NOT_FOUND' });
    await assert.rejects(sandbox.charge(f.customer, { ...input, method: 'apple_pay' }, '10.0.0.1'));
    await assert.rejects(
      new TipTopPayTestCheckout(
        f.pool,
        { ...options, maxMinor: '1' },
        Date.now,
        api.request,
      ).charge(f.customer, input, '10.0.0.1'),
    );
    assert.equal(api.calls.length, 0);
    const id = () =>
      f.pool
        .query('SELECT id FROM commerce_tiptoppay_test_payments WHERE quote_id=$1', [quote.quoteId])
        .then((r) => r.rows[0]?.id);
    api.calls.length = 0;
    const answers = [];
    const approve = fakeApi(answers);
    const charging = new TipTopPayTestCheckout(f.pool, options, Date.now, async (url, init) => {
      answers.push(approved(await id(), 80001));
      return approve.request(url, init);
    });
    const paid = await charging.charge(f.customer, input, '::ffff:10.0.0.7');
    assert.equal(paid.state, 'paid');
    assert.equal(paid.amountMinor, '100000');
    const call = approve.calls[0];
    assert.equal(call.url, 'https://api.tiptoppay.kz/payments/cards/charge');
    assert.equal(call.body.Amount, 1000);
    assert.equal(call.body.Currency, 'KZT');
    assert.equal(call.body.IpAddress, '10.0.0.7');
    assert.equal(call.body.CardCryptogramPacket, cryptogram);
    assert.equal(call.body.InvoiceId, paid.id);
    assert.equal(call.body.AccountId, f.customer);
    assert.equal(call.headers['X-Request-ID'], paid.id);
    assert.equal(
      call.headers.Authorization,
      'Basic ' + Buffer.from('pk_sandbox:synthetic-sandbox-secret').toString('base64'),
    );
    // A repeated press for the same quote never charges again.
    assert.equal((await charging.charge(f.customer, input, '10.0.0.7')).state, 'paid');
    assert.equal(approve.calls.length, 1);
    await assert.rejects(
      charging.charge(f.customer, { ...input, method: 'google_pay' }, '10.0.0.7'),
      { code: 'CONFLICT' },
    );
    const stored = (
      await f.pool.query('SELECT * FROM commerce_tiptoppay_test_payments WHERE id=$1', [paid.id])
    ).rows[0];
    assert.equal(stored.paid_operation_id, '80001');
    assert.ok(!JSON.stringify(stored).includes(cryptogram));

    // Signed notifications of that payment: duplicates are harmless, forgeries are refused.
    const fields = {
      TransactionId: '80001',
      InvoiceId: paid.id,
      AccountId: f.customer,
      Amount: '1000',
      Currency: 'KZT',
      TestMode: '1',
      Status: 'Completed',
      OperationType: 'Payment',
      DateTime: '2026-11-18 12:00:00',
    };
    const send = (event, patch = {}, secret = options.apiSecret) => {
      const raw = Buffer.from(new URLSearchParams({ ...fields, ...patch }).toString());
      return sandbox.receive(event, raw, createHmac('sha256', secret).update(raw).digest('base64'));
    };
    await assert.rejects(send('pay', {}, 'another-secret-value'), { code: 'SIGNATURE' });
    await assert.rejects(send('pay', { TestMode: '0' }), { code: 'MODE' });
    await assert.rejects(send('pay', { Amount: '1001' }), { code: 'BINDING' });
    await assert.rejects(send('pay', { AccountId: randomUUID() }), { code: 'BINDING' });
    await assert.rejects(send('pay', { TransactionId: '80002' }), { code: 'BINDING' });
    assert.deepEqual(await send('check'), { code: 13 });
    await Promise.all(Array.from({ length: 5 }, () => send('pay')));
    await send('fail', { ReasonCode: '5051' });
    assert.equal((await sandbox.read(f.customer, paid.id)).state, 'paid');
    await assert.rejects(sandbox.read(randomUUID(), paid.id));

    // 2. 3-D Secure: the app gets our page; the bank's answer finishes the charge.
    const secure = await f.quote();
    const threeDsAnswers = [];
    const threeDsApi = fakeApi(threeDsAnswers);
    const threeDs = new TipTopPayTestCheckout(f.pool, options, Date.now, threeDsApi.request);
    threeDsAnswers.push({
      Success: false,
      Message: null,
      Model: {
        TransactionId: 80010,
        PaReq: 'eJxVUdtugkAQ',
        AcsUrl: 'https://acs.example/3ds',
        TestMode: true,
      },
    });
    const waiting = await threeDs.charge(
      f.customer,
      { quoteId: secure.quoteId, method: 'card', cryptogram },
      '10.0.0.7',
    );
    assert.equal(waiting.state, 'pending');
    const page = new URL(waiting.threeDsUrl);
    assert.equal(
      page.origin + page.pathname,
      'https://checkout.example/v1/integrations/tiptoppay/test-3ds',
    );
    const fragment = new URLSearchParams(page.hash.slice(1));
    assert.equal(fragment.get('acs'), 'https://acs.example/3ds');
    assert.equal(fragment.get('pareq'), 'eJxVUdtugkAQ');
    assert.equal(fragment.get('md'), '80010');
    await assert.rejects(threeDs.complete3ds('99999', 'pares'), { code: 'NOT_FOUND' });
    threeDsAnswers.push(approved(waiting.id, 80010));
    assert.equal(await threeDs.complete3ds('80010', 'synthetic-pares'), 'paid');
    assert.deepEqual(threeDsApi.calls[1].body, { TransactionId: 80010, PaRes: 'synthetic-pares' });
    assert.equal(threeDsApi.calls[1].url, 'https://api.tiptoppay.kz/payments/cards/post3ds');
    assert.equal(await threeDs.complete3ds('80010', 'synthetic-pares'), 'paid');
    assert.equal(threeDsApi.calls.length, 2);

    // 3. Declined with the bank's message; no answer at all stays pending (never "failed").
    const declinedQuote = await f.quote();
    const declineAnswers = [
      {
        Success: false,
        Message: null,
        Model: {
          TransactionId: 80020,
          ReasonCode: 5051,
          Status: 'Declined',
          CardHolderMessage: 'Недостаточно средств на карте',
          TestMode: true,
        },
      },
    ];
    const declining = new TipTopPayTestCheckout(
      f.pool,
      options,
      Date.now,
      fakeApi(declineAnswers).request,
    );
    const declined = await declining.charge(
      f.customer,
      { quoteId: declinedQuote.quoteId, method: 'card', cryptogram },
      '10.0.0.7',
    );
    assert.equal(declined.state, 'failed');
    assert.equal(declined.message, 'Недостаточно средств на карте');
    const silentQuote = await f.quote();
    const silent = new TipTopPayTestCheckout(
      f.pool,
      options,
      Date.now,
      fakeApi([new Error('timeout')]).request,
    );
    const unknown = await silent.charge(
      f.customer,
      { quoteId: silentQuote.quoteId, method: 'card', cryptogram },
      '10.0.0.7',
    );
    assert.equal(unknown.state, 'pending');
    // The late Check and Pay of that unknown charge settle it.
    const late = { ...fields, InvoiceId: unknown.id, TransactionId: '80030' };
    const sendLate = (event) => {
      const raw = Buffer.from(new URLSearchParams(late).toString());
      return sandbox.receive(
        event,
        raw,
        createHmac('sha256', options.apiSecret).update(raw).digest('base64'),
      );
    };
    assert.deepEqual(await sendLate('check'), { code: 0 });
    assert.deepEqual(await sendLate('pay'), { code: 0 });
    assert.equal((await sandbox.read(f.customer, unknown.id)).state, 'paid');
    // A LIVE answer is never accepted as a sandbox result.
    const liveQuote = await f.quote();
    const live = new TipTopPayTestCheckout(
      f.pool,
      options,
      Date.now,
      fakeApi([
        { Success: true, Model: { TransactionId: 1, Status: 'Completed', TestMode: false } },
      ]).request,
    );
    await assert.rejects(
      live.charge(
        f.customer,
        { quoteId: liveQuote.quoteId, method: 'card', cryptogram },
        '10.0.0.7',
      ),
      { code: 'CONFLICT' },
    );
    assert.deepEqual(await Promise.all(tables.map((table) => f.count(table))), baseline);

    // The runtime role needs only SELECT on quotes and the sandbox table itself.
    const third = await f.quote();
    const runtimeRole = 'ttp_test_' + randomUUID().replaceAll('-', '');
    const runtimePassword = randomUUID();
    await f.admin.query(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}'`);
    const runtimeUrl = new URL(f.url.toString());
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    const runtimePool = createPool(runtimeUrl.toString(), 8);
    try {
      await f.admin.query(`GRANT USAGE ON SCHEMA ${f.schema} TO ${runtimeRole}`);
      await f.admin.query(`GRANT SELECT ON ${f.schema}.commerce_quotes TO ${runtimeRole}`);
      await f.admin.query(
        `GRANT SELECT,INSERT,UPDATE ON ${f.schema}.commerce_tiptoppay_test_payments TO ${runtimeRole}`,
      );
      const runtimeApi = fakeApi([new Error('offline'), new Error('offline')]);
      const runtime = new TipTopPayTestCheckout(runtimePool, options, Date.now, runtimeApi.request);
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          runtime.charge(
            f.customer,
            { quoteId: third.quoteId, method: 'card', cryptogram },
            '10.0.0.7',
          ),
        ),
      );
      assert.equal(new Set(results.map((result) => result.id)).size, 1);
      assert.equal(runtimeApi.calls.length, 1);
    } finally {
      await runtimePool.end();
      await f.admin.query(`DROP OWNED BY ${runtimeRole}`);
      await f.admin.query(`DROP ROLE ${runtimeRole}`);
    }
  }));

test('TEST configuration is explicit, keeps Apple Pay off without the domain and rejects LIVE', () => {
  const env = {
    TIPTOPPAY_TEST_CHECKOUT_ENABLED: 'true',
    TIPTOPPAY_TEST_WEBHOOKS_ENABLED: 'true',
    TIPTOPPAY_MODE: 'test',
    TIPTOPPAY_PUBLIC_ID: 'pk_sandbox',
    TIPTOPPAY_API_SECRET: 'synthetic-sandbox-secret',
    TIPTOPPAY_CHECKOUT_ORIGIN: 'https://checkout.example',
    CUSTOMER_KASPI_ORGANIZATION_ID: randomUUID(),
    CUSTOMER_KASPI_BRANCH_ID: randomUUID(),
  };
  assert.equal(tipTopPayTestOptions({}), null);
  assert.deepEqual(tipTopPayTestOptions(env).methods, ['card']);
  assert.equal(tipTopPayTestOptions(env).routingVerified, false);
  assert.deepEqual(
    tipTopPayTestOptions({ ...env, TIPTOPPAY_TEST_CHECKOUT_METHODS: 'card, google_pay' }).methods,
    ['card', 'google_pay'],
  );
  assert.throws(() =>
    tipTopPayTestOptions({ ...env, TIPTOPPAY_TEST_CHECKOUT_METHODS: 'card,apple_pay' }),
  );
  assert.deepEqual(
    tipTopPayTestOptions({
      ...env,
      TIPTOPPAY_TEST_CHECKOUT_METHODS: 'card,apple_pay,google_pay',
      TIPTOPPAY_APPLE_PAY_DOMAIN_VERIFIED: 'true',
    }).methods,
    ['card', 'apple_pay', 'google_pay'],
  );
  assert.throws(() =>
    tipTopPayTestOptions({ ...env, TIPTOPPAY_TEST_CHECKOUT_METHODS: 'card,card' }),
  );
  assert.throws(() => tipTopPayTestOptions({ ...env, TIPTOPPAY_MODE: 'live' }));
  assert.throws(() => tipTopPayTestOptions({ ...env, TIPTOPPAY_TEST_WEBHOOKS_ENABLED: 'false' }));
  assert.throws(() =>
    tipTopPayTestOptions({ ...env, TIPTOPPAY_CHECKOUT_ORIGIN: 'http://checkout.example' }),
  );
});
