import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  WorkPunch,
  WorkTime,
  WorkPlan,
  WorkMonth,
  calculateWorkforce,
  proposeAttendance,
} from '../dist/workforce.js';

const employee_id = randomUUID();
const at = (day, time) => `2026-09-${day}T${time}:00+05:00`;
const record = (kind, payload) => ({ id: randomUUID(), kind, revision: 1, payload });
const rate = (hourly_minor = '100000', effective_date = '2026-09-01') =>
  record('rate', { employee_id, hourly_minor, effective_date });
const time = (start = at('01', '09:00'), end = at('01', '17:00'), status = 'approved') =>
  record('time', {
    employee_id,
    date: start.slice(0, 10),
    status,
    attendance: 'worked',
    intervals: [{ start, end }],
    source_event_ids: [],
    note: 'Проверено по журналу',
  });
const punch = (direction, occurred_at) => ({
  id: randomUUID(),
  external_id: randomUUID(),
  employee_id,
  direction,
  occurred_at,
});
const calc = (records) => calculateWorkforce('2026-09-01', records);

test('hourly pay uses approved actual time, not a schedule or draft; voided entries excluded', () => {
  const plan = record('plan', {
    employee_id,
    start: at('01', '09:00'),
    end: at('01', '21:00'),
    unpaid_break_minutes: 60,
    position: 'Повар',
    status: 'published',
  });
  const result = calc([
    rate(),
    time(),
    plan,
    time(at('02', '09:00'), at('02', '17:00'), 'draft'),
    time(at('03', '09:00'), at('03', '17:00'), 'voided'),
  ]);
  assert.equal(result.total_minor, '800000');
  assert.equal(result.lines[0].seconds, 8 * 3600);
  assert.deepEqual(
    result.issues.map((i) => i.code),
    ['UNAPPROVED_TIME'],
  );
  assert.equal(calc([rate(), plan]).issues[0].code, 'MISSING_TIME');
});

test('rate changes split overnight work at local midnight; month boundary clips exactly', () => {
  const records = [
    rate(),
    rate('200000', '2026-09-02'),
    time(at('01', '22:00'), at('02', '06:00')),
  ];
  const result = calc(records);
  assert.equal(result.total_minor, '1400000');
  assert.equal(result.lines[0].night_seconds, 8 * 3600);
  const overnight = time(at('30', '22:00'), '2026-10-01T02:00:00+05:00');
  assert.equal(calc([rate(), overnight]).total_minor, '200000');
  assert.equal(calculateWorkforce('2026-10-01', [rate(), overnight]).total_minor, '200000');
  overnight.payload.status = 'draft';
  assert.equal(
    calculateWorkforce('2026-10-01', [rate(), overnight]).issues[0].code,
    'UNAPPROVED_TIME',
  );
});

test('integer money and seconds round once per employee; no floating-point or per-punch loss', () => {
  const first = time('2026-09-01T09:00:00+05:00', '2026-09-01T09:00:01+05:00');
  const second = time('2026-09-02T09:00:00+05:00', '2026-09-02T09:00:01+05:00');
  assert.equal(calc([rate('1000'), first, second]).total_minor, '1');
  assert.equal(calc([rate('999999999999'), time()]).total_minor, '7999999999992');
});

test('missing rate prevents a complete calculation; overlapping time and duplicate rates fail', () => {
  assert.equal(calc([time()]).issues[0].code, 'MISSING_RATE');
  assert.throws(() => calc([rate(), time(), time()]), /CONFLICT/);
  assert.throws(() => calc([rate(), rate(), time()]), /CONFLICT/);
});

