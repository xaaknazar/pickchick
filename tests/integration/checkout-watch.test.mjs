import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  CommerceRepository,
  CustomerCheckout,
  checkoutOrderMark,
  checkoutWatchCloudTables,
  digest,
} from '../../packages/commerce-core/dist/index.js';
import { CustomerCheckoutController } from '../../services/api/dist/customer-checkout-controller.js';
import { publishCatalog } from '../../packages/commerce-core/tests/catalog-fixture.mjs';
import { withSyncDatabases } from '../helpers/sync.mjs';

// Audit 2.8: the order watch long-poll ran the full customer read (about twenty statements
// with a row lock) every 500 ms per open screen. Idle watchers must now cost one cheap
// statement per second, and every real change must still reach the customer.

/** Counts every statement, including those inside transactions. */
function counting(pool) {
  const counter = { statements: 0 };
  const wrap = (target) =>
    new Proxy(target, {
      get(object, key) {
        if (key === 'query')
          return (...args) => {
            counter.statements++;
            return object.query(...args);
          };
        if (key === 'connect') return async (...args) => wrap(await object.connect(...args));
        const value = object[key];
        return typeof value === 'function' ? value.bind(object) : value;
      },
    });
  return { pool: wrap(pool), counter };
}

async function fixture(run) {
  await withSyncDatabases(async ({ cloud, org, branch, device }) => {
    const pool = cloud.pool;
    const customer = randomUUID(),
      payment = randomUUID(),
      fiscal = randomUUID();
    const scope = { organizationId: org, branchId: branch, principalId: customer, role: 'sales' };
    await pool.query("UPDATE devices SET status='active' WHERE id=$1", [device]);
    await pool.query(
      "INSERT INTO cloud_branch_availability(branch_id,device_id,revision,stopped_ids) VALUES($1,$2,1,'{}')",
      [branch, device],
    );
    const legal = (await pool.query('SELECT legal_entity_id FROM branches WHERE id=$1', [branch]))
      .rows[0].legal_entity_id;
    for (const [id, kind, provider] of [
      [payment, 'payment', 'kaspi-remote'],
      [fiscal, 'fiscal', 'synthetic-test'],
    ])
      await pool.query(
        'INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,kind,provider,external_reference,enabled,legal_entity_id) VALUES($1,$2,$3,$4,$5,$6,true,$7)',
        [id, org, branch, kind, provider, id, legal],
      );
    await publishCatalog({ pool, scope });
    await pool.query(
      'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
      [branch, org, device, randomUUID()],
    );
    const options = {
      ...scope,
      paymentAccountId: payment,
      customerIds: [customer],
      maxOrderMinor: '1000000',
      repeatOrdersEnabled: true,
      approvalReference: 'Synthetic watch approval',
    };
    const repo = new CommerceRepository(pool);
    const service = new CustomerCheckout(pool, options);
    const quote = await service.quote(customer, {
      key: randomUUID(),
      branchId: branch,
      serviceMode: 'takeaway',
      items: [{ productId: 'burger', quantity: 1, selections: [] }],
    });
    const order = await service.create(customer, { key: randomUUID(), quoteId: quote.quoteId });
    const stored = await repo.readOrder(scope, order.orderId);
    await repo.confirmAdmission(
      { organizationId: org, branchId: branch, deviceId: device },
      {
        eventId: randomUUID(),
        orderId: order.orderId,
        reservationId: randomUUID(),
        quoteDigest: digest(stored.snapshot),
      },
    );
    const reservation = (
      await pool.query('SELECT admission_reservation_id FROM commerce_orders WHERE id=$1', [
        order.orderId,
      ])
    ).rows[0].admission_reservation_id;
    // The edge projection of an admitted order held for payment (as in the hours test).
    await pool.query(
      `INSERT INTO cloud_fulfillment_projection(order_id,branch_id,organization_id,device_id,reservation_id,quote_id,quote_hash,owner_hash,version,state,routing_version,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7,1,'held',1,'{}')`,
      [order.orderId, branch, org, device, reservation, quote.quoteId, digest(stored.snapshot)],
    );
    await run({ pool, scope, customer, options, service, repo, orderId: order.orderId, payment });
  });
}

