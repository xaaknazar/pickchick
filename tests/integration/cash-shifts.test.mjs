import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createEdge } from '@pickchick/edge';
import { applyMenu, publishMenu } from '@pickchick/menu-sync';
import { parseEvent } from '../../packages/pos-order-sync/dist/model.js';
import {
  openCashShift,
  closeCashShift,
  currentCashShift,
  readCashShift,
  listCashShifts,
  listLocalOrders,
  createQuote,
  createLocalOrder,
  cancelLocalOrder,
  provisionStaff,
  readOrdering,
} from '@pickchick/local-orders';
import { withOrderDesk, staffAuth, staffHeaders } from '../helpers/orders.mjs';
import { running, request } from '../helpers/sync.mjs';
const code = (expected) => (error) => error.code === expected;
const auth = (ctx) => staffAuth(ctx.cashier);
const close = (ctx, input = {}, key = randomUUID()) =>
  closeCashShift(ctx.edge.pool, ctx.branch, auth(ctx), key, ctx.shift.shift_id, {
    expected_version: 1,
    counted_cash_minor: '0',
    reason: 'Synthetic close',
    ...input,
  });
const create = async (ctx, key = randomUUID()) => {
  const quote = await createQuote(ctx.edge.pool, ctx.branch, auth(ctx), ctx.cart);
  return createLocalOrder(ctx.edge.pool, ctx.branch, auth(ctx), key, { quote_id: quote.quote_id });
};

test('opening and closing shift never enables preview ordering; duplicate open/close replay and conflict', async () => {
  await withOrderDesk(async (ctx) => {
    assert.equal(
      (await readOrdering(ctx.edge.pool, ctx.branch, auth(ctx))).ordering_enabled,
      false,
    );
    await close(ctx);
    const key = randomUUID(),
      body = { opening_cash_minor: '9007199254740993' };
    const run = () => openCashShift(ctx.edge.pool, ctx.branch, auth(ctx), key, body);
    const [a, b] = await Promise.all([run(), run()]);
    assert.deepEqual(a, b);
    assert.equal(a.opening_cash_minor, body.opening_cash_minor);
    await assert.rejects(
      openCashShift(ctx.edge.pool, ctx.branch, auth(ctx), key, { opening_cash_minor: '1' }),
      code('CONFLICT'),
    );
    await assert.rejects(
      openCashShift(ctx.edge.pool, ctx.branch, auth(ctx), randomUUID(), body),
      code('CONFLICT'),
    );
    const closing = {
      expected_version: 1,
      counted_cash_minor: '9007199254740992',
      reason: 'One minor unit missing',
    };
    const closeKey = randomUUID();
    const first = await closeCashShift(
      ctx.edge.pool,
      ctx.branch,
      auth(ctx),
      closeKey,
      a.shift_id,
      closing,
    );
    assert.equal(first.discrepancy_minor, '-1');
    assert.equal(first.expected_cash_minor, body.opening_cash_minor);
    assert.deepEqual(
      await closeCashShift(ctx.edge.pool, ctx.branch, auth(ctx), closeKey, a.shift_id, closing),
      first,
    );
    assert.deepEqual(await run(), a); // Historical open replay does not reopen closed shift.
    assert.equal((await currentCashShift(ctx.edge.pool, ctx.branch, auth(ctx))).shift, null);
    assert.equal(
      (await readOrdering(ctx.edge.pool, ctx.branch, auth(ctx))).ordering_enabled,
      false,
    );
    await assert.rejects(
      createQuote(ctx.edge.pool, ctx.branch, auth(ctx), ctx.cart),
      code('BRANCH_UNAVAILABLE'),
    );
    assert.equal(
      (
        await ctx.edge.pool.query(
          "SELECT count(*) FROM local_audit WHERE resource_id=$1 AND action LIKE 'cash_shift.%'",
          [a.shift_id],
        )
      ).rows[0].count,
      '2',
    );
  }, false);
});

