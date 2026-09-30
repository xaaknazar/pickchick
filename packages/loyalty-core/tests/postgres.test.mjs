import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { LoyaltyRepository } from '../dist/index.js';
const connection =
  process.env.LOYALTY_TEST_DATABASE_URL ??
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55432/pickchick_cloud';
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection).hostname),
  'Disposable local PostgreSQL only',
);
const migrationDir = fileURLToPath(new URL('../../../db/cloud/migrations/', import.meta.url));
const rules = {
  earnBasisPoints: 10000,
  pointValueMinor: '1',
  maxRedemptionBasisPoints: 10000,
  lotTtlDays: 1,
  refundSpentExpiry: 'new_lot_ttl',
  expiredEarnRefund: 'ignore_expired',
};
const key = () => randomUUID();
async function fixture(run) {
  const schema = 'loyalty_' + key().replaceAll('-', ''),
    admin = createPool(connection, 12);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(connection);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = createPool(url.toString(), 12);
  try {
    await migrate(pool, migrationDir, 'cloud');
    const org = key(),
      legal = key(),
      branch = key(),
      customer = key(),
      actor = key();
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Synthetic loyalty')", [org]);
    await pool.query(
      "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES($1,$2,'Synthetic','000000000000')",
      [legal, org],
    );
    await pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,'L1','Synthetic')",
      [branch, org, legal],
    );
    const addCustomer = async () => {
      const id = key();
      await pool.query(
        "INSERT INTO identity_customers(id,phone_lookup,phone_cipher,profile_cipher,created_at) VALUES($1,$2,'synthetic','synthetic',clock_timestamp())",
        [id, createHash('sha256').update(id).digest('hex')],
      );
      return id;
    };
    await pool.query(
      "INSERT INTO identity_customers(id,phone_lookup,phone_cipher,profile_cipher,created_at) VALUES($1,$2,'synthetic','synthetic',clock_timestamp())",
      [customer, createHash('sha256').update(customer).digest('hex')],
    );
    let now = new Date('2030-01-01T12:00:00Z');
    const repo = new LoyaltyRepository(pool, { clock: () => new Date(now) });
    const ctx = (authority) => ({
      organizationId: org,
      branchId: branch,
      actorId: actor,
      authority,
    });
    const create = await repo.createApprovedProgram(ctx('manager'), key(), {
      version: 1,
      rules,
      approvalReference: 'synthetic approval only',
      reason: 'Test economics, not production',
    });
    const program = create.programId;
    const activate = () =>
      repo.activateProgram(ctx('manager'), key(), {
        programId: program,
        reason: 'Synthetic acceptance',
      });
    const earn = (amount = '100', order = key(), extra = {}) =>
      repo.earnFulfilledOrder(ctx('fulfillment'), key(), {
        customerId: customer,
        programId: program,
        orderId: order,
        originalEligibleMinor: amount,
        fulfillmentEventId: key(),
        ...extra,
      });
    const reserve = (points = '80', order = key(), extra = {}) =>
      repo.reserveRedemption(ctx('checkout'), key(), {
        customerId: customer,
        programId: program,
        orderId: order,
        points,
        eligibleOrderMinor: '10000',
        ...extra,
      });
    const release = (hold, extra = {}) =>
      repo.releaseRedemption(ctx('checkout'), key(), {
        customerId: customer,
        holdId: hold,
        resolutionReference: key(),
        reason: 'Trusted final decline',
        ...extra,
      });
    const capture = (hold, extra = {}) =>
      repo.captureRedemption(ctx('checkout'), key(), {
        customerId: customer,
        holdId: hold,
        sourceCaptureId: key(),
        ...extra,
      });
    const refund = (order, amount = '100', original = '100', source = key()) =>
      repo.refundEarned(ctx('refund'), key(), {
        customerId: customer,
        programId: program,
        orderId: order,
        originalEligibleMinor: original,
        sourceRefundId: source,
        eligibleRefundMinor: amount,
      });
    const restore = (hold, points = '80', source = key()) =>
      repo.refundRedemption(ctx('refund'), key(), {
        customerId: customer,
        holdId: hold,
        sourceRefundId: source,
        points,
      });
    const wallet = () => repo.readWallet({ organizationId: org, customerId: customer });
    const amount = async (balance, reserved = '0', debt = '0') => {
      const w = await wallet();
      assert.equal(w.balancePoints, balance);
      assert.equal(w.reservedPoints, reserved);
      assert.equal(w.debtPoints, debt);
      assert.equal(
        w.availablePoints,
        (BigInt(balance) > BigInt(reserved) ? BigInt(balance) - BigInt(reserved) : 0n).toString(),
      );
      return w;
    };
    await run({
      repo,
      pool,
      admin,
      schema,
      url,
      org,
      legal,
      branch,
      customer,
      program,
      ctx,
      activate,
      earn,
      reserve,
      release,
      capture,
      refund,
      restore,
      wallet,
      amount,
      addCustomer,
      advance: (days) => {
        now = new Date(now.getTime() + days * 86400000);
      },
    });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

