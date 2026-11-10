import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '@pickchick/database';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { backofficeGrants } from '../../../infra/staging/backoffice-grants.mjs';
import { backofficeSupplyGrants } from '../../../infra/staging/backoffice-supply-grants.mjs';
import {
  Backoffice,
  BackofficeError,
  MANAGER_SHIFT_TEMPLATE_V1,
  STAFF_POSITIONS_V1,
  assignedAt,
} from '../dist/index.js';
import { people } from './consumption-fixture.mjs';

/**
 * Staff assignment of lane bo-ui2 step 5 (staff-assignments.ts; design-bo-ui.md §9.4) on
 * PostgreSQL: flag off = no view, no command, no key, no permission; the stations of the kitchen
 * (KDS codes) and of the positions without a screen; assign, reassign in one transaction, end;
 * one open interval per employee, no overlap; the business day after midnight; the positions with
 * the manager's override; roles; «Расстановка заполнена» in the manager shift; the range read of
 * the time sheet and КД9; the API role with exactly the 076 helper rights. Synthetic data only.
 */
const ON = Object.freeze({
  rolesEnabled: true,
  staffPositionsEnabled: true,
  staffAssignmentEnabled: true,
  managerShiftsEnabled: true,
});
const is = (code, reason) => (error) =>
  error instanceof BackofficeError && error.code === code && error.reason === reason;
const request = (command, reason = 'Синтетическая расстановка') => ({
  request_id: randomUUID(),
  reason,
  command,
});
const count = async (c, table = 'bo_staff_assignments') =>
  (await c.cloud.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
const almaty = (offsetDays = 0) => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};
const next = (day) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
/** An Almaty wall clock instant as ISO (Asia/Almaty is UTC+5 since 01.03.2024). */
const at = (day, time) => new Date(`${day}T${time}:00+05:00`).toISOString();
const assign = (employee, station, day, time, revision = 0, extra = {}) => ({
  type: 'staff_assign',
  employee_id: employee,
  station_code: station,
  business_date: day,
  time,
  expected_revision: revision,
  ...extra,
});
const unassign = (employee, time, revision) => ({
  type: 'staff_unassign',
  employee_id: employee,
  time,
  expected_revision: revision,
});
/** Employee cards with positions (manager, staff positions on). */
async function staff(bo, token, c) {
  const card = async (name, position, extra = [], active = true) => {
    const id = randomUUID();
    await bo.command(
      token,
      c.branch,
      request(
        {
          type: 'save',
          kind: 'employee',
          id,
          expected_revision: 0,
          payload: {
            name,
            role: 'staff',
            active,
            note: '',
            position_code: position,
            ...(extra.length ? { extra_position_codes: extra } : {}),
            pos_access: 'none',
          },
        },
        'Синтетический сотрудник',
      ),
    );
    return id;
  };
  return {
    fryer: await card('Синтетический жарщик', 'fryer'),
    assembler: await card('Синтетический сборщик', 'assembler', ['issue']),
    cashier: await card('Синтетический кассир', 'cashier'),
    away: await card('Синтетический уволенный', 'runner', [], false),
  };
}
const rows = async (c, sql, args = [c.branch]) => (await c.cloud.pool.query(sql, args)).rows;