test('only expressly approved KPI awards enter gross preview; no invented automatic bonuses', () => {
  const bonus = record('bonus', {
    employee_id,
    month: '2026-09-01',
    name: 'Качество',
    target: 'Утверждённый план',
    actual: 'Подтверждённый результат',
    evidence: 'Протокол управляющего',
    amount_minor: '50000',
    status: 'draft',
  });
  assert.equal(calc([rate(), time(), bonus]).total_minor, '800000');
  assert.equal(calc([bonus]).issues[0].code, 'UNAPPROVED_BONUS');
  bonus.payload.status = 'approved';
  assert.equal(calc([rate(), time(), bonus]).total_minor, '850000');
  bonus.payload.status = 'voided';
  assert.equal(calc([bonus]).total_minor, '0');
});

test('explicit break marks split time; missing/duplicate/unknown marks require review', () => {
  const events = [
    punch('in', at('01', '09:00')),
    punch('break_start', at('01', '12:00')),
    punch('break_end', at('01', '12:30')),
    punch('out', at('01', '18:00')),
  ];
  const result = proposeAttendance(events.reverse());
  assert.equal(result.approvable, true);
  assert.equal(
    result.intervals.reduce((n, s) => n + Date.parse(s.end) - Date.parse(s.start), 0),
    8.5 * 3600000,
  );
  assert.equal(proposeAttendance([punch('in', at('01', '09:00'))]).approvable, false);
  assert.equal(proposeAttendance([punch('unknown', at('01', '09:00'))]).approvable, false);
  assert.equal(
    proposeAttendance([
      punch('in', at('01', '09:00')),
      punch('in', at('01', '09:01')),
      punch('out', at('01', '18:00')),
    ]).approvable,
    false,
  );
  assert.equal(proposeAttendance([punch('out', at('01', '18:00'))]).approvable, false);
  assert.throws(
    () => proposeAttendance([events[0], { ...events[1], employee_id: randomUUID() }]),
    /INVALID_REQUEST/,
  );
});

test('strict schemas reject biometrics, invalid dates, overlapping intervals and non-worked hours', () => {
  const e = punch('in', at('01', '09:00'));
  delete e.id;
  assert.equal(WorkPunch.safeParse({ ...e, fingerprint: 'forbidden' }).success, false);
  assert.equal(WorkPunch.safeParse({ ...e, occurred_at: 'invalid' }).success, false);
  assert.equal(
    WorkPunch.safeParse({ ...e, occurred_at: '2023-01-01T09:00:00+06:00' }).success,
    false,
  );
  assert.equal(WorkMonth.safeParse('2026-09-02').success, false);
  const t = time().payload;
  assert.equal(
    WorkTime.safeParse({ ...t, intervals: [...t.intervals, ...t.intervals] }).success,
    false,
  );
  assert.equal(WorkTime.safeParse({ ...t, attendance: 'day_off' }).success, false);
  assert.equal(WorkTime.safeParse({ ...t, date: '2026-09-02' }).success, false);
  assert.equal(
    WorkPlan.safeParse({
      employee_id,
      start: at('01', '09:00'),
      end: at('01', '10:00'),
      unpaid_break_minutes: 60,
      status: 'draft',
      position: 'Повар',
    }).success,
    false,
  );
});

test('duration-only attendance preserves decimal hours without inventing clock times; historical rates expire', () => {
  const entry = time();
  entry.payload.intervals = [];
  entry.payload.paid_duration_ms = 4802400; // 1.334 decimal hours, exact to 0.1 second.
  entry.payload.source = { sha256: 'a'.repeat(64), cell: 'График!D4', hours: '1.334' };
  assert.equal(WorkTime.safeParse(entry.payload).success, true);
  const r = rate('12345');
  r.payload.valid_until = '2026-09-30';
  const result = calc([r, entry]);
  assert.equal(result.lines[0].seconds, 4802.4);
  assert.equal(result.lines[0].unknown_clock_seconds, 4802.4);
  assert.equal(result.lines[0].base_minor, '16468');
  assert.equal(result.lines[0].night_seconds, 0);
  assert.equal(
    WorkTime.safeParse({ ...entry.payload, intervals: time().payload.intervals }).success,
    false,
  );
  assert.equal(
    WorkTime.safeParse({ ...entry.payload, source_event_ids: [randomUUID()] }).success,
    false,
  );
  entry.payload.date = '2026-10-01';
  assert.equal(calculateWorkforce('2026-10-01', [r, entry]).issues[0].code, 'MISSING_RATE');
});

