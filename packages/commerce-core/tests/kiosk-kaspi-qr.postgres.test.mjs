import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createPool } from '@pickchick/database';
import { kaspiWorkerGrants } from '../../../infra/staging/checkout-grants.mjs';
import { kioskQrWorkerGrants } from '../../../infra/staging/commercial-channel-grants.mjs';
import { withSyncDatabases, authFor } from '../../../tests/helpers/sync.mjs';
import {
  publishMenu,
  projectCatalogMenu,
  provisionDevice,
  pullMenu,
  applyMenu,
  acknowledgeMenu,
} from '@pickchick/menu-sync';
import {
  KioskCheckout,
  KioskSessions,
  KioskKaspiQrProcessor,
  KioskKaspiQrBridgeClient,
  readKioskQrPayment,
  kioskKaspiQrConfig,
} from '../dist/index.js';
import { publishCatalog } from './catalog-fixture.mjs';

// Same explicit localhost fixtures as commerce tests; never read a private server env.
process.env.APP_ENV ??= 'test';
process.env.CLOUD_DATABASE_URL ??=
  process.env.COMMERCE_TEST_DATABASE_URL ??
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55432/pickchick_cloud';
process.env.EDGE_DATABASE_URL ??=
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55433/pickchick_edge';
process.env.EDGE_BRANCH_ID ??= randomUUID();
process.env.REDIS_URL ??= 'redis://127.0.0.1:56379/0';
for (const name of ['CLOUD_DATABASE_URL', 'EDGE_DATABASE_URL'])
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env[name]).hostname));

async function fixture(run) {
  await withSyncDatabases(async (f) => {
    const pool = f.cloud.pool,
      payment = randomUUID(),
      kiosk = randomUUID(),
      deviceKey = randomBytes(32).toString('hex');
    const auth = authFor(await provisionDevice(pool, f.device));
    await pool.query(
      'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
      [f.branch, f.org, f.device, randomUUID()],
    );
    await pool.query(
      "INSERT INTO cloud_branch_availability(branch_id,device_id,revision,stopped_ids) VALUES($1,$2,1,'{}')",
      [f.branch, f.device],
    );
    await pool.query(
      "INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,kind,provider,external_reference,enabled,legal_entity_id) VALUES($1::uuid,$2,$3,'payment','kaspi-qr',$1::text,true,$4)",
      [payment, f.org, f.branch, f.legal],
    );
    await pool.query(
      'INSERT INTO kiosk_devices(id,organization_id,branch_id,token_hash) VALUES($1,$2,$3,$4)',
      [kiosk, f.org, f.branch, createHash('sha256').update(deviceKey).digest('hex')],
    );
    const sessions = new KioskSessions(pool, { piiKey: randomBytes(32) });
    async function guest() {
      const token = randomBytes(32).toString('hex');
      await sessions.start(kiosk, deviceKey, { sessionId: randomUUID(), token });
      return sessions.authenticate(kiosk, deviceKey, token);
    }
    const who = await guest();
    const publication = await publishCatalog({
      pool,
      scope: { organizationId: f.org, branchId: f.branch },
    });
    const menu = projectCatalogMenu(publication.payload, f.branch, 1, new Date().toISOString());
    const event = await publishMenu(pool, menu);
    await pool.query(
      'INSERT INTO catalog_menu_deliveries(branch_id,catalog_version,release_id,device_id) VALUES($1,1,$2,$3)',
      [f.branch, menu.release_id, f.device],
    );
    async function ack() {
      const pulled = (await pullMenu(pool, auth)).event;
      await acknowledgeMenu(pool, auth, await applyMenu(f.edge.pool, f.branch, pulled));
    }
    const options = {
      organizationId: f.org,
      branchId: f.branch,
      paymentAccountId: payment,
      paymentMethod: 'kaspi_qr',
      fiscalPolicy: 'deferred_pilot',
      approvalReference: 'Synthetic kiosk test only',
      taxCode: 'PENDING_PILOT',
      maxOrderMinor: '50000',
      hours: { openingTime: '10:00', closingTime: '00:00', timeZone: 'Asia/Almaty' },
    };
    const checkout = new KioskCheckout(
      pool,
      options,
      sessions,
      () => new Date('2026-10-04T10:00:00Z'),
    );
    const cart = () => ({
      key: randomUUID(),
      branchId: f.branch,
      catalog_version: 1,
      serviceMode: 'takeaway',
      items: [
        {
          productId: 'BURGER',
          quantity: 1,
          selections: [{ group_id: 'extra', option_id: 'sauce', quantity: 1 }],
        },
      ],
    });
    async function admission(order) {
      const row = (
          await pool.query('SELECT quote_id,quote_digest FROM commerce_orders WHERE id=$1', [
            order.orderId,
          ])
        ).rows[0],
        reservation = randomUUID();
      await checkout.repository.confirmAdmission(
        { organizationId: f.org, branchId: f.branch, deviceId: f.device },
        {
          eventId: randomUUID(),
          orderId: order.orderId,
          reservationId: reservation,
          quoteDigest: row.quote_digest,
        },
      );
      await pool.query(
        `INSERT INTO cloud_fulfillment_projection(order_id,branch_id,organization_id,device_id,reservation_id,quote_id,quote_hash,owner_hash,version,state,display_number,routing_version,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$7,1,'held','1',1,'{}')`,
        [order.orderId, f.branch, f.org, f.device, reservation, row.quote_id, row.quote_digest],
      );
    }
    await run({
      ...f,
      pool,
      payment,
      sessions,
      who,
      guest,
      ack,
      checkout,
      cart,
      admission,
      options,
      event,
    });
  });
}

