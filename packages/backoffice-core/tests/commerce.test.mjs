import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from '../../fulfillment-transport/tests/cloud-fixture.mjs';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import { Backoffice, grantBackoffice } from '../dist/index.js';
async function boFixture(run, options = {}) {
  return fixture(async (f) => {
    const manager = await provisionCatalogManager(f.pool, {
      organization_id: f.scope.organizationId,
      name: 'Synthetic BO manager',
      branch_ids: [f.scope.branchId],
    });
    await grantBackoffice(f.pool, manager.actor_id, f.scope.branchId, 'manager');
    const bo = new Backoffice(f.pool, true, options),
      command = (command) => ({
        request_id: randomUUID(),
        reason: 'Synthetic cross-domain acceptance',
        command,
      });
    await run({ ...f, bo, boManager: manager, command, branch: f.scope.branchId });
  });
}
test('manager refund uses commerce reservation/outbox atomically and never marks money returned early', () =>
  boFixture(
    async (f) => {
      const v = await f.reserve();
      await f.confirm(v);
      const captured = await f.capture(v);
      const req = f.command({
        type: 'refund',
        id: v.orderId,
        capture_id: captured.captures[0].id,
        amount_minor: '10000',
      });
      const result = await f.bo.command(f.boManager.token, f.branch, req);
      assert.equal(result.state, 'pending');
      assert.deepEqual(await f.bo.command(f.boManager.token, f.branch, req), result);
      let d = await f.bo.read(f.boManager.token, f.branch);
      assert.equal(d.metrics.captured_minor, '300000');
      assert.equal(d.metrics.refunded_minor, '0');
      assert.equal(d.refunds.length, 1);
      await f.commerce.observeRefund(
        { organizationId: f.scope.organizationId, branchId: f.branch, accountId: f.payment },
        {
          eventId: randomUUID(),
          refundId: result.refundId,
          outcome: 'succeeded',
          operationId: randomUUID(),
          amountMinor: '10000',
          occurredAt: new Date().toISOString(),
        },
      );
      d = await f.bo.read(f.boManager.token, f.branch);
      assert.equal(d.metrics.refunded_minor, '10000');
      await assert.rejects(
        f.bo.command(
          f.boManager.token,
          f.branch,
          f.command({
            type: 'refund',
            id: v.orderId,
            capture_id: captured.captures[0].id,
            amount_minor: '300001',
          }),
        ),
        /CONFLICT/,
      );
      assert.equal((await f.pool.query('SELECT count(*) FROM bo_audit')).rows[0].count, '1');
    },
    { refundAdapterEnabled: true },
  ));
test('an audit insertion failure rolls back the commerce command, refund reservation and outbox', () =>
  boFixture(
    async (f) => {
      const v = await f.reserve();
      await f.confirm(v);
      const captured = await f.capture(v);
      await f.pool.query(
        "CREATE FUNCTION reject_bo_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$; CREATE TRIGGER reject_bo_test BEFORE INSERT ON bo_audit FOR EACH ROW EXECUTE FUNCTION reject_bo_test()",
      );
      await assert.rejects(
        f.bo.command(
          f.boManager.token,
          f.branch,
          f.command({
            type: 'refund',
            id: v.orderId,
            capture_id: captured.captures[0].id,
            amount_minor: '10000',
          }),
        ),
        /synthetic audit failure/,
      );
      assert.equal(
        (await f.pool.query('SELECT count(*) FROM commerce_refunds')).rows[0].count,
        '0',
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*) FROM commerce_outbox WHERE event_type='refund.submit_requested'",
          )
        ).rows[0].count,
        '0',
      );
    },
    { refundAdapterEnabled: true },
  ));
