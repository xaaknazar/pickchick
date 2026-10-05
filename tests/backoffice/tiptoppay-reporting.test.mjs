import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from '../../packages/fulfillment-transport/tests/cloud-fixture.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { Backoffice, grantBackoffice } from '../../packages/backoffice-core/dist/index.js';

test('backoffice separates a TipTop Pay attempt from bank-confirmed money and scopes the order', () =>
  fixture(async (f) => {
    const manager = await provisionCatalogManager(f.pool, {
      organization_id: f.scope.organizationId,
      name: 'Synthetic payment reporting',
      branch_ids: [f.scope.branchId],
    });
    await grantBackoffice(f.pool, manager.actor_id, f.scope.branchId, 'manager');
    const payment = randomUUID();
    await f.pool.query(
      `INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,legal_entity_id,kind,provider,external_reference,enabled) VALUES($1,$2,$3,$4,'payment','tiptoppay','pk_synthetic',true)`,
      [payment, f.scope.organizationId, f.scope.branchId, f.legal],
    );
    const bo = new Backoffice(f.pool, true);
    const v = await f.reserve();
    await f.confirm(v);
    const before = await bo.order(manager.token, f.scope.branchId, v.orderId);
    assert.equal(before.captures.length, 0);
    const attempt = await f.commerce.startPaymentAttempt(f.scope, randomUUID(), {
      orderId: v.orderId,
      providerAccountId: payment,
    });
    const pending = await bo.order(manager.token, f.scope.branchId, v.orderId);
    assert.equal(pending.payment_attempts[0].state, 'pending');
    assert.equal(pending.captures.length, 0);
    await f.commerce.observePayment(
      { organizationId: f.scope.organizationId, branchId: f.scope.branchId, accountId: payment },
      {
        eventId: randomUUID(),
        attemptId: attempt.attemptId,
        outcome: 'captured',
        operationId: 'synthetic-bank-operation',
        amountMinor: attempt.amountMinor,
        occurredAt: new Date().toISOString(),
      },
    );
    const captured = await f.commerce.readOrder(f.scope, v.orderId);
    const report = await bo.order(manager.token, f.scope.branchId, v.orderId);
    assert.equal(report.payment_attempts.length, 1);
    assert.equal(report.payment_attempts[0].provider, 'tiptoppay');
    assert.equal(report.payment_attempts[0].state, 'succeeded');
    assert.equal(report.captures[0].provider, 'tiptoppay');
    assert.equal(report.captures[0].amount_minor, '300000');
    assert.equal(report.captures[0].id, captured.captures[0].id);
    assert.equal(report.captures[0].operation_id, 'synthetic-bank-operation');
    await assert.rejects(
      bo.command(manager.token, f.scope.branchId, {
        request_id: randomUUID(),
        reason: 'Synthetic unsupported refund',
        command: {
          type: 'refund',
          id: v.orderId,
          capture_id: report.captures[0].id,
          amount_minor: '10000',
        },
      }),
      /NOT_READY/,
    );
    assert.equal((await f.pool.query('SELECT count(*) FROM commerce_refunds')).rows[0].count, '0');
    assert.deepEqual(Object.keys(report.payment_attempts[0]).sort(), [
      'created_at',
      'id',
      'intended_minor',
      'provider',
      'state',
    ]);
    assert.deepEqual(Object.keys(report.captures[0]).sort(), [
      'amount_minor',
      'id',
      'occurred_at',
      'operation_id',
      'provider',
    ]);
    await assert.rejects(
      bo.order(manager.token, '00000000-0000-4000-8000-000000000001', v.orderId),
    );
  }));

test('sandbox results stay separate from sales and expose only scoped reporting fields', () =>
  fixture(async (f) => {
    const manager = await provisionCatalogManager(f.pool, {
      organization_id: f.scope.organizationId,
      name: 'Synthetic sandbox reporting',
      branch_ids: [f.scope.branchId],
    });
    await grantBackoffice(f.pool, manager.actor_id, f.scope.branchId, 'manager');
    const bo = new Backoffice(f.pool, true);
    const order = await f.create();
    const before = await bo.read(manager.token, f.scope.branchId);
    const id = randomUUID();
    await f.pool.query(
      `INSERT INTO commerce_tiptoppay_test_payments
       (id,quote_id,customer_id,organization_id,branch_id,public_id,amount_minor,method,snapshot,state,token_hash,expires_at,paid_operation_id)
       VALUES($1,$2,$3,$4,$5,'pk_synthetic',300000,'card',$6,'paid',$7,clock_timestamp()+interval '10 minutes','12345')`,
      [
        id,
        order.quote.quoteId,
        randomUUID(),
        f.scope.organizationId,
        f.scope.branchId,
        { lines: [{ title: 'Synthetic combo', quantity: 1 }] },
        'a'.repeat(64),
      ],
    );
    const after = await bo.read(manager.token, f.scope.branchId);
    assert.deepEqual(after.metrics, before.metrics);
    assert.deepEqual(after.finance, before.finance);
    assert.deepEqual(after.orders, before.orders);
    assert.equal(after.test_payments.length, 1);
    assert.equal(after.test_payments[0].id, id);
    assert.equal(after.test_payments[0].state, 'paid');
    assert.deepEqual(Object.keys(after.test_payments[0]).sort(), [
      'amount_minor',
      'created_at',
      'id',
      'lines',
      'method',
      'paid_operation_id',
      'state',
      'updated_at',
    ]);
    await f.pool.query(
      "UPDATE commerce_tiptoppay_test_payments SET created_at=clock_timestamp()-interval '2 days' WHERE id=$1",
      [id],
    );
    assert.equal((await bo.read(manager.token, f.scope.branchId)).test_payments.length, 0);
    const otherBranch = randomUUID();
    await f.pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,'OTHER','Other synthetic branch')",
      [otherBranch, f.scope.organizationId, f.legal],
    );
    await f.pool.query(
      'UPDATE commerce_tiptoppay_test_payments SET branch_id=$2,created_at=clock_timestamp() WHERE id=$1',
      [id, otherBranch],
    );
    assert.equal((await bo.read(manager.token, f.scope.branchId)).test_payments.length, 0);
    await assert.rejects(bo.read(manager.token, otherBranch));
  }));