test('orders associate with shift; close freezes counts and leaves unpaid orders untouched', async () => {
  await withOrderDesk(async (ctx) => {
    const a = await create(ctx),
      b = await create(ctx);
    assert.equal(a.cash_shift_id, ctx.shift.shift_id);
    await cancelLocalOrder(ctx.edge.pool, ctx.branch, auth(ctx), randomUUID(), a.order_id, {
      expected_version: 1,
      reason: 'Synthetic cancel',
    });
    const open = await readCashShift(ctx.edge.pool, ctx.branch, auth(ctx), ctx.shift.shift_id);
    assert.equal(open.order_count, 2);
    assert.equal(open.cancelled_count, 1);
    assert.equal(open.awaiting_payment_count, 1);
    assert.equal(open.order_total_minor, '1396000');
    assert.equal(open.unpaid_total_minor, '698000');
    assert.equal(
      (await listLocalOrders(ctx.edge.pool, ctx.branch, auth(ctx), ctx.shift.shift_id)).orders
        .length,
      2,
    );
    const closed = await close(ctx, { counted_cash_minor: '125' });
    assert.equal(closed.discrepancy_minor, '125');
    assert.equal(closed.cash_received_minor, '0');
    assert.equal(closed.payment_processing_available, false);
    assert.equal(
      (
        await ctx.edge.pool.query(
          'SELECT state,payment_state,fulfillment_state FROM local_orders WHERE id=$1',
          [b.order_id],
        )
      ).rows[0].state,
      'awaiting_payment',
    );
    await cancelLocalOrder(ctx.edge.pool, ctx.branch, auth(ctx), randomUUID(), b.order_id, {
      expected_version: 1,
      reason: 'Cancel after shift closure',
    });
    assert.deepEqual(
      await readCashShift(ctx.edge.pool, ctx.branch, auth(ctx), ctx.shift.shift_id),
      closed,
    );
    await assert.rejects(create(ctx), code('CASH_SHIFT_REQUIRED'));
    for (const sql of [
      "UPDATE local_cash_shifts SET state='open',version=1 WHERE id=$1",
      'DELETE FROM local_cash_shifts WHERE id=$1',
      "UPDATE local_cash_shifts SET closing_reason='rewrite' WHERE id=$1",
    ])
      await assert.rejects(ctx.edge.pool.query(sql, [ctx.shift.shift_id]));
    await assert.rejects(
      ctx.edge.pool.query('UPDATE local_orders SET cash_shift_id=NULL WHERE id=$1', [b.order_id]),
    );
  });
});

test('cashiers are isolated by staff and terminal; manager can read/close within branch; kitchen forbidden', async () => {
  await withOrderDesk(async (ctx) => {
    const other = await provisionStaff(ctx.edge.pool, ctx.branch, ctx.setup('cashier'));
    const sameTerminal = await provisionStaff(ctx.edge.pool, ctx.branch, {
      ...ctx.setup('cashier'),
      terminal_id: ctx.cashier.terminal_id,
    });
    for (const actor of [other, sameTerminal]) {
      assert.equal(
        (await listCashShifts(ctx.edge.pool, ctx.branch, staffAuth(actor))).shifts.length,
        0,
      );
      await assert.rejects(
        readCashShift(ctx.edge.pool, ctx.branch, staffAuth(actor), ctx.shift.shift_id),
        code('NOT_FOUND'),
      );
      await assert.rejects(
        closeCashShift(
          ctx.edge.pool,
          ctx.branch,
          staffAuth(actor),
          randomUUID(),
          ctx.shift.shift_id,
          { expected_version: 1, counted_cash_minor: '0', reason: 'Not my shift' },
        ),
        code('NOT_FOUND'),
      );
    }
    await assert.rejects(
      openCashShift(ctx.edge.pool, ctx.branch, staffAuth(sameTerminal), randomUUID(), {
        opening_cash_minor: '0',
      }),
      code('CONFLICT'),
    );
    const kitchen = await provisionStaff(ctx.edge.pool, ctx.branch, ctx.setup('kitchen'));
    await assert.rejects(
      currentCashShift(ctx.edge.pool, ctx.branch, staffAuth(kitchen)),
      code('FORBIDDEN'),
    );
    assert.equal(
      (await listCashShifts(ctx.edge.pool, ctx.branch, staffAuth(ctx.manager))).shifts.length,
      1,
    );
    const closed = await closeCashShift(
      ctx.edge.pool,
      ctx.branch,
      staffAuth(ctx.manager),
      randomUUID(),
      ctx.shift.shift_id,
      { expected_version: 1, counted_cash_minor: '0', reason: 'Manager verified count' },
    );
    assert.equal(closed.closed_by_staff_id, ctx.manager.staff_id);
  });
});