test('unpaid cancellation delegates to the versioned cloud-edge protocol; stale versions cannot cancel', () =>
  boFixture(async (f) => {
    const v = await f.reserve();
    await f.confirm(v);
    const detail = await f.bo.order(f.boManager.token, f.branch, v.orderId);
    await assert.rejects(
      f.bo.command(
        f.boManager.token,
        f.branch,
        f.command({ type: 'cancel_order', id: v.orderId, expected_version: 999 }),
      ),
      /CONFLICT/,
    );
    const result = await f.bo.command(
      f.boManager.token,
      f.branch,
      f.command({
        type: 'cancel_order',
        id: v.orderId,
        expected_version: Number(detail.order.version),
      }),
    );
    assert.equal(result.state, 'release_pending');
    assert.equal(
      (await f.pool.query('SELECT count(*) FROM commerce_cancellation_intents')).rows[0].count,
      '1',
    );
    await assert.rejects(
      f.commerce.startPaymentAttempt(f.scope, randomUUID(), {
        orderId: v.orderId,
        providerAccountId: f.payment,
      }),
      /NOT_READY/,
    );
  }));
test('consumption waits for actual kitchen facts and uses the recipe pinned when the order was created', () =>
  boFixture(async (f) => {
    const { receiveFulfillment } = await import('../../fulfillment-transport/dist/cloud.js');
    const ingredient = randomUUID(),
      recipe = randomUUID();
    await f.bo.command(
      f.boManager.token,
      f.branch,
      f.command({
        type: 'save',
        kind: 'ingredient',
        id: ingredient,
        expected_revision: 0,
        payload: { name: 'Synthetic raw chicken', unit: 'g', minimum: '0', active: true },
      }),
    );
    await f.bo.command(
      f.boManager.token,
      f.branch,
      f.command({
        type: 'stock',
        kind: 'receipt',
        reference: 'SYN-RAW',
        lines: [
          {
            ingredient_id: ingredient,
            quantity: '1000',
            value_minor: '30000',
            expected_revision: 0,
          },
        ],
      }),
    );
    // The legacy commerce fixture has a synthetic burger outside the neutral 24-SKU seed.
    const payload = {
      name: 'Synthetic burger norm',
      product_id: 'burger',
      output_ingredient_id: null,
      yield_quantity: '1',
      lines: [{ ingredient_id: ingredient, quantity: '100' }],
    };
    await f.pool.query(
      "INSERT INTO bo_records(id,branch_id,organization_id,kind,revision,payload) VALUES($1,$2,$3,'recipe',1,$4)",
      [recipe, f.branch, f.scope.organizationId, payload],
    );
    const v = await f.accepted();
    const req = f.command({
      type: 'consume',
      order_id: v.orderId,
      expected_balances: { [ingredient]: 1 },
    });
    await assert.rejects(f.bo.command(f.boManager.token, f.branch, req), /NOT_READY/);
    const pin = (
      await f.pool.query('SELECT snapshot FROM bo_order_recipes WHERE order_id=$1', [v.orderId])
    ).rows[0].snapshot;
    assert.equal(pin[0].revision, 1);
    await f.pool.query('UPDATE bo_records SET revision=2,payload=$2 WHERE id=$1', [
      recipe,
      { ...payload, lines: [{ ingredient_id: ingredient, quantity: '400' }] },
    ]);
    await f.edge.complete(v.accepted);
    for (const event of await f.events(v.orderId)) await receiveFulfillment(f.pool, f.auth, event);
    await f.bo.command(f.boManager.token, f.branch, req);
    await f.bo.command(f.boManager.token, f.branch, req);
    const stock = (await f.bo.read(f.boManager.token, f.branch)).stock[0];
    assert.equal(stock.quantity, '800');
    assert.equal(stock.value_minor, '24000');
    await assert.rejects(
      f.bo.command(
        f.boManager.token,
        f.branch,
        f.command({ ...req.command, expected_balances: { [ingredient]: 2 } }),
      ),
      /CONFLICT/,
    );
    assert.equal(
      (await f.pool.query("SELECT count(*) FROM bo_stock_documents WHERE kind='consumption'"))
        .rows[0].count,
      '1',
    );
    await assert.rejects(f.pool.query('DELETE FROM bo_order_recipes'), /immutable/);
  }));

