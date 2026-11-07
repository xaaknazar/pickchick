import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import {
  Backoffice,
  BackofficeError,
  ChecklistTemplateSchema,
  Command,
  LEGACY_JOURNAL_LIMIT,
  MANAGER_SHIFT_AUTO,
  MANAGER_SHIFT_TEMPLATE_V1,
  P1Request,
  Request,
  checklistProblems,
  designateBackoffice,
  grantBackoffice,
  managerShiftChecks,
  storedAnswers,
} from '../dist/index.js';
import { at, cashierShift, sale, zReport } from './pos-day-fixture.mjs';

/**
 * Manager shift of lane bo-ui (manager-shifts.ts, manager-shifts-store.ts; design-bo-ui.md 5.6):
 * one open shift per branch, the checklist with its automatic checks, the handover, closed is
 * immutable, the versioned checklist of the branch, the old journal read only, roles and the
 * flag-off behaviour. Synthetic data only.
 */
const is = (code, reason) => (error) =>
  error instanceof BackofficeError && error.code === code && error.reason === reason;
const request = (command, reason = 'Синтетическая смена менеджера') => ({
  request_id: randomUUID(),
  reason,
  command,
});
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(new Date());
const ON = { managerShiftsEnabled: true, rolesEnabled: true };
const done = (items) => items.map((i) => ({ code: i.code, status: 'done', comment: null }));
const OPENING = done(MANAGER_SHIFT_TEMPLATE_V1.opening);
const CLOSING = done(MANAGER_SHIFT_TEMPLATE_V1.closing);
const open = (id, items = OPENING, manager = null) => ({
  type: 'manager_shift_open',
  id,
  manager_employee_id: manager,
  items,
  expected_revision: 0,
});
const close = (
  id,
  revision,
  items = CLOSING,
  handover = 'Смену принял синтетический менеджер',
) => ({
  type: 'manager_shift_close',
  id,
  items,
  handover,
  expected_revision: revision,
});

// ------------------------------------------------------------------------------ pure ----

test('checklist rules: required answers, comments for problems, off checks are optional', () => {
  const items = [
    { code: 'cash_shifts', label: 'Кассовые смены', auto: 'cash_shifts', required: true },
    { code: 'cash_handover', label: 'Наличные сданы', auto: null, required: true },
    { code: 'blocked', label: 'Заблокированные', auto: 'blocked_consumption', required: true },
    { code: 'note', label: 'Заметка', auto: null, required: false },
  ];
  const ok = { status: 'ok', facts: {} };
  const checks = { cash_shifts: ok, blocked_consumption: { status: 'off', facts: {} } };
  const a = (code, status = 'done', comment = null) => ({ code, status, comment });
  assert.deepEqual(checklistProblems(items, [a('cash_shifts'), a('cash_handover')], checks), []);
  assert.deepEqual(checklistProblems(items, [a('cash_shifts')], checks), [
    { code: 'cash_handover', problem: 'missing' },
  ]);
  // «Есть проблема» and «Не применимо» need a comment (3+ characters after trim).
  for (const status of ['problem', 'not_applicable'])
    assert.deepEqual(
      checklistProblems(items, [a('cash_shifts'), a('cash_handover', status, '  ок ')], checks),
      [{ code: 'cash_handover', problem: 'comment' }],
    );
  assert.deepEqual(
    checklistProblems(
      items,
      [a('cash_shifts'), a('cash_handover', 'problem', 'Не хватает 500 тенге')],
      checks,
    ),
    [],
  );
  // A check that reports a problem needs the explanation even when the answer is «Готово».
  const problem = { ...checks, cash_shifts: { status: 'problem', facts: {} } };
  assert.deepEqual(checklistProblems(items, [a('cash_shifts'), a('cash_handover')], problem), [
    { code: 'cash_shifts', problem: 'comment' },
  ]);
  assert.deepEqual(
    checklistProblems(
      items,
      [a('cash_shifts', 'done', 'Расхождение -500 тенге пояснено'), a('cash_handover')],
      problem,
    ),
    [],
  );
  // An item whose check is off is optional; an unknown code is refused, also in a draft.
  assert.deepEqual(
    checklistProblems(items, [a('cash_shifts'), a('cash_handover'), a('bogus')], checks),
    [{ code: 'bogus', problem: 'unknown' }],
  );
  assert.deepEqual(checklistProblems(items, [a('bogus')], checks, true), [
    { code: 'bogus', problem: 'unknown' },
  ]);
  assert.deepEqual(checklistProblems(items, [], checks, true), []);
  const stored = storedAnswers(items, [a('cash_handover', 'problem', ' Нет 500 тенге ')], problem);
  assert.deepEqual(stored, [
    {
      code: 'cash_handover',
      label: 'Наличные сданы',
      auto: null,
      status: 'problem',
      comment: 'Нет 500 тенге',
      check: null,
    },
  ]);
});

