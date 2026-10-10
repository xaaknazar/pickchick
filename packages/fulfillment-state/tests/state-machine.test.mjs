import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ORDER_STATES,
  TASK_STATES,
  KITCHEN_ACTIONS,
  acceptsWork,
  blocksCancel,
  replayDecision,
  checkVersion,
  commandShape,
  planTask,
  planCompleteStation,
  planReady,
  planHandoff,
  guardConfirmCancel,
  planConfirmCancel,
} from '../dist/index.js';

// Independent, declarative statement of the edge behaviour (packages/edge-fulfillment, before S1).
const WORK = new Set(['accepted', 'in_production']);
const TASK_TABLE = {
  start_task: { orders: WORK, from: 'queued', to: 'in_progress', order: 'in_production' },
  complete_task: { orders: WORK, from: 'in_progress', to: 'done', order: 'in_production' },
  confirm_stop: {
    orders: new Set(['cancel_requested']),
    from: 'cancel_requested',
    to: 'cancelled',
    order: 'cancel_requested',
  },
};
const rejected = (code) => ({ ok: false, code });
const ids = ['a', 'b', 'c'];
/** Every list of 0..max task states (with repetition), in order. */
function* lists(max) {
  yield [];
  for (let n = 1; n <= max; n++) {
    const index = Array(n).fill(0);
    for (;;) {
      yield index.map((i) => TASK_STATES[i]);
      let k = n - 1;
      while (k >= 0 && ++index[k] === TASK_STATES.length) index[k--] = 0;
      if (k < 0) break;
    }
  }
}

test('state vocabularies are the edge database vocabularies', () => {
  assert.deepEqual(ORDER_STATES, [
    'held',
    'accepted',
    'in_production',
    'ready',
    'handed_over',
    'cancel_requested',
    'cancelled',
    'released',
  ]);
  assert.deepEqual(TASK_STATES, ['queued', 'in_progress', 'done', 'cancel_requested', 'cancelled']);
  assert.deepEqual(KITCHEN_ACTIONS, [
    'start_task',
    'complete_task',
    'complete_station',
    'confirm_stop',
    'ready',
    'handoff',
    'confirm_cancel',
  ]);
  for (const s of ORDER_STATES) assert.equal(acceptsWork(s), WORK.has(s));
  for (const s of TASK_STATES)
    assert.equal(blocksCancel(s), ['queued', 'in_progress', 'cancel_requested'].includes(s));
});

test('idempotent replay: same request replays, another body conflicts, new id executes', () => {
  assert.equal(replayDecision(undefined, 'h1'), 'execute');
  assert.equal(replayDecision('h1', 'h1'), 'replay');
  assert.equal(replayDecision('h1', 'h2'), 'conflict');
  assert.deepEqual(checkVersion(3, 3), { ok: true, value: undefined });
  assert.deepEqual(checkVersion(3, 2), rejected('CONFLICT'));
  assert.deepEqual(checkVersion(3, 4), rejected('CONFLICT'));
});

test('command shape: every action x every optional field combination', () => {
  const fields = {
    stationId: 's',
    taskId: 't',
    expectedTaskVersion: 1,
    reason: 'r',
    inventoryDisposition: 'recorded_elsewhere',
  };
  const names = Object.keys(fields);
  for (const action of KITCHEN_ACTIONS)
    for (let mask = 0; mask < 1 << names.length; mask++) {
      const command = { action };
      for (const [i, name] of names.entries()) if (mask & (1 << i)) command[name] = fields[name];
      const has = (name) => name in command;
      let expected;
      if (action !== 'complete_station' && has('stationId')) expected = rejected('INVALID');
      else if (action === 'complete_station')
        expected =
          has('stationId') && names.filter(has).length === 1
            ? { ok: true, value: { kind: 'station', stationId: 's' } }
            : rejected('INVALID');
      else if (TASK_TABLE[action])
        // Task actions ignore reason/disposition, exactly as the edge did.
        expected =
          has('taskId') && has('expectedTaskVersion')
            ? {
                ok: true,
                value: { kind: 'task', action, taskId: 't', expectedTaskVersion: 1 },
              }
            : rejected('INVALID');
      else
        expected =
          has('taskId') || has('expectedTaskVersion')
            ? rejected('INVALID')
            : { ok: true, value: { kind: 'order', action } };
      assert.deepEqual(commandShape(command), expected, JSON.stringify(command));
    }
});

test('task actions: all order states x task states x version match/mismatch', () => {
  let applied = 0;
  for (const action of Object.keys(TASK_TABLE))
    for (const order of ORDER_STATES)
      for (const state of TASK_STATES)
        for (const expectedTaskVersion of [4, 3, 5]) {
          const task = { id: 't', stationId: 's', state, version: 4 };
          const got = planTask({ action, order, task, expectedTaskVersion });
          const rule = TASK_TABLE[action];
          if (expectedTaskVersion !== 4) assert.deepEqual(got, rejected('CONFLICT'));
          else if (!rule.orders.has(order) || state !== rule.from)
            assert.deepEqual(got, rejected('NOT_READY'), `${action} ${order} ${state}`);
          else {
            applied++;
            assert.deepEqual(got, {
              ok: true,
              value: [
                {
                  kind: 'task',
                  event: 'task_changed',
                  taskId: 't',
                  stationId: 's',
                  from: rule.from,
                  to: rule.to,
                  taskVersion: 5,
                  order: rule.order,
                },
              ],
            });
          }
        }
  // start/complete in accepted+in_production, confirm_stop only in cancel_requested.
  assert.equal(applied, 5);
});

