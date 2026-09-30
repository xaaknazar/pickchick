import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, errorCode } from './fixture.mjs';
import { digest } from '../dist/index.js';
import { EdgeEventSchema } from '../../fulfillment-transport/dist/model.js';

const command = (order, stationId) => ({
  commandId: randomUUID(),
  orderId: order.orderId,
  expectedVersion: order.version,
  action: 'complete_station',
  stationId,
});

test('one station receipt completes the whole combo, gates assembly and replays exactly after handoff', () =>
  fixture(async (f) => {
    const { order } = await f.accepted(true);
    const prep = command(order, f.prep);
    await assert.rejects(
      f.repo.act(f.scope.branchId, f.packer.auth, command(order, f.assembly)),
      errorCode('NOT_READY'),
    );
    await assert.rejects(f.repo.act(f.scope.branchId, f.packer.auth, prep), errorCode('FORBIDDEN'));
    await assert.rejects(
      f.repo.act(f.scope.branchId, f.cashier.auth, prep),
      errorCode('FORBIDDEN'),
    );
    const done = await f.repo.act(f.scope.branchId, f.cook.auth, prep);
    const snapshot = await f.read(order.orderId);
    assert.ok(
      snapshot.tasks.filter((t) => t.station_id === f.prep).every((t) => t.state === 'done'),
    );
    assert.ok(
      snapshot.tasks.filter((t) => t.station_id === f.assembly).every((t) => t.state === 'queued'),
    );
    assert.equal(await f.count('fulfillment_commands'), 1);
    assert.deepEqual(await f.repo.act(f.scope.branchId, f.cook.auth, prep), done);
    const ready = await f.repo.act(f.scope.branchId, f.packer.auth, command(done, f.assembly));
    assert.equal(ready.state, 'ready');
    assert.equal((await f.repo.readDisplay(f.scope.branchId)).items[0].state, 'ready');
    await f.act(ready, 'handoff', f.packer);
    assert.deepEqual(await f.repo.act(f.scope.branchId, f.cook.auth, prep), done);
    assert.equal(await f.count('fulfillment_commands'), 3);
    const events = (await f.pool.query('SELECT * FROM fulfillment_outbox ORDER BY sequence')).rows;
    for (const event of events)
      EdgeEventSchema.parse({
        schemaVersion: 1,
        eventId: event.event_id,
        sequence: String(event.sequence),
        orderId: event.order_id,
        aggregateVersion: event.aggregate_version,
        type: event.event_type,
        payload: event.payload,
      });
  }));

test('receipt insertion failure rolls all station tasks, audit and outbox back; same key can then succeed', () =>
  fixture(async (f) => {
    const { order } = await f.accepted(true);
    const before = await f.read(order.orderId),
      events = await f.count('fulfillment_outbox');
    await f.pool.query(
      `CREATE FUNCTION fail_ticket_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END $$; CREATE TRIGGER fail_ticket BEFORE INSERT ON fulfillment_commands FOR EACH ROW EXECUTE FUNCTION fail_ticket_receipt()`,
    );
    const prep = command(order, f.prep);
    await assert.rejects(
      f.repo.act(f.scope.branchId, f.cook.auth, prep),
      /synthetic receipt failure/,
    );
    assert.deepEqual(await f.read(order.orderId), before);
    assert.equal(await f.count('fulfillment_outbox'), events);
    assert.equal(await f.count('fulfillment_commands'), 0);
    await f.pool.query('DROP TRIGGER fail_ticket ON fulfillment_commands');
    assert.equal((await f.repo.act(f.scope.branchId, f.cook.auth, prep)).state, 'in_production');
  }));

test('competing ticket confirmations commit once; cancelled order cannot be completed', () =>
  fixture(async (f) => {
    const { order } = await f.accepted(true);
    const results = await Promise.allSettled(
      [f.cook, f.manager].map((actor) =>
        f.repo.act(f.scope.branchId, actor.auth, command(order, f.prep)),
      ),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'CONFLICT');
    assert.equal(await f.count('fulfillment_commands'), 1);
    const { order: other } = await f.accepted(true);
    await f.repo.acceptCloud(f.scope, f.cancel(other));
    const stopped = await f.read(other.orderId);
    await assert.rejects(
      f.repo.act(f.scope.branchId, f.cook.auth, command(stopped, f.prep)),
      errorCode('NOT_READY'),
    );
  }));

test('kitchen comment comes from the immutable admitted snapshot on both stations', () =>
  fixture(async (f) => {
    const request = f.admission(true);
    request.payload.snapshot.kitchenComment = 'Без лука; подписать пакет';
    request.payload.quoteDigest = digest(request.payload.snapshot);
    const reserved = await f.repo.acceptCloud(f.scope, request);
    const order = await f.repo.acceptCloud(f.scope, f.authorize(request, reserved));
    for (const [actor, stationId] of [
      [f.cook, f.prep],
      [f.packer, f.assembly],
    ]) {
      const queue = await f.repo.listKitchen(f.scope.branchId, actor.auth, { stationId });
      assert.equal(queue.items[0].kitchenComment, request.payload.snapshot.kitchenComment);
    }
    assert.equal(
      (await f.read(order.orderId)).kitchenComment,
      request.payload.snapshot.kitchenComment,
    );
  }));
