import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from '../../fulfillment-transport/tests/cloud-fixture.mjs';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import { Backoffice, grantBackoffice } from '../dist/index.js';
async function boFixture(run) {
  return fixture(async (f) => {
    const manager = await provisionCatalogManager(f.pool, {
      organization_id: f.scope.organizationId,
      name: 'Synthetic BO manager',
      branch_ids: [f.scope.branchId],
    });
    await grantBackoffice(f.pool, manager.actor_id, f.scope.branchId, 'manager');
    const bo = new Backoffice(f.pool, true),
      command = (command) => ({
        request_id: randomUUID(),
        reason: 'Synthetic cross-domain acceptance',
        command,
      });
    await run({ ...f, bo, boManager: manager, command, branch: f.scope.branchId });
  });
}
test('manager refund uses commerce reservation/outbox atomically and never marks money returned early', () =>
  boFixture(async (f) => {
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
  }));
test('an audit insertion failure rolls back the commerce command, refund reservation and outbox', () =>
  boFixture(async (f) => {
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
    assert.equal((await f.pool.query('SELECT count(*) FROM commerce_refunds')).rows[0].count, '0');
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*) FROM commerce_outbox WHERE event_type='refund.submit_requested'",
        )
      ).rows[0].count,
      '0',
    );
  }));
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
      test_payments: false,
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
    assert.equal((await f.bo.read(f.boManager.token, f.branch)).availability.fresh, true);
    await f.pool.query(
      "UPDATE cloud_branch_availability SET observed_at=clock_timestamp()-interval '31 seconds'",
    );
    assert.equal((await f.bo.read(f.boManager.token, f.branch)).availability.fresh, false);
    await f.pool.query("UPDATE devices SET status='revoked' WHERE id=$1", [f.auth.deviceId]);
    assert.equal((await f.bo.read(f.boManager.token, f.branch)).availability.observed_at, null);
  }));