test('checklist template v1 and schemas: unique codes, one check per phase, strict commands', () => {
  assert.equal(ChecklistTemplateSchema.safeParse(MANAGER_SHIFT_TEMPLATE_V1).success, true);
  // The built-in checklist reads every automatic check (design-bo-ui 5.6).
  assert.deepEqual(
    [...MANAGER_SHIFT_TEMPLATE_V1.opening, ...MANAGER_SHIFT_TEMPLATE_V1.closing]
      .map((i) => i.auto)
      .filter(Boolean)
      .sort(),
    [...MANAGER_SHIFT_AUTO].sort(),
  );
  const item = MANAGER_SHIFT_TEMPLATE_V1.opening[0];
  for (const bad of [
    { opening: [item, item], closing: [MANAGER_SHIFT_TEMPLATE_V1.closing[0]] },
    { opening: [item], closing: [{ ...item, label: 'Другое' }] },
    {
      opening: [item, { ...item, code: 'other' }],
      closing: [MANAGER_SHIFT_TEMPLATE_V1.closing[0]],
    },
    { opening: [], closing: [item] },
    { opening: [{ ...item, code: 'Bad code' }], closing: [MANAGER_SHIFT_TEMPLATE_V1.closing[0]] },
  ])
    assert.equal(ChecklistTemplateSchema.safeParse(bad).success, false, JSON.stringify(bad));
  const command = open(randomUUID());
  const envelope = request(command);
  assert.equal(P1Request.safeParse(envelope).success, true);
  assert.equal(Command.safeParse(command).success, false);
  assert.equal(Request.safeParse(envelope).success, false);
  for (const bad of [
    { ...command, expected_revision: 1 },
    { ...command, extra: true },
    { ...command, items: [OPENING[0], OPENING[0]] },
    { ...command, items: [{ ...OPENING[0], status: 'ok' }] },
  ])
    assert.equal(P1Request.safeParse({ ...envelope, command: bad }).success, false);
});

// ------------------------------------------------------------------------ database ----

async function people(c) {
  const login = async (name, role, designation) => {
    const p = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name,
      branch_ids: [c.branch],
    });
    await grantBackoffice(c.cloud.pool, p.actor_id, c.branch, role);
    if (designation)
      await designateBackoffice(
        c.cloud.pool,
        p.actor_id,
        c.branch,
        designation,
        'Синтетическое назначение',
      );
    return p;
  };
  return {
    manager: await login('Синтетический управляющий', 'manager'),
    shift: await login('Синтетический начальник смены', 'analyst', 'shift_manager'),
    accountant: await login('Синтетический бухгалтер', 'analyst', 'accountant'),
    analyst: await login('Синтетический аналитик', 'analyst'),
  };
}
async function employee(c, name = 'Синтетический менеджер смены') {
  const id = randomUUID();
  await c.cloud.pool.query(
    `INSERT INTO bo_records(id,branch_id,organization_id,kind,revision,payload)
     VALUES($1,$2,$3,'employee',1,$4)`,
    [id, c.branch, c.org, { name, role: 'manager', active: true, note: '' }],
  );
  return id;
}