test('flag off: no view, no command, no key, no permission; without positions NOT_READY', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const s = await staff(
      new Backoffice(c.cloud.pool, true, { staffPositionsEnabled: true }),
      manager.token,
      c,
    );
    const audit = await count(c, 'bo_audit');
    for (const options of [
      {},
      { rolesEnabled: true, staffPositionsEnabled: true, managerShiftsEnabled: true },
    ]) {
      const bo = new Backoffice(c.cloud.pool, true, options);
      const read = await bo.read(manager.token, c.branch);
      assert.equal('staff_assignment' in read.capabilities, false);
      assert.equal((read.permissions ?? []).includes('staff.assign'), false);
      await assert.rejects(
        bo.ops(manager.token, c.branch, 'staff-assignments', { date: almaty() }),
        is('NOT_FOUND'),
      );
      for (const body of [
        assign(s.fryer, 'fryer', almaty(-1), '10:00'),
        unassign(s.fryer, '18:00', 1),
      ])
        await assert.rejects(
          bo.command(manager.token, c.branch, request(body)),
          is('INVALID_REQUEST'),
        );
      if (options.managerShiftsEnabled) {
        const shifts = await bo.ops(manager.token, c.branch, 'manager-shifts', {});
        assert.equal('extra_items' in shifts, false);
        assert.equal('staff_assignment' in shifts.checks, false);
      }
    }
    // The flag without the positions it builds on (loadConfig refuses it): key false, view
    // NOT_READY, commands unknown.
    const alone = new Backoffice(c.cloud.pool, true, { staffAssignmentEnabled: true });
    assert.equal((await alone.read(manager.token, c.branch)).capabilities.staff_assignment, false);
    await assert.rejects(
      alone.ops(manager.token, c.branch, 'staff-assignments', {}),
      is('NOT_READY'),
    );
    await assert.rejects(
      alone.command(
        manager.token,
        c.branch,
        request(assign(s.fryer, 'fryer', almaty(-1), '10:00')),
      ),
      is('INVALID_REQUEST'),
    );
    assert.equal(await count(c), 0);
    assert.equal(await count(c, 'bo_audit'), audit);
  }));

test('stations: the KDS codes of the kitchen, the positions without a screen, by number', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const s = await staff(bo, manager.token, c);
    const v = await bo.ops(manager.token, c.branch, 'staff-assignments', {});
    assert.equal(v.view, 'staff-assignments');
    assert.equal(v.mode, 'day');
    assert.equal(v.night_end, '06:00');
    assert.deepEqual(
      v.stations.map((x) => [x.code, x.label, x.number, x.kds, x.positions, x.active]),
      [
        ['cashier', 'Кассир (1)', 1, null, ['cashier'], true],
        ['issue', 'Выдача (2)', 2, 'issue', ['issue'], true],
        [
          'delivery_handover',
          'Выдача доставки (3)',
          3,
          'delivery_handover',
          ['delivery_handover'],
          true,
        ],
        ['assembly_hall', 'Сборка - зал (стол 1)', 4, 'assembly_hall', ['assembler'], true],
        [
          'assembly_delivery',
          'Сборка - доставка (стол 2)',
          4,
          'assembly_delivery',
          ['assembler'],
          true,
        ],
        ['toasts', 'Тосты и бургеры (5)', 5, 'toasts', ['toasts_fries'], true],
        ['breading', 'Панировка (6)', 6, 'breading', ['breading'], true],
        ['fryer', 'Жарщик (7)', 7, null, ['fryer'], true],
        ['prep', 'Заготовщик (8)', 8, null, ['prep'], true],
        ['runner', 'Раннер (9)', 9, null, ['runner'], true],
      ],
    );
    // Working cards only (by name), with the stations their positions allow.
    assert.deepEqual(
      v.employees.map((e) => [e.employee_id, e.position_code, e.extra_position_codes, e.stations]),
      [
        [s.fryer, 'fryer', [], ['fryer']],
        [s.cashier, 'cashier', [], ['cashier']],
        [s.assembler, 'assembler', ['issue'], ['issue', 'assembly_hall', 'assembly_delivery']],
      ],
    );
    assert.deepEqual(v.intervals, []);
    assert.deepEqual(v.earlier_open, []);
  }));