class FakeQr {
  creates = 0;
  async checkSession() {
    return true;
  }
  async create(amount) {
    this.creates++;
    return (
      this.createAnswer ?? {
        kind: 'ok',
        data: { QrOperationId: 123, Amount: amount, QrToken: 'https://qr.kaspi.kz/synthetic-test' },
      }
    );
  }
  async status() {
    return (
      this.statusAnswer ?? { kind: 'ok', data: { QrOperationId: 123, Amount: 110, Status: 'Wait' } }
    );
  }
}
async function ready(f, client = new FakeQr(), admitted = true) {
  await f.ack();
  const q = await f.checkout.quote(f.who, f.cart());
  const order = await f.checkout.create(f.who, { key: randomUUID(), quoteId: q.quoteId });
  if (admitted) await f.admission(order);
  await f.checkout.pay(f.who, order.orderId, { method: 'kaspi_qr' });
  const config = {
    accountId: f.payment,
    bridgeUrl: 'http://127.0.0.1:1',
    requestTimeoutMs: 1000,
    invoiceTtlSeconds: 180,
    webhookSecret: 'x'.repeat(32),
    session: null,
    latitude: 43,
    longitude: 76,
  };
  const processor = (pool = f.pool) => new KioskKaspiQrProcessor(pool, config, client);
  const due = () =>
    f.pool.query(
      "UPDATE commerce_kiosk_kaspi_qr SET next_check_at=clock_timestamp()-interval '1 second'",
    );
  const row = async () =>
    (await f.pool.query('SELECT * FROM commerce_kiosk_kaspi_qr WHERE order_id=$1', [order.orderId]))
      .rows[0];
  return { client, processor, due, row, order };
}
test('QR isolated config defaults disabled and requires separate account and coordinates', () => {
  assert.equal(kioskKaspiQrConfig({}), null);
  assert.throws(() => kioskKaspiQrConfig({ KIOSK_KASPI_QR_ENABLED: 'true' }));
});
test('QR bridge preserves bank QR token and never upgrades unsupported envelope to money', async () => {
  const calls = [];
  const config = {
    bridgeUrl: 'http://127.0.0.1:1',
    requestTimeoutMs: 1000,
    session: {
      tokenSN: 'synthetic-token',
      vtokenSecret: 'synthetic-secret',
      profileId: 'synthetic',
    },
  };
  const client = new KioskKaspiQrBridgeClient(config, async (url, options) => {
    calls.push({ url, options });
    return new Response(
      JSON.stringify({
        StatusCode: 0,
        Data: { QrOperationId: 123, Amount: 110, QrToken: 'https://qr.kaspi.kz/synthetic-test' },
      }),
      { status: 200 },
    );
  });
  const answer = await client.create(110, 43, 76);
  assert.equal(answer.kind, 'ok');
  assert.equal(answer.data.QrToken, 'https://qr.kaspi.kz/synthetic-test');
  assert.deepEqual(JSON.parse(calls[0].options.body), { amount: 110, latitude: 43, longitude: 76 });
  assert.equal(calls[0].options.redirect, 'error');
  const unsupported = new KioskKaspiQrBridgeClient(
    config,
    async () => new Response(JSON.stringify({ Data: { Status: 'Processed' } }), { status: 200 }),
  );
  assert.equal((await unsupported.status('123')).kind, 'uncertain');
});
test('QR concurrent submits create once, bind amount and observe bank capture exactly once', async () =>
  fixture(async (f) => {
    const r = await ready(f);
    await Promise.all([r.processor().tick(), r.processor().tick()]);
    assert.equal(r.client.creates, 1);
    assert.equal((await r.row()).state, 'issued');
    assert.equal((await readKioskQrPayment(f.pool, r.order.orderId)).state, 'pending');
    r.client.statusAnswer = {
      kind: 'ok',
      data: { QrOperationId: 123, Amount: 110, Status: 'Processed' },
    };
    await r.due();
    await r.processor().tick();
    assert.equal((await r.row()).state, 'paid');
    assert.equal((await f.checkout.read(f.who, r.order.orderId)).totalMinor, '11000');
    assert.equal(
      (await f.pool.query('SELECT amount_minor::text amount FROM commerce_captures')).rows[0]
        .amount,
      '11000',
    );
    // Simulate lost delivered marker after durable inbox commit.
    await f.pool.query('UPDATE commerce_kiosk_kaspi_qr SET delivered_at=NULL');
    await r.due();
    await r.processor().tick();
    assert.equal(
      (await f.pool.query('SELECT count(*)::int n FROM commerce_captures')).rows[0].n,
      1,
    );
  }));

