// Cutover KDS (contracts sections 5.2, 5.4): complete_station of an assembly table also closes the
// tasks whose upstreamOf is that table (toasts of station 5), without a new event kind. The old
// vectors (state-machine.test.mjs) stay as they were; this file adds the cascade vectors and
// proves exhaustively that tasks without upstreamOf decide exactly as the D0 machine did.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ORDER_STATES, TASK_STATES, planCompleteStation } from '../dist/index.js';

/** Frozen copy of planCompleteStation at D0 (5b212949). Never update it. */
function d0PlanCompleteStation({ order, assemblyStationId, stationId, tasks }) {
  if (order !== 'accepted' && order !== 'in_production') return { ok: false, code: 'NOT_READY' };
  const own = tasks.filter((task) => task.stationId === stationId);
  const assembly = stationId === assemblyStationId;
  if (!assembly && !own.length) return { ok: false, code: 'FORBIDDEN' };
  if (
    assembly &&
    (!tasks.length || tasks.some((task) => task.stationId !== stationId && task.state !== 'done'))
  )
    return { ok: false, code: 'NOT_READY' };
  if (own.some((task) => !['queued', 'in_progress', 'done'].includes(task.state)))
    return { ok: false, code: 'NOT_READY' };
  if (!assembly && own.every((task) => task.state === 'done'))
    return { ok: false, code: 'NOT_READY' };
  const steps = [];
  for (const task of own) {
    if (task.state === 'done') continue;
    const path = task.state === 'queued' ? ['in_progress', 'done'] : ['done'];
    let from = task.state;
    let taskVersion = task.version;
    for (const to of path) {
      taskVersion++;
      steps.push({
        kind: 'task',
        event: 'task_changed',
        taskId: task.id,
        stationId: task.stationId,
        from,
        to,
        taskVersion,
        order: 'in_production',
      });
      from = to;
    }
  }
  if (assembly) steps.push({ kind: 'order', event: 'ready', order: 'ready' });
  return { ok: true, value: steps };
}

const ISSUE = 'station-issue',
  TABLE = 'station-table',
  TOASTS = 'station-toasts';
const task = (id, stationId, state, extra = {}) => ({
  id,
  stationId,
  state,
  version: 3,
  ...extra,
});
const step = (id, stationId, from, to, taskVersion) => ({
  kind: 'task',
  event: 'task_changed',
  taskId: id,
  stationId,
  from,
  to,
  taskVersion,
  order: 'in_production',
});
const complete = (stationId, tasks, order = 'in_production') =>
  planCompleteStation({ order, assemblyStationId: ISSUE, stationId, tasks });

test('table closes its queued and started toasts first, each with the toast station id', () => {
  const tasks = [
    task('table-1', TABLE, 'queued'),
    task('toast-1', TOASTS, 'queued', { upstreamOf: TABLE }),
    task('toast-2', TOASTS, 'in_progress', { upstreamOf: TABLE }),
    task('drink-1', ISSUE, 'queued'),
  ];
  assert.deepEqual(complete(TABLE, tasks), {
    ok: true,
    value: [
      step('toast-1', TOASTS, 'queued', 'in_progress', 4),
      step('toast-1', TOASTS, 'in_progress', 'done', 5),
      step('toast-2', TOASTS, 'in_progress', 'done', 4),
      step('table-1', TABLE, 'queued', 'in_progress', 4),
      step('table-1', TABLE, 'in_progress', 'done', 5),
    ],
  });
  // The table is not the finishing station: no ready step, the drink at issue is untouched.
});

test('done toasts are skipped; a table with only open toasts still closes them', () => {
  assert.deepEqual(
    complete(TABLE, [
      task('table-1', TABLE, 'queued'),
      task('toast-1', TOASTS, 'done', { upstreamOf: TABLE }),
    ]),
    {
      ok: true,
      value: [
        step('table-1', TABLE, 'queued', 'in_progress', 4),
        step('table-1', TABLE, 'in_progress', 'done', 5),
      ],
    },
  );
  assert.deepEqual(
    complete(TABLE, [
      task('table-1', TABLE, 'done'),
      task('toast-1', TOASTS, 'in_progress', { upstreamOf: TABLE }),
    ]),
    { ok: true, value: [step('toast-1', TOASTS, 'in_progress', 'done', 4)] },
  );
  // Nothing left to close: as before, NOT_READY.
  assert.deepEqual(
    complete(TABLE, [
      task('table-1', TABLE, 'done'),
      task('toast-1', TOASTS, 'done', { upstreamOf: TABLE }),
    ]),
    { ok: false, code: 'NOT_READY' },
  );
});

test('the cascade never reaches tasks of another table, the issue counter or a stopped toast', () => {
  const other = 'station-table-2';
  assert.deepEqual(
    complete(TABLE, [
      task('table-1', TABLE, 'queued'),
      task('toast-other', TOASTS, 'queued', { upstreamOf: other }),
      task('drink-1', ISSUE, 'queued'),
    ]),
    {
      ok: true,
      value: [
        step('table-1', TABLE, 'queued', 'in_progress', 4),
        step('table-1', TABLE, 'in_progress', 'done', 5),
      ],
    },
  );
  for (const state of ['cancel_requested', 'cancelled'])
    assert.deepEqual(
      complete(TABLE, [
        task('table-1', TABLE, 'queued'),
        task('toast-1', TOASTS, state, { upstreamOf: TABLE }),
      ]),
      { ok: false, code: 'NOT_READY' },
    );
  // Station 5 completing its own toasts works exactly as any prep station.
  assert.deepEqual(
    complete(TOASTS, [
      task('table-1', TABLE, 'queued'),
      task('toast-1', TOASTS, 'queued', { upstreamOf: TABLE }),
    ]),
    {
      ok: true,
      value: [
        step('toast-1', TOASTS, 'queued', 'in_progress', 4),
        step('toast-1', TOASTS, 'in_progress', 'done', 5),
      ],
    },
  );
  // A stopped order: nothing cascades.
  for (const order of ['held', 'ready', 'handed_over', 'cancel_requested', 'cancelled'])
    assert.deepEqual(complete(TABLE, [task('table-1', TABLE, 'queued')], order).ok, false, order);
});

