import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { applyMenu, publishMenu } from '@pickchick/menu-sync';
import {
  setStaffPin,
  loginStaffPin,
  setStaffPassword,
  loginStaff,
  readSession,
  moveCash,
  closeCashShift,
  readCashShift,
  createQuote,
  createLocalOrder,
  setStop,
  readStop,
  readStops,
  provisionStaff,
  PIN_BACKOFF,
  pinBackoffStatus,
} from '@pickchick/local-orders';
import { createEdge } from '@pickchick/edge';
import { withOrderDesk, staffAuth } from '../helpers/orders.mjs';
import { running } from '../helpers/sync.mjs';
const code = (name) => (error) => error.code === name;

test('PIN is local, preserves password access and shared shift; unknown PINs are rate limited without credentials in storage', async () => {
  await withOrderDesk(async (ctx) => {
    await setStaffPassword(
      ctx.edge.pool,
      ctx.branch,
      staffAuth(ctx.cashier),
      'fixture.cashier',
      'Synthetic passphrase 42',
    );
    const credential = await loginStaff(ctx.edge.pool, ctx.branch, {
      login: 'fixture.cashier',
      password: 'Synthetic passphrase 42',
      terminal_id: ctx.cashier.terminal_id,
    });
    await setStaffPin(ctx.edge.pool, ctx.branch, staffAuth(credential), '7351');
    await assert.rejects(
      readSession(ctx.edge.pool, ctx.branch, staffAuth(credential)),
      code('UNAUTHORIZED'),
    );
    const body = { pin: '7351', terminal_id: ctx.cashier.terminal_id };
    const actor = await loginStaffPin(ctx.edge.pool, ctx.branch, body);
    assert.equal(actor.staff_id, ctx.cashier.staff_id);
    assert.equal(actor.role, 'cashier');
    assert.equal(actor.name, 'Synthetic staff');
    assert.equal(
      (await readCashShift(ctx.edge.pool, ctx.branch, staffAuth(actor), ctx.shift.shift_id)).state,
      'open',
    );
    const saved = (
      await ctx.edge.pool.query('SELECT login,algorithm,salt,verifier FROM local_staff_pins')
    ).rows[0];
    assert.match(saved.login, /^[a-f0-9]{64}$/);
    assert.equal(saved.algorithm, 'scrypt-v1');
    assert.equal(saved.verifier.length, 64);
    const password = await loginStaff(ctx.edge.pool, ctx.branch, {
      login: 'fixture.cashier',
      password: 'Synthetic passphrase 42',
      terminal_id: actor.terminal_id,
    });
    assert.equal(password.staff_id, actor.staff_id);
    await ctx.edge.pool.query(
      "UPDATE local_staff_login_limits SET window_started_at=clock_timestamp()-interval '2 minutes'",
    );
    // Per-terminal backoff (6.5): five unknown PINs, then even the right PIN waits.
    for (let i = 0; i < PIN_BACKOFF.freeFailures; i++)
      await assert.rejects(
        loginStaffPin(ctx.edge.pool, ctx.branch, { ...body, pin: '9999' }),
        code('UNAUTHORIZED'),
      );
    await assert.rejects(
      loginStaffPin(ctx.edge.pool, ctx.branch, body),
      (error) => error.name === 'Error' && error.constructor.name === 'StaffRateLimitError',
    );
    const audits = (await ctx.edge.pool.query('SELECT action FROM local_audit')).rows;
    assert.ok(audits.some((v) => v.action === 'staff.pin_login'));
  });
});