test('approved programs are inactive by default; customer scope and integer boundaries', async () =>
  fixture(async (f) => {
    await assert.rejects(f.earn(), { code: 'PROGRAM_INACTIVE' });
    assert.equal(await f.wallet(), null);
    await f.activate();
    await assert.rejects(
      f.repo.adjust(f.ctx('checkout'), key(), {
        customerId: f.customer,
        programId: f.program,
        deltaPoints: '100',
        reason: 'Disallowed caller',
      }),
      { code: 'FORBIDDEN' },
    );
    await f.earn();
    await f.amount('100');
    await assert.rejects(
      f.repo.readWallet({ organizationId: f.org, customerId: f.customer, phone: 'arbitrary' }),
      { code: 'INVALID' },
    );
    await assert.rejects(f.reserve('1.5'), { code: 'INVALID' });
    const other = await f.addCustomer();
    assert.equal(await f.repo.readWallet({ organizationId: f.org, customerId: other }), null);
  }));

test('parallel command replay and different source event cannot double earn; changed digest conflicts', async () =>
  fixture(async (f) => {
    await f.activate();
    const order = key(),
      command = key(),
      input = {
        customerId: f.customer,
        programId: f.program,
        orderId: order,
        originalEligibleMinor: '100',
        fulfillmentEventId: key(),
      };
    const values = await Promise.all(
      Array.from({ length: 8 }, () =>
        f.repo.earnFulfilledOrder(f.ctx('fulfillment'), command, input),
      ),
    );
    for (const v of values) assert.deepEqual(v, values[0]);
    await f.earn('100', order);
    await f.amount('100');
    await assert.rejects(
      f.repo.earnFulfilledOrder(f.ctx('fulfillment'), command, {
        ...input,
        originalEligibleMinor: '101',
      }),
      { code: 'CONFLICT' },
    );
    assert.equal(
      (await f.pool.query("SELECT count(*)::int AS n FROM loyalty_ledger WHERE kind='earn'"))
        .rows[0].n,
      1,
    );
  }));

test('two concurrent 800-point holds against 1000: exactly one succeeds; FIFO across approved lots', async () =>
  fixture(async (f) => {
    await f.activate();
    await f.earn('400');
    await f.earn('600');
    const results = await Promise.allSettled([f.reserve('800'), f.reserve('800')]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'INSUFFICIENT_POINTS');
    await f.amount('1000', '800');
    const rows = (
      await f.pool.query(
        'SELECT a.points FROM loyalty_allocations a JOIN loyalty_lots l ON l.id=a.lot_id ORDER BY l.sequence',
      )
    ).rows;
    assert.deepEqual(
      rows.map((r) => r.points),
      ['400', '400'],
    );
  }));