test('monthly worksheet keeps source salary, adjustments and review status separate from hourly preview', () => {
  const sheet = record('payroll', {
    employee_id,
    month: '2026-09-01',
    status: 'draft',
    base_override_minor: '900000',
    note: 'Сверка источника',
    items: [
      { name: 'Аванс', effect: 'deduction', amount_minor: '200000' },
      { name: 'Доплата', effect: 'addition', amount_minor: '10000' },
    ],
    source: {
      sha256: 'a'.repeat(64),
      sheet: 'Табель',
      row: 4,
      gross_minor: '900000',
      net_minor: '700000',
      cells: [],
      issues: [],
    },
  });
  const result = calc([rate(), time(), sheet]);
  assert.equal(result.total_minor, '800000');
  assert.equal(result.payroll[0].total_minor, '710000');
  assert.equal(result.payroll[0].source_net_minor, '700000');
  assert.equal(result.issues[0].code, 'UNAPPROVED_PAYROLL');
  sheet.payload.base_override_minor = null;
  sheet.payload.status = 'approved';
  assert.equal(calc([rate(), time(), sheet]).payroll[0].total_minor, '610000');
  sheet.payload.deleted = true;
  assert.equal(calc([sheet]).payroll.length, 0);
});

test('workbook import resumes stable commands and refuses duplicate attendance or changed imported data', async () => {
  const { planImport, runImport } = await import('../../../scripts/payroll-import.mjs');
  const branch = randomUUID();
  const input = {
    version: 1,
    sha256: 'a'.repeat(64),
    month: '2026-09-01',
    employees: [
      {
        name: 'Synthetic Person',
        position: 'Кухня',
        rate_minor: '100000',
        days: [
          {
            date: '2026-09-01',
            paid_duration_ms: 30600000,
            source: { sha256: 'a'.repeat(64), cell: 'График!D4', hours: '8.5' },
          },
        ],
        payroll: {
          base_override_minor: '850000',
          items: [],
          source: {
            sha256: 'a'.repeat(64),
            sheet: 'Табель',
            row: 4,
            gross_minor: '850000',
            net_minor: '850000',
            cells: [],
            issues: [],
          },
        },
      },
    ],
  };
  const snapshot = {
    branch_id: branch,
    month: input.month,
    role: 'manager',
    period: { closed: false },
    employees: [],
    records: [],
  };
  const initial = planImport(input, snapshot, branch);
  assert.equal(initial.summary.commands, 4);
  let writes = 0;
  const request = async (path, body) => {
    if (!body) return globalThis.structuredClone(snapshot);
    writes++;
    const c = body.command;
    (c.kind === 'employee' ? snapshot.employees : snapshot.records).push({
      id: c.id,
      kind: c.kind,
      revision: 1,
      payload: c.payload,
    });
    return { id: c.id, revision: 1 };
  };
  const applied = await runImport({
    input,
    branch,
    request,
    apply: true,
    expectedPlan: initial.hash,
  });
  assert.equal(applied.saved, 4);
  assert.equal(writes, 4);
  const again = await runImport({
    input,
    branch,
    request,
    apply: true,
    expectedPlan: initial.hash,
  });
  assert.equal(again.saved, 0);
  assert.equal(writes, 4);
  snapshot.records.find((r) => r.kind === 'time').payload.paid_duration_ms = 3600000;
  assert.throws(() => planImport(input, snapshot, branch), /modified/);
  snapshot.records.find((r) => r.kind === 'time').payload.paid_duration_ms = 30600000;
  snapshot.records.push({ ...snapshot.records.find((r) => r.kind === 'time'), id: randomUUID() });
  assert.throws(() => planImport(input, snapshot, branch), /conflicts/);
});
