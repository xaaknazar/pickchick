import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createEdge } from '@pickchick/edge';
import { LocalOrderSchema, QuoteSchema, ErrorSchema } from '@pickchick/contracts';
import { applyMenu, publishMenu } from '@pickchick/menu-sync';
import {
  createQuote,
  createLocalOrder,
  readLocalOrder,
  cancelLocalOrder,
  provisionStaff,
  revokeStaff,
  setOrdering,
  setStop,
  readStop,
} from '@pickchick/local-orders';
import { withOrderDesk, staffAuth, staffHeaders } from '../helpers/orders.mjs';
import { running, request } from '../helpers/sync.mjs';

const code = (expected) => (error) => error.code === expected;
const create = (ctx, quote, key = randomUUID()) =>
  createLocalOrder(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), key, {
    quote_id: quote.quote_id,
  });
const quote = (ctx) => createQuote(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), ctx.cart);

test('session renewal racing checkout completes without deadlock and invalidates old credentials', async () => {
  await withOrderDesk(async (ctx) => {
    let actor = ctx.cashier;
    for (let i = 0; i < 5; i++) {
      const old = actor;
      const [renewal, checkout] = await Promise.allSettled([
        provisionStaff(ctx.edge.pool, ctx.branch, ctx.cashierSetup),
        createQuote(ctx.edge.pool, ctx.branch, staffAuth(old), ctx.cart),
      ]);
      assert.equal(renewal.status, 'fulfilled');
      if (checkout.status === 'rejected') assert.equal(checkout.reason.code, 'UNAUTHORIZED');
      actor = renewal.value;
      await assert.rejects(
        createQuote(ctx.edge.pool, ctx.branch, staffAuth(old), ctx.cart),
        code('UNAUTHORIZED'),
      );
    }
  });
});