test('flag off: no view, no command, the old journal is writable as before', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    for (const options of [{}, { rolesEnabled: true, stockV2Enabled: true }]) {
      const off = new Backoffice(c.cloud.pool, true, options);
      await assert.rejects(off.ops(manager.token, c.branch, 'manager-shifts', {}), (e) =>
        is('NOT_FOUND', undefined)(e),
      );
      await assert.rejects(
        off.command(manager.token, c.branch, request(open(randomUUID()))),
        is('INVALID_REQUEST', undefined),
      );
      const state = await off.read(manager.token, c.branch);
      assert.equal('shift_records' in state.limits, false);
      assert.equal('shift_records' in state.truncated, false);
      assert.equal('manager_shifts' in state.capabilities, false);
    }
    const off = new Backoffice(c.cloud.pool, true, {});
    const person = await employee(c);
    const saved = await off.command(
      manager.token,
      c.branch,
      request({
        type: 'save',
        kind: 'shift',
        id: randomUUID(),
        expected_revision: 0,
        payload: {
          name: 'Смена',
          employee_id: person,
          opened_at: new Date().toISOString(),
          closed_at: null,
          opening_cash_minor: '0',
          closing_cash_minor: null,
          note: '',
        },
      }),
    );
    assert.equal(saved.kind, 'shift');
  }));