test('PIN backoff is per terminal, never reveals a PIN, and new 6-digit PINs work beside 4-digit ones (6.5)', async () => {
  await withOrderDesk(async (ctx) => {
    // Retry-After carries the real remaining lock, the same for every PIN.
    const limited = (error) =>
      error.constructor.name === 'StaffRateLimitError' &&
      error.retryAfterSeconds > 0 &&
      error.retryAfterSeconds <= 30;
    await setStaffPin(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), '735190');
    await setStaffPin(ctx.edge.pool, ctx.branch, staffAuth(ctx.manager), '2468');
    for (const pin of ['12345', '1234567', '73519O', ''])
      await assert.rejects(
        setStaffPin(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), pin, true),
        code('INVALID_REQUEST'),
      );
    const terminal = ctx.cashier.terminal_id;
    const cashier = await loginStaffPin(ctx.edge.pool, ctx.branch, {
      pin: '735190',
      terminal_id: terminal,
    });
    assert.equal(cashier.staff_id, ctx.cashier.staff_id);
    const manager = await loginStaffPin(ctx.edge.pool, ctx.branch, {
      pin: '2468',
      terminal_id: terminal,
    });
    assert.equal(manager.role, 'shift_manager');
    await assert.rejects(
      loginStaffPin(ctx.edge.pool, ctx.branch, { pin: '7351', terminal_id: terminal }),
      code('UNAUTHORIZED'),
      'a 4-digit prefix of a 6-digit PIN is a different PIN',
    );
    // A successful own login does not reset the counter an attacker is building.
    for (let i = 2; i < PIN_BACKOFF.freeFailures; i++)
      await assert.rejects(
        loginStaffPin(ctx.edge.pool, ctx.branch, { pin: '000000', terminal_id: terminal }),
        code('UNAUTHORIZED'),
      );
    await loginStaffPin(ctx.edge.pool, ctx.branch, { pin: '735190', terminal_id: terminal });
    assert.equal(pinBackoffStatus(ctx.branch, terminal).failures, PIN_BACKOFF.freeFailures - 1);
    await assert.rejects(
      loginStaffPin(ctx.edge.pool, ctx.branch, { pin: '111111', terminal_id: terminal }),
      code('UNAUTHORIZED'),
    );
    const status = pinBackoffStatus(ctx.branch, terminal);
    assert.equal(status.failures, PIN_BACKOFF.freeFailures);
    assert.ok(status.lockedSeconds > 0 && status.lockedSeconds <= 30);
    // While locked, a right PIN and a wrong PIN are indistinguishable and do no password work.
    const before = (
      await ctx.edge.pool.query(
        'SELECT attempts FROM local_staff_login_limits WHERE terminal_id=$1',
        [terminal],
      )
    ).rows[0].attempts;
    for (const pin of ['735190', '2468', '999999'])
      await assert.rejects(
        loginStaffPin(ctx.edge.pool, ctx.branch, { pin, terminal_id: terminal }),
        limited,
      );
    assert.equal(
      (
        await ctx.edge.pool.query(
          'SELECT attempts FROM local_staff_login_limits WHERE terminal_id=$1',
          [terminal],
        )
      ).rows[0].attempts,
      before,
    );
    // Over HTTP the cashier sees the same 429 with the real remaining lock, not a fixed minute.
    const edge = await running(createEdge, ctx.edge.config);
    try {
      const locked = await fetch(edge.url + '/edge/v1/staff/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '735190', terminal_id: terminal }),
      });
      assert.equal(locked.status, 429);
      assert.equal((await locked.json()).code, 'AUTH_RATE_LIMITED');
      const seconds = Number(locked.headers.get('retry-after'));
      assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= 30);
    } finally {
      await edge.app.close();
    }
    // Another workplace of the same branch is not locked out.
    const other = await provisionStaff(ctx.edge.pool, ctx.branch, ctx.setup('cashier'));
    await setStaffPin(ctx.edge.pool, ctx.branch, staffAuth(other), '480215');
    const elsewhere = await loginStaffPin(ctx.edge.pool, ctx.branch, {
      pin: '2468',
      terminal_id: other.terminal_id,
    });
    assert.equal(elsewhere.staff_id, ctx.manager.staff_id);
    // Unknown terminals never create backoff state.
    const unknown = randomUUID();
    await assert.rejects(
      loginStaffPin(ctx.edge.pool, ctx.branch, { pin: '000000', terminal_id: unknown }),
      code('UNAUTHORIZED'),
    );
    assert.equal(pinBackoffStatus(ctx.branch, unknown).failures, 0);
  });
});