test('complete_station: all order states x assembly/prep x every task mix up to 3+2', () => {
  let cases = 0,
    allowed = 0;
  for (const order of ORDER_STATES)
    for (const assembly of [false, true])
      for (const own of lists(3))
        for (const other of lists(2)) {
          cases++;
          const station = assembly ? 'A' : 'P';
          const tasks = [
            ...own.map((state, i) => ({ id: 'o' + i, stationId: station, state, version: 1 + i })),
            ...other.map((state, i) => ({ id: 'x' + i, stationId: 'X', state, version: 1 })),
          ];
          const got = planCompleteStation({
            order,
            assemblyStationId: 'A',
            stationId: station,
            tasks,
          });
          let expected;
          if (!WORK.has(order)) expected = rejected('NOT_READY');
          else if (!assembly && !own.length) expected = rejected('FORBIDDEN');
          else if (assembly && (!tasks.length || other.some((s) => s !== 'done')))
            expected = rejected('NOT_READY');
          else if (own.some((s) => !['queued', 'in_progress', 'done'].includes(s)))
            expected = rejected('NOT_READY');
          else if (!assembly && own.every((s) => s === 'done')) expected = rejected('NOT_READY');
          if (expected) {
            assert.deepEqual(got, expected, JSON.stringify({ order, assembly, own, other }));
            continue;
          }
          allowed++;
          assert.ok(got.ok);
          const steps = got.value;
          // One event and one aggregate version per step; queued tasks pass through in_progress.
          const expectedSteps =
            own.filter((s) => s === 'queued').length * 2 +
            own.filter((s) => s === 'in_progress').length +
            (assembly ? 1 : 0);
          assert.equal(steps.length, expectedSteps);
          for (const [i, state] of own.entries()) {
            const mine = steps.filter((s) => s.kind === 'task' && s.taskId === 'o' + i);
            const path = { queued: ['in_progress', 'done'], in_progress: ['done'], done: [] }[
              state
            ];
            assert.deepEqual(
              mine.map((s) => [s.from, s.to, s.taskVersion, s.order, s.stationId]),
              path.map((to, k) => [
                k ? path[k - 1] : state,
                to,
                1 + i + k + 1,
                'in_production',
                station,
              ]),
            );
          }
          assert.ok(steps.every((s) => s.kind === 'order' || !s.taskId.startsWith('x')));
          const last = steps.at(-1);
          if (assembly) assert.deepEqual(last, { kind: 'order', event: 'ready', order: 'ready' });
          else assert.equal(last.order, 'in_production');
        }
  assert.equal(cases, ORDER_STATES.length * 2 * (1 + 5 + 25 + 125) * (1 + 5 + 25));
  assert.ok(allowed > 0);
});

test('ready and handoff: all order states x every task mix up to 3', () => {
  for (const order of ORDER_STATES) {
    for (const states of lists(3)) {
      const tasks = states.map((state, i) => ({ id: 't' + i, stationId: 's', state, version: 1 }));
      const ok = WORK.has(order) && states.length > 0 && states.every((s) => s === 'done');
      assert.deepEqual(
        planReady({ order, tasks }),
        ok
          ? { ok: true, value: [{ kind: 'order', event: 'ready', order: 'ready' }] }
          : rejected('NOT_READY'),
      );
    }
    assert.deepEqual(
      planHandoff({ order }),
      order === 'ready'
        ? { ok: true, value: [{ kind: 'order', event: 'handed_over', order: 'handed_over' }] }
        : rejected('NOT_READY'),
    );
  }
});

test('confirm_cancel: role first, then state/reason/disposition, then stopped tasks', () => {
  for (const order of ORDER_STATES)
    for (const manager of [false, true])
      for (const reason of [undefined, '', 'r'])
        for (const inventoryDisposition of [undefined, 'requires_inventory_review'])
          for (const states of lists(2)) {
            const input = {
              order,
              manager,
              reason,
              inventoryDisposition,
              tasks: states.map((state, i) => ({ id: ids[i], stationId: 's', state, version: 1 })),
            };
            let expected;
            if (!manager) expected = rejected('FORBIDDEN');
            else if (order !== 'cancel_requested' || !reason || !inventoryDisposition)
              expected = rejected('NOT_READY');
            assert.deepEqual(guardConfirmCancel(input), expected ?? { ok: true, value: undefined });
            if (
              !expected &&
              states.some((s) => ['queued', 'in_progress', 'cancel_requested'].includes(s))
            )
              expected = rejected('NOT_READY');
            assert.deepEqual(
              planConfirmCancel(input),
              expected ?? {
                ok: true,
                value: [{ kind: 'order', event: 'cancelled', order: 'cancelled' }],
              },
            );
          }
});

test('terminal order states accept no kitchen command', () => {
  for (const order of ['held', 'handed_over', 'cancelled', 'released']) {
    const tasks = TASK_STATES.map((state, i) => ({
      id: 't' + i,
      stationId: 'A',
      state,
      version: 1,
    }));
    for (const task of tasks)
      for (const action of Object.keys(TASK_TABLE))
        assert.equal(planTask({ action, order, task, expectedTaskVersion: 1 }).ok, false);
    assert.equal(
      planCompleteStation({ order, assemblyStationId: 'A', stationId: 'A', tasks }).ok,
      false,
    );
    assert.equal(planReady({ order, tasks }).ok, false);
    assert.equal(planHandoff({ order }).ok, false);
    assert.equal(
      planConfirmCancel({ order, manager: true, reason: 'r', inventoryDisposition: 'x', tasks: [] })
        .ok,
      false,
    );
  }
});