test('one open shift, idempotent commands, checklist and handover, closed is immutable', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const person = await employee(c);
    const view = await bo.ops(manager.token, c.branch, 'manager-shifts', {});
    assert.equal(view.date, today());
    assert.equal(view.open, null);
    assert.equal(view.template.version, 1);
    assert.equal(view.template.editable, true);
    assert.deepEqual(Object.keys(view.checks), [...MANAGER_SHIFT_AUTO]);
    // Nothing from the cash desks in this branch: a manual answer, never a made-up zero.
    assert.equal(view.checks.cash_shifts.status, 'no_data');
    assert.equal(view.checks.blocked_consumption.status, 'off');

    // The opening checklist is complete or the shift does not open.
    await assert.rejects(
      bo.command(manager.token, c.branch, request(open(randomUUID(), OPENING.slice(1)))),
      is('INVALID_REQUEST', 'CHECKLIST_INCOMPLETE'),
    );
    await assert.rejects(
      bo.command(
        manager.token,
        c.branch,
        request(
          open(randomUUID(), [
            ...OPENING.slice(1),
            { code: OPENING[0].code, status: 'not_applicable', comment: null },
          ]),
        ),
      ),
      is('INVALID_REQUEST', 'CHECKLIST_INCOMPLETE'),
    );
    await assert.rejects(
      bo.command(manager.token, c.branch, request(open(randomUUID(), OPENING, randomUUID()))),
      is('INVALID_REQUEST', undefined),
    );
    const id = randomUUID();
    const first = request(
      open(
        id,
        [
          ...OPENING.slice(1),
          { code: 'attendance', status: 'problem', comment: 'Один жарщик опоздал на 20 минут' },
        ],
        person,
      ),
    );
    const opened = await bo.command(manager.token, c.branch, first);
    assert.equal(opened.state, 'open');
    assert.equal(opened.business_date, today());
    assert.equal(opened.manager_name, 'Синтетический менеджер смены');
    assert.equal(opened.opened_by_name, 'Синтетический управляющий');
    assert.equal(opened.template_version, 1);
    assert.equal(opened.revision, 1);
    assert.deepEqual(
      opened.opening.items.map((i) => i.code),
      MANAGER_SHIFT_TEMPLATE_V1.opening.map((i) => i.code),
    );
    assert.equal(
      opened.opening.items.find((i) => i.code === 'attendance').comment,
      'Один жарщик опоздал на 20 минут',
    );
    assert.equal(opened.opening.items.find((i) => i.code === 'attendance').check.status, 'no_data');
    // Exact replay: the same answer; the same request id with another body: CONFLICT.
    assert.deepEqual(await bo.command(manager.token, c.branch, first), opened);
    await assert.rejects(
      bo.command(manager.token, c.branch, { ...first, reason: 'Другая причина открытия' }),
      is('CONFLICT', undefined),
    );
    // One open shift per branch.
    await assert.rejects(
      bo.command(manager.token, c.branch, request(open(randomUUID()))),
      is('CONFLICT', 'MANAGER_SHIFT_OPEN'),
    );
    const listed = await bo.ops(manager.token, c.branch, 'manager-shifts', {});
    assert.equal(listed.open.id, id);
    assert.equal(listed.shifts.length, 1);
    assert.equal(listed.checks_date, today());

    // A draft of the closing: partial answers and the handover so far.
    const draft = await bo.command(
      manager.token,
      c.branch,
      request({
        type: 'manager_shift_save',
        id,
        phase: 'closing',
        items: CLOSING.slice(0, 2),
        handover: 'Черновик передачи',
        expected_revision: 1,
      }),
    );
    assert.equal(draft.revision, 2);
    assert.equal(draft.state, 'open');
    assert.equal(draft.closing.draft, true);
    assert.equal(draft.closing.items.length, 2);
    assert.equal(draft.closing.handover, 'Черновик передачи');
    await assert.rejects(
      bo.command(manager.token, c.branch, request(close(id, 1))),
      is('CONFLICT', undefined),
    );
    await assert.rejects(
      bo.command(manager.token, c.branch, request(close(id, 2, CLOSING.slice(1)))),
      is('INVALID_REQUEST', 'CHECKLIST_INCOMPLETE'),
    );
    await assert.rejects(
      bo.command(manager.token, c.branch, request(close(id, 2, CLOSING, '  ок '))),
      is('INVALID_REQUEST', 'HANDOVER_REQUIRED'),
    );
    const closed = await bo.command(manager.token, c.branch, request(close(id, 2)));
    assert.equal(closed.state, 'closed');
    assert.equal(closed.revision, 3);
    assert.equal(closed.closed_by_name, 'Синтетический управляющий');
    assert.equal(closed.closing.handover, 'Смену принял синтетический менеджер');
    assert.equal('draft' in closed.closing, false);
    // Closed is immutable: no command and no direct update changes it.
    for (const command of [
      close(id, 3),
      { type: 'manager_shift_save', id, phase: 'opening', items: OPENING, expected_revision: 3 },
    ])
      await assert.rejects(
        bo.command(manager.token, c.branch, request(command)),
        is('CONFLICT', undefined),
      );
    await assert.rejects(
      c.cloud.pool.query(
        "UPDATE bo_manager_shifts SET closing='{}'::jsonb,revision=revision+1 WHERE id=$1",
        [id],
      ),
      (e) => e.code === '23514',
    );
    // The next shift opens after the close; the audit has one row per command.
    await bo.command(manager.token, c.branch, request(open(randomUUID())));
    const audit = (
      await c.cloud.pool.query(
        "SELECT action FROM bo_audit WHERE branch_id=$1 AND action LIKE 'manager_shift%' ORDER BY created_at",
        [c.branch],
      )
    ).rows.map((r) => r.action);
    assert.deepEqual(audit, [
      'manager_shift_open',
      'manager_shift_save',
      'manager_shift_close',
      'manager_shift_open',
    ]);
    await assert.rejects(
      bo.command(
        manager.token,
        c.branch,
        request({
          type: 'manager_shift_save',
          id: randomUUID(),
          phase: 'closing',
          items: [],
          expected_revision: 1,
        }),
      ),
      is('NOT_FOUND', undefined),
    );
  }));

