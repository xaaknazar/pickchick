import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { createHttpApplication, Resources, RESOURCE } from '@pickchick/platform';
import { CloudKitchen, KitchenScreens, provisionCloudKitchen } from '@pickchick/cloud-kitchen';
import {
  AvailabilityError,
  KioskCheckout,
  KioskSessions,
  cloudKitchenProjection,
  useCloudKitchenAdmission,
} from '../../packages/commerce-core/dist/index.js';
import { provisionDevice } from '../../packages/menu-sync/dist/index.js';
import { publishCatalog } from '../../packages/commerce-core/tests/catalog-fixture.mjs';
import {
  CLOUD_KITCHEN,
  CLOUD_KITCHEN_OPTIONS,
  CLOUD_KITCHEN_SCREENS,
  cloudKitchenModule,
} from '../../services/api/dist/cloud-kitchen-controller.js';

// ADR-0014 S4 end to end on PostgreSQL: kiosk order in mode 'cloud' -> Kaspi QR attempt ->
// simulated trusted capture (as the commerce tests do; never a real bank) -> cloud kitchen order
// numbered 300-599 -> paired screens poll and run it to handoff over HTTP. Mode 'edge' keeps the
// cashier admission exactly as before. No device registry (051) and no cashier take part.
process.env.APP_ENV ??= 'test';
for (const name of ['CLOUD_DATABASE_URL', 'EDGE_DATABASE_URL'])
  if (process.env[name])
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env[name]).hostname));