test('refund before earn and duplicate refund never resurrect returned rewards; cumulative rounding', async () =>
  fixture(async (f) => {
    await f.activate();
    const order = key(),
      source = key();
    await f.refund(order, '60', '100', source);
    await f.refund(order, '60', '100', source);
    await f.amount('0');
    await f.earn('100', order);
    await f.amount('40');
    await f.refund(order, '40');
    await f.amount('0');
    await f.earn('100', order);
    await f.amount('0');
    await assert.rejects(f.refund(order, '1'), { code: 'REFUND_LIMIT' });
    const order2 = key();
    await f.refund(order2);
    await f.earn('100', order2);
    await f.amount('0');
  }));

test('parallel partial refunds lock total and same source identity conflicts', async () =>
  fixture(async (f) => {
    await f.activate();
    const order = key();
    await f.earn('100', order);
    const results = await Promise.allSettled([f.refund(order, '60'), f.refund(order, '60')]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'REFUND_LIMIT');
    await f.amount('40');
    const source = key();
    await f.refund(order, '20', '100', source);
    await assert.rejects(f.refund(order, '10', '100', source), { code: 'CONFLICT' });
    await f.amount('20');
  }));

test('refund after spending creates debt; later credits settle it without double debit on expiry', async () =>
  fixture(async (f) => {
    await f.activate();
    const order = key();
    await f.earn('100', order);
    const h = await f.reserve('100');
    await f.capture(h.holdId);
    await f.refund(order);
    await f.amount('-100', '0', '100');
    await f.earn('60');
    await f.amount('-40', '0', '40');
    f.advance(2);
    await f.amount('-40', '0', '40');
    await f.earn('60');
    await f.amount('20');
    f.advance(2);
    await f.amount('0');
  }));

test('clawback while held then release removes revoked portion once, without debt', async () =>
  fixture(async (f) => {
    await f.activate();
    const order = key();
    await f.earn('100', order);
    const h = await f.reserve('80');
    await f.refund(order);
    await f.amount('0', '80');
    f.advance(2);
    await f.release(h.holdId);
    await f.amount('0');
  }));

test('clawback held then capture creates debt, including when other credits make balance positive', async () =>
  fixture(async (f) => {
    await f.activate();
    const order = key();
    await f.earn('100', order);
    const h = await f.reserve('80');
    await f.refund(order);
    await f.earn('100');
    await f.amount('100', '80');
    await f.capture(h.holdId);
    await f.amount('20');
    f.advance(2);
    await f.amount('0');
  }));

test('expired reserved points survive expiry; release expires valid remainder once', async () =>
  fixture(async (f) => {
    await f.activate();
    const order = key();
    await f.earn('100', order);
    const h = await f.reserve('80');
    f.advance(2);
    await f.amount('80', '80');
    await f.refund(order, '50');
    await f.amount('50', '80');
    await f.release(h.holdId);
    await f.amount('0');
    // 20 points had expired, only remaining 30 were clawed back; released 50 expire.
    const deltas = (
      await f.pool.query('SELECT kind,delta_points FROM loyalty_ledger ORDER BY created_at,id')
    ).rows;
    assert.equal(
      deltas.filter((r) => r.kind === 'clawback').reduce((s, r) => s + BigInt(r.delta_points), 0n),
      -30n,
    );
  }));

test('expiry and reserve race at boundary cannot allocate expired free points', async () =>
  fixture(async (f) => {
    await f.activate();
    await f.earn('100');
    f.advance(1);
    const results = await Promise.allSettled([
      f.reserve('80'),
      f.repo.expire(f.ctx('scheduler'), key(), f.customer),
    ]);
    assert.equal(results[0].status, 'rejected');
    assert.equal(results[0].reason.code, 'INSUFFICIENT_POINTS');
    assert.equal(results[1].status, 'fulfilled');
    await f.amount('0');
  }));

test('expired full earned refund adds no debt; spent portion alone becomes debt', async () =>
  fixture(async (f) => {
    await f.activate();
    const order = key();
    await f.earn('100', order);
    const h = await f.reserve('30');
    await f.capture(h.holdId);
    f.advance(2);
    await f.amount('0');
    await f.refund(order);
    await f.amount('-30', '0', '30');
    await f.restore(h.holdId, '30');
    await f.amount('0');
    f.advance(2);
    await f.amount('0');
  }));