test('director calendar bounds financial events, rejects unknown shift and reports trusted stop freshness', () =>
  boFixture(async (f) => {
    const v = await f.reserve();
    await f.confirm(v);
    await f.capture(v);
    const current = await f.bo.read(f.boManager.token, f.branch, { period: 'today' });
    assert.equal(current.metrics.orders, 1);
    assert.equal(current.orders.length, 1);
    assert.equal(current.metrics.captured_minor, '300000');
    assert.equal(current.timezone, 'Asia/Almaty');
    assert.equal(current.availability.fresh, false);
    const yesterday = await f.bo.read(f.boManager.token, f.branch, { period: 'yesterday' });
    assert.equal(yesterday.metrics.orders, 0);
    assert.equal(yesterday.metrics.captured_minor, '0');
    assert.equal(yesterday.orders.length, 0);
    assert.equal(yesterday.finance.length, 0);
    const past = await f.bo.read(f.boManager.token, f.branch, {
      period: 'custom',
      start_date: '2024-02-29',
      end_date: '2024-02-29',
    });
    assert.equal(past.orders.length, 0);
    assert.equal(past.metrics.orders, 0);
    assert.equal(past.metrics.captured_minor, '0');
    assert.equal(past.finance.length, 0);
    assert.equal(past.refunds.length, 0);
    assert.equal(past.chart.length, 0);
    assert.deepEqual(past.truncated, {
      orders: false,
      pos: false,
      finance: false,
      refunds: false,
      issues: false,
      cashier_orders: false,
      cashier_shifts: false,
    });
    await assert.rejects(
      f.bo.read(f.boManager.token, f.branch, { shift_id: randomUUID() }),
      /NOT_FOUND/,
    );
    await assert.rejects(
      f.bo.read(f.boManager.token, randomUUID(), { shift_id: randomUUID() }),
      /FORBIDDEN/,
    );
    const category = randomUUID(),
      product = randomUUID(),
      variant = randomUUID(),
      unknown = randomUUID();
    await f.pool.query(
      "INSERT INTO categories(id,organization_id,name_ru,name_kk) VALUES($1,$2,'Synthetic','Synthetic')",
      [category, f.scope.organizationId],
    );
    await f.pool.query(
      "INSERT INTO products(id,organization_id,category_id,name_ru,name_kk) VALUES($1,$2,$3,'Synthetic item','Synthetic item')",
      [product, f.scope.organizationId, category],
    );
    await f.pool.query(
      "INSERT INTO product_variants(id,organization_id,product_id,sku) VALUES($1,$2,$3,'Synthetic sku')",
      [variant, f.scope.organizationId, product],
    );
    await f.pool.query(
      'INSERT INTO cloud_branch_availability(branch_id,device_id,revision,stopped_ids) VALUES($1,$2,1,$3::uuid[])',
      [f.branch, f.auth.deviceId, [variant, unknown]],
    );
    const stops = (await f.bo.read(f.boManager.token, f.branch)).availability;
    assert.deepEqual(stops.stopped_items, [
      { id: variant, name: 'Synthetic item', kind: 'variant' },
    ]);
    assert.deepEqual(stops.stopped_ids, [variant, unknown]);
    // v2 stop list: without a publication every stop is unknown and keeps the legacy names.
    const v2 = await f.bo.stops(f.boManager.token, f.branch);
    assert.equal(v2.schema_version, 2);
    assert.equal(v2.catalog, null);
    assert.deepEqual(v2.items, []);
    assert.deepEqual(
      v2.unknown_stops.map((s) => [s.variant_id, s.name_ru, s.kind]).sort(),
      [
        [variant, 'Synthetic item', 'variant'],
        [unknown, null, null],
      ].sort(),
    );
    assert.equal(v2.availability.fresh, true);
    assert.equal(v2.availability.states_reported, false);
    assert.deepEqual(v2.remote_stops, { enabled: false, edge_ready: false, writable: false });
    assert.equal((await f.bo.read(f.boManager.token, f.branch)).availability.fresh, true);
    await f.pool.query(
      "UPDATE cloud_branch_availability SET observed_at=clock_timestamp()-interval '31 seconds'",
    );
    assert.equal((await f.bo.read(f.boManager.token, f.branch)).availability.fresh, false);
    await f.pool.query("UPDATE devices SET status='revoked' WHERE id=$1", [f.auth.deviceId]);
    assert.equal((await f.bo.read(f.boManager.token, f.branch)).availability.observed_at, null);
    assert.equal((await f.bo.stops(f.boManager.token, f.branch)).availability.observed_at, null);
  }));
