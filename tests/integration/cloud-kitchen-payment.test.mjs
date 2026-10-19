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
  reviewOrderInTransaction,
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

async function fixture(run, { mode = 'cloud', hook = true, kitchenOptions = {} } = {}) {
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
    // As the API wires it (release fixes 19.10): catch-up failures go to commerce review.
    const kitchen = new CloudKitchen(pool, { review: reviewOrderInTransaction, ...kitchenOptions }),
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
    assert.deepEqual(
      { ...(await f.checkout.config(who)), branchId: undefined },
      {
        enabled: false,
        branchId: undefined,
        restaurant: (await f.pool.query('SELECT name FROM branches WHERE id=$1', [f.branch]))
          .rows[0].name,
        paymentMethod: 'kaspi_qr',
        paymentMethods: ['kaspi_qr'],
        kitchen: 'offline',
      },
    );
    await assert.rejects(f.checkout.quote(who, f.cart()), offline);
    assert.equal((await f.http(cook, '/kitchen')).status, 200);
    await assert.rejects(f.checkout.quote(who, f.cart()), offline, 'prep without assembly');
    assert.equal((await f.checkout.config(who)).kitchen, 'offline');
    assert.equal((await f.http(packer, '/kitchen')).status, 200);
    const ready = await f.checkout.config(who);
    assert.equal(ready.enabled, true);
    assert.equal(ready.kitchen, 'online');
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
    // The kiosk reads its number and kitchen status from the cloud kitchen; no receipt for now.
    let view = await f.checkout.read(who, order.orderId);
    assert.equal(view.totalMinor, quote.totalMinor);
    assert.equal(view.displayNumber, String(number));
    assert.equal(view.phase, 'preparing');
    assert.equal(view.kitchenStage, 'cooking');
    assert.equal(view.receipt, 'deferred');

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
    view = await f.checkout.read(who, order.orderId);
    assert.equal(view.phase, 'ready');
    assert.equal(view.displayNumber, String(number));
    assert.equal((await f.http(board, '/display')).body.items[0].state, 'ready');
    result = await f.http(packer, '/commands', {
      orderId: order.orderId,
      expectedVersion: result.body.version,
      action: 'handoff',
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.state, 'handed_over');
    assert.equal((await cloudKitchenProjection(f.pool, order.orderId)).state, 'handed_over');
    view = await f.checkout.read(who, order.orderId);
    assert.equal(view.phase, 'handed_over');
    assert.equal(view.receipt, 'deferred');
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

test("mode 'cloud': kiosk readiness is the cloud kitchen gate, not the cashier binding", () =>
  fixture(async (f) => {
    const who = await f.guest();
    // The cashier binding and device are gone: irrelevant for a branch in mode 'cloud'.
    await f.pool.query(
      'UPDATE fulfillment_transport_bindings SET active=false WHERE branch_id=$1',
      [f.branch],
    );
    const cook = await f.pair('prep', [f.prep]),
      packer = await f.pair('assembly', [f.assembly]);
    assert.equal((await f.checkout.config(who)).enabled, false);
    await Promise.all([f.http(cook, '/kitchen'), f.http(packer, '/kitchen')]);
    assert.deepEqual(
      [(await f.checkout.config(who)).enabled, (await f.checkout.config(who)).kitchen],
      [true, 'online'],
    );
    const quote = await f.checkout.quote(who, f.cart());
    const order = await f.checkout.create(who, { key: randomUUID(), quoteId: quote.quoteId });
    // Before payment: no number yet, receipt deferred, ready to pay.
    const view = await f.checkout.read(who, order.orderId);
    assert.equal(view.displayNumber, null);
    assert.equal(view.receipt, 'deferred');
    assert.equal(view.phase, 'ready_to_pay');
    // The stations stop polling (older than 30 s): checkout closes with KITCHEN_OFFLINE.
    await f.pool.query(
      "UPDATE cloud_kitchen_station_presence SET seen_at=clock_timestamp()-interval '1 minute'",
    );
    assert.deepEqual(
      [(await f.checkout.config(who)).enabled, (await f.checkout.config(who)).kitchen],
      [false, 'offline'],
    );
    await assert.rejects(f.checkout.pay(who, order.orderId, { method: 'kaspi_qr' }), offline);
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
      // The edge answer keeps its shape (no cloud kitchen field) and receipt policy.
      assert.equal('kitchen' in (await f.checkout.config(who)), false);
      assert.equal((await f.checkout.read(who, order.orderId)).receipt, 'pending');
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

// Release fixes 2026-10-19 (audit 1.2, 1.5).
const issueCodes = async (f, orderId) =>
  (
    await f.pool.query(
      'SELECT code FROM commerce_reconciliation_issues WHERE order_id=$1 ORDER BY code',
      [orderId],
    )
  ).rows.map((r) => r.code);
/** Both stations polled within 30 s: the KITCHEN_OFFLINE gate is open. */
async function online(f) {
  const cook = await f.pair('prep', [f.prep]),
    packer = await f.pair('assembly', [f.assembly]);
  await f.http(cook, '/kitchen');
  await f.http(packer, '/kitchen');
}
async function paidOrder(f, selections) {
  const who = await f.guest();
  const cart = f.cart();
  if (selections) cart.items[0].selections = selections;
  const quote = await f.checkout.quote(who, cart);
  const order = await f.checkout.create(who, { key: randomUUID(), quoteId: quote.quoteId });
  await f.checkout.pay(who, order.orderId, { method: 'kaspi_qr' });
  return { order, quote, who };
}

test('a Kaspi-paid order after a switch to edge goes to review from the feed catch-up; cloud mode stays closed until then', () =>
  fixture(
    async (f) => {
      await online(f);
      const { order, quote } = await paidOrder(f);
      await f.setMode('edge');
      // As the Kaspi payment worker commits it: no kitchen hook in that process.
      assert.equal(
        (await f.capture(order.orderId, quote.totalMinor)).state,
        'paid_pending_acceptance',
      );
      const { setMode: ownerSetMode } =
        await import('../../infra/staging/cloud-kitchen-release-owner.mjs');
      const { stuckCloudOrders, overlappingEdgeNumbers } =
        await import('../../packages/backoffice-core/dist/cloud-kitchen.js');
      const client = await f.pool.connect();
      try {
        // The back-office switch uses the same two checks.
        assert.equal(await stuckCloudOrders(client, f.branch), 1);
        assert.equal(await overlappingEdgeNumbers(client, f.branch), 0);
        await assert.rejects(
          ownerSetMode(client, {
            branch: f.branch,
            owner: 'cloud',
            operator: 'owner',
            reason: 'Synthetic switch back',
          }),
          /Paid cloud orders still wait/,
        );
        const result = await f.kitchen.admitPendingPaid(f.branch);
        assert.deepEqual(result, { admitted: [], reviewed: [order.orderId] });
        assert.deepEqual(await issueCodes(f, order.orderId), [
          'CLOUD_MODE_CHANGED_BEFORE_ADMISSION',
        ]);
        assert.equal(
          (await f.pool.query('SELECT state FROM commerce_orders WHERE id=$1', [order.orderId]))
            .rows[0].state,
          'attention_required',
        );
        // Reviewed once; later polls select nothing.
        assert.deepEqual(await f.kitchen.admitPendingPaid(f.branch), { admitted: [] });
        // Audit 1.4: a live cashier order still numbered in 300-899 (before edge 022) blocks too.
        const row = (
          await f.pool.query('SELECT quote_id,quote_digest FROM commerce_orders WHERE id=$1', [
            order.orderId,
          ])
        ).rows[0];
        await f.pool.query(
          `INSERT INTO cloud_fulfillment_projection(order_id,branch_id,organization_id,device_id,reservation_id,quote_id,quote_hash,owner_hash,version,state,display_number,routing_version,payload)
           VALUES($1,$2,$3,$4,$5,$6,$7,$7,2,'accepted','345',1,'{}')`,
          [order.orderId, f.branch, f.org, f.device, randomUUID(), row.quote_id, row.quote_digest],
        );
        assert.equal(await stuckCloudOrders(client, f.branch), 0);
        assert.equal(await overlappingEdgeNumbers(client, f.branch), 1);
        await assert.rejects(
          ownerSetMode(client, {
            branch: f.branch,
            owner: 'cloud',
            operator: 'owner',
            reason: 'Synthetic switch back',
          }),
          /numbers 300-899/,
        );
        await f.pool.query(
          "UPDATE cloud_fulfillment_projection SET state='handed_over',version=3 WHERE order_id=$1",
          [order.orderId],
        );
        assert.equal(
          (
            await ownerSetMode(client, {
              branch: f.branch,
              owner: 'cloud',
              operator: 'owner',
              reason: 'Synthetic switch back',
            })
          ).after,
          'cloud',
        );
      } finally {
        client.release();
      }
    },
    { hook: false },
  ));

test('orders that can never be admitted go to review and never starve a newer paid order', () =>
  fixture(
    async (f) => {
      await online(f);
      const broken = [await paidOrder(f), await paidOrder(f)];
      const fine = await paidOrder(f, []);
      // A route was removed after these sauce orders were paid (owner republished stations).
      await f.pool.query(
        'UPDATE cloud_kitchen_config SET active_routing_version=1 WHERE branch_id=$1',
        [f.branch],
      );
      const { provisionCloudKitchen } = await import('@pickchick/cloud-kitchen');
      await provisionCloudKitchen(f.pool, {
        branchId: f.branch,
        stations: [
          { id: f.prep, kind: 'prep', name: 'Горячий цех' },
          { id: f.assembly, kind: 'assembly', name: 'Сборка' },
        ],
        routing: {
          version: 2,
          assemblyStationId: f.assembly,
          routes: [{ productId: 'burger', stationId: f.prep, kind: 'prep' }],
        },
      });
      for (const { order, quote } of [...broken, fine])
        await f.capture(order.orderId, quote.totalMinor);
      // Window of two: before the fix the same two failing orders were retried forever.
      const first = await f.kitchen.admitPendingPaid(f.branch, 2);
      assert.deepEqual(first.admitted, []);
      assert.deepEqual([...first.reviewed].sort(), broken.map((b) => b.order.orderId).sort());
      const second = await f.kitchen.admitPendingPaid(f.branch, 2);
      assert.deepEqual(second, { admitted: [fine.order.orderId] });
      for (const { order } of broken)
        assert.deepEqual(await issueCodes(f, order.orderId), ['CLOUD_KITCHEN_ADMISSION_FAILED']);
    },
    { hook: false },
  ));

test('refunded and long-ready cloud orders free their display numbers', () =>
  fixture(
    async (f) => {
      await online(f);
      const holds = async () =>
        (
          await f.pool.query(
            'SELECT count(*)::int n FROM channel_number_holds WHERE released_at IS NULL',
          )
        ).rows[0].n;
      const refunded = await paidOrder(f);
      const paid = await f.capture(refunded.order.orderId, refunded.quote.totalMinor);
      assert.equal(paid.state, 'paid_pending_acceptance');
      const ready = await paidOrder(f);
      await f.capture(ready.order.orderId, ready.quote.totalMinor);
      assert.equal(await holds(), 2);
      // A manager refunds the first order (money goes back; the kitchen must stop).
      const view = await f.checkout.repository.readOrder(
        { organizationId: f.org, branchId: f.branch, principalId: randomUUID(), role: 'manager' },
        refunded.order.orderId,
      );
      await f.checkout.repository.requestRefund(
        { organizationId: f.org, branchId: f.branch, principalId: randomUUID(), role: 'manager' },
        randomUUID(),
        {
          orderId: refunded.order.orderId,
          captureId: view.captures[0].id,
          amountMinor: refunded.quote.totalMinor,
          reason: 'Synthetic refund',
          fulfillmentPolicy: 'manager_reviewed',
        },
      );
      // The second order is ready and nobody presses "Выдан".
      const manager = {
        branchId: f.branch,
        deviceId: randomUUID(),
        stationIds: [],
        manager: true,
      };
      let current = await f.kitchen.readOrder(manager, ready.order.orderId);
      for (const task of current.tasks) {
        await f.kitchen.act(manager, 'k-' + randomUUID(), {
          orderId: current.orderId,
          expectedVersion: current.version,
          action: 'start_task',
          taskId: task.id,
          expectedTaskVersion: task.version,
        });
        current = await f.kitchen.readOrder(manager, ready.order.orderId);
        await f.kitchen.act(manager, 'k-' + randomUUID(), {
          orderId: current.orderId,
          expectedVersion: current.version,
          action: 'complete_task',
          taskId: task.id,
          expectedTaskVersion: task.version + 1,
        });
        current = await f.kitchen.readOrder(manager, ready.order.orderId);
      }
      await f.kitchen.act(manager, 'k-' + randomUUID(), {
        orderId: current.orderId,
        expectedVersion: current.version,
        action: 'ready',
      });
      assert.deepEqual(await f.kitchen.sweepStale(f.branch), {
        cancelled: [refunded.order.orderId],
        closed: [],
      });
      assert.equal(await holds(), 1);
      await new Promise((r) => setTimeout(r, 1200));
      assert.deepEqual(await f.kitchen.sweepStale(f.branch), {
        cancelled: [],
        closed: [ready.order.orderId],
      });
      assert.equal(await holds(), 0);
      const states = (
        await f.pool.query('SELECT order_id,state FROM cloud_kitchen_orders ORDER BY state')
      ).rows;
      assert.deepEqual(Object.fromEntries(states.map((r) => [r.order_id, r.state])), {
        [refunded.order.orderId]: 'cancelled',
        [ready.order.orderId]: 'handed_over',
      });
    },
    { kitchenOptions: { staleReadySeconds: 1 } },
  ));
