import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createEdge } from '@pickchick/edge';
import { provisionStaff, setStop, cancelLocalOrder } from '@pickchick/local-orders';
import { withOrderDesk, staffAuth } from '../helpers/orders.mjs';
import { running } from '../helpers/sync.mjs';
import { PosController, scopeFor } from '../../apps/pos/dist/model.js';
import { ApiError } from '../../apps/pos/dist/api.js';
import { money } from '../../apps/pos/dist/types.js';
import { createPosServer } from '../../apps/pos/server.mjs';

const memory = () => {
  const data = new Map();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
};
function apiFor(url, inspect = () => {}) {
  return async (path, c, o = {}) => {
    inspect(path, c, o);
    const response = await fetch(`${url}/edge/v1/${path}`, {
      method: o.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${c.token}`,
        'X-Staff-Session-Id': c.session_id,
        'Content-Type': 'application/json',
        ...(o.key ? { 'Idempotency-Key': o.key } : {}),
      },
      ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
    });
    const value = await response.json();
    if (!response.ok) throw new ApiError(value.code, response.status);
    return value;
  };
}
async function desk(run) {
  await withOrderDesk(async (ctx) => {
    const edge = await running(createEdge, ctx.edge.config);
    try {
      await run(ctx, edge, apiFor(edge.url));
    } finally {
      await edge.app.close();
    }
  });
}
async function prepared(ctx, api, sessions = memory(), storage = memory()) {
  const controller = new PosController(api, sessions, storage, randomUUID);
  await controller.login(JSON.stringify(ctx.cashier));
  assert.equal(controller.state.error, null);
  controller.quantity(ctx.cart.items[0].variant_id, 2);
  await controller.calculate();
  assert.equal(controller.state.error, null);
  return { controller, sessions, storage };
}
test('real session/role validation, exact integer server quote, no credential in persistent journal', async () => {
  await desk(async (ctx, _edge, api) => {
    const storage = memory(),
      sessions = memory(),
      controller = new PosController(api, sessions, storage, randomUUID);
    await controller.login(JSON.stringify({ ...ctx.cashier, token: '0'.repeat(64) }));
    assert.equal(controller.state.actor, null);
    const kitchen = await provisionStaff(ctx.edge.pool, ctx.branch, ctx.setup('kitchen'));
    await controller.login(JSON.stringify(kitchen));
    assert.equal(controller.state.actor, null);
    assert.equal(controller.state.error.code, 'FORBIDDEN');
    await controller.login(JSON.stringify({ ...ctx.cashier, role: 'shift_manager' }));
    assert.equal(controller.state.actor.role, 'cashier');
    controller.quantity(ctx.cart.items[0].variant_id, 2);
    await controller.calculate();
    assert.equal(controller.state.quote.total_minor, '698000');
    await controller.setOrdering(false);
    assert.equal(controller.state.error.code, 'FORBIDDEN');
    assert.equal(
      (await ctx.edge.pool.query('SELECT ordering_enabled FROM branch_config')).rows[0]
        .ordering_enabled,
      true,
    );
    assert.ok(!JSON.stringify([...storage.data]).includes(ctx.cashier.token));
    controller.logout();
    assert.equal(sessions.data.size, 0);
    assert.equal(controller.state.actor, null);
    assert.equal(money('9223372036854775807'), '92 233 720 368 547 758,07 ₸');
  });
});
test('create commits but response is lost: reload replays identical request and reads current state', async () => {
  await desk(async (ctx, _edge, api) => {
    const requests = [];
    let drop = true;
    const flaky = async (path, c, o) => {
      if (path === 'orders' && o?.method === 'POST') requests.push(globalThis.structuredClone(o));
      const value = await api(path, c, o);
      if (path === 'orders' && o?.method === 'POST' && drop) {
        drop = false;
        throw new ApiError('EDGE_UNREACHABLE');
      }
      return value;
    };
    const { controller, sessions, storage } = await prepared(ctx, flaky);
    await controller.create();
    assert.ok(controller.state.pending);
    const first = controller.state.pending;
    const orderId = (await ctx.edge.pool.query('SELECT id FROM local_orders')).rows[0].id;
    // A manager changes the order while this terminal was waiting for the lost response.
    await cancelLocalOrder(
      ctx.edge.pool,
      ctx.branch,
      staffAuth(ctx.manager),
      randomUUID(),
      orderId,
      { expected_version: 1, reason: 'Synthetic manager cancellation' },
    );
    const reloaded = new PosController(flaky, sessions, storage, randomUUID);
    await reloaded.boot();
    assert.deepEqual(reloaded.state.pending, first);
    await reloaded.create();
    assert.equal(requests.length, 1);
    await reloaded.recover();
    assert.equal(reloaded.state.order.order_id, orderId);
    assert.equal(reloaded.state.order.state, 'cancelled');
    assert.equal(reloaded.state.pending, null);
    assert.deepEqual(requests[1], requests[0]);
    assert.equal(
      (await ctx.edge.pool.query('SELECT count(*) FROM local_orders')).rows[0].count,
      '1',
    );
  });
});
test('expired actor preserves pending journal; wrong actor cannot replay; renewed same identity recovers', async () => {
  await desk(async (ctx, _edge, api) => {
    let drop = true;
    const flaky = async (path, c, o) => {
      const result = await api(path, c, o);
      if (path === 'orders' && o?.method === 'POST' && drop) {
        drop = false;
        throw new ApiError('EDGE_UNREACHABLE');
      }
      return result;
    };
    const { controller, sessions, storage } = await prepared(ctx, flaky);
    await controller.create();
    const pending = globalThis.structuredClone(controller.state.pending);
    const key = `pickchick.pos.journal.v1.${scopeFor(ctx.cashier)}`,
      raw = storage.getItem(key);
    await ctx.edge.pool.query(
      "UPDATE staff_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [ctx.cashier.session_id],
    );
    const reload = new PosController(api, sessions, storage, randomUUID);
    await reload.boot();
    assert.equal(reload.state.actor, null);
    assert.equal(storage.getItem(key), raw);
    const other = await provisionStaff(ctx.edge.pool, ctx.branch, ctx.setup('cashier'));
    await reload.login(JSON.stringify(other));
    assert.equal(reload.state.pending, null);
    assert.equal(storage.getItem(key), raw);
    reload.logout();
    const renewed = await provisionStaff(ctx.edge.pool, ctx.branch, ctx.cashierSetup);
    await reload.login(JSON.stringify(renewed));
    assert.deepEqual(reload.state.pending, pending);
    await reload.recover();
    assert.equal(reload.state.order.state, 'awaiting_payment');
    assert.equal(reload.state.pending, null);
  });
});
test('failed durable write blocks POST, malformed journal blocks recovery, server stop invalidates quote', async () => {
  await desk(async (ctx, _edge, api) => {
    const { controller, storage } = await prepared(ctx, api);
    let posts = 0;
    const apiCount = async (...args) => {
      if (args[0] === 'orders' && args[2]?.method === 'POST') posts++;
      return api(...args);
    };
    const c = new PosController(apiCount, memory(), storage, randomUUID);
    await c.login(JSON.stringify(ctx.cashier));
    await c.calculate();
    const write = storage.setItem;
    storage.setItem = () => {
      throw new Error('quota');
    };
    await c.create();
    assert.equal(posts, 0);
    assert.equal(c.state.storageBlocked, true);
    storage.setItem = write;
    const broken = memory(),
      k = `pickchick.pos.journal.v1.${scopeFor(ctx.cashier)}`;
    broken.setItem(k, '{"pending":');
    const b = new PosController(api, memory(), broken, randomUUID);
    await b.login(JSON.stringify(ctx.cashier));
    assert.equal(b.state.actor, null);
    assert.equal(b.state.error.message, 'STORAGE_DAMAGED');
    assert.equal(broken.getItem(k), '{"pending":');
    await setStop(ctx.edge.pool, ctx.branch, staffAuth(ctx.manager), randomUUID(), {
      variant_id: ctx.cart.items[0].variant_id,
      stopped: true,
      expected_version: 0,
      reason: 'Synthetic stop',
    });
    await controller.create();
    assert.equal(controller.state.error.code, 'ITEM_STOPPED');
    assert.equal(controller.state.pending, null);
    assert.equal(controller.state.quote, null);
    assert.equal(
      (await ctx.edge.pool.query('SELECT count(*) FROM local_orders')).rows[0].count,
      '0',
    );
  });
});
test('cancel persists exact reason and version before request; reload does not apply cancellation twice', async () => {
  await desk(async (ctx, _edge, api) => {
    let drop = true;
    const flaky = async (path, c, o) => {
      const result = await api(path, c, o);
      if (path.endsWith('/cancel') && drop) {
        drop = false;
        throw new ApiError('EDGE_UNREACHABLE');
      }
      return result;
    };
    const { controller, sessions, storage } = await prepared(ctx, flaky);
    await controller.create();
    const id = controller.state.order.order_id;
    await controller.cancel('Синтетическая проверка отмены');
    assert.ok(controller.state.pending);
    const saved = globalThis.structuredClone(controller.state.pending);
    const reloaded = new PosController(flaky, sessions, storage, randomUUID);
    await reloaded.boot();
    assert.deepEqual(reloaded.state.pending, saved);
    await reloaded.recover();
    assert.equal(reloaded.state.order.order_id, id);
    assert.equal(reloaded.state.order.version, 2);
    assert.equal(reloaded.state.order.cancellation_reason, 'Синтетическая проверка отмены');
    assert.equal(reloaded.state.pending, null);
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
test('loopback proxy forwards real auth and rejects cross-origin, arbitrary URLs and unsupported actions', async () => {
  await desk(async (ctx, edge) => {
    const proxy = createPosServer({ edgePort: Number(new URL(edge.url).port) });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${proxy.address().port}`;
    try {
      const headers = {
        Authorization: `Bearer ${ctx.cashier.token}`,
        'X-Staff-Session-Id': ctx.cashier.session_id,
      };
      assert.equal((await fetch(`${url}/edge/v1/session`)).status, 401);
      assert.equal(
        (await (await fetch(`${url}/edge/v1/session`, { headers })).json()).role,
        'cashier',
      );
      assert.equal(
        (
          await fetch(`${url}/edge/v1/session`, {
            headers: { ...headers, Origin: 'https://untrusted.invalid' },
          })
        ).status,
        403,
      );
      for (const path of [
        '/edge/v1/session?token=not-a-token',
        '/edge/v1/orders/x/payments',
        '/edge/v1/http://127.0.0.1/',
      ])
        assert.equal((await fetch(url + path, { headers })).status, 404);
      const response = await fetch(`${url}/`);
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    } finally {
      await new Promise((resolve) => proxy.close(resolve));
    }
  });
});