test('assign, reassign in one transaction, end: revisions, idempotency, audit', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const s = await staff(bo, manager.token, c);
    const D = almaty(-2);
    const run = (body, req = request(body)) => bo.command(manager.token, c.branch, req);
    const first = request(assign(s.assembler, 'assembly_hall', D, '10:00'));
    const opened = await run(null, first);
    assert.equal(opened.changed, true);
    assert.equal(opened.closed, null);
    assert.equal(opened.assignment.started_at, at(D, '10:00'));
    assert.equal(opened.assignment.business_date, D);
    assert.equal(opened.assignment.station_label, 'Сборка - зал (стол 1)');
    assert.equal(opened.assignment.ended_at, null);
    assert.equal(opened.assignment.set_by_name, 'Синтетический управляющий');
    // The same request again: the same answer, nothing new.
    assert.deepEqual(await run(null, first), opened);
    assert.equal(await count(c), 1);
    // A reassignment names the open interval's revision; another revision is a CONFLICT.
    await assert.rejects(run(assign(s.assembler, 'issue', D, '13:30', 0)), is('CONFLICT'));
    await assert.rejects(run(assign(s.assembler, 'issue', D, '13:30', 2)), is('CONFLICT'));
    // Already on that station: nothing changes, no new interval.
    const same = await run(assign(s.assembler, 'assembly_hall', D, '12:00', 1));
    assert.equal(same.changed, false);
    assert.equal(same.assignment.id, opened.assignment.id);
    assert.equal(await count(c), 1);
    // «Переставить с 13:30»: the open interval ends at 13:30 and the new one starts then.
    const moved = await run(assign(s.assembler, 'issue', D, '13:30', 1));
    assert.equal(moved.closed.id, opened.assignment.id);
    assert.equal(moved.closed.ended_at, at(D, '13:30'));
    assert.equal(moved.closed.revision, 2);
    assert.equal(moved.closed.ended_by_name, 'Синтетический управляющий');
    assert.equal(moved.assignment.started_at, at(D, '13:30'));
    assert.equal(moved.assignment.station_code, 'issue');
    // End the assignment at 22:00.
    await assert.rejects(run(unassign(s.assembler, '22:00', 2)), is('CONFLICT'));
    const ended = await run(unassign(s.assembler, '22:00', 1));
    assert.equal(ended.assignment.id, moved.assignment.id);
    assert.equal(ended.assignment.ended_at, at(D, '22:00'));
    // Nothing open any more: ending again is a CONFLICT.
    await assert.rejects(run(unassign(s.assembler, '23:00', 2)), is('CONFLICT'));
    // The history of the day, oldest first.
    const v = await bo.ops(manager.token, c.branch, 'staff-assignments', { date: D });
    assert.deepEqual(
      v.intervals.map((i) => [i.station_code, i.started_at, i.ended_at, i.revision]),
      [
        ['assembly_hall', at(D, '10:00'), at(D, '13:30'), 2],
        ['issue', at(D, '13:30'), at(D, '22:00'), 2],
      ],
    );
    assert.deepEqual(v.counts, { intervals: 2, open: 0, employees: 1 });
    // The audit keeps every change with the state before it.
    const audit = await rows(
      c,
      "SELECT action,entity_id::text e,before_value b,after_value a FROM bo_audit WHERE branch_id=$1 AND action LIKE 'staff_%' ORDER BY created_at,id",
    );
    assert.deepEqual(
      audit.map((r) => r.action),
      ['staff_assign', 'staff_assign', 'staff_assign', 'staff_unassign'],
    );
    assert.equal(audit[0].b, null);
    assert.equal(audit[2].b.id, opened.assignment.id);
    assert.equal(audit[2].e, moved.assignment.id);
    assert.equal(audit[3].a.assignment.ended_at, at(D, '22:00'));
  }));

test('overlap refused: before the open start, inside an earlier interval; nothing is written', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const s = await staff(bo, manager.token, c);
    const D = almaty(-2);
    const run = (body) => bo.command(manager.token, c.branch, request(body));
    await run(assign(s.cashier, 'cashier', D, '10:00'));
    // A reassignment before the start of the open interval.
    await assert.rejects(
      run(assign(s.cashier, 'cashier', D, '09:30', 1)),
      is('CONFLICT', 'ASSIGNMENT_OVERLAP'),
    );
    await run(unassign(s.cashier, '14:00', 1));
    const audit = await count(c, 'bo_audit');
    // A new start inside the closed 10:00-14:00.
    await assert.rejects(
      run(assign(s.cashier, 'cashier', D, '12:00')),
      is('CONFLICT', 'ASSIGNMENT_OVERLAP'),
    );
    // An end before the start of the open interval.
    await run(assign(s.cashier, 'cashier', D, '15:00'));
    await assert.rejects(
      run(unassign(s.cashier, '14:30', 1)),
      is('INVALID_REQUEST', 'ASSIGNMENT_TIME'),
    );
    assert.equal(await count(c), 2);
    assert.equal(await count(c, 'bo_audit'), audit + 1);
    // At 14:00 exactly, right after the closed interval: allowed for another employee's day.
    const v = await bo.ops(manager.token, c.branch, 'staff-assignments', { date: D });
    assert.deepEqual(
      v.intervals.map((i) => [i.started_at, i.ended_at]),
      [
        [at(D, '10:00'), at(D, '14:00')],
        [at(D, '15:00'), null],
      ],
    );
    // One open interval per employee holds in the database as well.
    await assert.rejects(
      c.cloud.pool.query(
        `INSERT INTO bo_staff_assignments(id,branch_id,business_date,employee_id,station_code,started_at,set_by,revision)
         VALUES($1,$2,$3,$4,'cashier',$5,$6,1)`,
        [randomUUID(), c.branch, D, s.cashier, at(D, '20:00'), manager.actor_id],
      ),
      (e) => e?.code === '23505' || e?.code === '23514',
    );
  }));