test('drawer movement is idempotent, append only, manager controlled, bounded and frozen on close', async () => {
  await withOrderDesk(async (ctx) => {
    const key = randomUUID(),
      input = { direction: 'in', amount_minor: '1000000', reason: 'Test change float' };
    const run = () =>
      moveCash(ctx.edge.pool, ctx.branch, staffAuth(ctx.manager), key, ctx.shift.shift_id, input);
    const [a, b] = await Promise.all([run(), run()]);
    assert.deepEqual(a, b);
    assert.equal(a.expected_cash_minor, '1000000');
    assert.equal(a.cash_movements.length, 1);
    await assert.rejects(
      moveCash(
        ctx.edge.pool,
        ctx.branch,
        staffAuth(ctx.cashier),
        randomUUID(),
        ctx.shift.shift_id,
        input,
      ),
      code('FORBIDDEN'),
    );
    await assert.rejects(
      moveCash(
        ctx.edge.pool,
        ctx.branch,
        staffAuth(ctx.manager),
        randomUUID(),
        ctx.shift.shift_id,
        { ...input, direction: 'out', amount_minor: '1000001' },
      ),
      code('INVALID_REQUEST'),
    );
    const out = await moveCash(
      ctx.edge.pool,
      ctx.branch,
      staffAuth(ctx.manager),
      randomUUID(),
      ctx.shift.shift_id,
      { direction: 'out', amount_minor: '350000', reason: 'Test collection' },
    );
    assert.equal(out.expected_cash_minor, '650000');
    for (const query of [
      'UPDATE local_cash_movements SET amount_minor=1',
      'DELETE FROM local_cash_movements',
    ])
      await assert.rejects(ctx.edge.pool.query(query));
    const closed = await closeCashShift(
      ctx.edge.pool,
      ctx.branch,
      staffAuth(ctx.manager),
      randomUUID(),
      ctx.shift.shift_id,
      { expected_version: 1, counted_cash_minor: '649900', reason: 'Test shortage' },
    );
    assert.equal(closed.discrepancy_minor, '-100');
    assert.equal(closed.expected_cash_minor, '650000');
    assert.equal(closed.cash_received_minor, '0');
    assert.equal(closed.order_count, 0);
    await assert.rejects(
      moveCash(
        ctx.edge.pool,
        ctx.branch,
        staffAuth(ctx.manager),
        randomUUID(),
        ctx.shift.shift_id,
        input,
      ),
      code('CASH_SHIFT_REQUIRED'),
    );
    assert.deepEqual(await run(), a);
    assert.deepEqual(
      await readCashShift(ctx.edge.pool, ctx.branch, staffAuth(ctx.manager), ctx.shift.shift_id),
      closed,
    );
  });
});

test('modifier stop blocks both quote and stale quote admission; hour and shift expiry keep monotonic version', async () => {
  await withOrderDesk(async (ctx) => {
    const group = randomUUID(),
      option = randomUUID(),
      release = ctx.menu(2);
    release.items[0].modifier_groups = [
      {
        id: group,
        name: { ru: 'Соус', kk: 'Соус' },
        min_selected: 1,
        max_selected: 1,
        options: [
          { id: option, name: { ru: 'Сырный', kk: 'Сырный' }, price_minor: '0', max_quantity: 1 },
        ],
      },
    ];
    await applyMenu(ctx.edge.pool, ctx.branch, await publishMenu(ctx.cloud.pool, release));
    const cart = {
      ...ctx.cart,
      release_id: release.release_id,
      details: { display_name: 'Әлия', kitchen_comment: 'Соус отдельно' },
      items: [
        {
          variant_id: release.items[0].variant_id,
          quantity: 1,
          modifiers: [{ group_id: group, option_id: option, quantity: 1 }],
        },
      ],
    };
    const q = await createQuote(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), cart);
    assert.deepEqual(q.details, cart.details);
    await setStop(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), randomUUID(), {
      variant_id: option,
      stopped: true,
      expected_version: 0,
      reason: 'Test hour',
      duration: 'hour',
    });
    await assert.rejects(
      createQuote(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), cart),
      code('ITEM_STOPPED'),
    );
    await assert.rejects(
      createLocalOrder(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), randomUUID(), {
        quote_id: q.quote_id,
      }),
      code('ITEM_STOPPED'),
    );
    await ctx.edge.pool.query(
      "UPDATE local_stops SET expires_at=clock_timestamp()-interval '1 second' WHERE variant_id=$1",
      [option],
    );
    assert.deepEqual(await readStop(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), option), {
      variant_id: option,
      stopped: false,
      version: 1,
    });
    await setStop(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), randomUUID(), {
      variant_id: option,
      stopped: true,
      expected_version: 1,
      reason: 'Test shift',
      duration: 'shift',
    });
    assert.equal(
      (await readStops(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier))).stops.find(
        (s) => s.variant_id === option,
      ).stopped,
      true,
    );
    await closeCashShift(
      ctx.edge.pool,
      ctx.branch,
      staffAuth(ctx.manager),
      randomUUID(),
      ctx.shift.shift_id,
      { expected_version: 1, counted_cash_minor: '0', reason: 'Test close' },
    );
    assert.deepEqual(await readStop(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), option), {
      variant_id: option,
      stopped: false,
      version: 2,
    });
  });
});
