import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createPool } from '@pickchick/database';
import { EdgeFulfillment } from '../dist/index.js';
import { fixture } from './fixture.mjs';

// Control only scheduling; every SQL statement/auth/action still reaches the
// genuine isolated PostgreSQL schema. No result or credential is stubbed.
function pauseAfterQuery(pool, matches) {
  const reached = Promise.withResolvers(),
    resume = Promise.withResolvers();
  let paused = false;
  return {
    reached: reached.promise,
    resume: () => resume.resolve(),
    pool: {
      async connect() {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, key) {
            if (key === 'query')
              return async (...args) => {
                const result = await target.query(...args);
                if (!paused && matches(args[0], args[1])) {
                  paused = true;
                  reached.resolve();
                  await resume.promise;
                }
                return result;
              };
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    },
  };
}
function boundedPool(f) {
  const url = new URL(f.url);
  url.searchParams.set('options', url.searchParams.get('options') + ' -c lock_timeout=750ms');
  return createPool(url.toString(), 4);
}
const settled = (promise) =>
  promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
const mustSucceed = (result) => {
  if (result.error) throw result.error;
  return result.value;
};

for (const terminal of ['handoff', 'cancel']) {
  test(
    `KDS snapshot remains coherent when ${terminal} commits between ID and task reads`,
    { timeout: 10000 },
    () =>
      fixture(async (f) => {
        const accepted = await f.accepted();
        let before = accepted.order;
        if (terminal === 'handoff')
          before = await f.act(await f.complete(before), 'ready', f.packer);
        const expected = await f.read(before.orderId);
        const gate = pauseAfterQuery(f.pool, (sql) =>
          sql.startsWith('SELECT r.order_id FROM fulfillment_reservations'),
        );
        const pending = settled(
          new EdgeFulfillment(gate.pool).listKitchen(f.scope.branchId, f.manager.auth),
        );
        try {
          await Promise.race([
            gate.reached,
            pending.then((result) => {
              mustSucceed(result);
              assert.fail('Reader did not reach the query barrier');
            }),
          ]);
          if (terminal === 'handoff') await f.act(before, 'handoff', f.packer);
          else await f.repo.acceptCloud(f.scope, f.cancel(before));
          gate.resume();
          const page = mustSucceed(await pending);
          const item = page.items.find((row) => row.orderId === before.orderId);
          assert.ok(item, 'Order belongs to the snapshot taken before the terminal commit');
          assert.equal(item.state, expected.state);
          assert.equal(item.version, expected.version);
          assert.deepEqual(item.tasks, expected.tasks);
          assert.equal(
            (await f.repo.listKitchen(f.scope.branchId, f.manager.auth)).items.length,
            0,
            'Next snapshot must observe the terminal commit',
          );
        } finally {
          gate.resume();
          await pending;
        }
      }),
  );
}

test(
  'KDS polling neither waits for a locked order nor holds another order against its cook',
  { timeout: 10000 },
  () =>
    fixture(async (f) => {
      const accepted = [await f.accepted(), await f.accepted()].sort((a, b) =>
        a.order.orderId.localeCompare(b.order.orderId),
      );
      const first = await f.read(accepted[0].order.orderId),
        second = accepted[1].order;
      const bounded = boundedPool(f),
        writer = new EdgeFulfillment(bounded);
      const blocker = await f.pool.connect();
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT order_id FROM fulfillment_reservations WHERE order_id=$1 FOR UPDATE',
        [second.orderId],
      );
      const gate = pauseAfterQuery(
        bounded,
        (sql, values) =>
          sql.startsWith('SELECT * FROM fulfillment_tasks') && values[1] === first.orderId,
      );
      const pending = settled(
        new EdgeFulfillment(gate.pool).listKitchen(f.scope.branchId, f.manager.auth),
      );
      try {
        await Promise.race([
          gate.reached,
          pending.then((result) => {
            mustSucceed(result);
            assert.fail('Reader did not inspect first order');
          }),
        ]);
        const changed = await writer.act(f.scope.branchId, f.manager.auth, {
          commandId: randomUUID(),
          orderId: first.orderId,
          expectedVersion: first.version,
          action: 'start_task',
          taskId: first.tasks[0].id,
          expectedTaskVersion: 1,
        });
        assert.equal(changed.state, 'in_production');
        gate.resume();
        // The second row remains exclusively locked here. Snapshot reading must
        // finish; old FOR UPDATE instead hits the real PostgreSQL lock_timeout.
        const page = mustSucceed(await pending);
        assert.equal(page.items.length, 2);
        assert.equal(page.items.find((row) => row.orderId === first.orderId).state, 'accepted');
        assert.equal(page.items.find((row) => row.orderId === second.orderId).state, 'accepted');
      } finally {
        gate.resume();
        await blocker.query('ROLLBACK');
        blocker.release();
        await pending;
        await bounded.end();
      }
    }),
);

test(
  'single-order inspection uses the committed snapshot without waiting for an order writer',
  { timeout: 10000 },
  () =>
    fixture(async (f) => {
      const { order } = await f.accepted(),
        expected = await f.read(order.orderId);
      const blocker = await f.pool.connect(),
        bounded = boundedPool(f);
      await blocker.query('BEGIN');
      await blocker.query(
        "UPDATE fulfillment_reservations SET state='in_production',version=version+1 WHERE order_id=$1",
        [order.orderId],
      );
      try {
        const actual = await new EdgeFulfillment(bounded).readOrder(
          f.scope.branchId,
          f.manager.auth,
          order.orderId,
        );
        assert.deepEqual(actual, expected);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await bounded.end();
      }
    }),
);