test('business day: the night after midnight belongs to the day before; earlier days end first', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const s = await staff(bo, manager.token, c);
    const D = almaty(-3);
    const run = (body) => bo.command(manager.token, c.branch, request(body));
    await run(assign(s.fryer, 'fryer', D, '22:00'));
    // 01:30 of the business day D is 01:30 of the next calendar day, still day D.
    const night = await run(assign(s.assembler, 'assembly_delivery', D, '01:30'));
    assert.equal(night.assignment.started_at, at(next(D), '01:30'));
    assert.equal(night.assignment.business_date, D);
    // The reassignment after midnight continues the business day of the open interval.
    const moved = await run(assign(s.assembler, 'assembly_hall', D, '05:59', 1));
    assert.equal(moved.closed.ended_at, at(next(D), '05:59'));
    assert.equal(moved.assignment.started_at, at(next(D), '05:59'));
    // From 06:00 the clock time is the business day itself.
    const morning = await run(assign(s.cashier, 'cashier', D, '06:00'));
    assert.equal(morning.assignment.started_at, at(D, '06:00'));
    const fryer = await run(unassign(s.fryer, '02:15', 1));
    assert.equal(fryer.assignment.ended_at, at(next(D), '02:15'));
    const day = await bo.ops(manager.token, c.branch, 'staff-assignments', { date: D });
    assert.equal(day.intervals.length, 4);
    assert.equal(
      (await bo.ops(manager.token, c.branch, 'staff-assignments', { date: next(D) })).intervals
        .length,
      0,
    );
    // Intervals left open on day D: a new business day starts only after they are ended.
    const E = almaty(-1);
    await assert.rejects(
      run(assign(s.cashier, 'cashier', E, '10:00', 1)),
      is('CONFLICT', 'ASSIGNMENT_PREVIOUS_DAY'),
    );
    const view = await bo.ops(manager.token, c.branch, 'staff-assignments', { date: E });
    assert.deepEqual(
      view.earlier_open.map((i) => [i.employee_id, i.business_date, i.started_at]),
      [
        [s.cashier, D, at(D, '06:00')],
        [s.assembler, D, at(next(D), '05:59')],
      ],
    );
    // The end is a clock time of the interval's own business day.
    await run(unassign(s.cashier, '23:30', 1));
    const fresh = await run(assign(s.cashier, 'cashier', E, '10:00'));
    assert.equal(fresh.assignment.business_date, E);
    assert.equal(fresh.assignment.started_at, at(E, '10:00'));
    // A night interval ends before 06:00: a later clock time is the day itself, before its start.
    await assert.rejects(
      run(unassign(s.assembler, '07:00', 1)),
      is('INVALID_REQUEST', 'ASSIGNMENT_TIME'),
    );
    // More than 5 minutes ahead of the clock is refused.
    await assert.rejects(
      run(assign(s.fryer, 'fryer', almaty(1), '12:00')),
      is('INVALID_REQUEST', 'ASSIGNMENT_TIME'),
    );
    // The default business day: the Almaty day of now minus 6 hours.
    const [{ day: expected }] = await rows(
      c,
      "SELECT (((clock_timestamp() AT TIME ZONE 'Asia/Almaty') - interval '6 hours')::date)::text AS day",
      [],
    );
    const current = await bo.ops(manager.token, c.branch, 'staff-assignments', {});
    assert.equal(current.today, expected);
    assert.equal(current.date, expected);
    assert.equal(current.manager_shift, null);
    // The open manager shift is reported with the view (its own business day).
    const shift = randomUUID();
    await c.cloud.pool.query(
      `INSERT INTO bo_manager_shifts(id,branch_id,business_date,opened_at,opening,template_version,revision,opened_by,updated_at)
       VALUES($1,$2,$3::date,$4,'{"items":[]}',1,1,$5,$4)`,
      [shift, c.branch, E, at(E, '09:00'), manager.actor_id],
    );
    const withShift = await bo.ops(manager.token, c.branch, 'staff-assignments', { date: E });
    assert.deepEqual(withShift.manager_shift, {
      id: shift,
      business_date: E,
      opened_at: at(E, '09:00'),
    });
  }));

