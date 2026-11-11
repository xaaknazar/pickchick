// Lane bo-ui2 step 5 «Расстановка» in the cabinet (design-bo-ui §9.4): the allowlists of
// ops/staff-assignments in the cabinet, the operator proxy and the gateway, the parser of the
// view, the grid by station, the texts (every server reason has Russian words, times and the
// night after midnight), the commands and the rights, «Расстановка заполнена» in the manager
// shift checklist and the stations of the time sheet. Pure functions of the built cabinet and
// the core, no PostgreSQL. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { allowedPath, reasonMessage } from '../../apps/backoffice/dist/api.js';
import { allowed } from '../../apps/backoffice/server.mjs';
import {
  ASSIGNMENT_ERRORS,
  ASSIGNMENT_SECTION,
  assignCommand,
  assignmentDayView,
  assignmentRangeView,
  intervalText,
  monthWindow,
  openOf,
  placedOn,
  stationChoices,
  stationGrid,
  stationStrip,
  unassignCommand,
  unassigned,
} from '../../apps/backoffice/dist/assignment-model.js';
import {
  RIGHTS_TEXT,
  commandPermission,
  staffAssignmentAvailable,
} from '../../apps/backoffice/dist/operations-model.js';
import {
  answerProblems,
  checkText,
  shiftChecklist,
} from '../../apps/backoffice/dist/manager-shift-model.js';
import {
  BackofficeErrorReasonSchema,
  P2_COMMAND_PERMISSIONS,
} from '../../packages/backoffice-core/dist/index.js';

const LONG_DASH = /[–—]/;
const branch = randomUUID();
const ids = { a: randomUUID(), b: randomUUID(), c: randomUUID() };
const station = (code, label, number, kds = null, active = true) => ({
  code,
  label,
  number,
  kds,
  positions: [code],
  active,
});
const STATIONS = [
  station('cashier', 'Кассир (1)', 1),
  station('issue', 'Выдача (2)', 2, 'issue'),
  station('assembly_hall', 'Сборка - зал (стол 1)', 4, 'assembly_hall'),
  station('fryer', 'Жарщик (7)', 7, null, false),
];
const interval = (extra) => ({
  id: randomUUID(),
  employee_id: ids.a,
  employee_name: 'Синтетический сборщик',
  station_code: 'assembly_hall',
  station_label: 'Сборка - зал (стол 1)',
  business_date: '2026-11-19',
  started_at: '2026-11-19T05:00:00.000Z',
  ended_at: null,
  set_by_name: 'Синтетический управляющий',
  set_at: '2026-11-19T05:00:01.000Z',
  ended_by_name: null,
  revision: 1,
  override_reason: null,
  ...extra,
});
const day = (extra = {}) => ({
  schema_version: 1,
  branch_id: branch,
  view: 'staff-assignments',
  timezone: 'Asia/Almaty',
  as_of: '2026-11-19T09:00:00.000Z',
  today: '2026-11-19',
  night_end: '06:00',
  manager_shift: null,
  mode: 'day',
  date: '2026-11-19',
  stations: STATIONS,
  employees: [
    {
      employee_id: ids.a,
      name: 'Синтетический сборщик',
      position_code: 'assembly_hall',
      extra_position_codes: ['issue'],
      stations: ['issue', 'assembly_hall'],
    },
    {
      employee_id: ids.b,
      name: 'Синтетический кассир',
      position_code: 'cashier',
      extra_position_codes: [],
      stations: ['cashier'],
    },
    {
      employee_id: ids.c,
      name: 'Синтетический раннер',
      position_code: 'fryer',
      extra_position_codes: [],
      stations: [],
    },
  ],
  intervals: [
    // 10:00-13:30 at the hall table, then from 13:30 at the issue (Almaty, UTC+5).
    interval({
      ended_at: '2026-11-19T08:30:00.000Z',
      ended_by_name: 'Синтетический управляющий',
      revision: 2,
    }),
    interval({
      station_code: 'issue',
      station_label: 'Выдача (2)',
      started_at: '2026-11-19T08:30:00.000Z',
    }),
  ],
  earlier_open: [
    interval({
      employee_id: ids.b,
      employee_name: 'Синтетический кассир',
      station_code: 'cashier',
      station_label: 'Кассир (1)',
      business_date: '2026-11-18',
      started_at: '2026-11-18T13:00:00.000Z',
    }),
  ],
  counts: { intervals: 2, open: 1, employees: 1 },
  limits: { intervals: 500, earlier_open: 200 },
  truncated: { intervals: false },
  ...extra,
});