function watchResponse() {
  const response = new EventEmitter();
  response.destroyed = false;
  response.setHeader = () => {};
  return response;
}

test('the change mark moves with every input of the customer view and is stable otherwise', () =>
  fixture(async ({ pool, customer, service, repo, scope, orderId, payment }) => {
    const cloud = await checkoutWatchCloudTables(pool);
    const mark = () => checkoutOrderMark(pool, orderId, cloud);
    const first = await mark();
    assert.match(first, /^[a-f0-9]{32}$/);
    assert.equal(await mark(), first);
    assert.equal((await service.read(customer, orderId)).phase, 'ready_to_pay');

    const sending = await service.pay(customer, orderId);
    assert.equal(sending.phase, 'sending');
    const afterAttempt = await mark();
    assert.notEqual(afterAttempt, first);

    const attempt = (await repo.readOrder(scope, orderId)).attempts[0];
    await pool.query("UPDATE commerce_payment_attempts SET state='unknown' WHERE id=$1", [
      attempt.id,
    ]);
    const afterUnknown = await mark();
    assert.notEqual(afterUnknown, afterAttempt);
    await pool.query("UPDATE commerce_payment_attempts SET state='pending' WHERE id=$1", [
      attempt.id,
    ]);

    await repo.observePayment(
      { organizationId: scope.organizationId, branchId: scope.branchId, accountId: payment },
      {
        eventId: randomUUID(),
        attemptId: attempt.id,
        outcome: 'captured',
        operationId: randomUUID(),
        amountMinor: sending.totalMinor,
        occurredAt: new Date().toISOString(),
      },
    );
    const paid = await mark();
    assert.equal((await service.read(customer, orderId)).phase, 'paid');
    assert.notEqual(paid, afterUnknown);
    assert.equal(await mark(), paid);
  }));

test('an idle watch costs a fraction of the old polling and still returns a change promptly', (t) =>
  fixture(async ({ pool, customer, options, orderId }) => {
    const { pool: measured, counter } = counting(pool);
    const controller = new CustomerCheckoutController(
      { me: async () => ({ customer: { id: customer } }) },
      { pool: measured },
      { revision: 0 },
    );
    controller.checkout = new CustomerCheckout(measured, options);
    const before = await controller.checkout.read(customer, orderId);
    const token = 'Bearer ' + 'a'.repeat(64);
    const response = watchResponse();
    counter.statements = 0;
    const started = Date.now();
    const pending = controller.watch(orderId, before.revision, response, token, 'application/json');
    try {
      await new Promise((resolve) => setTimeout(resolve, 3200));
      const idle = counter.statements;
      t.diagnostic(`idle watch statements in 3.2 s: ${idle}`);
      // Old loop: one full read (~20 statements) every 500 ms = well over 100 in 3.2 s.
      assert.ok(idle < 45, `idle watch ran ${idle} statements in 3.2 s`);
      const changedAt = Date.now();
      await new CustomerCheckout(pool, options).pay(customer, orderId);
      const result = await pending;
      assert.equal(result.phase, 'sending');
      assert.notEqual(result.revision, before.revision);
      assert.ok(Date.now() - changedAt < 2500, 'change reached the watcher within one interval');
      assert.ok(Date.now() - started < 20_000);
    } finally {
      response.emit('close');
      await pending.catch(() => {});
    }
  }));

test('a closed client ends the watch without further reads', () =>
  fixture(async ({ pool, customer, options, orderId }) => {
    const { pool: measured, counter } = counting(pool);
    const controller = new CustomerCheckoutController(
      { me: async () => ({ customer: { id: customer } }) },
      { pool: measured },
      { revision: 0 },
    );
    controller.checkout = new CustomerCheckout(measured, options);
    const before = await controller.checkout.read(customer, orderId);
    const response = watchResponse();
    const pending = controller.watch(
      orderId,
      before.revision,
      response,
      'Bearer ' + 'a'.repeat(64),
      'application/json',
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    response.emit('close');
    const result = await pending;
    assert.equal(result.revision, before.revision);
    const settled = counter.statements;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(counter.statements, settled);
  }));