test('QR restricted worker role creates and reconciles once without money or account rewrite rights', async () =>
  fixture(async (f) => {
    const role = 'kiosk_qr_' + randomUUID().replaceAll('-', '');
    await f.cloud.admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    let runtime;
    try {
      await f.pool.query(`GRANT USAGE ON SCHEMA ${f.cloud.schema} TO ${role}`);
      await f.pool.query(kaspiWorkerGrants(role, true));
      const url = new URL(f.cloud.config.databaseUrl);
      url.searchParams.set('options', `-c search_path=${f.cloud.schema} -c role=${role}`);
      runtime = createPool(url.toString(), 2);
      const r = await ready(f);
      await assert.rejects(r.processor(runtime).tick(), /permission denied/);
      assert.equal(r.client.creates, 0);
      await f.pool.query(kioskQrWorkerGrants(role, true));
      await f.pool.query(kioskQrWorkerGrants(role, true));
      // The unsuccessful pre-grant tick leased the outbox before reaching the QR table.
      await f.pool.query(
        "UPDATE commerce_outbox SET lease_until=clock_timestamp()-interval '1 second'",
      );
      assert.equal((await r.processor(runtime).tick()).errors, 0);
      assert.equal(r.client.creates, 1);
      r.client.statusAnswer = {
        kind: 'ok',
        data: { QrOperationId: 123, Amount: 110, Status: 'Processed' },
      };
      await r.due();
      assert.equal((await r.processor(runtime).tick()).errors, 0);
      assert.equal((await r.row()).state, 'paid');
      await r.processor(runtime).tick();
      assert.equal(
        (await f.pool.query('SELECT count(*)::int n FROM commerce_captures')).rows[0].n,
        1,
      );
      for (const sql of [
        'UPDATE commerce_kiosk_kaspi_qr SET amount_minor=1',
        'UPDATE commerce_kiosk_kaspi_qr SET account_id=account_id',
        'UPDATE commerce_kiosk_kaspi_qr SET issue_started_at=clock_timestamp()',
        'DELETE FROM commerce_kiosk_kaspi_qr',
        'UPDATE commerce_captures SET amount_minor=1',
        'UPDATE commerce_orders SET total_minor=1',
        'UPDATE commerce_provider_accounts SET enabled=false',
        'INSERT INTO commerce_orders DEFAULT VALUES',
        'SELECT * FROM kiosk_sessions',
      ])
        await assert.rejects(runtime.query(sql), /permission denied/);
    } finally {
      await runtime?.end();
      await f.pool.query(`DROP OWNED BY ${role}`);
      await f.cloud.admin.query(`DROP ROLE ${role}`);
    }
  }));