test('pending redemption refund before capture does not mint and blocks release; applies once', async () =>
  fixture(async (f) => {
    await f.activate();
    await f.earn();
    const h = await f.reserve('80'),
      source = key();
    const pending = await f.restore(h.holdId, '50', source);
    assert.equal(pending.pending, true);
    await f.amount('100', '80');
    await assert.rejects(f.release(h.holdId), { code: 'NOT_READY' });
    await f.capture(h.holdId);
    await f.amount('70');
    await f.restore(h.holdId, '50', source);
    await f.amount('70');
    await f.restore(h.holdId, '30');
    await f.amount('100');
    await assert.rejects(f.restore(h.holdId, '1'), { code: 'REFUND_LIMIT' });
  }));

test('capture, release and refund are idempotent; released hold cannot be captured or restored', async () =>
  fixture(async (f) => {
    await f.activate();
    await f.earn();
    const h = await f.reserve(),
      reference = key();
    await f.release(h.holdId, { resolutionReference: reference });
    await f.release(h.holdId, { resolutionReference: reference });
    await f.amount('100');
    await assert.rejects(f.capture(h.holdId), { code: 'CONFLICT' });
    await assert.rejects(f.restore(h.holdId), { code: 'CONFLICT' });
    const h2 = await f.reserve(),
      capture = key();
    await Promise.all([
      f.capture(h2.holdId, { sourceCaptureId: capture }),
      f.capture(h2.holdId, { sourceCaptureId: capture }),
    ]);
    await f.amount('20');
    await assert.rejects(f.capture(h2.holdId), { code: 'CONFLICT' });
  }));

test('manager negative adjustment preserves debt through held expiry/release; positive adjustment audited', async () =>
  fixture(async (f) => {
    await f.activate();
    await f.earn();
    const h = await f.reserve();
    await f.repo.adjust(f.ctx('manager'), key(), {
      customerId: f.customer,
      programId: f.program,
      deltaPoints: '-150',
      reason: 'Documented correction',
    });
    await f.amount('-50', '80', '50');
    f.advance(2);
    await f.release(h.holdId);
    await f.amount('-50', '0', '50');
    await f.repo.adjust(f.ctx('manager'), key(), {
      customerId: f.customer,
      programId: f.program,
      deltaPoints: '60',
      reason: 'Documented correction reversal',
    });
    await f.amount('10');
    f.advance(2);
    await f.amount('0');
  }));

test('one network wallet across branches, cross-branch order misuse denied', async () =>
  fixture(async (f) => {
    await f.activate();
    await f.earn();
    const branch2 = key();
    await f.pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,'L2','Synthetic')",
      [branch2, f.org, f.legal],
    );
    const h = await f.repo.reserveRedemption({ ...f.ctx('checkout'), branchId: branch2 }, key(), {
      customerId: f.customer,
      programId: f.program,
      orderId: key(),
      points: '80',
      eligibleOrderMinor: '100',
    });
    await f.amount('100', '80');
    await assert.rejects(f.capture(h.holdId), { code: 'FORBIDDEN' });
    const other = await f.addCustomer();
    await assert.rejects(f.capture(h.holdId, { customerId: other }), { code: 'NOT_FOUND' });
    const wrong = { ...f.ctx('manager'), organizationId: key() };
    await assert.rejects(
      f.repo.activateProgram(wrong, key(), { programId: f.program, reason: 'Wrong scope' }),
      { code: 'FORBIDDEN' },
    );
  }));

test('old approved version honors delayed earn/refund while new checkout pins active version', async () =>
  fixture(async (f) => {
    await f.activate();
    const p2 = await f.repo.createApprovedProgram(f.ctx('manager'), key(), {
      version: 2,
      rules: { ...rules, earnBasisPoints: 5000 },
      approvalReference: 'Synthetic revision',
      reason: 'Explicit new rule version',
    });
    await f.repo.activateProgram(f.ctx('manager'), key(), {
      programId: p2.programId,
      reason: 'Synthetic activation',
    });
    const order = key();
    await f.earn('100', order);
    await f.amount('100');
    await assert.rejects(f.reserve(), { code: 'PROGRAM_INACTIVE' });
    await f.refund(order);
    await f.amount('0');
  }));