test('allowlists: a day, or a window with one employee or station, in the cabinet, the proxy and the gateway', async () => {
  const id = randomUUID();
  for (const [path, ok] of Object.entries({
    'staff-assignments': true,
    'staff-assignments?date=2026-11-19': true,
    'staff-assignments?start_date=2026-11-01&end_date=2026-11-30': true,
    [`staff-assignments?start_date=2026-11-01&end_date=2026-11-30&employee_id=${id}`]: true,
    'staff-assignments?start_date=2026-11-01&end_date=2026-11-30&station_code=assembly_hall': true,
    'staff-assignments?date=2026-11-19&station_code=fryer': false,
    'staff-assignments?date=2026-11-19&start_date=2026-11-01&end_date=2026-11-30': false,
    'staff-assignments?start_date=2026-11-01': false,
    'staff-assignments?date=19.11.2026': false,
    'staff-assignments?date=2026-11-19&date=2026-11-20': false,
    'staff-assignments?start_date=2026-11-01&end_date=2026-11-30&employee_id=x': false,
    'staff-assignments?start_date=2026-11-01&end_date=2026-11-30&station_code=Fryer': false,
    'staff-assignments?at=2026-11-19T10:00:00Z': false,
    'staff-assignments/x': false,
    'staff-assignment': false,
  })) {
    assert.equal(allowedPath(`operations/branches/${branch}/ops/${path}`), ok, 'cabinet ' + path);
    assert.equal(
      allowed('GET', `/v1/admin/backoffice/branches/${branch}/ops/${path}`),
      ok,
      'proxy ' + path,
    );
  }
  assert.equal(
    allowed('POST', `/v1/admin/backoffice/branches/${branch}/ops/staff-assignments`),
    false,
  );
  const caddy = await readFile(
    new URL('../../infra/public-staging/gateway.Caddyfile', import.meta.url),
    'utf8',
  );
  const regex = new RegExp(/path_regexp backoffice_get (\S+)/.exec(caddy)[1]);
  assert.equal(regex.test(`/v1/admin/backoffice/branches/${branch}/ops/staff-assignments`), true);
  assert.equal(
    regex.test(`/v1/admin/backoffice/branches/${branch}/ops/staff-assignments/x`),
    false,
  );
});

test('the view: a day and a window; anything else is an invalid answer', () => {
  const v = assignmentDayView(day(), branch);
  assert.equal(v.intervals.length, 2);
  for (const bad of [
    null,
    day({ branch_id: randomUUID() }),
    day({ view: 'staff-roster' }),
    day({ mode: 'range' }),
    day({ stations: null }),
    day({ earlier_open: undefined }),
  ])
    assert.throws(() => assignmentDayView(bad, branch), /INVALID_RESPONSE/);
  const range = {
    ...day(),
    mode: 'range',
    start_date: '2026-11-01',
    end_date: '2026-11-30',
    employees: [{ employee_id: ids.a, name: 'Синтетический сборщик' }],
    intervals: day().intervals.map(
      ({ id, employee_id, station_code, business_date, started_at, ended_at }) => ({
        id,
        employee_id,
        station_code,
        business_date,
        started_at,
        ended_at,
      }),
    ),
  };
  assert.equal(assignmentRangeView(range, branch).intervals.length, 2);
  assert.throws(() => assignmentRangeView(day(), branch), /INVALID_RESPONSE/);
});

