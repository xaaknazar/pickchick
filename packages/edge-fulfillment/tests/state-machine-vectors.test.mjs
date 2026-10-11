import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  KITCHEN_ACTIONS,
  checkVersion,
  commandShape,
  planCompleteStation,
  planConfirmCancel,
  planHandoff,
  planReady,
  planTask,
} from '@pickchick/fulfillment-state';
import { fixture } from './fixture.mjs';

// Transition vectors (ADR-0014 S1): random kitchen command walks against the real edge
// aggregate in PostgreSQL. Each outcome (error code, version delta, final order/task states,
// outbox event sequence, replay) must equal the shared pure machine's prediction.
const EVENT = {
  task_changed: 'edge.task_changed',
  ready: 'edge.fulfillment_ready',
  handed_over: 'edge.fulfillment_handed_over',
  cancelled: 'edge.fulfillment_cancelled',
};
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const snapshot = (t) => ({ id: t.id, stationId: t.station_id, state: t.state, version: t.version });

function predict(order, command, manager) {
  const version = checkVersion(order.version, command.expectedVersion);
  if (!version.ok) return version;
  const shape = commandShape(command);
  if (!shape.ok) return shape;
  const tasks = order.tasks.map(snapshot);
  if (shape.value.kind === 'station')
    return planCompleteStation({
      order: order.state,
      assemblyStationId: order.assemblyStationId,
      stationId: shape.value.stationId,
      tasks,
    });
  if (shape.value.kind === 'task') {
    const task = tasks.find((t) => t.id === shape.value.taskId);
    if (!task) return { ok: false, code: 'NOT_FOUND' };
    return planTask({
      action: shape.value.action,
      order: order.state,
      task,
      expectedTaskVersion: shape.value.expectedTaskVersion,
    });
  }
  if (shape.value.action === 'confirm_cancel')
    return planConfirmCancel({
      order: order.state,
      manager,
      reason: command.reason,
      inventoryDisposition: command.inventoryDisposition,
      tasks,
    });
  if (shape.value.action === 'ready') return planReady({ order: order.state, tasks });
  return planHandoff({ order: order.state });
}