test('journal, allocations, source events and identities are immutable; projection drift rolls back', async () =>
  fixture(async (f) => {
    await f.activate();
    const order = key();
    await f.earn('100', order);
    const h = await f.reserve();
    await f.refund(order, '10');
    for (const table of [
      'loyalty_ledger',
      'loyalty_lots',
      'loyalty_allocations',
      'loyalty_earned_refunds',
      'loyalty_programs',
      'loyalty_wallets',
      'loyalty_holds',
      'loyalty_commands',
    ])
      await assert.rejects(f.pool.query(`DELETE FROM ${table}`));
    await assert.rejects(
      f.pool.query('UPDATE loyalty_wallets SET balance_points=balance_points+1'),
    );
    await assert.rejects(
      f.pool.query("UPDATE loyalty_lots SET expires_at=expires_at+interval '1 day'"),
    );
    await assert.rejects(
      f.pool.query(
        'UPDATE loyalty_lots SET remaining_points=remaining_points-1,revoked_points=revoked_points+1',
      ),
    );
    await f.amount('90', '80');
    await f.release(h.holdId);
    await f.amount('90');
  }));

test('database failure rolls back source receipt, balance, holds, allocations and command together', async () =>
  fixture(async (f) => {
    await f.activate();
    await f.earn();
    await f.pool.query(
      "CREATE FUNCTION reject_loyalty_command() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic transaction failure'; END $$",
    );
    await f.pool.query(
      'CREATE TRIGGER reject_loyalty_command BEFORE INSERT ON loyalty_commands FOR EACH ROW EXECUTE FUNCTION reject_loyalty_command()',
    );
    await assert.rejects(f.reserve());
    await f.amount('100');
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM loyalty_holds')).rows[0].n, 0);
    assert.equal(
      (await f.pool.query('SELECT count(*)::int AS n FROM loyalty_allocations')).rows[0].n,
      0,
    );
  }));

test('refund-before-earn and earn-before-refund agree under integer rounding', async () =>
  fixture(async (f) => {
    const program = (
      await f.repo.createApprovedProgram(f.ctx('manager'), key(), {
        version: 2,
        rules: { ...rules, earnBasisPoints: 700, pointValueMinor: '100' },
        approvalReference: 'Synthetic rounding',
        reason: 'Test fractional reward entitlement',
      })
    ).programId;
    await f.repo.activateProgram(f.ctx('manager'), key(), {
      programId: program,
      reason: 'Synthetic program',
    });
    const order1 = key(),
      order2 = key(),
      body = (order) => ({
        customerId: f.customer,
        programId: program,
        orderId: order,
        originalEligibleMinor: '19999',
      });
    await f.repo.refundEarned(f.ctx('refund'), key(), {
      ...body(order1),
      sourceRefundId: key(),
      eligibleRefundMinor: '10000',
    });
    await f.repo.earnFulfilledOrder(f.ctx('fulfillment'), key(), {
      ...body(order1),
      fulfillmentEventId: key(),
    });
    await f.amount('6');
    await f.repo.earnFulfilledOrder(f.ctx('fulfillment'), key(), {
      ...body(order2),
      fulfillmentEventId: key(),
    });
    await f.amount('19');
    await f.repo.refundEarned(f.ctx('refund'), key(), {
      ...body(order2),
      sourceRefundId: key(),
      eligibleRefundMinor: '10000',
    });
    await f.amount('12');
  }));