test('positions: only the stations of the card unless the manager overrides with a reason', () =>
  withSyncDatabases(async (c) => {
    const { manager, shift } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const s = await staff(bo, manager.token, c);
    const D = almaty(-1);
    const as = (token, body) => bo.command(token, c.branch, request(body));
    // The extra station of a card is allowed.
    await as(shift.token, assign(s.assembler, 'issue', D, '10:00'));
    // Not the cashier's position: refused, also for the shift manager with a reason.
    await assert.rejects(
      as(manager.token, assign(s.cashier, 'fryer', D, '10:00')),
      is('INVALID_REQUEST', 'STATION_NOT_ALLOWED'),
    );
    await assert.rejects(
      as(
        shift.token,
        assign(s.cashier, 'fryer', D, '10:00', 0, { override_reason: 'Жарщик заболел' }),
      ),
      is('FORBIDDEN', 'ROLE_FORBIDDEN'),
    );
    const override = await as(
      manager.token,
      assign(s.cashier, 'fryer', D, '10:05', 0, { override_reason: 'Жарщик заболел' }),
    );
    assert.equal(override.assignment.override_reason, 'Жарщик заболел');
    const v = await bo.ops(shift.token, c.branch, 'staff-assignments', { date: D });
    assert.deepEqual(
      v.intervals.map((i) => [i.employee_id, i.station_code, i.override_reason]),
      [
        [s.assembler, 'issue', null],
        [s.cashier, 'fryer', 'Жарщик заболел'],
      ],
    );
    // Unknown station, a manager without a station, a card that does not work, no card.
    await assert.rejects(
      as(manager.token, assign(s.fryer, 'kitchen', D, '10:00')),
      is('INVALID_REQUEST', 'STATION_UNKNOWN'),
    );
    await assert.rejects(
      as(manager.token, assign(s.fryer, 'shift_manager', D, '10:00')),
      is('INVALID_REQUEST', 'STATION_UNKNOWN'),
    );
    await assert.rejects(
      as(manager.token, assign(s.away, 'runner', D, '10:00')),
      is('INVALID_REQUEST', 'EMPLOYEE_NOT_WORKING'),
    );
    await assert.rejects(
      as(manager.token, assign(randomUUID(), 'runner', D, '10:00')),
      is('NOT_FOUND'),
    );
    // A position switched off: its station takes nobody new; the old interval keeps its name.
    await as(manager.token, {
      type: 'staff_positions_save',
      positions: STAFF_POSITIONS_V1.map((p) => ({ ...p, active: p.code !== 'fryer' })),
      expected_version: 1,
    });
    await assert.rejects(
      as(manager.token, assign(s.fryer, 'fryer', D, '11:00')),
      is('INVALID_REQUEST', 'STATION_UNKNOWN'),
    );
    const after = await bo.ops(manager.token, c.branch, 'staff-assignments', { date: D });
    assert.equal(after.stations.find((x) => x.code === 'fryer').active, false);
    assert.equal(
      after.intervals.find((i) => i.employee_id === s.cashier).station_label,
      'Жарщик (7)',
    );
    assert.equal(after.employees.find((e) => e.employee_id === s.fryer).stations.length, 0);
  }));