test('a shift that closes after midnight belongs to the day it was opened', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(
      new Date(Date.now() - 86400000),
    );
    const id = randomUUID();
    // Opened yesterday at 23:30 Almaty (written as the command would have written it then).
    await c.cloud.pool.query(
      `INSERT INTO bo_manager_shifts(id,branch_id,business_date,opened_at,opening,template_version,revision,opened_by)
       VALUES($1,$2,$3::date,$4,'{"items":[]}',1,1,$5)`,
      [id, c.branch, yesterday, at(yesterday, '23:30:00'), manager.actor_id],
    );
    const now = await bo.ops(manager.token, c.branch, 'manager-shifts', {});
    assert.equal(now.open.id, id);
    assert.equal(now.open.business_date, yesterday);
    assert.equal(now.checks_date, yesterday, 'checks of the business day of the open shift');
    assert.deepEqual(now.shifts, [], 'not a shift of today');
    const closed = await bo.command(manager.token, c.branch, request(close(id, 1)));
    assert.equal(closed.business_date, yesterday);
    assert.ok(Date.parse(closed.closed_at) > Date.parse(closed.opened_at));
    const day = await bo.ops(manager.token, c.branch, 'manager-shifts', { date: yesterday });
    assert.deepEqual(
      day.shifts.map((s) => [s.id, s.state]),
      [[id, 'closed']],
    );
    await assert.rejects(
      bo.ops(manager.token, c.branch, 'manager-shifts', { date: '19.11.2026' }),
      is('INVALID_REQUEST', undefined),
    );
    await assert.rejects(
      bo.ops(manager.token, c.branch, 'manager-shifts', { date: yesterday, extra: '1' }),
      is('INVALID_REQUEST', undefined),
    );
  }));

test('automatic checks from the cash desks: closed with a discrepancy, unrecorded receipts, stale data', () =>
  withSyncDatabases(async (c) => {
    const D = '2026-11-12';
    const one = randomUUID(),
      two = randomUUID();
    await zReport(c, {
      shift: randomUUID(),
      terminal: one,
      opened: at(D, '09:00:00'),
      closed: at(D, '23:40:00'),
      opening: '500000',
      cash_sales: '250000',
      cash_refunds: '0',
      expected: '750000',
      counted: '700000',
      methods: [],
    });
    const shiftTwo = randomUUID();
    await zReport(c, {
      shift: shiftTwo,
      terminal: two,
      opened: at(D, '10:00:00'),
      closed: at(D, '23:50:00'),
      opening: '300000',
      cash_sales: '0',
      cash_refunds: '0',
      expected: '300000',
      counted: '300000',
      methods: [],
    });
    await sale(c, {
      shift: shiftTwo,
      terminal: two,
      number: 1,
      at: at(D, '12:00:00'),
      tenders: [['kaspi_terminal', '1167000']],
      receipt: { state: 'pending' },
    });
    const checks = await managerShiftChecks(c.cloud.pool, c.branch, D, new Date(), {});
    assert.equal(checks.cash_shifts.status, 'problem');
    assert.deepEqual(
      {
        total: checks.cash_shifts.facts.total,
        closed: checks.cash_shifts.facts.closed,
        open: checks.cash_shifts.facts.open,
        cash: checks.cash_shifts.facts.cash_discrepancy_minor,
      },
      { total: 2, closed: 2, open: 0, cash: '-50000' },
    );
    assert.deepEqual(checks.cash_float, {
      status: 'ok',
      facts: {
        desks: [
          { label: 'Касса 1', opening_cash_minor: '500000' },
          { label: 'Касса 2', opening_cash_minor: '300000' },
        ],
      },
    });
    assert.equal(checks.webkassa_receipts.status, 'problem');
    assert.equal(checks.webkassa_receipts.facts.pending, 1);
    assert.equal(checks.webkassa_receipts.facts.pending_minor, '1167000');
    // A desk still open whose reports stopped: «Данные кассы не поступают с ...».
    const D2 = '2026-11-13';
    await cashierShift(c, {
      shift: randomUUID(),
      terminal: one,
      staff: randomUUID(),
      opened: at(D2, '09:00:00'),
      opening: '500000',
      expected: '500000',
    });
    const later = new Date(Date.now() + 30 * 60000);
    const stale = await managerShiftChecks(c.cloud.pool, c.branch, D2, later, {});
    assert.equal(stale.cash_shifts.status, 'no_data');
    assert.equal(stale.cash_shifts.facts.reason, 'stale');
    assert.equal(typeof stale.cash_shifts.facts.last_received_at, 'string');
    const fresh = await managerShiftChecks(c.cloud.pool, c.branch, D2, new Date(), {});
    assert.equal(fresh.cash_shifts.status, 'problem', 'an open desk while data still arrives');
    assert.equal(fresh.cash_shifts.facts.open, 1);
  }));

