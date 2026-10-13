import { z } from 'zod';
import { BackofficeError, parse } from './model.js';

// Attendance contains timestamps and opaque employee/event IDs, never fingerprints.
// This module starts after Kazakhstan's UTC+5 transition. Earlier imports need a
// historical timezone adapter, rather than silently using today's offset.
export const WorkDate = z.iso.date().refine((v) => v >= '2024-03-01' && v <= '2099-12-31');
export const WorkMonth = WorkDate.refine((v) => v.endsWith('-01'));
const id = z.uuid();
const money = z.string().regex(/^(0|[1-9][0-9]{0,11})$/);
const instant = z.iso
  .datetime({ offset: true })
  .refine((v) => !v.includes('.') && WorkDate.safeParse(localWorkDate(v)).success);
const note = z.string().trim().min(3).max(500);
const interval = z
  .strictObject({ start: instant, end: instant })
  .refine(
    (v) =>
      Date.parse(v.end) > Date.parse(v.start) &&
      Date.parse(v.end) - Date.parse(v.start) <= 86400000,
  );
export const WorkPlan = z
  .strictObject({
    deleted: z.literal(true).optional(),
    employee_id: id,
    start: instant,
    end: instant,
    unpaid_break_minutes: z.number().int().min(0).max(240),
    status: z.enum(['draft', 'published', 'cancelled']),
    position: z.string().trim().min(1).max(100),
  })
  .refine(
    (v) =>
      Date.parse(v.end) > Date.parse(v.start) + v.unpaid_break_minutes * 60000 &&
      Date.parse(v.end) - Date.parse(v.start) <= 86400000,
  );
export const HourlyRate = z
  .strictObject({
    valid_until: WorkDate.optional(),
    deleted: z.literal(true).optional(),
    employee_id: id,
    effective_date: WorkDate,
    hourly_minor: money.refine((v) => BigInt(v) > 0n),
  })
  .refine((v) => !v.valid_until || v.valid_until >= v.effective_date);
export const WorkPunch = z.strictObject({
  external_id: z.string().trim().min(1).max(160),
  employee_id: id,
  occurred_at: instant,
  direction: z.enum(['in', 'out', 'break_start', 'break_end', 'unknown']),
});
export const WorkTime = z
  .strictObject({
    deleted: z.literal(true).optional(),
    employee_id: id,
    date: WorkDate,
    status: z.enum(['draft', 'approved', 'voided']),
    attendance: z.enum(['worked', 'day_off', 'absence', 'leave', 'sick']),
    intervals: z.array(interval).max(20),
    paid_duration_ms: z.number().int().min(1).max(86400000).optional(),
    source: z
      .strictObject({
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        cell: z.string().max(100),
        hours: z.string().regex(/^\d+(\.\d{1,6})?$/),
      })
      .optional(),
    source_event_ids: z.array(id).max(100),
    note,
  })
  .superRefine((v, ctx) => {
    const bad = () => ctx.addIssue({ code: 'custom', message: 'Invalid timesheet' });
    if (
      (v.attendance === 'worked') !==
      (v.intervals.length > 0 || v.paid_duration_ms !== undefined)
    )
      bad();
    if (v.paid_duration_ms !== undefined && (v.intervals.length || v.source_event_ids.length))
      bad();
    if (new Set(v.source_event_ids).size !== v.source_event_ids.length) bad();
    const sorted = [...v.intervals].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    if (
      sorted.some(
        (p, i) =>
          localWorkDate(p.start) !== v.date ||
          (i > 0 && Date.parse(p.start) < Date.parse(sorted[i - 1]!.end)),
      )
    )
      bad();
    if (sorted.reduce((sum, p) => sum + Date.parse(p.end) - Date.parse(p.start), 0) > 86400000)
      bad();
  });
