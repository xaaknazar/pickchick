import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixture.mjs';
import { EdgeFulfillment } from '../dist/index.js';
const release = (r) => ({
  eventId: randomUUID(),
  type: 'edge.admission_release_requested',
  payload: {
    orderId: r.orderId,
    branchId: r.branchId,
    reservationId: r.reservationId,
    quoteDigest: r.quoteDigest,
    owner: 'cloud',
    expectedVersion: r.version,
    reason: 'Synthetic cancellation',
  },
});
const count = async (f, table) =>
  Number((await f.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
// This wrapper faults only our borrowed client and returns it cleanly to its pool.
function faultPool(pool, condition, after = false) {
  return {
    connect: async () => {
      const c = await pool.connect(),
        original = c.query.bind(c),
        release = c.release.bind(c);
      let fired = false;
      c.query = async (...args) => {
        if (!fired && condition(args[0])) {
          fired = true;
          if (after) await original(...args);
          throw Error('Synthetic connection outcome unknown');
        }
        return original(...args);
      };
      c.release = (...args) => {
        c.query = original;
        release(...args);
      };
      return c;
    },
  };
}
test('SQL failure before COMMIT rolls back state, decision and outbox together; retry applies once', () =>
  fixture(async (f) => {
    const held = await f.repo.acceptCloud(f.scope, f.admission()),
      command = release(held);
    const broken = new EdgeFulfillment(
      faultPool(
        f.pool,
        (sql) =>
          typeof sql === 'string' && sql.startsWith('INSERT INTO fulfillment_release_results'),
      ),
    );
    await assert.rejects(broken.acceptRelease(f.scope, command), /Synthetic/);
    assert.equal(await count(f, 'fulfillment_release_results'), 0);
    assert.equal(await count(f, 'fulfillment_outbox'), 1);
    assert.equal(
      (await f.pool.query('SELECT state FROM fulfillment_reservations')).rows[0].state,
      'held',
    );
    assert.equal((await f.repo.acceptRelease(f.scope, command)).outcome, 'applied');
  }));
test('lost COMMIT response never becomes rejected; retry recovers the durable original applied result', () =>
  fixture(async (f) => {
    const held = await f.repo.acceptCloud(f.scope, f.admission()),
      command = release(held);
    const broken = new EdgeFulfillment(faultPool(f.pool, (sql) => sql === 'COMMIT', true));
    await assert.rejects(broken.acceptRelease(f.scope, command), /Synthetic/);
    assert.equal(await count(f, 'fulfillment_release_results'), 1);
    const result = await f.repo.acceptRelease(f.scope, command);
    assert.equal(result.outcome, 'applied');
    assert.equal(result.version, 2);
    assert.equal(await count(f, 'fulfillment_release_results'), 1);
    assert.equal(await count(f, 'fulfillment_outbox'), 3);
  }));
test('wrong owner or same command ID changed body cannot write a release result; missing legacy decision stays explicit', () =>
  fixture(async (f) => {
    const held = await f.repo.acceptCloud(f.scope, f.admission()),
      command = release(held);
    await assert.rejects(f.repo.acceptRelease({ ...f.scope, deviceId: randomUUID() }, command));
    assert.equal(await count(f, 'fulfillment_release_results'), 0);
    await f.repo.acceptCloud(f.scope, command);
    await assert.rejects(f.repo.acceptRelease(f.scope, command), (e) => e.code === 'CONFLICT');
    assert.equal(
      await count(f, 'fulfillment_release_results'),
      0,
      'do not invent original outcome from later state',
    );
  }));