test('edge kitchen commands equal the shared state machine on random transition walks', (t) =>
  fixture(async (f) => {
    const next = random(20261010);
    const pick = (list) => list[Math.floor(next() * list.length)];
    const chance = (p) => next() < p;
    const outbox = async (orderId) =>
      (
        await f.pool.query(
          'SELECT event_type,aggregate_version FROM fulfillment_outbox WHERE order_id=$1 ORDER BY sequence',
          [orderId],
        )
      ).rows;
    const tally = { applied: 0, rejected: {}, replayed: 0, cloudCancels: 0 };
    const orders = [];
    for (let i = 0; i < 8; i++) orders.push((await f.accepted(i % 3 !== 2)).order.orderId);
    // A held reservation (never authorized) must refuse every kitchen command.
    orders.push((await f.repo.acceptCloud(f.scope, f.admission(true))).orderId);
    for (const orderId of orders)
      for (let step = 0; step < 60; step++) {
        const before = await f.read(orderId);
        if (chance(0.06) && ['accepted', 'in_production', 'ready'].includes(before.state)) {
          // Reach cancel_requested/cancelled via the trusted cloud port.
          await f.repo.acceptCloud(f.scope, f.cancel(before));
          tally.cloudCancels++;
          continue;
        }
        // Half of the commands are plausible for the current state, half are arbitrary.
        const plausible = {
          accepted: ['start_task', 'complete_task', 'complete_station', 'ready'],
          in_production: ['start_task', 'complete_task', 'complete_station', 'ready'],
          ready: ['handoff'],
          cancel_requested: ['confirm_stop', 'confirm_cancel'],
        }[before.state];
        const action = plausible && chance(0.5) ? pick(plausible) : pick(KITCHEN_ACTIONS);
        const command = {
          commandId: randomUUID(),
          orderId,
          expectedVersion:
            chance(0.9) || before.version < 2 ? before.version : before.version + pick([-1, 1]),
          action,
        };
        if (['start_task', 'complete_task', 'confirm_stop'].includes(action)) {
          const from =
            { start_task: 'queued', complete_task: 'in_progress' }[action] ?? 'cancel_requested';
          const eligible = before.tasks.filter((t) => t.state === from);
          const task =
            eligible.length && chance(0.7)
              ? pick(eligible)
              : before.tasks.length && chance(0.95)
                ? pick(before.tasks)
                : null;
          if (chance(0.97)) command.taskId = task ? task.id : randomUUID();
          if (chance(0.97))
            command.expectedTaskVersion =
              task && chance(0.9) ? task.version : 1 + Math.floor(next() * 9);
        }
        if (action === 'complete_station' && chance(0.97))
          command.stationId = pick([f.prep, f.assembly]);
        if (action === 'confirm_cancel') {
          if (chance(0.85)) command.reason = 'Synthetic stop';
          if (chance(0.85)) command.inventoryDisposition = 'recorded_elsewhere';
        }
        if (chance(0.03)) command.stationId = f.prep; // misplaced field
        if (chance(0.03)) command.taskId = before.tasks[0]?.id ?? randomUUID();
        const manager = !(action === 'confirm_cancel' && chance(0.2));
        const actor = manager ? f.manager : f.cook;
        const expected = predict(before, command, manager);
        const eventsBefore = await outbox(orderId);
        let result, error;
        try {
          result = await f.repo.act(f.scope.branchId, actor.auth, command);
        } catch (e) {
          error = e;
        }
        const after = await f.read(orderId);
        const eventsAfter = await outbox(orderId);
        const label = JSON.stringify({
          before: {
            state: before.state,
            tasks: before.tasks.map((t) => [
              t.station_id === f.assembly ? 'A' : 'P',
              t.state,
              t.version,
            ]),
          },
          command,
          expected,
        });
        if (!expected.ok) {
          assert.equal(error?.code, expected.code, label);
          assert.equal(after.version, before.version, label);
          assert.deepEqual(after.tasks, before.tasks, label);
          assert.deepEqual(eventsAfter, eventsBefore, label);
          tally.rejected[expected.code] = (tally.rejected[expected.code] ?? 0) + 1;
          continue;
        }
        assert.equal(error, undefined, label + ' ' + error?.stack);
        tally.applied++;
        const steps = expected.value;
        assert.equal(result.version, before.version + steps.length, label);
        assert.equal(result.state, steps.at(-1).order, label);
        assert.equal(after.state, result.state);
        assert.deepEqual(
          eventsAfter.slice(eventsBefore.length),
          steps.map((s, i) => ({
            event_type: EVENT[s.event],
            aggregate_version: before.version + i + 1,
          })),
          label,
        );
        for (const task of after.tasks) {
          const old = before.tasks.find((t) => t.id === task.id);
          const mine = steps.filter((s) => s.kind === 'task' && s.taskId === task.id);
          assert.equal(task.state, mine.at(-1)?.to ?? old.state, label);
          assert.equal(task.version, mine.at(-1)?.taskVersion ?? old.version, label);
        }
        // Idempotency: the same command id and body replays without a new effect;
        // another body under the same id conflicts.
        if (chance(0.3)) {
          assert.deepEqual(await f.repo.act(f.scope.branchId, actor.auth, command), result);
          await assert.rejects(
            f.repo.act(f.scope.branchId, actor.auth, {
              ...command,
              expectedVersion: command.expectedVersion + 1,
            }),
            (e) => e.code === 'CONFLICT',
          );
          assert.deepEqual(await outbox(orderId), eventsAfter);
          tally.replayed++;
        }
      }
    t.diagnostic(JSON.stringify(tally));
    // The walk must actually exercise success, every guard family and replays.
    assert.ok(tally.applied >= 20, JSON.stringify(tally));
    for (const code of ['INVALID', 'CONFLICT', 'NOT_READY', 'NOT_FOUND', 'FORBIDDEN'])
      assert.ok(tally.rejected[code] > 0, JSON.stringify(tally));
    assert.ok(tally.replayed > 0 && tally.cloudCancels > 0, JSON.stringify(tally));
  }));