test('the checklist template: versioned by the manager, an open shift keeps its version', () =>
  withSyncDatabases(async (c) => {
    const { manager, shift } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const template = (version, extra) => ({
      type: 'manager_shift_template',
      opening: MANAGER_SHIFT_TEMPLATE_V1.opening,
      closing: [...MANAGER_SHIFT_TEMPLATE_V1.closing, ...extra],
      expected_version: version,
    });
    const fridge = {
      code: 'fridge_log',
      label: 'Журнал холодильников заполнен',
      auto: null,
      required: true,
    };
    await assert.rejects(
      bo.command(shift.token, c.branch, request(template(1, [fridge]))),
      is('FORBIDDEN', 'ROLE_FORBIDDEN'),
    );
    const v2 = await bo.command(manager.token, c.branch, request(template(1, [fridge])));
    assert.equal(v2.version, 2);
    await assert.rejects(
      bo.command(manager.token, c.branch, request(template(1, [fridge]))),
      is('CONFLICT', undefined),
    );
    await assert.rejects(
      bo.command(
        manager.token,
        c.branch,
        request(template(2, [fridge, { ...fridge, label: 'Повтор' }])),
      ),
      is('INVALID_REQUEST', undefined),
    );
    const id = randomUUID();
    const opened = await bo.command(shift.token, c.branch, request(open(id)));
    assert.equal(opened.template_version, 2);
    // A newer version does not change the shift that is open.
    await bo.command(
      manager.token,
      c.branch,
      request({
        ...template(2, []),
        closing: MANAGER_SHIFT_TEMPLATE_V1.closing.slice(0, 2),
      }),
    );
    const view = await bo.ops(shift.token, c.branch, 'manager-shifts', {});
    assert.equal(view.template.version, 3);
    assert.equal(view.open_template.version, 2);
    assert.deepEqual(view.open_template.closing.map((i) => i.code).at(-1), 'fridge_log');
    await assert.rejects(
      bo.command(shift.token, c.branch, request(close(id, 1))),
      is('INVALID_REQUEST', 'CHECKLIST_INCOMPLETE'),
    );
    const closed = await bo.command(
      shift.token,
      c.branch,
      request(close(id, 1, [...CLOSING, { code: 'fridge_log', status: 'done', comment: null }])),
    );
    assert.equal(closed.closed_by_name, 'Синтетический начальник смены');
    // Versions are append-only.
    await assert.rejects(
      c.cloud.pool.query("UPDATE bo_branch_templates SET body='{}' WHERE branch_id=$1", [c.branch]),
    );
    await assert.rejects(
      c.cloud.pool.query(
        `INSERT INTO bo_manager_shifts(id,branch_id,business_date,opened_at,template_version,revision,opened_by)
         VALUES($1,$2,(now() AT TIME ZONE 'Asia/Almaty')::date,now(),9,1,$3)`,
        [randomUUID(), c.branch, manager.actor_id],
      ),
      (e) => e.code === '23503',
    );
  }));