test('create racing close either joins frozen report or fails; no order leaks into a closed shift', async () => {
  await withOrderDesk(async (ctx) => {
    const quote = await createQuote(ctx.edge.pool, ctx.branch, auth(ctx), ctx.cart);
    const results = await Promise.allSettled([
      createLocalOrder(ctx.edge.pool, ctx.branch, auth(ctx), randomUUID(), {
        quote_id: quote.quote_id,
      }),
      close(ctx),
    ]);
    assert.equal(results[1].status, 'fulfilled');
    if (results[0].status === 'fulfilled') assert.equal(results[1].value.order_count, 1);
    else {
      assert.equal(results[0].reason.code, 'CASH_SHIFT_REQUIRED');
      assert.equal(results[1].value.order_count, 0);
    }
  });
});

test('audit failure rolls back close and receipt; retry preserves one terminal transition', async () => {
  await withOrderDesk(async (ctx) => {
    await ctx.edge.pool.query(
      "CREATE FUNCTION fail_shift_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='cash_shift.closed' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER fail_shift_audit BEFORE INSERT ON local_audit FOR EACH ROW EXECUTE FUNCTION fail_shift_audit()",
    );
    const key = randomUUID();
    await assert.rejects(close(ctx, {}, key));
    assert.equal(
      (await currentCashShift(ctx.edge.pool, ctx.branch, auth(ctx))).shift.state,
      'open',
    );
    assert.equal(
      (
        await ctx.edge.pool.query(
          "SELECT count(*) FROM local_command_results WHERE command_type='cash_shift.close'",
        )
      ).rows[0].count,
      '0',
    );
    await ctx.edge.pool.query('DROP TRIGGER fail_shift_audit ON local_audit');
    assert.equal((await close(ctx, {}, key)).state, 'closed');
  });
});

test('HTTP shift state survives edge restart; malformed requests denied; feed is authenticated', async () => {
  await withOrderDesk(async (ctx) => {
    let edge = await running(createEdge, ctx.edge.config);
    try {
      const get = async (path, headers = staffHeaders(ctx.cashier)) =>
        request(edge.url + '/edge/v1/' + path, { headers });
      assert.equal(
        (await (await get('cash-shifts/current')).json()).shift.shift_id,
        ctx.shift.shift_id,
      );
      assert.equal((await get('orders', {})).status, 401);
      assert.equal((await get('orders?shift_id=invalid')).status, 400);
      const bad = await request(
        edge.url + '/edge/v1/cash-shifts/' + ctx.shift.shift_id + '/close',
        {
          method: 'POST',
          headers: staffHeaders(ctx.cashier),
          body: JSON.stringify({ expected_version: 1, counted_cash_minor: '1.2', reason: '' }),
        },
      );
      assert.equal(bad.status, 400);
      await edge.app.close();
      edge = await running(createEdge, ctx.edge.config);
      assert.equal(
        (await (await get('cash-shifts/current')).json()).shift.shift_id,
        ctx.shift.shift_id,
      );
      const orders = await (await get('orders')).json();
      assert.deepEqual(orders.orders, []);
      assert.ok(orders.server_time);
      const key = randomUUID(),
        closeOptions = {
          method: 'POST',
          headers: staffHeaders(ctx.cashier, key),
          body: JSON.stringify({
            expected_version: 1,
            counted_cash_minor: '0',
            reason: 'HTTP close',
          }),
        };
      const closed = await request(
        edge.url + '/edge/v1/cash-shifts/' + ctx.shift.shift_id + '/close',
        closeOptions,
      );
      assert.equal(closed.status, 200);
      const snapshot = await closed.json();
      assert.equal(snapshot.state, 'closed');
      assert.deepEqual(
        await (
          await request(
            edge.url + '/edge/v1/cash-shifts/' + ctx.shift.shift_id + '/close',
            closeOptions,
          )
        ).json(),
        snapshot,
      );
    } finally {
      await edge.app.close();
    }
  });
});