test('QR timeout create never reissues after outbox replay or worker restart', async () =>
  fixture(async (f) => {
    const client = new FakeQr();
    client.createAnswer = { kind: 'uncertain' };
    const r = await ready(f, client);
    await r.processor().tick();
    assert.equal((await r.row()).state, 'unknown');
    await f.pool.query(
      "UPDATE commerce_outbox SET acknowledged_at=NULL,lease_until=NULL WHERE event_type='payment.submit_requested'",
    );
    await r.due();
    await r.processor().tick();
    assert.equal(client.creates, 1);
    assert.equal(
      (await f.pool.query('SELECT count(*)::int n FROM commerce_captures')).rows[0].n,
      0,
    );
  }));

test('QR process loss after create leaves durable intent and cannot create again', async () =>
  fixture(async (f) => {
    const client = new FakeQr();
    client.create = async () => {
      client.creates++;
      throw new Error('Synthetic crash after bank accepted request');
    };
    const r = await ready(f, client);
    const first = await r.processor().tick();
    assert.equal(first.errors, 1);
    assert.equal((await r.row()).state, 'issuing');
    await f.pool.query(
      "UPDATE commerce_outbox SET lease_until=NULL WHERE event_type='payment.submit_requested'",
    );
    await f.pool.query(
      "UPDATE commerce_kiosk_kaspi_qr SET lease_until=clock_timestamp()-interval '1 second'",
    );
    await r.due();
    await r.processor().tick();
    assert.equal(client.creates, 1);
    assert.equal((await r.row()).state, 'unknown');
  }));

test('QR late create reply survives a recovery worker observing unknown', async () =>
  fixture(async (f) => {
    const client = new FakeQr();
    let resolveCreate, notifyStarted;
    const started = new Promise((resolve) => {
      notifyStarted = resolve;
    });
    client.create = async (amount) => {
      client.creates++;
      notifyStarted();
      return new Promise((resolve) => {
        resolveCreate = () =>
          resolve({
            kind: 'ok',
            data: {
              QrOperationId: 123,
              Amount: amount,
              QrToken: 'https://qr.kaspi.kz/synthetic-test',
            },
          });
      });
    };
    const r = await ready(f, client);
    const issuing = r.processor().tick();
    await started;
    await f.pool.query(
      "UPDATE commerce_kiosk_kaspi_qr SET next_check_at=clock_timestamp()-interval '1 second',lease_until=clock_timestamp()-interval '1 second'",
    );
    await r.processor().tick();
    assert.equal((await r.row()).state, 'unknown');
    resolveCreate();
    assert.equal((await issuing).errors, 0);
    assert.equal((await r.row()).operation_id, '123');
    assert.equal((await r.row()).state, 'issued');
    assert.equal(client.creates, 1);
    client.statusAnswer = {
      kind: 'ok',
      data: { QrOperationId: 123, Amount: 110, Status: 'Processed' },
    };
    await r.due();
    await r.processor().tick();
    assert.equal((await r.row()).state, 'paid');
    assert.ok((await r.row()).delivered_at);
    assert.equal(
      (await f.pool.query('SELECT count(*)::int n FROM commerce_captures')).rows[0].n,
      1,
    );
  }));