test('roles: manager and shift manager run the shift, every role reads, others are refused', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    for (const person of Object.values(p))
      assert.equal((await bo.ops(person.token, c.branch, 'manager-shifts', {})).open, null);
    await assert.rejects(
      bo.command(p.accountant.token, c.branch, request(open(randomUUID()))),
      is('FORBIDDEN', 'ROLE_FORBIDDEN'),
    );
    await assert.rejects(
      bo.command(p.analyst.token, c.branch, request(open(randomUUID()))),
      is('FORBIDDEN', undefined),
    );
    const id = randomUUID();
    await bo.command(p.shift.token, c.branch, request(open(id)));
    await bo.command(p.manager.token, c.branch, request(close(id, 1)));
    const read = await bo.read(p.shift.token, c.branch);
    assert.deepEqual(read.permissions.slice(-1), ['manager_shifts.write']);
    assert.deepEqual((await bo.read(p.manager.token, c.branch)).permissions.slice(-2), [
      'manager_shifts.write',
      'manager_shifts.template',
    ]);
    assert.equal(read.capabilities.manager_shifts, true);
    // Without BACKOFFICE_ROLES_ENABLED the grant decides: the manager runs it, the analyst reads.
    const plain = new Backoffice(c.cloud.pool, true, { managerShiftsEnabled: true });
    await assert.rejects(
      plain.command(p.shift.token, c.branch, request(open(randomUUID()))),
      is('FORBIDDEN', undefined),
    );
    await plain.command(p.manager.token, c.branch, request(open(randomUUID())));
  }));

test('flag on: the old journal is read only and listed apart, so stations are never crowded out', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const person = await employee(c);
    // 2001 old journal rows and one station: kind order puts the station after them.
    await c.cloud.pool.query(
      `INSERT INTO bo_records(id,branch_id,organization_id,kind,revision,payload,updated_at)
       SELECT gen_random_uuid(),$1,$2,'shift',1,jsonb_build_object('name','Смена '||g,'employee_id',$3::text,
         'opened_at','2026-10-01T09:00:00.000Z','closed_at','2026-10-01T21:00:00.000Z',
         'opening_cash_minor','0','closing_cash_minor','0','note',''),
         timestamptz '2026-10-01' + g * interval '1 minute'
       FROM generate_series(1,2001) g`,
      [c.branch, c.org, person],
    );
    const station = randomUUID();
    await c.cloud.pool.query(
      `INSERT INTO bo_records(id,branch_id,organization_id,kind,revision,payload)
       VALUES($1,$2,$3,'station',1,$4)`,
      [
        station,
        c.branch,
        c.org,
        {
          name: 'Сборка',
          role: 'assembly',
          device_id: null,
          active: true,
          product_ids: [],
          target_seconds: 300,
        },
      ],
    );
    const off = await new Backoffice(c.cloud.pool, true, {}).read(manager.token, c.branch);
    assert.equal(off.records.length, 2000);
    assert.equal(
      off.records.some((r) => r.id === station),
      false,
      'the cloud lane loses it',
    );
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const on = await bo.read(manager.token, c.branch);
    assert.equal(
      on.records.some((r) => r.id === station),
      true,
    );
    const journal = on.records.filter((r) => r.kind === 'shift');
    assert.equal(journal.length, LEGACY_JOURNAL_LIMIT);
    assert.equal(journal[0].payload.name, 'Смена 2001', 'newest first');
    assert.deepEqual(on.limits.shift_records, LEGACY_JOURNAL_LIMIT);
    assert.equal(on.truncated.shift_records, true);
    await assert.rejects(
      bo.command(
        manager.token,
        c.branch,
        request({
          type: 'save',
          kind: 'shift',
          id: journal[0].id,
          expected_revision: 1,
          payload: { ...journal[0].payload, note: 'Правка' },
        }),
      ),
      is('NOT_READY', 'LEGACY_JOURNAL_READ_ONLY'),
    );
  }));