test('the finishing station waits for the table and its toasts; ready only after all are done', () => {
  const open = [
    task('table-1', TABLE, 'done'),
    task('toast-1', TOASTS, 'in_progress', { upstreamOf: TABLE }),
    task('drink-1', ISSUE, 'queued'),
  ];
  assert.deepEqual(complete(ISSUE, open), { ok: false, code: 'NOT_READY' });
  const closed = open.map((t) => (t.id === 'toast-1' ? { ...t, state: 'done' } : t));
  assert.deepEqual(complete(ISSUE, closed), {
    ok: true,
    value: [
      step('drink-1', ISSUE, 'queued', 'in_progress', 4),
      step('drink-1', ISSUE, 'in_progress', 'done', 5),
      { kind: 'order', event: 'ready', order: 'ready' },
    ],
  });
  // Delivery: the courier counter (3) has no tasks of its own and only makes the order ready.
  assert.deepEqual(
    planCompleteStation({
      order: 'in_production',
      assemblyStationId: 'station-handover',
      stationId: 'station-handover',
      tasks: closed.map((t) => ({ ...t, state: 'done' })),
    }),
    { ok: true, value: [{ kind: 'order', event: 'ready', order: 'ready' }] },
  );
  // A toast upstream of the finishing station itself is closed by it before ready.
  assert.deepEqual(
    complete(ISSUE, [
      task('drink-1', ISSUE, 'done'),
      task('toast-1', TOASTS, 'queued', { upstreamOf: ISSUE }),
    ]),
    {
      ok: true,
      value: [
        step('toast-1', TOASTS, 'queued', 'in_progress', 4),
        step('toast-1', TOASTS, 'in_progress', 'done', 5),
        { kind: 'order', event: 'ready', order: 'ready' },
      ],
    },
  );
});

/** Every list of 0..max task states (with repetition), in order. */
function* stateLists(max) {
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
const STATIONS = [ISSUE, TABLE, TOASTS];

test('without upstreamOf every decision and step equals the D0 machine (exhaustive)', () => {
  let cases = 0;
  for (const order of ORDER_STATES)
    for (const states of stateLists(3))
      for (let placement = 0; placement < STATIONS.length ** states.length; placement++) {
        const tasks = states.map((state, i) =>
          task('t' + i, STATIONS[Math.floor(placement / STATIONS.length ** i) % 3], state, {
            version: i + 1,
          }),
        );
        // Also with the key present but undefined, as a caller may map it.
        const keyed = tasks.map((t) => ({ ...t, upstreamOf: undefined }));
        for (const stationId of STATIONS) {
          const input = { order, assemblyStationId: ISSUE, stationId };
          const expected = d0PlanCompleteStation({ ...input, tasks });
          assert.deepEqual(planCompleteStation({ ...input, tasks }), expected);
          assert.deepEqual(planCompleteStation({ ...input, tasks: keyed }), expected);
          cases++;
        }
      }
  assert.ok(cases > 30000, String(cases));
});

test('with upstreamOf: the cascade equals D0 on the toasts moved to the closing station', () => {
  // Reference: D0 with every upstream task of the closing station counted as its own (first),
  // then the steps of those tasks carry their real station id again. A station that has no own
  // task in the order stays FORBIDDEN, as at D0: upstream tasks alone never make it a member.
  const reference = (input) => {
    const working = input.order === 'accepted' || input.order === 'in_production';
    if (
      working &&
      input.stationId !== input.assemblyStationId &&
      !input.tasks.some((t) => t.stationId === input.stationId)
    )
      return { ok: false, code: 'FORBIDDEN' };
    const upstream = input.tasks.filter(
      (t) => t.stationId !== input.stationId && t.upstreamOf === input.stationId,
    );
    const moved = [
      ...upstream.map((t) => ({ ...t, stationId: input.stationId })),
      ...input.tasks.filter((t) => !upstream.includes(t)),
    ];
    const result = d0PlanCompleteStation({ ...input, tasks: moved });
    if (!result.ok) return result;
    const real = new Map(input.tasks.map((t) => [t.id, t.stationId]));
    return {
      ok: true,
      value: result.value.map((s) =>
        s.kind === 'task' ? { ...s, stationId: real.get(s.taskId) } : s,
      ),
    };
  };
  let cases = 0;
  for (const order of ['accepted', 'in_production', 'ready'])
    for (const states of stateLists(3))
      for (let placement = 0; placement < 9 ** states.length; placement++) {
        // Each task: one of three stations and upstreamOf none / TABLE / ISSUE.
        const tasks = states.map((state, i) => {
          const code = Math.floor(placement / 9 ** i) % 9;
          const upstreamOf = [undefined, TABLE, ISSUE][Math.floor(code / 3)];
          return task('t' + i, STATIONS[code % 3], state, {
            version: i + 1,
            ...(upstreamOf ? { upstreamOf } : {}),
          });
        });
        for (const stationId of STATIONS) {
          const input = { order, assemblyStationId: ISSUE, stationId, tasks };
          assert.deepEqual(planCompleteStation(input), reference(input), JSON.stringify(input));
          cases++;
        }
      }
  assert.ok(cases > 50000, String(cases));
});