export const WorkBonus = z.strictObject({
  deleted: z.literal(true).optional(),
  employee_id: id,
  month: WorkMonth,
  name: z.string().trim().min(1).max(120),
  target: z.string().trim().min(1).max(200),
  actual: z.string().trim().min(1).max(200),
  evidence: note,
  amount_minor: money,
  status: z.enum(['draft', 'approved', 'voided']),
});
export const WorkPayroll = z.strictObject({
  deleted: z.literal(true).optional(),
  employee_id: id,
  month: WorkMonth,
  status: z.enum(['draft', 'approved', 'voided']),
  base_override_minor: money.nullable(),
  note,
  items: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(120),
        effect: z.enum(['addition', 'deduction']),
        amount_minor: money,
      }),
    )
    .max(30),
  source: z
    .strictObject({
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      sheet: z.string().max(100),
      row: z.number().int().min(1).max(100000),
      gross_minor: money.nullable(),
      net_minor: z
        .string()
        .regex(/^-?(0|[1-9][0-9]{0,13})$/)
        .nullable(),
      cells: z
        .array(
          z.strictObject({
            cell: z.string().max(12),
            label: z.string().max(120),
            value: z.string().max(500),
            formula: z.string().max(500),
          }),
        )
        .max(30),
      issues: z.array(z.string().max(250)).max(20),
    })
    .optional(),
});
export const WorkforceSchemas = {
  plan: WorkPlan,
  rate: HourlyRate,
  time: WorkTime,
  bonus: WorkBonus,
  payroll: WorkPayroll,
};
export type WorkforceKind = keyof typeof WorkforceSchemas;
export type WorkRecord = { id: string; kind: WorkforceKind; revision: number; payload: unknown };
export type Punch = z.infer<typeof WorkPunch> & { id: string };
export const WorkforceRequest = z.strictObject({
  request_id: id,
  reason: note,
  command: z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('delete'),
      kind: z.enum(['plan', 'rate', 'time', 'bonus', 'payroll', 'employee']),
      id,
      expected_revision: z.number().int().min(1).max(2147483646),
    }),
    z.strictObject({
      type: z.literal('save'),
      kind: z.enum(['plan', 'rate', 'time', 'bonus', 'payroll']),
      id,
      expected_revision: z.number().int().min(0).max(2147483646),
      payload: z.unknown(),
    }),
    z.strictObject({
      type: z.literal('import'),
      source: z.string().regex(/^[a-z0-9_-]{1,50}$/),
      events: z.array(WorkPunch).min(1).max(500),
    }),
    z.strictObject({ type: z.literal('generate_payroll'), month: WorkMonth }),
    z.strictObject({
      type: z.literal('period'),
      month: WorkMonth,
      closed: z.boolean(),
      expected_revision: z.number().int().min(0).max(2147483646),
    }),
  ]),
});

/** Asia/Almaty is UTC+5 for the supported periods. Preserve seconds; never round punches. */
export function localWorkDate(value: string): string {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds + 5 * 3600000).toISOString().slice(0, 10)
    : '';
}
export function monthWindow(month: string) {
  parse(WorkMonth, month);
  const start = Date.parse(month + 'T00:00:00+05:00');
  const next = new Date(month + 'T00:00:00Z');
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { start, end: next.getTime() - 5 * 3600000 };
}