test('priced modifiers survive order, feed and sync envelope; same SKU different quantities stay separate', async () => {
  await withOrderDesk(async (ctx) => {
    const groupId = randomUUID(),
      optionId = randomUUID(),
      unavailableId = randomUUID();
    const next = ctx.menu(2);
    next.items = [
      {
        ...next.items[0],
        modifier_groups: [
          {
            id: groupId,
            name: { ru: 'Сыр', kk: 'Ірімшік' },
            min_selected: 1,
            max_selected: 2,
            options: [
              {
                id: optionId,
                name: { ru: 'Добавка', kk: 'Қоспа' },
                price_minor: '200',
                max_quantity: 2,
              },
              {
                id: unavailableId,
                name: { ru: 'Нет', kk: 'Жоқ' },
                price_minor: '0',
                available: false,
              },
            ],
          },
        ],
      },
    ];
    await applyMenu(ctx.edge.pool, ctx.branch, await publishMenu(ctx.cloud.pool, next));
    const cart = {
      release_id: next.release_id,
      service_mode: 'takeaway',
      items: [1, 2].map((quantity) => ({
        variant_id: next.items[0].variant_id,
        quantity: 1,
        modifiers: [{ group_id: groupId, option_id: optionId, quantity }],
      })),
    };
    const q = await createQuote(ctx.edge.pool, ctx.branch, auth(ctx), cart);
    assert.equal(q.total_minor, '698600');
    assert.equal(q.lines.length, 2);
    const order = await createLocalOrder(ctx.edge.pool, ctx.branch, auth(ctx), randomUUID(), {
      quote_id: q.quote_id,
    });
    assert.deepEqual(order.snapshot, q);
    assert.deepEqual(
      (await listLocalOrders(ctx.edge.pool, ctx.branch, auth(ctx))).orders[0].snapshot,
      q,
    );
    const row = (
      await ctx.edge.pool.query(
        "SELECT * FROM outbox_events WHERE aggregate_id=$1 AND event_type='order.created'",
        [order.order_id],
      )
    ).rows[0];
    const event = {
      event_id: row.event_id,
      producer_id: row.producer_id,
      producer_sequence: row.producer_sequence,
      aggregate_type: row.aggregate_type,
      aggregate_id: row.aggregate_id,
      aggregate_version: Number(row.aggregate_version),
      event_type: row.event_type,
      schema_version: row.schema_version,
      branch_id: row.branch_id,
      occurred_at: row.occurred_at.toISOString(),
      correlation_id: row.correlation_id,
      causation_id: row.causation_id,
      payload: row.payload,
    };
    assert.deepEqual(parseEvent(event).payload.snapshot, q);
    const duplicate = globalThis.structuredClone(event);
    duplicate.payload.snapshot.lines[1] = globalThis.structuredClone(
      duplicate.payload.snapshot.lines[0],
    );
    duplicate.payload.snapshot.lines[1].total_minor = '349200';
    duplicate.payload.total_minor = '698400';
    duplicate.payload.snapshot.total_minor = '698400';
    duplicate.payload.snapshot.subtotal_minor = '698400';
    assert.throws(() => parseEvent(duplicate));
    cart.items[0].modifiers[0].option_id = unavailableId;
    await assert.rejects(
      createQuote(ctx.edge.pool, ctx.branch, auth(ctx), cart),
      code('INVALID_REQUEST'),
    );
  });
});