test('a payment that arrives after the restaurant cancelled the held order is shown for refund', () =>
  boFixture(async (f) => {
    const v = await f.reserve();
    await f.confirm(v);
    const attempt = await f.commerce.startPaymentAttempt(f.scope, randomUUID(), {
      orderId: v.orderId,
      providerAccountId: f.payment,
    });
    await f.pool.query(
      "UPDATE cloud_fulfillment_projection SET state='cancelled' WHERE order_id=$1",
      [v.orderId],
    );
    await f.commerce.observePayment(
      { organizationId: f.scope.organizationId, branchId: f.branch, accountId: f.payment },
      {
        eventId: randomUUID(),
        attemptId: attempt.attemptId,
        outcome: 'captured',
        operationId: randomUUID(),
        amountMinor: attempt.amountMinor,
        occurredAt: new Date().toISOString(),
      },
    );
    const detail = await f.bo.order(f.boManager.token, f.branch, v.orderId);
    assert.equal(detail.order.state, 'attention_required');
    assert.deepEqual(
      detail.issues.map((i) => i.code),
      ['PAID_AFTER_RESTAURANT_CANCEL'],
    );
  }));

test('without a refund adapter the old request-refund command is refused and nothing is queued', () =>
  boFixture(async (f) => {
    const v = await f.reserve();
    await f.confirm(v);
    const captured = await f.capture(v);
    await assert.rejects(
      f.bo.command(
        f.boManager.token,
        f.branch,
        f.command({
          type: 'refund',
          id: v.orderId,
          capture_id: captured.captures[0].id,
          amount_minor: '10000',
        }),
      ),
      (e) => e.code === 'NOT_READY' && e.reason === 'REFUND_ADAPTER_NOT_CONFIGURED',
    );
    assert.equal((await f.pool.query('SELECT count(*) FROM commerce_refunds')).rows[0].count, '0');
    const detail = await f.bo.order(f.boManager.token, f.branch, v.orderId);
    assert.deepEqual(detail.refund_capabilities, { adapter: false, manual: false });
    // Manual registration stays off until the owner enables it with its grants.
    await assert.rejects(
      f.bo.command(
        f.boManager.token,
        f.branch,
        f.command({
          type: 'manual_refund',
          id: v.orderId,
          capture_id: captured.captures[0].id,
          amount_minor: '10000',
          bank_reference: 'KP-000001',
        }),
      ),
      (e) => e.code === 'NOT_READY' && e.reason === 'MANUAL_REFUNDS_DISABLED',
    );
  }));