async function fixture(run, { mode = 'cloud', hook = true } = {}) {
  await withSyncDatabases(async (f) => {
    const pool = f.cloud.pool,
      payment = randomUUID(),
      fiscal = randomUUID(),
      kiosk = randomUUID(),
      deviceKey = randomBytes(32).toString('hex');
    // The cashier registration and binding are configuration only; nothing below needs the
    // cashier online (no heartbeat, no edge pull or ACK).
    await provisionDevice(pool, f.device);
    await pool.query(
      'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
      [f.branch, f.org, f.device, randomUUID()],
    );
    await pool.query(
      "INSERT INTO cloud_branch_availability(branch_id,device_id,revision,stopped_ids) VALUES($1,$2,1,'{}')",
      [f.branch, f.device],
    );
    for (const [id, kind, provider] of [
      [payment, 'payment', 'kaspi-qr'],
      [fiscal, 'fiscal', 'webkassa'],
    ])
      await pool.query(
        'INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,kind,provider,external_reference,enabled,legal_entity_id) VALUES($1::uuid,$2,$3,$5,$6,$1::text,true,$4)',
        [id, f.org, f.branch, f.legal, kind, provider],
      );
    await pool.query(
      'INSERT INTO kiosk_devices(id,organization_id,branch_id,token_hash) VALUES($1,$2,$3,$4)',
      [kiosk, f.org, f.branch, createHash('sha256').update(deviceKey).digest('hex')],
    );
    const sessions = new KioskSessions(pool, { piiKey: randomBytes(32) });
    const guest = async () => {
      const token = randomBytes(32).toString('hex');
      await sessions.start(kiosk, deviceKey, { sessionId: randomUUID(), token });
      return sessions.authenticate(kiosk, deviceKey, token);
    };
    await publishCatalog({ pool, scope: { organizationId: f.org, branchId: f.branch } });
    const checkout = new KioskCheckout(
      pool,
      {
        organizationId: f.org,
        branchId: f.branch,
        paymentAccountId: payment,
        paymentMethod: 'kaspi_qr',
        fiscalAccountId: fiscal,
        fiscalPolicy: 'required',
        approvalReference: 'Synthetic cloud kitchen test only',
        taxCode: 'PENDING_PILOT',
        maxOrderMinor: '50000',
        hours: { openingTime: '10:00', closingTime: '00:00', timeZone: 'Asia/Almaty' },
      },
      sessions,
      () => new Date('2026-10-04T10:00:00Z'),
    );
    const prep = randomUUID(),
      assembly = randomUUID();
    await provisionCloudKitchen(pool, {
      branchId: f.branch,
      stations: [
        { id: prep, kind: 'prep', name: 'Горячий цех' },
        { id: assembly, kind: 'assembly', name: 'Сборка' },
      ],
      routing: {
        version: 1,
        assemblyStationId: assembly,
        routes: [
          { productId: 'burger', stationId: prep, kind: 'prep' },
          { productId: 'sauce', stationId: prep, kind: 'prep' },
        ],
      },
    });
    const setMode = (owner) =>
      pool.query('SELECT * FROM cloud_kitchen_set_mode($1,$2,$3,$4)', [
        f.branch,
        owner,
        'synthetic-manager',
        'Synthetic switch',
      ]);
    if (mode === 'cloud') await setMode('cloud');
    const kitchen = new CloudKitchen(pool),
      screens = new KitchenScreens(pool);
    useCloudKitchenAdmission(hook ? kitchen : null);
    const pair = async (role, stationIds) => {
      const screen = await screens.create({
        branchId: f.branch,
        role,
        stationIds,
        name: 'Экран ' + role,
        actor: 'owner:synthetic',
        reason: 'Synthetic screen',
      });
      const code = await screens.issuePairingCode({
        branchId: f.branch,
        screenId: screen.screenId,
        actor: 'owner:synthetic',
        reason: 'Synthetic pairing',
      });
      return (await screens.exchange({ pairingCode: code.pairingCode })).screenKey;
    };
    const app = await createHttpApplication(
      cloudKitchenModule([
        { provide: RESOURCE, useFactory: () => new Resources(f.cloud.config) },
        { provide: CLOUD_KITCHEN, useValue: kitchen },
        { provide: CLOUD_KITCHEN_SCREENS, useValue: screens },
        { provide: CLOUD_KITCHEN_OPTIONS, useValue: { enabled: true } },
      ]),
    );
    await app.listen(0, '127.0.0.1');
    const url = (await app.getUrl()) + '/v1/kitchen';
    const http = async (key, path, body) => {
      const response = await fetch(url + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: 'Bearer ' + key,
          ...(body
            ? { 'Content-Type': 'application/json', 'Idempotency-Key': 'k-' + randomUUID() }
            : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    };
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
    const outbox = async (orderId) =>
      (
        await pool.query(
          'SELECT event_type FROM commerce_outbox WHERE order_id=$1 ORDER BY created_at,event_type',
          [orderId],
        )
      ).rows.map((r) => r.event_type);
    const capture = async (orderId, amount) => {
      const attempt = (
        await pool.query('SELECT id FROM commerce_payment_attempts WHERE order_id=$1', [orderId])
      ).rows[0];
      return checkout.repository.observePayment(
        { organizationId: f.org, branchId: f.branch, accountId: payment },
        {
          eventId: randomUUID(),
          attemptId: attempt.id,
          outcome: 'captured',
          operationId: 'synthetic-' + randomUUID(),
          amountMinor: amount,
          occurredAt: new Date().toISOString(),
        },
      );
    };
    try {
      await run({
        ...f,
        pool,
        checkout,
        guest,
        cart,
        pair,
        http,
        outbox,
        capture,
        setMode,
        kitchen,
        prep,
        assembly,
      });
    } finally {
      useCloudKitchenAdmission(null);
      await app.close();
    }
  });
}
const offline = (e) => e instanceof AvailabilityError && e.code === 'KITCHEN_OFFLINE';

test("mode 'cloud': kiosk QR order is paid, numbered 300-599 and handed over by paired screens", () =>
  fixture(async (f) => {
    const who = await f.guest();
    // The cashier has been silent for an hour: irrelevant in mode 'cloud'.
    await f.pool.query(
      "UPDATE cloud_branch_availability SET observed_at=clock_timestamp()-interval '1 hour'",
    );
    const cook = await f.pair('prep', [f.prep]),
      packer = await f.pair('assembly', [f.assembly]),
      board = await f.pair('display', []);
    // Nobody polls the cloud kitchen yet: the kiosk refuses to take the order.
    await assert.rejects(f.checkout.quote(who, f.cart()), offline);
    assert.equal((await f.http(cook, '/kitchen')).status, 200);
    await assert.rejects(f.checkout.quote(who, f.cart()), offline, 'prep without assembly');
    assert.equal((await f.http(packer, '/kitchen')).status, 200);
    const quote = await f.checkout.quote(who, f.cart());
    const order = await f.checkout.create(who, { key: randomUUID(), quoteId: quote.quoteId });
    const registered = (
      await f.pool.query(
        'SELECT channel,fiscal_status FROM cloud_channel_orders WHERE order_id=$1',
        [order.orderId],
      )
    ).rows[0];
    assert.deepEqual(registered, { channel: 'kiosk', fiscal_status: 'deferred_no_receipt' });
    // The cashier is never asked to admit the order; payment opens at once.
    assert.deepEqual(await f.outbox(order.orderId), []);
    assert.equal(
      (await f.pool.query('SELECT state FROM commerce_orders WHERE id=$1', [order.orderId])).rows[0]
        .state,
      'awaiting_payment',
    );
    await f.checkout.pay(who, order.orderId, { method: 'kaspi_qr' });
    const paid = await f.capture(order.orderId, quote.totalMinor);
    assert.equal(paid.state, 'paid_pending_acceptance');
    assert.equal(paid.attentionRequired, false);
    const events = await f.outbox(order.orderId);
    assert.ok(events.includes('payment.capture_recorded'));
    assert.ok(!events.includes('edge.kitchen_admission_requested'));
    assert.ok(!events.includes('edge.admission_requested'));
    assert.ok(!events.includes('fiscal.submit_requested'));
    // No receipt for now: no fiscal document, marked for later reconciliation.
    assert.equal(
      (await f.pool.query('SELECT count(*)::int n FROM commerce_fiscal_documents')).rows[0].n,
      0,
    );
    // Admitted in the capture transaction.
    const projection = await cloudKitchenProjection(f.pool, order.orderId);
    assert.equal(projection.state, 'accepted');
    const number = Number(projection.display_number);
    assert.ok(number >= 300 && number <= 599, String(number));
    assert.equal(projection.assembly, false);
    // The kiosk can still read its order.
    assert.equal((await f.checkout.read(who, order.orderId)).totalMinor, quote.totalMinor);

    // Kitchen over HTTP with screen keys.
    const display = await f.http(board, '/display');
    assert.deepEqual(display.body.items, [
      { number, state: 'preparing', fulfillmentOwner: 'cloud' },
    ]);
    assert.equal((await f.http(board, '/kitchen')).status, 403);
    const feed = await f.http(cook, '/kitchen?stationId=' + f.prep);
    assert.equal(feed.body.items.length, 1);
    let item = feed.body.items[0];
    assert.equal(item.displayNumber, number);
    const task = item.tasks[0];
    assert.equal(task.stationId, f.prep);
    let result = await f.http(cook, '/commands', {
      orderId: order.orderId,
      expectedVersion: item.version,
      action: 'start_task',
      taskId: task.id,
      expectedTaskVersion: task.version,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.state, 'in_production');
    // The packer may not act on the prep station.
    const foreign = await f.http(packer, '/commands', {
      orderId: order.orderId,
      expectedVersion: result.body.version,
      action: 'complete_station',
      stationId: f.prep,
    });
    assert.equal(foreign.status, 403);
    result = await f.http(cook, '/commands', {
      orderId: order.orderId,
      expectedVersion: result.body.version,
      action: 'complete_station',
      stationId: f.prep,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    result = await f.http(packer, '/commands', {
      orderId: order.orderId,
      expectedVersion: result.body.version,
      action: 'ready',
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.state, 'ready');
    assert.equal((await cloudKitchenProjection(f.pool, order.orderId)).state, 'ready');
    assert.equal((await f.http(board, '/display')).body.items[0].state, 'ready');
    result = await f.http(packer, '/commands', {
      orderId: order.orderId,
      expectedVersion: result.body.version,
      action: 'handoff',
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.state, 'handed_over');
    assert.equal((await cloudKitchenProjection(f.pool, order.orderId)).state, 'handed_over');
    assert.deepEqual((await f.http(board, '/display')).body.items, []);
    // The number is free again.
    assert.ok(
      (
        await f.pool.query('SELECT released_at FROM channel_number_holds WHERE order_id=$1', [
          order.orderId,
        ])
      ).rows[0].released_at,
    );
    // Every command is journalled with the screen as device.
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(DISTINCT device_id)::int n FROM cloud_kitchen_commands WHERE order_id=$1',
          [order.orderId],
        )
      ).rows[0].n,
      2,
    );
  }));

test("mode 'cloud' without the in-transaction hook: the next feed poll admits the paid order", () =>
  fixture(
    async (f) => {
      const who = await f.guest();
      const cook = await f.pair('prep', [f.prep]),
        packer = await f.pair('assembly', [f.assembly]);
      await f.http(cook, '/kitchen');
      await f.http(packer, '/kitchen');
      const quote = await f.checkout.quote(who, f.cart());
      const order = await f.checkout.create(who, { key: randomUUID(), quoteId: quote.quoteId });
      await f.checkout.pay(who, order.orderId, { method: 'kaspi_qr' });
      // As a payment worker process would: capture committed, no kitchen hook in this process.
      assert.equal(
        (await f.capture(order.orderId, quote.totalMinor)).state,
        'paid_pending_acceptance',
      );
      assert.equal(await cloudKitchenProjection(f.pool, order.orderId), null);
      const feed = await f.http(cook, '/kitchen?stationId=' + f.prep);
      assert.equal(feed.body.items.length, 1);
      assert.equal(feed.body.items[0].orderId, order.orderId);
      const number = (await cloudKitchenProjection(f.pool, order.orderId)).display_number;
      assert.ok(Number(number) >= 300 && Number(number) <= 599);
      // Idempotent: another poll does not admit twice.
      await f.http(packer, '/kitchen');
      assert.equal(
        (await f.pool.query('SELECT count(*)::int n FROM cloud_kitchen_orders')).rows[0].n,
        1,
      );
    },
    { hook: false },
  ));

test("mode switch: payment closes after leaving 'cloud'; a switch during payment needs review", () =>
  fixture(async (f) => {
    const cook = await f.pair('prep', [f.prep]),
      packer = await f.pair('assembly', [f.assembly]);
    const poll = () => Promise.all([f.http(cook, '/kitchen'), f.http(packer, '/kitchen')]);
    await poll();
    const first = await f.guest();
    const quote = await f.checkout.quote(first, f.cart());
    const early = await f.checkout.create(first, { key: randomUUID(), quoteId: quote.quoteId });
    await f.setMode('edge');
    // The order belongs to the cloud channel; with the branch back on the cashier it stays closed.
    await assert.rejects(f.checkout.pay(first, early.orderId, { method: 'kaspi_qr' }), {
      code: 'NOT_READY',
    });
    await f.setMode('cloud');
    await poll();
    const second = await f.guest();
    const quote2 = await f.checkout.quote(second, f.cart());
    const late = await f.checkout.create(second, { key: randomUUID(), quoteId: quote2.quoteId });
    await f.checkout.pay(second, late.orderId, { method: 'kaspi_qr' });
    await f.setMode('edge');
    // The money is recorded; no kitchen owns the order, so it goes to review.
    const paid = await f.capture(late.orderId, quote2.totalMinor);
    assert.equal(paid.state, 'attention_required');
    assert.equal(
      (
        await f.pool.query('SELECT code FROM commerce_reconciliation_issues WHERE order_id=$1', [
          late.orderId,
        ])
      ).rows[0].code,
      'CLOUD_MODE_CHANGED_BEFORE_ADMISSION',
    );
    assert.equal(
      (await f.pool.query('SELECT count(*)::int n FROM cloud_kitchen_admissions')).rows[0].n,
      0,
    );
    assert.ok(!(await f.outbox(late.orderId)).includes('edge.kitchen_admission_requested'));
  }));

test("mode 'edge' (default): the cashier admits as before and nothing cloud is written", () =>
  fixture(
    async (f) => {
      const who = await f.guest();
      const quote = await f.checkout.quote(who, f.cart());
      const order = await f.checkout.create(who, { key: randomUUID(), quoteId: quote.quoteId });
      assert.deepEqual(await f.outbox(order.orderId), ['edge.admission_requested']);
      assert.equal(
        (await f.pool.query('SELECT count(*)::int n FROM cloud_channel_orders')).rows[0].n,
        0,
      );
      assert.equal(
        (await f.pool.query('SELECT state FROM commerce_orders WHERE id=$1', [order.orderId]))
          .rows[0].state,
        'awaiting_admission',
      );
      await f.checkout.pay(who, order.orderId, { method: 'kaspi_qr' });
      await f.capture(order.orderId, quote.totalMinor);
      // Fiscal policy 'required' still queues the sale receipt for an edge order.
      assert.ok((await f.outbox(order.orderId)).includes('fiscal.submit_requested'));
      assert.equal(
        (await f.pool.query('SELECT count(*)::int n FROM cloud_kitchen_admissions')).rows[0].n,
        0,
      );
      assert.equal(await cloudKitchenProjection(f.pool, order.orderId), null);
    },
    { mode: 'edge' },
  ));