test('roles: the manager and the shift manager place people, the accountant and the analyst read', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const s = await staff(bo, p.manager.token, c);
    const D = almaty(-1);
    const permissions = async (who) =>
      (await bo.read(p[who].token, c.branch)).permissions.filter((x) => x.startsWith('staff.'));
    assert.deepEqual(await permissions('manager'), [
      'staff.positions',
      'staff.assign',
      'staff.assign_override',
    ]);
    assert.deepEqual(await permissions('shift'), ['staff.assign']);
    assert.deepEqual(await permissions('accountant'), []);
    assert.deepEqual(await permissions('analyst'), []);
    for (const who of ['manager', 'shift', 'accountant', 'analyst'])
      assert.equal(
        (await bo.ops(p[who].token, c.branch, 'staff-assignments', { date: D })).date,
        D,
        who,
      );
    await bo.command(p.shift.token, c.branch, request(assign(s.fryer, 'fryer', D, '10:00')));
    await bo.command(p.shift.token, c.branch, request(unassign(s.fryer, '15:00', 1)));
    for (const [who, reason] of [
      ['accountant', 'ROLE_FORBIDDEN'],
      ['analyst', undefined],
    ]) {
      await assert.rejects(
        bo.command(p[who].token, c.branch, request(assign(s.cashier, 'cashier', D, '10:00'))),
        is('FORBIDDEN', reason),
        who,
      );
      await assert.rejects(
        bo.command(p[who].token, c.branch, request(unassign(s.fryer, '16:00', 2))),
        is('FORBIDDEN', reason),
        who,
      );
    }
    // Without BACKOFFICE_ROLES_ENABLED the grant decides: the manager writes, the analyst reads.
    const plain = new Backoffice(c.cloud.pool, true, { ...ON, rolesEnabled: false });
    await plain.command(
      p.manager.token,
      c.branch,
      request(assign(s.cashier, 'cashier', D, '10:00')),
    );
    await assert.rejects(
      plain.command(p.analyst.token, c.branch, request(unassign(s.cashier, '12:00', 1))),
      is('FORBIDDEN'),
    );
    assert.equal(await count(c), 2);
  }));