test('a manual Kaspi Pay refund is recorded once, counts as refunded and leaves an audit entry', () =>
  boFixture(
    async (f) => {
      const v = await f.reserve();
      await f.confirm(v);
      const captured = await f.capture(v);
      const capture = captured.captures[0].id;
      const req = f.command({
        type: 'manual_refund',
        id: v.orderId,
        capture_id: capture,
        amount_minor: '10000',
        bank_reference: 'KP 123456',
      });
      const result = await f.bo.command(f.boManager.token, f.branch, req);
      assert.equal(result.state, 'succeeded');
      assert.equal(result.bankReference, 'KP 123456');
      assert.deepEqual(await f.bo.command(f.boManager.token, f.branch, req), result);
      const d = await f.bo.read(f.boManager.token, f.branch);
      assert.equal(d.metrics.refunded_minor, '10000');
      const detail = await f.bo.order(f.boManager.token, f.branch, v.orderId);
      assert.deepEqual(detail.refund_capabilities, { adapter: false, manual: true });
      assert.equal(detail.refunds[0].state, 'succeeded');
      assert.equal(detail.refunds[0].bank_reference, 'manual:KP 123456');
      const audit = (await f.pool.query('SELECT action,reason FROM bo_audit')).rows;
      assert.deepEqual(audit, [
        { action: 'manual_refund', reason: 'Synthetic cross-domain acceptance' },
      ]);
      // No bank request is queued: the refund already happened in Kaspi Pay.
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*) FROM commerce_outbox WHERE event_type='refund.submit_requested'",
          )
        ).rows[0].count,
        '0',
      );
      // The same Kaspi operation cannot be recorded twice, nor more than was paid.
      await assert.rejects(
        f.bo.command(
          f.boManager.token,
          f.branch,
          f.command({ ...req.command, amount_minor: '100' }),
        ),
        (e) => e.code === 'CONFLICT' && e.reason === 'REFUND_REFERENCE_ALREADY_USED',
      );
      await assert.rejects(
        f.bo.command(
          f.boManager.token,
          f.branch,
          f.command({ ...req.command, bank_reference: 'KP-2', amount_minor: '290001' }),
        ),
        (e) => e.code === 'CONFLICT' && e.reason === 'REFUND_EXCEEDS_PAYMENT',
      );
      await assert.rejects(
        f.bo.command(
          f.boManager.token,
          f.branch,
          f.command({ ...req.command, bank_reference: 'x' }),
        ),
        /INVALID_REQUEST/,
      );
      assert.equal(
        (
          await f.bo.command(
            f.boManager.token,
            f.branch,
            f.command({ ...req.command, bank_reference: 'KP-2', amount_minor: '290000' }),
          )
        ).state,
        'succeeded',
      );
      const order = await f.commerce.readOrder(f.manager, v.orderId);
      assert.equal(order.money.refunded, '300000');
      assert.equal(order.kitchenEffectId, null);
    },
    { manualRefundsEnabled: true },
  ));

test('an old pending refund request can be withdrawn or settled as a manual refund', () =>
  boFixture(
    async (f) => {
      const v = await f.reserve();
      await f.confirm(v);
      const captured = await f.capture(v);
      const capture = captured.captures[0].id;
      const legacy = (amount) =>
        f.commerce.requestRefund(f.manager, randomUUID(), {
          orderId: v.orderId,
          captureId: capture,
          amountMinor: amount,
          reason: 'Synthetic old button request',
          fulfillmentPolicy: 'manager_reviewed',
        });
      const withdrawn = await legacy('10000');
      const result = await f.bo.command(
        f.boManager.token,
        f.branch,
        f.command({ type: 'withdraw_refund', id: v.orderId, refund_id: withdrawn.refundId }),
      );
      assert.equal(result.state, 'failed');
      const settled = await legacy('20000');
      await assert.rejects(
        f.bo.command(
          f.boManager.token,
          f.branch,
          f.command({
            type: 'manual_refund',
            id: v.orderId,
            capture_id: capture,
            amount_minor: '19999',
            bank_reference: 'KP-777',
            refund_id: settled.refundId,
          }),
        ),
        /INVALID_REQUEST/,
      );
      const manual = await f.bo.command(
        f.boManager.token,
        f.branch,
        f.command({
          type: 'manual_refund',
          id: v.orderId,
          capture_id: capture,
          amount_minor: '20000',
          bank_reference: 'KP-777',
          refund_id: settled.refundId,
        }),
      );
      assert.equal(manual.refundId, settled.refundId);
      const detail = await f.bo.order(f.boManager.token, f.branch, v.orderId);
      assert.deepEqual(
        detail.refunds.map((r) => r.state),
        ['failed', 'succeeded'],
      );
      // A settled refund cannot be withdrawn afterwards.
      await assert.rejects(
        f.bo.command(
          f.boManager.token,
          f.branch,
          f.command({ type: 'withdraw_refund', id: v.orderId, refund_id: settled.refundId }),
        ),
        /CONFLICT/,
      );
      assert.equal((await f.commerce.readOrder(f.manager, v.orderId)).money.refunded, '20000');
      assert.equal((await f.commerce.readOrder(f.manager, v.orderId)).money.reserved, '0');
    },
    { manualRefundsEnabled: true },
  ));
