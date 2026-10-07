import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { withSyncDatabases, authFor } from '../../../tests/helpers/sync.mjs';
import {
  localCatalogId,
  publishMenu,
  projectCatalogMenu,
  provisionDevice,
  pullMenu,
  applyMenu,
  acknowledgeMenu,
} from '@pickchick/menu-sync';
import {
  CustomerCheckout,
  KioskCheckout,
  KioskSessions,
  KaspiRemoteProcessor,
  kioskCheckoutOptions,
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

async function fixture(run, paymentMethod = 'kaspi_invoice') {
  await withSyncDatabases(async (f) => {
    const pool = f.cloud.pool,
      payment = randomUUID(),
      invoicePayment = paymentMethod === 'both' ? randomUUID() : undefined,
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
      "INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,kind,provider,external_reference,enabled,legal_entity_id) VALUES($1::uuid,$2,$3,'payment',$5,$1::text,true,$4)",
      [
        payment,
        f.org,
        f.branch,
        f.legal,
        paymentMethod === 'kaspi_qr' || paymentMethod === 'both' ? 'kaspi-qr' : 'kaspi-remote',
      ],
    );
    if (invoicePayment)
      await pool.query(
        "INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,kind,provider,external_reference,enabled,legal_entity_id) VALUES($1::uuid,$2,$3,'payment','kaspi-remote',$1::text,true,$4)",
        [invoicePayment, f.org, f.branch, f.legal],
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
      paymentMethod: paymentMethod === 'both' ? 'kaspi_qr' : paymentMethod,
      invoicePaymentAccountId: invoicePayment,
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
      invoicePayment,
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

test('kiosk is explicitly disabled and refuses menu before the exact restaurant ACK', async () => {
  assert.equal(kioskCheckoutOptions({}), null);
  assert.throws(() => kioskCheckoutOptions({ KIOSK_CHECKOUT_ENABLED: 'true' }));
  await fixture(async (f) => {
    assert.equal((await f.checkout.config(f.who)).enabled, false);
    await assert.rejects(f.checkout.quote(f.who, f.cart()), { code: 'NOT_READY' });
    await f.ack();
    assert.equal((await f.checkout.config(f.who)).enabled, true);
    const quote = await f.checkout.quote(f.who, f.cart());
    assert.equal(quote.totalMinor, '11000');
    const row = (
      await f.pool.query('SELECT snapshot,customer_id FROM commerce_quotes WHERE id=$1', [
        quote.quoteId,
      ])
    ).rows[0];
    assert.equal(row.snapshot.channel, 'kiosk');
    assert.equal(row.customer_id, null);
    assert.equal((await f.checkout.catalog(f.who)).channel, 'kiosk');
    await f.pool.query(
      'UPDATE fulfillment_transport_bindings SET active=false WHERE branch_id=$1',
      [f.branch],
    );
    assert.equal((await f.checkout.config(f.who)).enabled, false);
  });
});

test('server enforces price, version, stop-list, branch ownership and one order per guest', async () => {
  await fixture(async (f) => {
    await f.ack();
    await assert.rejects(f.checkout.quote(f.who, { ...f.cart(), totalMinor: '1' }), {
      code: 'INVALID',
    });
    await assert.rejects(f.checkout.quote(f.who, { ...f.cart(), catalog_version: 42 }), {
      code: 'CONFLICT',
    });
    await f.pool.query(
      'UPDATE cloud_branch_availability SET stopped_ids=$2::uuid[] WHERE branch_id=$1',
      [f.branch, [localCatalogId(f.branch, 'base-preview', 'burger')]],
    );
    await assert.rejects(f.checkout.quote(f.who, f.cart()), { code: 'ITEM_STOPPED' });
    await f.pool.query("UPDATE cloud_branch_availability SET stopped_ids='{}' WHERE branch_id=$1", [
      f.branch,
    ]);
    const q = await f.checkout.quote(f.who, f.cart()),
      q2 = await f.checkout.quote(f.who, f.cart());
    const req = { key: randomUUID(), quoteId: q.quoteId };
    const order = await f.checkout.create(f.who, req);
    assert.equal((await f.checkout.create(f.who, req)).orderId, order.orderId);
    await assert.rejects(f.checkout.create(f.who, { key: randomUUID(), quoteId: q2.quoteId }), {
      code: 'CONFLICT',
    });
    await assert.rejects(f.checkout.read(await f.guest(), order.orderId), { code: 'NOT_FOUND' });
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM commerce_orders')).rows[0].n, 1);
    assert.equal(order.phase, 'awaiting_restaurant');
    assert.equal(
      (await f.pool.query('SELECT count(*)::int n FROM commerce_payment_attempts')).rows[0].n,
      0,
    );
  });
});

test('guest invoice prevents end until bank confirmation without logging in as a customer', async () => {
  await fixture(async (f) => {
    await f.ack();
    const q = await f.checkout.quote(f.who, f.cart()),
      order = await f.checkout.create(f.who, { key: randomUUID(), quoteId: q.quoteId });
    await f.admission(order);
    const paidBody = { phone: '+77011234567' };
    await Promise.all([
      f.checkout.pay(f.who, order.orderId, paidBody),
      f.checkout.pay(f.who, order.orderId, paidBody),
    ]);
    await assert.rejects(f.checkout.pay(f.who, order.orderId, { phone: '+77011234568' }), {
      code: 'CONFLICT',
    });
    assert.equal(
      (await f.pool.query('SELECT count(*)::int n FROM commerce_payment_attempts')).rows[0].n,
      1,
    );
    let calls = 0,
      status = 'RemotePaymentCreated';
    const bridge = {
      checkSession: async () => true,
      createInvoice: async (phone, amount) => {
        calls++;
        assert.equal(phone, '77011234567');
        assert.equal(amount, 110);
        return { kind: 'ok', data: { QrOperationId: 700001, Status: status } };
      },
      details: async () => ({
        kind: 'ok',
        data: { QrOperationId: 700001, Amount: 110, Status: status },
      }),
    };
    const processor = new KaspiRemoteProcessor(
      f.pool,
      {
        bridgeUrl: 'http://127.0.0.1:1',
        webhookSecret: 'x'.repeat(32),
        accountId: f.payment,
        invoiceTtlSeconds: 180,
        requestTimeoutMs: 1000,
        session: null,
      },
      bridge,
      async () => {
        throw Error('Guest must never use customer phone lookup');
      },
      undefined,
      (id) => f.sessions.readOrderPhone(id),
    );
    await assert.rejects(f.sessions.end(f.who.sessionId), { code: 'CONFLICT' });
    await processor.tick();
    assert.equal(calls, 1);
    assert.equal((await f.checkout.read(f.who, order.orderId)).phase, 'awaiting_payment');
    status = 'Processed';
    await f.pool.query('UPDATE commerce_kaspi_invoices SET next_check_at=clock_timestamp()');
    await processor.tick();
    const view = await f.checkout.repository.readOrder(
      { organizationId: f.org, branchId: f.branch, principalId: f.who.sessionId, role: 'sales' },
      order.orderId,
    );
    assert.equal(view.money.captured, '11000');
    assert.equal(view.fiscalPolicy, 'deferred_pilot');
    assert.ok(view.kitchenEffectId);
    await f.pool.query(
      "UPDATE kiosk_sessions SET phone_expires_at=clock_timestamp()-interval '1 day'",
    );
    assert.equal(await f.sessions.purgeExpiredPhones(), 1);
    assert.equal(await f.sessions.readOrderPhone(order.orderId), null);
    assert.equal((await f.checkout.pay(f.who, order.orderId, paidBody)).orderId, order.orderId);
    assert.equal(await f.sessions.readOrderPhone(order.orderId), null);
    assert.equal(
      (await f.pool.query('SELECT count(*)::int n FROM commerce_payment_attempts')).rows[0].n,
      1,
    );
    await f.sessions.end(f.who.sessionId);
    await processor.tick();
    assert.equal(calls, 1);
  });
});

test('client-chosen guest principal cannot access a mobile quote or order with the same UUID', async () => {
  await fixture(async (f) => {
    await f.ack();
    const scope = {
      organizationId: f.org,
      branchId: f.branch,
      principalId: f.who.sessionId,
      role: 'sales',
    };
    const release = (await f.pool.query('SELECT id FROM menu_releases LIMIT 1')).rows[0].id;
    const mobileQuote = await f.checkout.repository.issueQuote(scope, randomUUID(), {
      releaseId: release,
      customerId: f.who.sessionId,
      channel: 'mobile',
      serviceMode: 'takeaway',
      currency: 'KZT',
      ttlSeconds: 300,
      lines: [
        {
          lineId: randomUUID(),
          productId: 'burger',
          title: 'Synthetic mobile order',
          quantity: 1,
          unitPriceMinor: '10000',
          discountMinor: '0',
          taxCode: 'PENDING_PILOT',
        },
      ],
    });
    await assert.rejects(
      f.checkout.create(f.who, { key: randomUUID(), quoteId: mobileQuote.quoteId }),
      { code: 'NOT_FOUND' },
    );
    const mobile = await f.checkout.repository.createDeferredFiscalOrder(
      scope,
      randomUUID(),
      mobileQuote.quoteId,
    );
    await assert.rejects(f.checkout.read(f.who, mobile.orderId), { code: 'NOT_FOUND' });
    await assert.rejects(f.checkout.pay(f.who, mobile.orderId, { phone: '+77011234567' }), {
      code: 'NOT_FOUND',
    });
    assert.equal(await f.sessions.readOrderPhone(mobile.orderId), null);
    assert.equal(
      (await f.pool.query('SELECT count(*)::int n FROM commerce_payment_attempts')).rows[0].n,
      0,
    );
  });
});

test('mobile APIs never adopt guest quotes, orders, payment or feedback on a principal collision', async () => {
  await fixture(async (f) => {
    await f.ack();
    const q = await f.checkout.quote(f.who, f.cart());
    const customer = f.who.sessionId;
    const mobile = new CustomerCheckout(f.pool, {
      organizationId: f.org,
      branchId: f.branch,
      paymentAccountId: f.payment,
      customerIds: [customer],
      publishedCatalogEnabled: true,
      repeatOrdersEnabled: true,
      maxOrderMinor: '50000',
      approvalReference: 'Synthetic mobile test',
    });
    await assert.rejects(mobile.create(customer, { key: randomUUID(), quoteId: q.quoteId }), {
      code: 'NOT_FOUND',
    });
    const order = await f.checkout.create(f.who, { key: randomUUID(), quoteId: q.quoteId });
    await assert.rejects(mobile.read(customer, order.orderId), { code: 'NOT_FOUND' });
    await assert.rejects(mobile.pay(customer, order.orderId), { code: 'NOT_FOUND' });
    await assert.rejects(mobile.feedback(customer, order.orderId), { code: 'NOT_FOUND' });
    await assert.rejects(mobile.submitFeedback(customer, order.orderId, { rating: 5 }), {
      code: 'NOT_FOUND',
    });
    assert.deepEqual(await mobile.list(customer), { orders: [] });
    assert.deepEqual(await mobile.listFeedback(customer), { feedback: [] });
  });
});

test('both methods use separate accounts and cannot switch an existing attempt', async () => {
  await fixture(async (f) => {
    await f.ack();
    assert.deepEqual((await f.checkout.config(f.who)).paymentMethods, [
      'kaspi_qr',
      'kaspi_invoice',
    ]);
    const q = await f.checkout.quote(f.who, f.cart());
    const order = await f.checkout.create(f.who, { key: randomUUID(), quoteId: q.quoteId });
    await f.admission(order);
    const req = { method: 'kaspi_invoice', phone: '+77011234567' };
    await Promise.all([
      f.checkout.pay(f.who, order.orderId, req),
      f.checkout.pay(f.who, order.orderId, req),
    ]);
    assert.equal((await f.checkout.read(f.who, order.orderId)).paymentMethod, 'kaspi_invoice');
    const attempts = (await f.pool.query('SELECT account_id FROM commerce_payment_attempts')).rows;
    assert.deepEqual(
      attempts.map((a) => a.account_id),
      [f.invoicePayment],
    );
    await assert.rejects(f.checkout.pay(f.who, order.orderId, { method: 'kaspi_qr' }), {
      code: 'CONFLICT',
    });
    await assert.rejects(f.sessions.end(f.who.sessionId), { code: 'CONFLICT' });
    // Recovery is pinned to the existing account even after config disable or guest expiry.
    await f.pool.query('UPDATE commerce_provider_accounts SET enabled=false');
    await f.pool.query(
      "UPDATE kiosk_sessions SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour'",
    );
    assert.equal((await f.checkout.pay(f.who, order.orderId, req)).orderId, order.orderId);
    assert.equal(
      (await f.pool.query('SELECT count(*)::int n FROM commerce_payment_attempts')).rows[0].n,
      1,
    );
  }, 'both');
});
test('racing QR and phone selection creates only one provider attempt', async () => {
  await fixture(async (f) => {
    await f.ack();
    const q = await f.checkout.quote(f.who, f.cart());
    const order = await f.checkout.create(f.who, { key: randomUUID(), quoteId: q.quoteId });
    await f.admission(order);
    const results = await Promise.allSettled([
      f.checkout.pay(f.who, order.orderId, { method: 'kaspi_qr' }),
      f.checkout.pay(f.who, order.orderId, { method: 'kaspi_invoice', phone: '+77011234567' }),
      f.sessions.end(f.who.sessionId),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(
      (await f.pool.query('SELECT count(*)::int n FROM commerce_payment_attempts')).rows[0].n,
      1,
    );
    assert.equal(
      (await f.pool.query('SELECT ended_at FROM kiosk_sessions WHERE id=$1', [f.who.sessionId]))
        .rows[0].ended_at,
      null,
    );
  }, 'both');
});
test('ended or expired guests cannot create a new order or payment', async () => {
  await fixture(async (f) => {
    await f.ack();
    const q = await f.checkout.quote(f.who, f.cart());
    await f.sessions.end(f.who.sessionId);
    await assert.rejects(f.checkout.create(f.who, { key: randomUUID(), quoteId: q.quoteId }), {
      code: 'FORBIDDEN',
    });
  });
  await fixture(async (f) => {
    await f.ack();
    const q = await f.checkout.quote(f.who, f.cart());
    const order = await f.checkout.create(f.who, { key: randomUUID(), quoteId: q.quoteId });
    await f.admission(order);
    await f.pool.query(
      "UPDATE kiosk_sessions SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour'",
    );
    await assert.rejects(f.checkout.pay(f.who, order.orderId, { phone: '+77011234567' }), {
      code: 'FORBIDDEN',
    });
    assert.equal(
      (await f.pool.query('SELECT count(*)::int n FROM commerce_payment_attempts')).rows[0].n,
      0,
    );
  });
});
test('independent API instances serialize ending a guest against order creation', async () => {
  await fixture(async (f) => {
    await f.ack();
    const other = new KioskSessions(f.pool, { piiKey: randomBytes(32) });
    const quote = await f.checkout.quote(f.who, f.cart());
    const results = await Promise.allSettled([
      f.checkout.create(f.who, { key: randomUUID(), quoteId: quote.quoteId }),
      other.end(f.who.sessionId),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const ended = (
      await f.pool.query('SELECT ended_at FROM kiosk_sessions WHERE id=$1', [f.who.sessionId])
    ).rows[0].ended_at;
    const orders = (await f.pool.query('SELECT count(*)::int n FROM commerce_orders')).rows[0].n;
    assert.equal(orders, ended ? 0 : 1);
  });
});
test('unavailable QR account still permits explicitly configured invoice; wrong provider is rejected', async () => {
  await fixture(async (f) => {
    await f.ack();
    await f.pool.query('UPDATE commerce_provider_accounts SET enabled=false WHERE id=$1', [
      f.payment,
    ]);
    assert.equal((await f.checkout.config(f.who)).enabled, true);
    assert.deepEqual((await f.checkout.config(f.who)).paymentMethods, ['kaspi_invoice']);
    const wrong = new KioskCheckout(
      f.pool,
      { ...f.options, invoicePaymentAccountId: f.payment },
      f.sessions,
    );
    assert.equal((await wrong.config(f.who)).enabled, false);
    assert.deepEqual((await wrong.config(f.who)).paymentMethods, []);
  }, 'both');
});
test('QR checkout owns its server price and payment without recording guest phone', async () => {
  await fixture(async (f) => {
    await f.ack();
    assert.equal((await f.checkout.config(f.who)).paymentMethod, 'kaspi_qr');
    const quote = await f.checkout.quote(f.who, f.cart());
    const order = await f.checkout.create(f.who, { key: randomUUID(), quoteId: quote.quoteId });
    await f.admission(order);
    await assert.rejects(f.checkout.pay(f.who, order.orderId, { phone: '+77011234567' }), {
      code: 'NOT_READY',
    });
    await Promise.all([
      f.checkout.pay(f.who, order.orderId, { method: 'kaspi_qr' }),
      f.checkout.pay(f.who, order.orderId, { method: 'kaspi_qr' }),
    ]);
    assert.equal(
      (await f.pool.query('SELECT count(*)::int n FROM commerce_payment_attempts')).rows[0].n,
      1,
    );
    assert.equal(await f.sessions.readOrderPhone(order.orderId), null);
    const view = await f.checkout.read(f.who, order.orderId);
    assert.equal(view.payment.kind, 'kaspi_qr');
    assert.equal(view.payment.qrPayload, null);
    assert.equal(view.totalMinor, quote.totalMinor);
    await assert.rejects(f.checkout.read(await f.guest(), order.orderId), { code: 'NOT_FOUND' });
  }, 'kaspi_qr');
});