test('manager shift: «Расстановка заполнена» closes the day, with its check and comment', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const s = await staff(bo, manager.token, c);
    const Y = almaty(-1);
    const shift = randomUUID();
    await c.cloud.pool.query(
      `INSERT INTO bo_manager_shifts(id,branch_id,business_date,opened_at,opening,template_version,revision,opened_by,updated_at)
       VALUES($1,$2,$3::date,$4,'{"items":[]}',1,1,$5,$4)`,
      [shift, c.branch, Y, at(Y, '09:00'), manager.actor_id],
    );
    const view = await bo.ops(manager.token, c.branch, 'manager-shifts', { date: Y });
    assert.deepEqual(view.extra_items, {
      opening: [],
      closing: [
        {
          code: 'staff_assignment',
          label: 'Расстановка заполнена',
          auto: 'staff_assignment',
          required: true,
        },
      ],
    });
    assert.equal(Object.keys(view).at(-1), 'extra_items');
    assert.equal(Object.keys(view.checks).at(-1), 'staff_assignment');
    assert.deepEqual(view.checks.staff_assignment, {
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
    });
    const closing = MANAGER_SHIFT_TEMPLATE_V1.closing.map((i) => ({
      code: i.code,
      status: 'done',
      comment: null,
    }));
    const close = (items) =>
      bo.command(
        manager.token,
        c.branch,
        request({
          type: 'manager_shift_close',
          id: shift,
          items,
          handover: 'Смену принял синтетический менеджер',
          expected_revision: 1,
        }),
      );
    // The item is required; a problem needs a comment.
    await assert.rejects(close(closing), is('INVALID_REQUEST', 'CHECKLIST_INCOMPLETE'));
    await assert.rejects(
      close([...closing, { code: 'staff_assignment', status: 'done', comment: null }]),
      is('INVALID_REQUEST', 'CHECKLIST_INCOMPLETE'),
    );
    await bo.command(manager.token, c.branch, request(assign(s.fryer, 'fryer', Y, '10:00')));
    // The cashier is in the published schedule of the day and not placed yet: a problem with
    // his name (the schedule as «Явка по графику» reads it).
    await c.cloud.pool.query(
      `INSERT INTO bo_workforce_records(id,branch_id,kind,employee_id,revision,payload)
       VALUES($1,$2,'plan',$3,1,$4)`,
      [
        randomUUID(),
        c.branch,
        s.cashier,
        { status: 'published', start: at(Y, '10:00'), end: at(Y, '22:00') },
      ],
    );
    const planned = (await bo.ops(manager.token, c.branch, 'manager-shifts', { date: Y })).checks
      .staff_assignment;
    assert.equal(planned.status, 'problem');
    assert.deepEqual(planned.facts.missing, ['Синтетический кассир']);
    assert.equal(planned.facts.missing_count, 1);
    await bo.command(manager.token, c.branch, request(assign(s.cashier, 'cashier', Y, '10:00')));
    const checked = (await bo.ops(manager.token, c.branch, 'manager-shifts', { date: Y })).checks
      .staff_assignment;
    assert.equal(checked.status, 'ok');
    assert.deepEqual(
      [
        checked.facts.intervals,
        checked.facts.employees,
        checked.facts.open,
        checked.facts.stations,
        checked.facts.missing_count,
      ],
      [2, 2, 2, 2, 0],
    );
    const closed = await close([
      ...closing,
      { code: 'staff_assignment', status: 'done', comment: null },
    ]);
    assert.equal(closed.state, 'closed');
    const stored = closed.closing.items.at(-1);
    assert.equal(stored.code, 'staff_assignment');
    assert.equal(stored.label, 'Расстановка заполнена');
    assert.equal(stored.check.status, 'ok');

    // Step 6 (step 5 notDone): rollback. With the flag switched off after the close, the closed
    // shift reads back exactly as it was stored (the answer, its label and its check snapshot);
    // only the extra item and its live check of the open day are gone.
    const onRead = await bo.ops(manager.token, c.branch, 'manager-shifts', { date: Y });
    const off = new Backoffice(c.cloud.pool, true, { ...ON, staffAssignmentEnabled: false });
    const offRead = await off.ops(manager.token, c.branch, 'manager-shifts', { date: Y });
    const mine = (view) => view.shifts.find((x) => x.id === shift);
    assert.deepEqual(mine(offRead), mine(onRead));
    assert.deepEqual(mine(offRead).closing.items.at(-1), stored);
    assert.equal('extra_items' in offRead, false);
    assert.equal('staff_assignment' in offRead.checks, false);
    // The intervals stay in the table; the view and the commands answer like unknown ones.
    assert.equal(await count(c), 2);
    await assert.rejects(
      off.ops(manager.token, c.branch, 'staff-assignments', { date: Y }),
      is('NOT_FOUND', undefined),
    );
  }));

test('range: the read of the time sheet and КД9, compact, filtered, at most 92 days', () =>
  withSyncDatabases(async (c) => {
    const { manager, analyst } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const s = await staff(bo, manager.token, c);
    const D = almaty(-4),
      E = almaty(-3);
    const run = (body) => bo.command(manager.token, c.branch, request(body));
    await run(assign(s.assembler, 'assembly_hall', D, '10:00'));
    await run(assign(s.assembler, 'assembly_delivery', D, '15:00', 1));
    await run(unassign(s.assembler, '23:00', 1));
    await run(assign(s.fryer, 'fryer', E, '10:00'));
    const range = await bo.ops(analyst.token, c.branch, 'staff-assignments', {
      start_date: D,
      end_date: E,
    });
    assert.equal(range.mode, 'range');
    assert.deepEqual(Object.keys(range.intervals[0]), [
      'id',
      'employee_id',
      'station_code',
      'business_date',
      'started_at',
      'ended_at',
    ]);
    assert.deepEqual(
      range.intervals.map((i) => [i.station_code, i.started_at, i.ended_at]),
      [
        ['assembly_hall', at(D, '10:00'), at(D, '15:00')],
        ['assembly_delivery', at(D, '15:00'), at(D, '23:00')],
        ['fryer', at(E, '10:00'), null],
      ],
    );
    assert.deepEqual(range.employees.map((e) => e.name).sort(), [
      'Синтетический жарщик',
      'Синтетический сборщик',
    ]);
    const table2 = await bo.ops(analyst.token, c.branch, 'staff-assignments', {
      start_date: D,
      end_date: E,
      station_code: 'assembly_delivery',
    });
    assert.deepEqual(
      table2.intervals.map((i) => i.employee_id),
      [s.assembler],
    );
    // КД9 on the server: who stood at the delivery table at 16:00 of day D.
    assert.deepEqual(
      (await assignedAt(c.cloud.pool, c.branch, 'assembly_delivery', new Date(at(D, '16:00')))).map(
        (r) => r.employee_id,
      ),
      [s.assembler],
    );
    assert.deepEqual(
      await assignedAt(c.cloud.pool, c.branch, 'assembly_delivery', new Date(at(D, '23:00'))),
      [],
    );
    for (const input of [
      { start_date: almaty(-100), end_date: E },
      { start_date: E, end_date: D },
      { date: D, start_date: D, end_date: E },
      { start_date: D },
      { date: D, station_code: 'fryer' },
      { date: '2023-12-31' },
    ])
      await assert.rejects(
        bo.ops(analyst.token, c.branch, 'staff-assignments', input),
        is('INVALID_REQUEST'),
        JSON.stringify(input),
      );
  }));