test('QR rejects wrong bank id/amount and missing identity, then can reconcile exact paid fact', async () =>
  fixture(async (f) => {
    const r = await ready(f);
    await r.processor().tick();
    for (const data of [
      { QrOperationId: 124, Amount: 110, Status: 'Processed' },
      { QrOperationId: 123, Amount: 111, Status: 'Processed' },
      { Status: 'Processed' },
    ]) {
      r.client.statusAnswer = { kind: 'ok', data };
      await r.due();
      await r.processor().tick();
      assert.equal(
        (await f.pool.query('SELECT count(*)::int n FROM commerce_captures')).rows[0].n,
        0,
      );
      assert.equal((await r.row()).state, 'unknown');
    }
    r.client.statusAnswer = {
      kind: 'ok',
      data: { QrOperationId: 123, Amount: 110, Status: 'Processed' },
    };
    await r.due();
    await r.processor().tick();
    assert.equal((await r.row()).state, 'paid');
  }));
test('QR local expiry hides payload, preserves identity/deadline and accepts later bank payment', async () =>
  fixture(async (f) => {
    const r = await ready(f);
    await r.processor().tick();
    const before = await r.row();
    const expired = await readKioskQrPayment(
      f.pool,
      r.order.orderId,
      new Date(before.expires_at.getTime() + 1),
    );
    assert.equal(expired.state, 'checking');
    assert.equal(expired.qrPayload, null);
    await assert.rejects(
      f.pool.query("UPDATE commerce_kiosk_kaspi_qr SET expires_at=expires_at+interval '1 second'"),
      { code: '23514' },
    );
    await assert.rejects(f.pool.query("UPDATE commerce_kiosk_kaspi_qr SET operation_id='999'"), {
      code: '23514',
    });
    r.client.statusAnswer = {
      kind: 'ok',
      data: { QrOperationId: 123, Amount: 110, Status: 'Processed' },
    };
    await r.due();
    await r.processor().tick();
    assert.equal((await r.row()).expires_at.toISOString(), before.expires_at.toISOString());
    assert.equal((await readKioskQrPayment(f.pool, r.order.orderId)).state, 'paid');
  }));
test('QR server withholds create without an active restaurant transport', async () =>
  fixture(async (f) => {
    const r = await ready(f);
    await f.pool.query('UPDATE fulfillment_transport_bindings SET active=false');
    await r.processor().tick();
    assert.equal(r.client.creates, 0);
    assert.equal(await r.row(), undefined);
  }));

test('kiosk QR pays before edge admission, retains delivery and emits kitchen command only after admission', async () =>
  fixture(async (f) => {
    const r = await ready(f, new FakeQr(), false);
    const count = async (event) =>
      (
        await f.pool.query('SELECT count(*)::int n FROM commerce_outbox WHERE event_type=$1', [
          event,
        ])
      ).rows[0].n;
    assert.equal(await count('edge.admission_requested'), 1);
    await Promise.all([r.processor().tick(), r.processor().tick()]);
    assert.equal(r.client.creates, 1);
    assert.equal((await r.row()).state, 'issued');
    r.client.statusAnswer = {
      kind: 'ok',
      data: { QrOperationId: 123, Amount: 110, Status: 'Processed' },
    };
    await r.due();
    await r.processor().tick();
    const paid = await f.checkout.read(f.who, r.order.orderId);
    assert.equal(paid.phase, 'paid');
    assert.equal(paid.displayNumber, null);
    assert.equal(await count('edge.kitchen_admission_requested'), 0);
    assert.equal(
      (
        await f.pool.query('SELECT admission_reservation_id FROM commerce_orders WHERE id=$1', [
          r.order.orderId,
        ])
      ).rows[0].admission_reservation_id,
      null,
    );
    await f.admission(r.order);
    await r.processor().tick();
    assert.equal((await f.checkout.read(f.who, r.order.orderId)).displayNumber, '1');
    assert.equal(await count('edge.kitchen_admission_requested'), 1);
    assert.equal(
      (await f.pool.query('SELECT count(*)::int n FROM commerce_captures')).rows[0].n,
      1,
    );
    assert.equal(r.client.creates, 1);
  }));