/** Unambiguous in/out pairs only. Unknown/repeated marks require human review. */
export function proposeAttendance(events: Punch[]) {
  const sorted = [...events].sort(
    (a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.id.localeCompare(b.id),
  );
  const intervals: { start: string; end: string }[] = [];
  const issues: string[] = [];
  let start: string | null = null;
  let onBreak = false;
  const employees = new Set(events.map((e) => e.employee_id));
  if (employees.size > 1) throw new BackofficeError('INVALID_REQUEST');
  for (const e of sorted) {
    parse(WorkPunch, {
      external_id: e.external_id,
      employee_id: e.employee_id,
      occurred_at: e.occurred_at,
      direction: e.direction,
    });
    if (e.direction === 'unknown') {
      issues.push('UNKNOWN_DIRECTION');
      continue;
    }
    if (e.direction === 'in' || e.direction === 'break_end') {
      if (start || (e.direction === 'in' && onBreak) || (e.direction === 'break_end' && !onBreak)) {
        issues.push('UNEXPECTED_IN');
        continue;
      }
      start = e.occurred_at;
      onBreak = false;
    } else {
      if (!start) {
        issues.push('MISSING_IN');
        continue;
      }
      const span = Date.parse(e.occurred_at) - Date.parse(start);
      if (span <= 0 || span > 86400000) issues.push('INVALID_DURATION');
      else intervals.push({ start, end: e.occurred_at });
      start = null;
      onBreak = e.direction === 'break_start';
    }
  }
  if (start || onBreak) issues.push('MISSING_OUT');
  return {
    intervals,
    issues: [...new Set(issues)],
    approvable: issues.length === 0 && intervals.length > 0,
  };
}

export type PayrollLine = {
  employee_id: string;
  seconds: number;
  night_seconds: number;
  base_minor: string;
  bonus_minor: string;
  total_minor: string;
  unknown_clock_seconds: number;
};
/** Base gross pay only. Statutory premiums, deductions and payment are separate stages. */
export function calculateWorkforce(month: string, records: WorkRecord[]) {
  records = records.filter((r) => !(r.payload as Record<string, unknown>).deleted);
  const window = monthWindow(month),
    rows = new Map<string, PayrollLine>();
  const amounts = new Map<string, bigint>();
  const issues: { employee_id: string; code: string; record_id: string }[] = [];
  const rates = records
    .filter((r) => r.kind === 'rate')
    .map((r) => ({ ...parse(HourlyRate, r.payload), id: r.id }));
  const activeIntervals = new Map<string, { start: number; end: number }[]>();
  const row = (employee: string) => {
    if (!rows.has(employee))
      rows.set(employee, {
        employee_id: employee,
        seconds: 0,
        night_seconds: 0,
        unknown_clock_seconds: 0,
        base_minor: '0',
        bonus_minor: '0',
        total_minor: '0',
      });
    return rows.get(employee)!;
  };
  for (const record of records) {
    if (record.kind !== 'time') continue;
    const time = parse(WorkTime, record.payload);
    if (time.status === 'voided') continue;
    if (time.status !== 'approved') {
      if (
        time.date.slice(0, 7) === month.slice(0, 7) ||
        time.intervals.some(
          (s) => Date.parse(s.start) < window.end && Date.parse(s.end) > window.start,
        )
      )
        issues.push({
          employee_id: time.employee_id,
          code: 'UNAPPROVED_TIME',
          record_id: record.id,
        });
      continue;
    }
    if (time.paid_duration_ms !== undefined && time.date.slice(0, 7) === month.slice(0, 7)) {
      const line = row(time.employee_id);
      line.seconds += time.paid_duration_ms / 1000;
      line.unknown_clock_seconds += time.paid_duration_ms / 1000;
      const applicable = rates
        .filter(
          (r) =>
            r.employee_id === time.employee_id &&
            r.effective_date <= time.date &&
            (!r.valid_until || r.valid_until >= time.date),
        )
        .sort((a, b) => b.effective_date.localeCompare(a.effective_date));
      if (!applicable[0])
        issues.push({ employee_id: time.employee_id, code: 'MISSING_RATE', record_id: record.id });
      else if (applicable[1]?.effective_date === applicable[0].effective_date)
        throw new BackofficeError('CONFLICT');
      else
        amounts.set(
          time.employee_id,
          (amounts.get(time.employee_id) ?? 0n) +
            BigInt(applicable[0].hourly_minor) * BigInt(time.paid_duration_ms),
        );
    }
    for (const span of time.intervals) {
      let cursor = Math.max(window.start, Date.parse(span.start));
      const end = Math.min(window.end, Date.parse(span.end));
      if (cursor >= end) continue;
      const spans = activeIntervals.get(time.employee_id) ?? [];
      if (spans.some((p) => cursor < p.end && end > p.start)) throw new BackofficeError('CONFLICT');
      spans.push({ start: cursor, end });
      activeIntervals.set(time.employee_id, spans);
      const line = row(time.employee_id);
      while (cursor < end) {
        const date = localWorkDate(new Date(cursor).toISOString());
        const midnight = Date.parse(date + 'T00:00:00+05:00');
        const stop = Math.min(end, midnight + 86400000);
        const seconds = (stop - cursor) / 1000;
        line.seconds += seconds;
        const overlap = (a: number, b: number) =>
          Math.max(0, Math.min(stop, b) - Math.max(cursor, a)) / 1000;
        line.night_seconds +=
          overlap(midnight, midnight + 6 * 3600000) +
          overlap(midnight + 22 * 3600000, midnight + 86400000);
        const applicable = rates
          .filter(
            (r) =>
              r.employee_id === time.employee_id &&
              r.effective_date <= date &&
              (!r.valid_until || r.valid_until >= date),
          )
          .sort((a, b) => b.effective_date.localeCompare(a.effective_date));
        const rate = applicable[0];
        if (!rate)
          issues.push({
            employee_id: time.employee_id,
            code: 'MISSING_RATE',
            record_id: record.id,
          });
        else if (applicable[1]?.effective_date === rate.effective_date)
          throw new BackofficeError('CONFLICT');
        else
          amounts.set(
            time.employee_id,
            (amounts.get(time.employee_id) ?? 0n) +
              BigInt(rate.hourly_minor) * BigInt(stop - cursor),
          );
        cursor = stop;
      }
    }
  }
  for (const record of records) {
    if (record.kind === 'plan') {
      const plan = parse(WorkPlan, record.payload);
      if (
        plan.status === 'published' &&
        Date.parse(plan.start) < window.end &&
        Date.parse(plan.end) > window.start
      ) {
        const date = localWorkDate(plan.start);
        const confirmed = records.some(
          (r) =>
            r.kind === 'time' &&
            (() => {
              const t = parse(WorkTime, r.payload);
              return (
                t.employee_id === plan.employee_id && t.date === date && t.status === 'approved'
              );
            })(),
        );
        if (!confirmed)
          issues.push({
            employee_id: plan.employee_id,
            code: 'MISSING_TIME',
            record_id: record.id,
          });
      }
    }
    if (record.kind !== 'bonus') continue;
    const bonus = parse(WorkBonus, record.payload);
    if (bonus.month !== month || bonus.status === 'voided') continue;
    if (bonus.status !== 'approved')
      issues.push({
        employee_id: bonus.employee_id,
        code: 'UNAPPROVED_BONUS',
        record_id: record.id,
      });
    else {
      const line = row(bonus.employee_id);
      line.bonus_minor = String(BigInt(line.bonus_minor) + BigInt(bonus.amount_minor));
    }
  }
  for (const line of rows.values()) {
    line.base_minor = String(((amounts.get(line.employee_id) ?? 0n) + 1800000n) / 3600000n);
    line.total_minor = String(BigInt(line.base_minor) + BigInt(line.bonus_minor));
  }
  const payroll = records
    .filter((r) => r.kind === 'payroll')
    .map((r) => {
      const p = parse(WorkPayroll, r.payload);
      if (p.month !== month || p.status === 'voided') return null;
      const calculated = rows.get(p.employee_id);
      const base = BigInt(p.base_override_minor ?? calculated?.base_minor ?? '0');
      const bonus = BigInt(calculated?.bonus_minor ?? '0');
      const additions = p.items
        .filter((i) => i.effect === 'addition')
        .reduce((n, i) => n + BigInt(i.amount_minor), 0n);
      const deductions = p.items
        .filter((i) => i.effect === 'deduction')
        .reduce((n, i) => n + BigInt(i.amount_minor), 0n);
      if (p.status !== 'approved')
        issues.push({ employee_id: p.employee_id, code: 'UNAPPROVED_PAYROLL', record_id: r.id });
      if (p.base_override_minor === null && !calculated)
        issues.push({ employee_id: p.employee_id, code: 'MISSING_PAYROLL_BASE', record_id: r.id });
      return {
        id: r.id,
        employee_id: p.employee_id,
        status: p.status,
        base_minor: String(base),
        bonus_minor: String(bonus),
        additions_minor: String(additions),
        deductions_minor: String(deductions),
        total_minor: String(base + bonus + additions - deductions),
        source_net_minor: p.source?.net_minor ?? null,
      };
    })
    .filter((p) => p !== null);
  return {
    month,
    payroll,
    calculation: 'base_gross_preview' as const,
    lines: [...rows.values()].sort((a, b) => a.employee_id.localeCompare(b.employee_id)),
    issues,
    total_minor: String([...rows.values()].reduce((sum, r) => sum + BigInt(r.total_minor), 0n)),
  };
}
