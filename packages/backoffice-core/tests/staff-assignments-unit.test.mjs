import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KDS_STATION_LABELS,
  P2Command,
  P2_COMMAND_FLAGS,
  P2_COMMAND_PERMISSIONS,
  STAFF_ASSIGNMENT_PERMISSIONS,
  STAFF_POSITIONS_V1,
  StaffAssignCommand,
  StaffUnassignCommand,
  assignmentStations,
  can,
  cardStations,
  permissionsOf,
  workingCard,
} from '../dist/index.js';

/**
 * Pure rules of the staff assignment (lane bo-ui2 step 5, staff-assignments.ts): the stations of
 * a list of positions (the KDS codes of contracts §2.3), the stations a card may stand on, the
 * command schemas and the role matrix. Synthetic data only.
 */
const ID = '0b000000-0000-4000-8000-0000000000a1';

test('the KDS stations carry the kitchen codes and the screen names of contracts §2.3', () => {
  assert.deepEqual(Object.keys(KDS_STATION_LABELS).sort(), [
    'assembly_delivery',
    'assembly_hall',
    'breading',
    'delivery_handover',
    'issue',
    'toasts',
  ]);
  const stations = assignmentStations(STAFF_POSITIONS_V1);
  // Every KDS function of the built-in positions is a station; managers have none.
  for (const fn of Object.keys(KDS_STATION_LABELS))
    assert.equal(stations.find((s) => s.code === fn)?.kds, fn);
  assert.equal(
    stations.some((s) => ['manager', 'shift_manager'].includes(s.code)),
    false,
  );
  assert.deepEqual(
    stations.map((s) => s.number),
    [1, 2, 3, 4, 4, 5, 6, 7, 8, 9],
  );
});

test('a branch list: shared functions merge, inactive positions give inactive stations', () => {
  const list = [
    {
      code: 'assembler',
      label: 'Сборщик',
      station: 4,
      kds: ['assembly_hall', 'assembly_delivery'],
      pos_access: 'none',
      active: true,
    },
    {
      code: 'hall_only',
      label: 'Сборщик зала',
      station: 4,
      kds: ['assembly_hall'],
      pos_access: 'none',
      active: true,
    },
    { code: 'helper', label: 'Помощник', station: 4, kds: [], pos_access: 'none', active: true },
    { code: 'old_runner', label: 'Раннер', station: 9, kds: [], pos_access: 'none', active: false },
    {
      code: 'manager',
      label: 'Управляющий',
      station: null,
      kds: [],
      pos_access: 'shift_manager',
      active: true,
    },
  ];
  const stations = assignmentStations(list);
  assert.deepEqual(
    stations.map((s) => [s.code, s.label, s.positions, s.active]),
    [
      ['assembly_hall', 'Сборка - зал (стол 1)', ['assembler', 'hall_only'], true],
      ['assembly_delivery', 'Сборка - доставка (стол 2)', ['assembler'], true],
      ['helper', 'Помощник (4)', ['helper'], true],
      ['old_runner', 'Раннер (9)', ['old_runner'], false],
    ],
  );
  const card = {
    name: 'Синтетический сотрудник',
    active: true,
    position_code: 'hall_only',
    extra_position_codes: ['old_runner', 'helper'],
  };
  // An inactive station is never offered, even through an extra position.
  assert.deepEqual(cardStations(card, stations), ['assembly_hall', 'helper']);
  assert.deepEqual(cardStations({ name: 'Без должности', active: true }, stations), []);
  assert.equal(workingCard(card), true);
  assert.equal(workingCard({ ...card, active: false }), false);
  assert.equal(workingCard({ ...card, deleted: true }), false);
  assert.equal(workingCard({ ...card, employment_status: 'inactive' }), false);
  assert.equal(workingCard({ ...card, employment_status: 'unknown' }), true);
});

test('command schemas: a business day and a clock time, an override reason only with words', () => {
  const base = {
    type: 'staff_assign',
    employee_id: ID,
    station_code: 'fryer',
    business_date: '2026-11-19',
    time: '13:30',
    expected_revision: 0,
  };
  assert.equal(StaffAssignCommand.safeParse(base).success, true);
  assert.equal(P2Command.safeParse(base).success, true);
  for (const bad of [
    { ...base, time: '24:00' },
    { ...base, time: '9:30' },
    { ...base, business_date: '2023-12-31' },
    { ...base, business_date: '2026-02-30' },
    { ...base, station_code: 'Fryer' },
    { ...base, expected_revision: -1 },
    { ...base, override_reason: 'ок' },
    { ...base, override_reason: 'строка\nвторая' },
    { ...base, started_at: '2026-11-19T13:30:00+05:00' },
  ])
    assert.equal(StaffAssignCommand.safeParse(bad).success, false, JSON.stringify(bad));
  assert.equal(
    StaffAssignCommand.safeParse({ ...base, override_reason: '  Жарщик заболел  ' }).data
      .override_reason,
    'Жарщик заболел',
  );
  const end = { type: 'staff_unassign', employee_id: ID, time: '22:00', expected_revision: 1 };
  assert.equal(StaffUnassignCommand.safeParse(end).success, true);
  assert.equal(StaffUnassignCommand.safeParse({ ...end, expected_revision: 0 }).success, false);
  // The step 1 proposal bodies (an instant instead of the day and the time) stay unknown.
  assert.equal(
    StaffUnassignCommand.safeParse({ ...end, ended_at: '2026-11-19T22:00:00+05:00' }).success,
    false,
  );
});

test('rights: staff.assign for the manager and the shift manager, the override for the manager', () => {
  assert.deepEqual(STAFF_ASSIGNMENT_PERMISSIONS, ['staff.assign', 'staff.assign_override']);
  assert.deepEqual(P2_COMMAND_PERMISSIONS.staff_assign, ['staff.assign']);
  assert.deepEqual(P2_COMMAND_PERMISSIONS.staff_unassign, ['staff.assign']);
  assert.deepEqual(P2_COMMAND_FLAGS.staff_assign, [
    'staffAssignmentEnabled',
    'staffPositionsEnabled',
  ]);
  const matrix = Object.fromEntries(
    ['manager', 'shift_manager', 'accountant', 'analyst'].map((role) => [
      role,
      STAFF_ASSIGNMENT_PERMISSIONS.filter((p) => can(role, p)),
    ]),
  );
  assert.deepEqual(matrix, {
    manager: ['staff.assign', 'staff.assign_override'],
    shift_manager: ['staff.assign'],
    accountant: [],
    analyst: [],
  });
  // Listed only while the feature is available, after the supply rights.
  assert.equal(permissionsOf('manager').includes('staff.assign'), false);
  const all = permissionsOf('manager', [], ['suppliers.write', ...STAFF_ASSIGNMENT_PERMISSIONS]);
  assert.deepEqual(all.slice(-3), ['suppliers.write', 'staff.assign', 'staff.assign_override']);
});