test('real edge HTTP creates a priced unpaid order and retains it through restart without cloud', async () => {
  await withOrderDesk(async (ctx) => {
    let edge = await running(createEdge, ctx.edge.config);
    try {
      const session = await request(`${edge.url}/edge/v1/session`, {
        headers: staffHeaders(ctx.cashier),
      });
      assert.equal((await session.json()).role, 'cashier');
      const response = await request(`${edge.url}/edge/v1/checkout/quotes`, {
        method: 'POST',
        headers: staffHeaders(ctx.cashier),
        body: JSON.stringify(ctx.cart),
      });
      assert.equal(response.status, 201);
      const q = QuoteSchema.parse(await response.json());
      assert.equal(q.total_minor, '698000');
      const key = randomUUID();
      const options = {
        method: 'POST',
        headers: staffHeaders(ctx.cashier, key),
        body: JSON.stringify({ quote_id: q.quote_id }),
      };
      const created = await request(`${edge.url}/edge/v1/orders`, options);
      assert.equal(created.status, 201);
      const order = LocalOrderSchema.parse(await created.json());
      assert.equal(order.state, 'awaiting_payment');
      assert.equal(order.payment_state, 'not_started');
      assert.equal(order.fulfillment_state, 'blocked');
      assert.equal(order.next_action, 'payment_not_available');
      assert.deepEqual(await (await request(`${edge.url}/edge/v1/orders`, options)).json(), order);
      await edge.app.close();
      edge = await running(createEdge, ctx.edge.config);
      assert.deepEqual(
        await (
          await request(`${edge.url}/edge/v1/orders/${order.order_id}`, {
            headers: staffHeaders(ctx.cashier),
          })
        ).json(),
        order,
      );
      const unsupported = await request(`${edge.url}/edge/v1/orders/${order.order_id}/payments`, {
        method: 'POST',
        headers: staffHeaders(ctx.cashier),
      });
      assert.equal(unsupported.status, 404);
      const events = (
        await ctx.edge.pool.query(
          "SELECT * FROM outbox_events WHERE aggregate_type='order_commercial'",
        )
      ).rows;
      assert.equal(events.length, 1);
      assert.equal(events[0].event_type, 'order.created');
      assert.deepEqual(events[0].payload.snapshot, q);
      assert.equal(events[0].acknowledged_at, null);
    } finally {
      await edge.app.close();
    }
  });
});
test('concurrent duplicate commands create one order/event; changed payload or reused quote conflicts', async () => {
  await withOrderDesk(async (ctx) => {
    const q = await quote(ctx),
      key = randomUUID();
    const [a, b] = await Promise.all([create(ctx, q, key), create(ctx, q, key)]);
    assert.deepEqual(a, b);
    await assert.rejects(create(ctx, q), code('CONFLICT'));
    const other = await quote(ctx);
    await assert.rejects(create(ctx, other, key), code('CONFLICT'));
    assert.equal(
      (await ctx.edge.pool.query('SELECT count(*) FROM local_orders')).rows[0].count,
      '1',
    );
    assert.equal(
      (
        await ctx.edge.pool.query(
          "SELECT count(*) FROM local_command_results WHERE command_type='order.create'",
        )
      ).rows[0].count,
      '1',
    );
  });
});
test('another cashier or terminal cannot use a quote or read an order; manager can read', async () => {
  await withOrderDesk(async (ctx) => {
    const q = await quote(ctx),
      order = await create(ctx, q);
    const other = await provisionStaff(ctx.edge.pool, ctx.branch, ctx.setup('cashier'));
    const newTerminal = await provisionStaff(ctx.edge.pool, ctx.branch, {
      ...ctx.cashierSetup,
      terminal_id: randomUUID(),
    });
    for (const session of [other, newTerminal]) {
      await assert.rejects(
        createLocalOrder(ctx.edge.pool, ctx.branch, staffAuth(session), randomUUID(), {
          quote_id: q.quote_id,
        }),
        code('NOT_FOUND'),
      );
      await assert.rejects(
        readLocalOrder(ctx.edge.pool, ctx.branch, staffAuth(session), order.order_id),
        code('NOT_FOUND'),
      );
    }
    assert.equal(
      (await readLocalOrder(ctx.edge.pool, ctx.branch, staffAuth(ctx.manager), order.order_id))
        .order_id,
      order.order_id,
    );
    await assert.rejects(
      readLocalOrder(ctx.edge.pool, randomUUID(), staffAuth(ctx.cashier), order.order_id),
      code('UNAUTHORIZED'),
    );
  });
});
test('HTTP role enforcement denies kitchen checkout and cashier manager commands', async () => {
  await withOrderDesk(async (ctx) => {
    const kitchen = await provisionStaff(ctx.edge.pool, ctx.branch, ctx.setup('kitchen'));
    const edge = await running(createEdge, ctx.edge.config);
    try {
      for (const [path, actor, body] of [
        ['checkout/quotes', kitchen, ctx.cart],
        ['ordering/close', ctx.cashier, { expected_version: 2 }],
        [
          'availability/stops',
          kitchen,
          {
            variant_id: ctx.cart.items[0].variant_id,
            stopped: true,
            expected_version: 0,
            reason: 'test',
          },
        ],
      ]) {
        const result = await request(`${edge.url}/edge/v1/${path}`, {
          method: 'POST',
          headers: staffHeaders(actor),
          body: JSON.stringify(body),
        });
        assert.equal(result.status, 403);
        assert.equal(ErrorSchema.parse(await result.json()).code, 'FORBIDDEN');
      }
      assert.equal((await request(`${edge.url}/edge/v1/session`)).status, 401);
      const tampered = await request(`${edge.url}/edge/v1/checkout/quotes`, {
        method: 'POST',
        headers: staffHeaders(ctx.cashier),
        body: JSON.stringify({ ...ctx.cart, total_minor: '1', role: 'shift_manager' }),
      });
      assert.equal(tampered.status, 400);
    } finally {
      await edge.app.close();
    }
  });
});
test('expired quote is rejected using database clock without leaving command or order', async () => {
  await withOrderDesk(async (ctx) => {
    const q = await quote(ctx),
      id = randomUUID();
    const times = (
      await ctx.edge.pool.query(
        "SELECT clock_timestamp()-interval '10 minutes' AS created, clock_timestamp()-interval '5 minutes' AS expires",
      )
    ).rows[0];
    const expired = {
      ...q,
      quote_id: id,
      created_at: times.created.toISOString(),
      expires_at: times.expires.toISOString(),
    };
    await ctx.edge.pool.query(
      `INSERT INTO checkout_quotes(id,branch_id,staff_id,terminal_id,release_id,total_minor,snapshot,created_at,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        ctx.branch,
        ctx.cashier.staff_id,
        ctx.cashier.terminal_id,
        q.release_id,
        q.total_minor,
        expired,
        expired.created_at,
        expired.expires_at,
      ],
    );
    await assert.rejects(create(ctx, expired), code('QUOTE_EXPIRED'));
    assert.equal(
      (await ctx.edge.pool.query('SELECT count(*) FROM local_orders')).rows[0].count,
      '0',
    );
  });
});
test('new menu invalidates unconsumed quote but never changes an existing order snapshot or replay', async () => {
  await withOrderDesk(async (ctx) => {
    const q = await quote(ctx),
      key = randomUUID(),
      order = await create(ctx, q, key),
      pending = await quote(ctx);
    const next = ctx.menu(2);
    next.items = next.items.map((i) => ({ ...i, price_minor: '999000' }));
    await applyMenu(ctx.edge.pool, ctx.branch, await publishMenu(ctx.cloud.pool, next));
    await assert.rejects(create(ctx, pending), code('MENU_CHANGED'));
    assert.deepEqual(await create(ctx, q, key), order);
    assert.equal(
      (await readLocalOrder(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), order.order_id))
        .snapshot.total_minor,
      '698000',
    );
  });
});
test('manual stop blocks both quote and order, with optimistic versions and audited manager changes', async () => {
  await withOrderDesk(async (ctx) => {
    const q = await quote(ctx),
      auth = staffAuth(ctx.manager),
      stop = {
        variant_id: ctx.cart.items[0].variant_id,
        stopped: true,
        expected_version: 0,
        reason: 'Synthetic sold out',
      };
    assert.equal((await readStop(ctx.edge.pool, ctx.branch, auth, stop.variant_id)).version, 0);
    const first = await setStop(ctx.edge.pool, ctx.branch, auth, randomUUID(), stop);
    assert.deepEqual(await readStop(ctx.edge.pool, ctx.branch, auth, stop.variant_id), first);
    assert.equal(first.version, 1);
    await assert.rejects(quote(ctx), code('ITEM_STOPPED'));
    await assert.rejects(create(ctx, q), code('ITEM_STOPPED'));
    await assert.rejects(
      setStop(ctx.edge.pool, ctx.branch, auth, randomUUID(), { ...stop, stopped: false }),
      code('CONFLICT'),
    );
    await setStop(ctx.edge.pool, ctx.branch, auth, randomUUID(), {
      ...stop,
      stopped: false,
      expected_version: 1,
    });
    assert.equal((await create(ctx, q)).state, 'awaiting_payment');
  });
});
test('closing ordering blocks new work but preserves idempotent replay; stale configuration conflicts', async () => {
  await withOrderDesk(async (ctx) => {
    const q = await quote(ctx),
      key = randomUUID(),
      created = await create(ctx, q, key),
      pending = await quote(ctx);
    const auth = staffAuth(ctx.manager),
      closeKey = randomUUID();
    const closed = await setOrdering(ctx.edge.pool, ctx.branch, auth, closeKey, false, {
      expected_version: 2,
    });
    assert.deepEqual(
      await setOrdering(ctx.edge.pool, ctx.branch, auth, closeKey, false, { expected_version: 2 }),
      closed,
    );
    await assert.rejects(quote(ctx), code('BRANCH_UNAVAILABLE'));
    await assert.rejects(create(ctx, pending), code('BRANCH_UNAVAILABLE'));
    assert.deepEqual(await create(ctx, q, key), created);
    await assert.rejects(
      setOrdering(ctx.edge.pool, ctx.branch, auth, randomUUID(), true, { expected_version: 2 }),
      code('CONFLICT'),
    );
  });
});
test('staff sessions expire, renew and revoke locally; terminal revocation also denies access', async () => {
  await withOrderDesk(async (ctx) => {
    const renewed = await provisionStaff(ctx.edge.pool, ctx.branch, ctx.cashierSetup);
    await assert.rejects(quote(ctx), code('UNAUTHORIZED'));
    await ctx.edge.pool.query(
      "UPDATE staff_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [renewed.session_id],
    );
    await assert.rejects(
      createQuote(ctx.edge.pool, ctx.branch, staffAuth(renewed), ctx.cart),
      code('UNAUTHORIZED'),
    );
    const active = await provisionStaff(ctx.edge.pool, ctx.branch, ctx.cashierSetup);
    await ctx.edge.pool.query('UPDATE local_terminals SET active=false WHERE id=$1', [
      active.terminal_id,
    ]);
    await assert.rejects(
      createQuote(ctx.edge.pool, ctx.branch, staffAuth(active), ctx.cart),
      code('UNAUTHORIZED'),
    );
    await revokeStaff(ctx.edge.pool, ctx.branch, active.staff_id);
    await assert.rejects(
      provisionStaff(ctx.edge.pool, ctx.branch, ctx.cashierSetup),
      code('CONFLICT'),
    );
    await assert.rejects(
      provisionStaff(ctx.edge.pool, ctx.branch, { ...ctx.cashierSetup, role: 'shift_manager' }),
      code('CONFLICT'),
    );
  });
});
test('concurrent cancellation produces one transition/event; stale versions and resurrection are rejected', async () => {
  await withOrderDesk(async (ctx) => {
    const q = await quote(ctx),
      order = await create(ctx, q),
      key = randomUUID(),
      body = { expected_version: 1, reason: 'Changed mind' };
    const cancel = () =>
      cancelLocalOrder(
        ctx.edge.pool,
        ctx.branch,
        staffAuth(ctx.cashier),
        key,
        order.order_id,
        body,
      );
    const [a, b] = await Promise.all([cancel(), cancel()]);
    assert.deepEqual(a, b);
    assert.equal(a.state, 'cancelled');
    assert.equal(a.version, 2);
    await assert.rejects(
      cancelLocalOrder(
        ctx.edge.pool,
        ctx.branch,
        staffAuth(ctx.manager),
        randomUUID(),
        order.order_id,
        body,
      ),
      code('CONFLICT'),
    );
    await assert.rejects(
      ctx.edge.pool.query(
        "UPDATE local_orders SET state='awaiting_payment',version=3,cancellation_reason=NULL WHERE id=$1",
        [order.order_id],
      ),
    );
    assert.equal(
      (
        await ctx.edge.pool.query(
          "SELECT count(*) FROM outbox_events WHERE event_type='order.cancelled'",
        )
      ).rows[0].count,
      '1',
    );
  });
});
test('outbox failure rolls back order, command, audit and sequence; retry creates one order', async () => {
  await withOrderDesk(async (ctx) => {
    const q = await quote(ctx),
      key = randomUUID();
    await ctx.edge.pool
      .query(`CREATE FUNCTION fail_order_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='order.created' THEN RAISE EXCEPTION 'failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER test_failure BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION fail_order_outbox()`);
    await assert.rejects(create(ctx, q, key));
    for (const table of ['local_orders', 'local_order_streams'])
      assert.equal((await ctx.edge.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count, '0');
    assert.equal(
      (
        await ctx.edge.pool.query(
          "SELECT count(*) FROM local_command_results WHERE command_type='order.create'",
        )
      ).rows[0].count,
      '0',
    );
    assert.equal(
      (await ctx.edge.pool.query("SELECT count(*) FROM local_audit WHERE action='order.created'"))
        .rows[0].count,
      '0',
    );
    await ctx.edge.pool.query('DROP TRIGGER test_failure ON outbox_events');
    await create(ctx, q, key);
    assert.equal(
      (await ctx.edge.pool.query('SELECT last_sequence FROM local_order_streams')).rows[0]
        .last_sequence,
      '1',
    );
  });
});
test('database prevents quote mutation, changed order amounts and fake payment/fulfillment success', async () => {
  await withOrderDesk(async (ctx) => {
    const q = await quote(ctx),
      order = await create(ctx, q);
    await assert.rejects(
      ctx.edge.pool.query('UPDATE checkout_quotes SET total_minor=1 WHERE id=$1', [q.quote_id]),
    );
    for (const sql of [
      'UPDATE local_orders SET total_minor=1 WHERE id=$1',
      "UPDATE local_orders SET payment_state='succeeded' WHERE id=$1",
      "UPDATE local_orders SET fulfillment_state='ready' WHERE id=$1",
      'DELETE FROM local_orders WHERE id=$1',
    ])
      await assert.rejects(ctx.edge.pool.query(sql, [order.order_id]));
  });
});