test('the grid: active stations and inactive ones with intervals, who stands where, who is free', () => {
  const v = assignmentDayView(day(), branch);
  const grid = stationGrid(v);
  assert.deepEqual(
    grid.map((r) => [r.station.code, r.current.length, r.past.length]),
    [
      ['cashier', 0, 0],
      ['issue', 1, 0],
      ['assembly_hall', 0, 1],
    ],
  );
  // The fryer station (inactive position) appears once it has an interval that day.
  const withFryer = assignmentDayView(
    day({
      intervals: [
        ...day().intervals,
        interval({
          employee_id: ids.c,
          station_code: 'fryer',
          station_label: 'Жарщик (7)',
          override_reason: 'Жарщик заболел',
        }),
      ],
    }),
    branch,
  );
  assert.equal(stationGrid(withFryer).at(-1).station.code, 'fryer');
  // The cashier's open interval of yesterday counts as open; nobody is free but the runner.
  assert.equal(openOf(v, ids.b).business_date, '2026-11-18');
  assert.deepEqual(
    unassigned(v).map((e) => e.employee_id),
    [ids.c],
  );
  const choices = stationChoices(v, v.employees[0]);
  assert.deepEqual(
    [choices.allowed.map((s) => s.code), choices.other.map((s) => s.code)],
    [['issue', 'assembly_hall'], ['cashier']],
  );
});

test('texts: Almaty times, the night after midnight, the time sheet strip, no long dashes', () => {
  const v = assignmentDayView(day(), branch);
  assert.equal(intervalText(v.intervals[0]), '10:00 - 13:30');
  assert.equal(intervalText(v.intervals[1]), 'с 13:30');
  // 01:30 of the night after 18.11 belongs to the business day 18.11.
  assert.equal(
    intervalText({
      business_date: '2026-11-18',
      started_at: '2026-11-18T20:30:00.000Z',
      ended_at: '2026-11-18T22:00:00.000Z',
    }),
    '01:30 (ночь) - 03:00',
  );
  assert.equal(
    intervalText({
      business_date: '2026-11-18',
      started_at: '2026-11-18T17:00:00.000Z',
      ended_at: '2026-11-18T19:30:00.000Z',
    }),
    '22:00 - 00:30 (ночь)',
  );
  const range = {
    stations: STATIONS,
    intervals: v.intervals,
    employees: [],
    truncated: { intervals: false },
  };
  assert.equal(
    stationStrip(range, ids.a, '2026-11-19'),
    'Сборка - зал (стол 1) 10:00 - 13:30; Выдача (2) с 13:30',
  );
  assert.equal(stationStrip(range, ids.b, '2026-11-19'), '');
  assert.deepEqual([...placedOn(range, '2026-11-19')], [ids.a]);
  assert.deepEqual(monthWindow('2026-11-01'), { start: '2026-11-01', end: '2026-11-30' });
  assert.deepEqual(monthWindow('2028-02-01'), { start: '2028-02-01', end: '2028-02-29' });
  for (const text of [...Object.values(ASSIGNMENT_ERRORS), ...ASSIGNMENT_SECTION])
    assert.equal(LONG_DASH.test(text), false, text);
});

test('reasons: every staff assignment reason of the server has its words', () => {
  const ours = [
    'STATION_UNKNOWN',
    'STATION_NOT_ALLOWED',
    'EMPLOYEE_NOT_WORKING',
    'ASSIGNMENT_TIME',
    'ASSIGNMENT_OVERLAP',
    'ASSIGNMENT_PREVIOUS_DAY',
  ];
  for (const reason of ours) {
    assert.equal(BackofficeErrorReasonSchema.safeParse(reason).success, true, reason);
    assert.equal(reasonMessage(reason), ASSIGNMENT_ERRORS[reason], reason);
    assert.equal(LONG_DASH.test(reasonMessage(reason)), false, reason);
  }
});