test('generic payment port and database invoice guard still require admission; QR cannot change amount', async () =>
  fixture(async (f) => {
    const q = await f.checkout.quote(f.who, f.cart());
    const order = await f.checkout.create(f.who, { key: randomUUID(), quoteId: q.quoteId });
    const scope = {
      organizationId: f.org,
      branchId: f.branch,
      principalId: f.who.sessionId,
      role: 'sales',
    };
    await assert.rejects(
      f.checkout.repository.startPaymentAttempt(scope, randomUUID(), {
        orderId: order.orderId,
        providerAccountId: f.payment,
      }),
      { code: 'NOT_READY' },
    );
    const invoice = randomUUID();
    await f.pool.query(
      "INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,kind,provider,external_reference,enabled,legal_entity_id) VALUES($1::uuid,$2,$3,'payment','kaspi-remote',$1::text,true,$4)",
      [invoice, f.org, f.branch, f.legal],
    );
    const insert = (account, amount) =>
      f.pool.query(
        'INSERT INTO commerce_payment_attempts(id,intent_id,order_id,account_id,intended_minor) SELECT $1,id,order_id,$3,$4 FROM commerce_payment_intents WHERE order_id=$2',
        [randomUUID(), order.orderId, account, amount],
      );
    await assert.rejects(insert(invoice, '11000'), { code: '23514' });
    await assert.rejects(insert(f.payment, '11001'), { code: '23514' });
    await f.pool.query('UPDATE kiosk_devices SET active=false');
    await assert.rejects(insert(f.payment, '11000'), { code: '23514' });
    assert.equal(
      (await f.pool.query('SELECT count(*)::int n FROM commerce_payment_attempts')).rows[0].n,
      0,
    );
  }));

test('expired guest resumes only its existing QR order without renewal, while new orders and ended guests stay blocked', async () =>
  fixture(async (f) => {
    const q = await f.checkout.quote(f.who, f.cart());
    const unusedQuote = await f.checkout.quote(f.who, f.cart());
    const order = await f.checkout.create(f.who, { key: randomUUID(), quoteId: q.quoteId });
    await f.pool.query('UPDATE kiosk_sessions SET expires_at=clock_timestamp() WHERE id=$1', [
      f.who.sessionId,
    ]);
    const expires = (
      await f.pool.query('SELECT expires_at FROM kiosk_sessions WHERE id=$1', [f.who.sessionId])
    ).rows[0].expires_at;
    await assert.rejects(f.sessions.assertActive(f.who.sessionId), { code: 'FORBIDDEN' });
    await assert.rejects(
      f.checkout.create(f.who, { key: randomUUID(), quoteId: unusedQuote.quoteId }),
      { code: 'CONFLICT' },
    );
    const other = await f.guest();
    await assert.rejects(f.checkout.pay(other, order.orderId, { method: 'kaspi_qr' }), {
      code: 'NOT_FOUND',
    });
    await f.pool.query('UPDATE kiosk_devices SET active=false');
    await assert.rejects(f.checkout.pay(f.who, order.orderId, { method: 'kaspi_qr' }));
    await f.pool.query('UPDATE kiosk_devices SET active=true');
    await f.pool.query('UPDATE kiosk_sessions SET ended_at=clock_timestamp() WHERE id=$1', [
      f.who.sessionId,
    ]);
    await assert.rejects(f.checkout.pay(f.who, order.orderId, { method: 'kaspi_qr' }), {
      code: 'FORBIDDEN',
    });
    await f.pool.query('UPDATE kiosk_sessions SET ended_at=NULL WHERE id=$1', [f.who.sessionId]);
    const result = await Promise.all([
      f.checkout.pay(f.who, order.orderId, { method: 'kaspi_qr' }),
      f.checkout.pay(f.who, order.orderId, { method: 'kaspi_qr' }),
    ]);
    assert.ok(result.every((r) => r.orderId === order.orderId));
    assert.equal(
      (await f.pool.query('SELECT count(*)::int n FROM commerce_payment_attempts')).rows[0].n,
      1,
    );
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM commerce_orders')).rows[0].n, 1);
    assert.equal(
      (
        await f.pool.query('SELECT expires_at FROM kiosk_sessions WHERE id=$1', [f.who.sessionId])
      ).rows[0].expires_at.toISOString(),
      expires.toISOString(),
    );
  }));