async function withRole(c, run) {
  const schema = c.cloud.schema;
  const role = 'bo_sa_' + randomUUID().replaceAll('-', '');
  let pool;
  await c.cloud.admin.query(
    `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
  );
  try {
    await c.cloud.pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await c.cloud.pool.query(backofficeGrants(role, true));
    const url = new URL(c.cloud.config.databaseUrl);
    url.searchParams.set('options', `-c search_path=${schema} -c role=${role}`);
    pool = createPool(url.toString());
    await run({ role, schema, pool });
  } finally {
    await pool?.end();
    await c.cloud.admin.query(`DROP OWNED BY ${role}`);
    await c.cloud.admin.query(`DROP ROLE ${role}`);
  }
}
const OFF = { backoffice: true, supply: false, stockReports: false, staffAssignment: false };

test('API role: NOT_READY without the 076 helper rights, the assignment with exactly them', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const options = {
      rolesEnabled: true,
      staffPositionsEnabled: true,
      staffAssignmentEnabled: true,
    };
    const s = await staff(new Backoffice(c.cloud.pool, true, options), manager.token, c);
    await withRole(c, async ({ role, schema, pool }) => {
      const bo = new Backoffice(pool, true, options);
      const run = (body) => bo.command(manager.token, c.branch, request(body));
      const read = await bo.read(manager.token, c.branch);
      assert.equal(read.capabilities.staff_assignment, false);
      assert.equal(read.permissions.includes('staff.assign'), false);
      await assert.rejects(
        bo.ops(manager.token, c.branch, 'staff-assignments', {}),
        is('NOT_READY'),
      );
      await assert.rejects(run(assign(s.fryer, 'fryer', almaty(-1), '10:00')), is('NOT_READY'));
      await c.cloud.pool.query(
        backofficeSupplyGrants(role, { ...OFF, staffAssignment: true }, schema),
      );
      const on = await bo.read(manager.token, c.branch);
      assert.equal(on.capabilities.staff_assignment, true);
      assert.deepEqual(on.permissions.slice(-2), ['staff.assign', 'staff.assign_override']);
      await run(assign(s.fryer, 'fryer', almaty(-1), '10:00'));
      await run(unassign(s.fryer, '18:00', 1));
      assert.equal(
        (await bo.ops(manager.token, c.branch, 'staff-assignments', { date: almaty(-1) })).intervals
          .length,
        1,
      );
      // The role never deletes; the helper off again: NOT_READY, the rows stay.
      await assert.rejects(
        pool.query('DELETE FROM bo_staff_assignments'),
        (e) => e?.code === '42501',
      );
      await c.cloud.pool.query(backofficeSupplyGrants(role, OFF, schema));
      await assert.rejects(
        bo.ops(manager.token, c.branch, 'staff-assignments', {}),
        is('NOT_READY'),
      );
      assert.equal(await count(c), 1);
    });
  }));