test('commands and rights: the shapes the server parses, the permission of each', () => {
  assert.deepEqual(assignCommand(ids.a, 'issue', '2026-11-19', '13:30', 1, null), {
    type: 'staff_assign',
    employee_id: ids.a,
    station_code: 'issue',
    business_date: '2026-11-19',
    time: '13:30',
    expected_revision: 1,
  });
  assert.equal(
    assignCommand(ids.c, 'fryer', '2026-11-19', '10:00', 0, '  Жарщик заболел ').override_reason,
    'Жарщик заболел',
  );
  assert.deepEqual(unassignCommand(ids.a, '22:00', 1), {
    type: 'staff_unassign',
    employee_id: ids.a,
    time: '22:00',
    expected_revision: 1,
  });
  for (const type of ['staff_assign', 'staff_unassign'])
    assert.equal(commandPermission({ type }), P2_COMMAND_PERMISSIONS[type][0], type);
  assert.match(RIGHTS_TEXT['staff.assign'], /управляющий и начальник смены/);
  assert.match(RIGHTS_TEXT['staff.assign_override'], /только управляющий/);
  assert.equal(staffAssignmentAvailable({ capabilities: { staff_assignment: true } }), true);
  assert.equal(staffAssignmentAvailable({ capabilities: { staff_assignment: false } }), false);
  assert.equal(staffAssignmentAvailable({ capabilities: {} }), false);
  assert.deepEqual(ASSIGNMENT_SECTION.slice(0, 2), ['assignment', 'Расстановка']);
});

test('manager shift: «Расстановка заполнена» after the template items, its check in words', () => {
  const item = {
    code: 'staff_assignment',
    label: 'Расстановка заполнена',
    auto: 'staff_assignment',
    required: true,
  };
  const template = {
    version: 1,
    opening: [{ code: 'attendance', label: 'Явка', auto: 'attendance', required: true }],
    closing: [{ code: 'waste', label: 'Списания', auto: 'waste', required: true }],
    editable: true,
    updated_at: null,
    updated_by_name: null,
  };
  const view = {
    date: '2026-11-19',
    template,
    open: null,
    open_template: null,
    shifts: [],
    truncated: false,
    checks_date: '2026-11-19',
    checks: {},
  };
  // Without the feature the checklist is the template's (bo-ui).
  assert.deepEqual(shiftChecklist(view), template);
  const extended = shiftChecklist({ ...view, extra_items: { opening: [], closing: [item] } });
  assert.deepEqual(
    extended.closing.map((i) => i.code),
    ['waste', 'staff_assignment'],
  );
  assert.deepEqual(extended.opening, template.opening);
  const problem = {
    status: 'problem',
    facts: {
      intervals: 0,
      employees: 0,
      open: 0,
      stations: 0,
      missing: [],
      missing_count: 0,
      earlier_open: 0,
    },
  };
  assert.match(checkText('staff_assignment', problem), /не заполнена/);
  const ok = {
    status: 'ok',
    facts: {
      intervals: 3,
      employees: 2,
      open: 2,
      stations: 2,
      missing: [],
      missing_count: 0,
      earlier_open: 0,
    },
  };
  assert.equal(
    checkText('staff_assignment', ok),
    'Расставлено: 2 сотрудника на 2 станциях, сейчас на станциях: 2.',
  );
  const missing = {
    status: 'problem',
    facts: { ...ok.facts, missing: ['Синтетический кассир'], missing_count: 1, earlier_open: 1 },
  };
  const text = checkText('staff_assignment', missing);
  assert.match(text, /По графику без станции: Синтетический кассир\./);
  assert.match(text, /Не закрыты интервалы прошлых дней: 1/);
  assert.match(text, /Поясните в комментарии/);
  // The item is required and a problem needs a comment, as the server says.
  assert.deepEqual(
    answerProblems(extended.closing, [{ code: 'waste', status: 'done', comment: null }], {
      staff_assignment: problem,
    }),
    [{ code: 'staff_assignment', problem: 'missing' }],
  );
  assert.deepEqual(
    answerProblems(
      extended.closing,
      [
        { code: 'waste', status: 'done', comment: null },
        { code: 'staff_assignment', status: 'done', comment: null },
      ],
      { staff_assignment: problem },
    ),
    [{ code: 'staff_assignment', problem: 'comment' }],
  );
});