test('deleted identity cannot read/reserve, but existing financial liabilities still resolve', async () =>
  fixture(async (f) => {
    await f.activate();
    const order = key();
    await f.earn('100', order);
    const h = await f.reserve('80');
    await f.pool.query(
      'UPDATE identity_customers SET phone_lookup=NULL,phone_cipher=NULL,profile_cipher=NULL,profile_completed_at=NULL,deleted_at=clock_timestamp() WHERE id=$1',
      [f.customer],
    );
    await assert.rejects(f.wallet(), { code: 'NOT_FOUND' });
    await assert.rejects(f.reserve('1'), { code: 'NOT_FOUND' });
    await assert.rejects(f.earn(), { code: 'NOT_FOUND' });
    await f.refund(order);
    await f.capture(h.holdId);
    await f.restore(h.holdId);
    const row = (
      await f.pool.query('SELECT balance_points,debt_points,reserved_points FROM loyalty_wallets')
    ).rows[0];
    assert.deepEqual(row, { balance_points: '0', debt_points: '0', reserved_points: '0' });
  }));

test('reused actual capture ID on another hold rolls back second capture atomically', async () =>
  fixture(async (f) => {
    await f.activate();
    await f.earn('1000');
    const a = await f.reserve('100'),
      b = await f.reserve('200'),
      source = key();
    await f.capture(a.holdId, { sourceCaptureId: source });
    await assert.rejects(f.capture(b.holdId, { sourceCaptureId: source }), { code: 'CONFLICT' });
    await f.amount('900', '200');
    assert.equal(
      (await f.pool.query('SELECT state FROM loyalty_holds WHERE id=$1', [b.holdId])).rows[0].state,
      'held',
    );
  }));

test('limited runtime role executes transactions without owning schema, identity, or immutable audit tables', async () =>
  fixture(async (f) => {
    const role = 'loyalty_runtime_' + key().replaceAll('-', '');
    let runtime;
    try {
      await f.admin.query(`CREATE ROLE ${role} NOLOGIN`);
      await f.admin.query(`GRANT USAGE ON SCHEMA ${f.schema} TO ${role}`);
      const tables = (
        await f.pool.query(
          "SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE 'loyalty_%'",
        )
      ).rows.map((r) => r.tablename);
      for (const table of tables) await f.pool.query(`GRANT SELECT,INSERT ON ${table} TO ${role}`);
      for (const table of [
        'loyalty_active_programs',
        'loyalty_wallets',
        'loyalty_lots',
        'loyalty_holds',
        'loyalty_rewards',
      ])
        await f.pool.query(`GRANT UPDATE ON ${table} TO ${role}`);
      await f.pool.query(`GRANT SELECT ON branches,identity_customers TO ${role}`);
      await f.pool.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${f.schema} TO ${role}`);
      const url = new URL(f.url);
      url.searchParams.set('options', `-c search_path=${f.schema} -c role=${role}`);
      runtime = createPool(url.toString());
      const repo = new LoyaltyRepository(runtime);
      await repo.activateProgram(f.ctx('manager'), key(), {
        programId: f.program,
        reason: 'Synthetic runtime activation',
      });
      const order = key();
      await repo.earnFulfilledOrder(f.ctx('fulfillment'), key(), {
        customerId: f.customer,
        programId: f.program,
        orderId: order,
        originalEligibleMinor: '100',
        fulfillmentEventId: key(),
      });
      const hold = await repo.reserveRedemption(f.ctx('checkout'), key(), {
        customerId: f.customer,
        programId: f.program,
        orderId: key(),
        points: '80',
        eligibleOrderMinor: '100',
      });
      await repo.captureRedemption(f.ctx('checkout'), key(), {
        customerId: f.customer,
        holdId: hold.holdId,
        sourceCaptureId: key(),
      });
      assert.equal(
        (await repo.readWallet({ organizationId: f.org, customerId: f.customer })).balancePoints,
        '20',
      );
      for (const sql of [
        'DELETE FROM loyalty_ledger',
        'TRUNCATE loyalty_ledger CASCADE',
        'UPDATE identity_customers SET deleted_at=NULL',
        'CREATE TABLE unauthorized(id int)',
        'ALTER TABLE loyalty_lots DISABLE TRIGGER ALL',
      ])
        await assert.rejects(runtime.query(sql), { code: '42501' });
    } finally {
      if (runtime) await runtime.end();
      await f.pool.query(`DROP OWNED BY ${role}`);
      await f.admin.query(`DROP ROLE ${role}`);
    }
  }));
