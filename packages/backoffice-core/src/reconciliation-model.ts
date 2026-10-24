import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Daily payment reconciliation (stage 2, lane rec): pure parts, no database.
 *
 * PickChick facts (captures and refund effects confirmed by payment adapters or registered as
 * manual Kaspi Pay refunds) are compared with external facts: statement lines imported from a
 * CSV file through a configurable column mapping, and manual bank/ККМ totals. The bank file
 * format is NOT confirmed (no Kaspi Pay statement sample), so nothing here assumes one.
 * Money is integer minor units (bigint); the business day is the Asia/Almaty calendar day.
 */
export const REC_TIMEZONE = 'Asia/Almaty';
export const SOURCES = ['kaspi', 'tiptoppay', 'cash', 'other'] as const;
export type Source = (typeof SOURCES)[number];
export const METHOD_KEYS = [
  'kaspi_remote',
  'kaspi_qr',
  'manual_refund',
  'kaspi_pos',
  'kaspi_other',
  'tiptoppay',
  'cash',
  'other',
] as const;
export type MethodKey = (typeof METHOD_KEYS)[number];
/**
 * `recorded`: PickChick itself records payments of this method. Cash and Kaspi Smart POS on the
 * cashier are not recorded yet (the cashier reports orders as awaiting payment only), so only an
 * external fact exists for them and it is shown as such, never as a computed expectation.
 */
export const METHODS: Record<MethodKey, { label: string; source: Source; recorded: boolean }> = {
  kaspi_remote: {
    label: 'Kaspi: счёт на телефон (приложение, киоск)',
    source: 'kaspi',
    recorded: true,
  },
  kaspi_qr: { label: 'Kaspi QR на киоске', source: 'kaspi', recorded: true },
  manual_refund: { label: 'Ручные возвраты в Kaspi Pay', source: 'kaspi', recorded: true },
  kaspi_pos: { label: 'Kaspi Smart POS на кассе', source: 'kaspi', recorded: false },
  kaspi_other: { label: 'Kaspi: способ не определён', source: 'kaspi', recorded: false },
  tiptoppay: { label: 'TipTopPay (карта)', source: 'tiptoppay', recorded: true },
  cash: { label: 'Наличные на кассе', source: 'cash', recorded: false },
  other: { label: 'Другие провайдеры', source: 'other', recorded: true },
};
export const SOURCE_LABELS: Record<Source, string> = {
  kaspi: 'Kaspi Pay',
  tiptoppay: 'TipTopPay',
  cash: 'Касса (наличные)',
  other: 'Другой источник',
};
/** Payment provider of a commerce provider account -> reconciliation method. */
export function methodOfProvider(provider: string): MethodKey {
  return provider === 'kaspi-remote'
    ? 'kaspi_remote'
    : provider === 'kaspi-qr'
      ? 'kaspi_qr'
      : provider === 'tiptoppay'
        ? 'tiptoppay'
        : 'other';
}
export function fallbackMethod(source: Source): MethodKey {
  return source === 'kaspi'
    ? 'kaspi_other'
    : source === 'tiptoppay'
      ? 'tiptoppay'
      : source === 'cash'
        ? 'cash'
        : 'other';
}
export const STATES = [
  'matched',
  'late',
  'amount_differs',
  'missing_in_bank',
  'missing_in_pickchick',
  'duplicate',
] as const;
export type RecState = (typeof STATES)[number];
export const STATE_LABELS: Record<RecState, string> = {
  matched: 'Совпадает',
  late: 'Поздно / другой день',
  amount_differs: 'Сумма отличается',
  missing_in_bank: 'Нет в банке',
  missing_in_pickchick: 'Нет в PickChick',
  duplicate: 'Повтор',
};
export const RESOLUTION_STATUSES = ['open', 'in_progress', 'resolved', 'accepted'] as const;
export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];

// ---------------------------------------------------------------------------------------------
// Time: Asia/Almaty business day. Intl uses the tz database, like PostgreSQL AT TIME ZONE.
// ---------------------------------------------------------------------------------------------
const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: REC_TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const dayFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: REC_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
function offsetAt(ms: number) {
  const p = Object.fromEntries(
    partsFormat.formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return asUtc - Math.floor(ms / 1000) * 1000;
}
/** Almaty wall-clock time -> UTC epoch ms; null for an impossible calendar value. */
export function almatyToUtc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0) {
  if (y < 2000 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  const local = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(local);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  let utc = local - offsetAt(local);
  utc = local - offsetAt(utc);
  return utc;
}
export function businessDay(value: string | number | Date) {
  return dayFormat.format(new Date(value));
}
export const DayString = z.iso
  .date()
  .refine(
    (v) =>
      v >= '2024-01-01' &&
      v <= '2099-12-31' &&
      Number.isFinite(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v,
  );
/** UTC bounds of a business day: [start, end). */
export function dayBounds(day: string) {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const start = almatyToUtc(y, m, d)!;
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const end = almatyToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate())!;
  return { start: new Date(start), end: new Date(end) };
}
export function shiftDay(day: string, delta: number) {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Statement mapping profile and CSV parsing.
// ---------------------------------------------------------------------------------------------
const column = z.string().trim().min(1).max(100);
const optionalColumn = column.nullable().default(null);
const value = z.string().trim().min(1).max(60);
export const MappingSchema = z
  .strictObject({
    version: z.literal(1),
    /** Whose statement this is; matching never crosses sources. */
    source: z.enum(SOURCES),
    /** Method assumed for an unmatched line when the file has no method column. */
    default_method: z.enum(METHOD_KEYS).nullable().default(null),
    /** Used by the cabinet to decode the file before upload (Excel on Windows: windows-1251). */
    encoding: z.enum(['utf-8', 'windows-1251']).default('utf-8'),
    delimiter: z.enum([',', ';', '\t']),
    has_header: z.boolean(),
    /** Lines before the header (bank title, period, account). */
    skip_rows: z.number().int().min(0).max(50).default(0),
    columns: z.strictObject({
      occurred_at: column,
      time: optionalColumn,
      amount: column,
      fee: optionalColumn,
      operation_id: optionalColumn,
      reference: optionalColumn,
      method: optionalColumn,
      direction: optionalColumn,
      description: optionalColumn,
    }),
    date_format: z.enum(['dmy', 'ymd', 'iso']),
    decimal_separator: z.enum([',', '.']),
    amount_unit: z.enum(['major', 'minor']),
    /** Values of the direction column that mean a refund/outgoing operation (amount negated). */
    refund_values: z.array(value).max(20).default([]),
    /** Values of the method column mapped to methods of this source. */
    method_values: z.record(value, z.enum(METHOD_KEYS)).default({}),
    /** Rows that cannot be read (e.g. a final «Итого» row) are skipped and listed, not stored. */
    skip_invalid_rows: z.boolean().default(false),
    /** Amount+time matching window for lines without a matching operation id. */
    window_minutes: z.number().int().min(1).max(120).default(10),
  })
  .superRefine((m, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    const methods = [
      ...(m.default_method ? [m.default_method] : []),
      ...Object.values(m.method_values),
    ];
    if (methods.some((k) => METHODS[k].source !== m.source)) issue('Method outside the source');
    if (!m.has_header)
      for (const v of Object.values(m.columns))
        if (v !== null && !/^[1-9][0-9]{0,2}$/.test(v)) issue('Column numbers required');
    if (Object.keys(m.method_values).length > 20) issue('Too many method values');
    if (m.columns.time && m.date_format === 'iso') issue('ISO time carries its own time');
  });
export type Mapping = z.infer<typeof MappingSchema>;
export const STATEMENT_MAX_CHARS = 200_000;
export const STATEMENT_MAX_ROWS = 5000;

/** RFC 4180 records: quoted fields, doubled quotes, CRLF/LF; BOM removed. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [],
    field = '',
    quoted = false,
    started = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      started = true;
    } else if (c === delimiter) {
      record.push(field);
      field = '';
      started = true;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      started = false;
    } else {
      field += c;
      started = true;
    }
  }
  if (started || field !== '' || record.length) {
    record.push(field);
    records.push(record);
  }
  return records;
}
/** Stable digest of a statement file: same content -> same digest, whatever the line endings. */
export function statementDigest(text: string) {
  const s = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/u, ''))
    .join('\n')
    .replace(/\n+$/u, '');
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
export function cleanId(raw: string | undefined) {
  const v = (raw ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return v.length ? v.slice(0, 160) : null;
}
/** Phone-like digit runs (7+ digits) are masked: statements may carry personal data. */
export function cleanDescription(raw: string | undefined) {
  return (raw ?? '')
    .replace(CONTROL, ' ')
    .replace(/\+?\d(?:[\s()-]*\d){6,}/g, '•••')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}
export function parseAmount(
  raw: string,
  decimal: ',' | '.',
  unit: 'major' | 'minor',
): bigint | null {
  let s = raw.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s
    .replace(/₸|kzt|тенге|тг\.?/giu, '')
    .replace(/[\s\u00a0\u202f'\u2019]/gu, '')
    .replace(/^\+/, '');
  if (/^[-\u2212]/u.test(s)) {
    negative = !negative;
    s = s.slice(1);
  } else if (/[-\u2212]$/u.test(s)) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  s = decimal === ',' ? s.replaceAll('.', '').replace(',', '.') : s.replaceAll(',', '');
  let n: bigint;
  if (unit === 'minor') {
    if (!/^\d{1,14}$/.test(s)) return null;
    n = BigInt(s);
  } else {
    const m = s.match(/^(\d{1,12})(?:\.(\d{1,2}))?$/);
    if (!m) return null;
    n = BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
  }
  if (n > 99999999999999n) return null;
  return negative ? -n : n;
}
type Parsed = { ms: number; precision: 'second' | 'minute' | 'day' };
export function parseDateTime(
  dateRaw: string,
  timeRaw: string | null,
  format: 'dmy' | 'ymd' | 'iso',
): Parsed | null {
  const d = dateRaw.trim().replace(/\s+/g, ' ');
  if (format === 'iso') {
    const m = d.match(
      /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?$/,
    );
    if (!m) return null;
    if (m[7]) {
      const ms = Date.parse(
        `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}${m[7].length === 5 ? m[7].slice(0, 3) + ':' + m[7].slice(3) : m[7]}`,
      );
      const local = almatyToUtc(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
      return Number.isFinite(ms) && local !== null
        ? { ms, precision: m[6] ? 'second' : 'minute' }
        : null;
    }
    const ms = almatyToUtc(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
    return ms === null ? null : { ms, precision: m[6] ? 'second' : 'minute' };
  }
  const re =
    format === 'dmy'
      ? /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
      : /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
  const m = d.match(re);
  if (!m) return null;
  const [y, mo, day] =
    format === 'dmy' ? [+m[3]!, +m[2]!, +m[1]!] : ([+m[1]!, +m[2]!, +m[3]!] as const);
  let h = m[4],
    mi = m[5],
    s = m[6];
  if (timeRaw !== null) {
    if (h !== undefined) return null;
    const t = timeRaw.trim();
    if (t) {
      const tm = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if (!tm) return null;
      [h, mi, s] = [tm[1], tm[2], tm[3]];
    }
  }
  const ms = almatyToUtc(y, mo, day, +(h ?? 0), +(mi ?? 0), +(s ?? 0));
  if (ms === null) return null;
  return { ms, precision: h === undefined ? 'day' : s === undefined ? 'minute' : 'second' };
}
export type StatementLine = {
  row_number: number;
  occurred_at: string;
  business_day: string;
  time_precision: 'second' | 'minute' | 'day';
  amount_minor: string;
  fee_minor: string;
  operation_id: string | null;
  reference: string | null;
  method: MethodKey | null;
  description: string;
};
export type StatementIssue = { row: number; column: string; code: string };
export type StatementResult = {
  digest: string;
  rows: number;
  lines: StatementLine[];
  skipped: StatementIssue[];
  errors: StatementIssue[];
};
const norm = (v: string) => v.trim().replace(/\s+/g, ' ').toLowerCase();
export function parseStatement(text: string, mapping: Mapping): StatementResult {
  const digest = statementDigest(text);
  const records = parseCsv(text, mapping.delimiter);
  const errors: StatementIssue[] = [],
    skipped: StatementIssue[] = [],
    lines: StatementLine[] = [];
  const fail = (row: number, column: string, code: string) => {
    if (errors.length < 50) errors.push({ row, column, code });
    else if (errors.length === 50) errors.push({ row: 0, column: '', code: 'too_many_errors' });
  };
  let first = mapping.skip_rows;
  const index: Record<string, number> = {};
  const spec = mapping.columns as Record<string, string | null>;
  if (mapping.has_header) {
    const header = records[first];
    if (!header)
      return {
        digest,
        rows: 0,
        lines,
        skipped,
        errors: [{ row: 0, column: '', code: 'empty_file' }],
      };
    const names = header.map(norm);
    for (const [key, name] of Object.entries(spec)) {
      if (name === null) continue;
      const at = names.indexOf(norm(name));
      if (at < 0) fail(first + 1, key, 'missing_column');
      else index[key] = at;
    }
    first++;
  } else for (const [key, n] of Object.entries(spec)) if (n !== null) index[key] = Number(n) - 1;
  if (errors.length) return { digest, rows: 0, lines, skipped, errors };
  const body = records.slice(first);
  if (body.length > STATEMENT_MAX_ROWS)
    return {
      digest,
      rows: body.length,
      lines,
      skipped,
      errors: [{ row: 0, column: '', code: 'too_many_rows' }],
    };
  const refunds = new Set(mapping.refund_values.map(norm));
  const methods = new Map(Object.entries(mapping.method_values).map(([k, v]) => [norm(k), v]));
  body.forEach((cells, i) => {
    const row = first + i + 1;
    const cell = (key: string) =>
      index[key] === undefined ? undefined : (cells[index[key]!] ?? '');
    if (Object.keys(index).every((k) => !(cell(k) ?? '').trim())) return; // blank line
    const problems: [string, string][] = [];
    const when = parseDateTime(
      cell('occurred_at') ?? '',
      mapping.columns.time === null ? null : (cell('time') ?? ''),
      mapping.date_format,
    );
    if (!when) problems.push(['occurred_at', 'date']);
    let amount = parseAmount(cell('amount') ?? '', mapping.decimal_separator, mapping.amount_unit);
    if (amount === null) problems.push(['amount', 'amount']);
    const feeRaw = (cell('fee') ?? '').trim();
    const fee = feeRaw ? parseAmount(feeRaw, mapping.decimal_separator, mapping.amount_unit) : 0n;
    if (fee === null) problems.push(['fee', 'amount']);
    let method: MethodKey | null = mapping.default_method;
    const methodRaw = (cell('method') ?? '').trim();
    if (mapping.columns.method !== null && methodRaw) {
      const mapped = methods.get(norm(methodRaw));
      if (mapped) method = mapped;
    }
    if (problems.length) {
      if (mapping.skip_invalid_rows) {
        if (skipped.length < 200)
          skipped.push({ row, column: problems[0]![0], code: 'unreadable' });
      } else for (const [c, code] of problems) fail(row, c, code);
      return;
    }
    if (amount === 0n) {
      if (skipped.length < 200) skipped.push({ row, column: 'amount', code: 'zero' });
      return;
    }
    const direction = (cell('direction') ?? '').trim();
    if (direction && refunds.has(norm(direction))) amount = -(amount! < 0n ? -amount! : amount!);
    lines.push({
      row_number: row,
      occurred_at: new Date(when!.ms).toISOString(),
      business_day: businessDay(when!.ms),
      time_precision: when!.precision,
      amount_minor: String(amount),
      fee_minor: String(fee! < 0n ? -fee! : fee!),
      operation_id: cleanId(cell('operation_id')),
      reference: cleanId(cell('reference')),
      method,
      description: cleanDescription(cell('description')),
    });
  });
  return { digest, rows: body.length, lines, skipped, errors };
}

// ---------------------------------------------------------------------------------------------
// Matching.
// ---------------------------------------------------------------------------------------------
export type Fact = {
  /** c-<capture id> | r-<refund effect id> */
  id: string;
  kind: 'capture' | 'refund';
  method: MethodKey;
  /** Signed: a capture is money in (+), a refund is money out (-). */
  amount_minor: bigint;
  occurred_at: string;
  day: string;
  order_id: string;
  operation_id: string | null;
  /** Normalized identifiers a statement may carry: operation id, Kaspi invoice reference. */
  keys: string[];
  gift_minor: bigint;
};
export type Line = {
  id: string;
  import_id: string;
  /** Import order (older first) for deterministic matching. */
  import_seq: number;
  row_number: number;
  source: Source;
  method: MethodKey | null;
  amount_minor: bigint;
  fee_minor: bigint;
  occurred_at: string;
  day: string;
  time_precision: 'second' | 'minute' | 'day';
  operation_id: string | null;
  reference: string | null;
  description: string;
  window_seconds: number;
};
export type Total = {
  id: string;
  method: MethodKey;
  source: 'bank' | 'kkm';
  amount_minor: bigint;
  comment: string;
  created_at: string;
  author: string;
};
export type OrderCheck = {
  order_id: string;
  method: MethodKey;
  total_minor: bigint;
  captured_minor: bigint;
  refunded_minor: bigint;
  last_capture_day: string;
};
export type ShiftCheck = {
  shift_id: string;
  closed_at: string;
  day: string;
  discrepancy_minor: bigint;
};
export type ReconcileInput = {
  day: string;
  facts: Fact[];
  lines: Line[];
  totals: Total[];
  orders: OrderCheck[];
  shifts: ShiftCheck[];
  /** Pick Combo gift orders with nothing to pay, created on the day. */
  gifts: { orders: number; discount_minor: bigint };
  unknown_attempts: Partial<Record<MethodKey, number>>;
};
export type Rule =
  | 'operation_id'
  | 'amount_time'
  | 'unmatched'
  | 'duplicate_line'
  | 'manual_total'
  | 'no_bank_data'
  | 'double_payment'
  | 'cash_shift';
export type RowFact = {
  id: string;
  kind: 'capture' | 'refund';
  order_id: string;
  occurred_at: string;
  day: string;
  operation_id: string | null;
};
export type RowLine = {
  id: string;
  import_id: string;
  row_number: number;
  occurred_at: string;
  day: string;
  operation_id: string | null;
  reference: string | null;
  description: string;
  fee_minor: string;
};
export type Row = {
  key: string;
  state: RecState;
  rule: Rule;
  method: MethodKey;
  /** Difference attributable to this day, bank minus PickChick (see the lane doc per rule). */
  amount_minor: string;
  pickchick_minor: string | null;
  bank_minor: string | null;
  pickchick: RowFact | null;
  bank: RowLine | null;
  total: { id: string; source: 'bank' | 'kkm'; comment: string; author: string } | null;
  order_id: string | null;
  explanation: string;
  time: string | null;
};
export type MethodSummary = {
  method: MethodKey;
  label: string;
  source: Source;
  recorded: boolean;
  orders_paid: number;
  captures_count: number;
  captures_minor: string;
  refunds_count: number;
  refunds_minor: string;
  gifts_minor: string;
  /** Captures minus refunds of the day; null when PickChick does not record this method. */
  expected_minor: string | null;
  coverage: 'statement' | 'total' | 'none';
  bank_count: number;
  bank_minor: string;
  fees_minor: string;
  totals: { id: string; source: 'bank' | 'kkm'; amount_minor: string }[];
  /** External minus expected (statement first, else the latest manual total); null: nothing to compare. */
  difference_minor: string | null;
  unknown_attempts: number;
};
export type DayReport = {
  day: string;
  methods: MethodSummary[];
  rows: Row[];
  gifts: { orders: number; discount_minor: string };
  shifts_checked: number;
  fingerprint: string;
};
export function normalizeKey(v: string) {
  return v.trim().replace(/\s+/g, ' ').toUpperCase();
}
/** Internal identifiers: kaspi-remote captures are stored as kaspi:<op>, manual refunds as manual:<ref>. */
export function factKeys(operationId: string | null, extra: (string | null | undefined)[] = []) {
  const keys = new Set<string>();
  if (operationId) keys.add(normalizeKey(operationId.replace(/^(?:kaspi|manual):/u, '')));
  for (const v of extra) if (v) keys.add(normalizeKey(v));
  return [...keys].filter(Boolean);
}
const lineKeys = (l: Line) => [
  ...new Set([l.operation_id, l.reference].filter((v): v is string => !!v).map(normalizeKey)),
];
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const minutes = (ms: number) => Math.round(ms / 60000);
const ru = (day: string) => day.slice(8, 10) + '.' + day.slice(5, 7);
type LineState =
  { kind: 'pair'; fact: Fact; rule: 'operation_id' | 'amount_time' } | { kind: 'dup'; of: string };
export function reconcileDay(input: ReconcileInput): DayReport {
  const D = input.day;
  const facts = [...input.facts].sort(
    (a, b) => cmp(a.occurred_at, b.occurred_at) || cmp(a.id, b.id),
  );
  const lines = [...input.lines].sort(
    (a, b) =>
      cmp(a.occurred_at, b.occurred_at) ||
      a.import_seq - b.import_seq ||
      a.row_number - b.row_number ||
      cmp(a.id, b.id),
  );
  const source = (f: Fact) => METHODS[f.method].source;
  const byKey = new Map<string, Fact[]>();
  for (const f of facts)
    for (const k of f.keys)
      byKey.set(source(f) + '|' + k, [...(byKey.get(source(f) + '|' + k) ?? []), f]);
  const paired = new Map<string, Line>();
  const state = new Map<string, LineState>();
  const seen = new Map<string, string>();
  // A. Operation id / invoice reference. One fact pairs with one line; a repeated id in the same
  // direction is a duplicate. A statement may show a refund under the id of its payment (format
  // not confirmed), so money out never duplicates or pairs with money in under one id.
  const out = (v: bigint) => (v < 0n ? '-' : '+');
  for (const l of lines) {
    const keys = lineKeys(l);
    if (!keys.length) continue;
    const tag = (k: string) => l.source + '|' + out(l.amount_minor) + '|' + k;
    const dup = keys.map((k) => seen.get(tag(k))).find(Boolean);
    if (dup) {
      state.set(l.id, { kind: 'dup', of: dup });
      continue;
    }
    for (const k of keys) seen.set(tag(k), l.id);
    const candidates = [...new Set(keys.flatMap((k) => byKey.get(l.source + '|' + k) ?? []))]
      .filter((f) => !paired.has(f.id) && out(f.amount_minor) === out(l.amount_minor))
      .sort(
        (a, b) =>
          Number(l.method !== null && a.method !== l.method) -
            Number(l.method !== null && b.method !== l.method) ||
          Number(a.amount_minor !== l.amount_minor) - Number(b.amount_minor !== l.amount_minor),
      );
    const f = candidates[0];
    if (f) {
      paired.set(f.id, l);
      state.set(l.id, { kind: 'pair', fact: f, rule: 'operation_id' });
    }
  }
  // B. The same line without identifiers from another imported file (overlapping statements).
  const signatures = new Map<string, Line>();
  for (const l of lines) {
    if (state.has(l.id) || lineKeys(l).length) continue;
    const sig = [l.source, l.occurred_at, l.amount_minor, l.time_precision, l.description].join(
      '|',
    );
    const first = signatures.get(sig);
    if (first && first.import_id !== l.import_id) state.set(l.id, { kind: 'dup', of: first.id });
    else if (!first) signatures.set(sig, l);
  }
  // C. Amount + time window, only when at least one side has no identifier.
  for (const l of lines) {
    if (state.has(l.id)) continue;
    const keyed = lineKeys(l).length > 0;
    let best: Fact | null = null,
      bestDelta = Infinity;
    for (const f of facts) {
      if (paired.has(f.id) || source(f) !== l.source || f.amount_minor !== l.amount_minor) continue;
      if (l.method !== null && l.method !== f.method) continue;
      if (keyed && f.keys.length) continue;
      const delta = Math.abs(Date.parse(f.occurred_at) - Date.parse(l.occurred_at));
      const inside =
        l.time_precision === 'day'
          ? f.day === l.day
          : delta <= l.window_seconds * 1000 + (l.time_precision === 'minute' ? 60000 : 0);
      if (inside && delta < bestDelta) {
        best = f;
        bestDelta = delta;
      }
    }
    if (best) {
      paired.set(best.id, l);
      state.set(l.id, { kind: 'pair', fact: best, rule: 'amount_time' });
    }
  }
  const coverage = new Set(
    lines.filter((l) => l.day === D && state.get(l.id)?.kind !== 'dup').map((l) => l.source),
  );
  const rowFact = (f: Fact): RowFact => ({
    id: f.id,
    kind: f.kind,
    order_id: f.order_id,
    occurred_at: f.occurred_at,
    day: f.day,
    operation_id: f.operation_id,
  });
  const rowLine = (l: Line): RowLine => ({
    id: l.id,
    import_id: l.import_id,
    row_number: l.row_number,
    occurred_at: l.occurred_at,
    day: l.day,
    operation_id: l.operation_id,
    reference: l.reference,
    description: l.description,
    fee_minor: String(l.fee_minor),
  });
  const base = { total: null, order_id: null } as const;
  const rows: Row[] = [];
  const attributed = new Map<string, MethodKey>();
  for (const l of lines) {
    const s = state.get(l.id);
    if (s?.kind === 'pair') {
      const f = s.fact;
      attributed.set(l.id, f.method);
      if (f.day !== D && l.day !== D) continue;
      const equal = f.amount_minor === l.amount_minor;
      const st: RecState = !equal ? 'amount_differs' : f.day !== l.day ? 'late' : 'matched';
      const diff = (l.day === D ? l.amount_minor : 0n) - (f.day === D ? f.amount_minor : 0n);
      rows.push({
        ...base,
        key: `pair:${f.id}:${l.id}`,
        state: st,
        rule: s.rule,
        method: f.method,
        amount_minor: String(diff),
        pickchick_minor: String(f.amount_minor),
        bank_minor: String(l.amount_minor),
        pickchick: rowFact(f),
        bank: rowLine(l),
        order_id: f.order_id,
        time: f.day === D ? f.occurred_at : l.occurred_at,
        explanation:
          st === 'matched'
            ? s.rule === 'operation_id'
              ? 'Совпадает по номеру операции'
              : `Совпадает по сумме и времени (разница ${minutes(Math.abs(Date.parse(f.occurred_at) - Date.parse(l.occurred_at)))} мин)`
            : st === 'late'
              ? `Другой день: в PickChick ${ru(f.day)}, в банке ${ru(l.day)}`
              : s.rule === 'operation_id'
                ? 'Номер операции совпадает, суммы различаются'
                : 'Суммы различаются',
      });
      continue;
    }
    const method = l.method ?? fallbackMethod(l.source);
    attributed.set(l.id, method);
    if (l.day !== D) continue;
    if (s?.kind === 'dup')
      rows.push({
        ...base,
        key: `ext:${l.id}`,
        state: 'duplicate',
        rule: 'duplicate_line',
        method,
        amount_minor: '0',
        pickchick_minor: null,
        bank_minor: String(l.amount_minor),
        pickchick: null,
        bank: rowLine(l),
        time: l.occurred_at,
        explanation: 'Повтор строки выписки: не учитывается в сумме банка',
      });
    else
      rows.push({
        ...base,
        key: `ext:${l.id}`,
        state: 'missing_in_pickchick',
        rule: 'unmatched',
        method,
        amount_minor: String(l.amount_minor),
        pickchick_minor: null,
        bank_minor: String(l.amount_minor),
        pickchick: null,
        bank: rowLine(l),
        time: l.occurred_at,
        explanation: 'Операция есть в выписке, в PickChick не найдена',
      });
  }
  const uncovered = new Map<MethodKey, Fact[]>();
  for (const f of facts) {
    if (f.day !== D || paired.has(f.id)) continue;
    if (coverage.has(source(f)))
      rows.push({
        ...base,
        key: `int:${f.id}`,
        state: 'missing_in_bank',
        rule: 'unmatched',
        method: f.method,
        amount_minor: String(-f.amount_minor),
        pickchick_minor: String(f.amount_minor),
        bank_minor: null,
        pickchick: rowFact(f),
        bank: null,
        order_id: f.order_id,
        time: f.occurred_at,
        explanation: 'Оплата есть в PickChick, в выписке не найдена',
      });
    else uncovered.set(f.method, [...(uncovered.get(f.method) ?? []), f]);
  }
  // Method summaries.
  const today = facts.filter((f) => f.day === D);
  const todayLines = lines.filter((l) => l.day === D && state.get(l.id)?.kind !== 'dup');
  const methods: MethodSummary[] = [];
  for (const method of METHOD_KEYS) {
    const m = METHODS[method];
    const own = today.filter((f) => f.method === method);
    const captures = own.filter((f) => f.kind === 'capture'),
      refunds = own.filter((f) => f.kind === 'refund');
    const sum = (v: bigint[]) => v.reduce((a, b) => a + b, 0n);
    const capturesMinor = sum(captures.map((f) => f.amount_minor)),
      refundsMinor = -sum(refunds.map((f) => f.amount_minor));
    const bank = todayLines.filter((l) => attributed.get(l.id) === method);
    const totals = input.totals.filter((t) => t.method === method);
    const expected = m.recorded ? capturesMinor - refundsMinor : null;
    const coverageKind: MethodSummary['coverage'] = coverage.has(m.source)
      ? 'statement'
      : totals.length
        ? 'total'
        : 'none';
    const bankMinor = sum(bank.map((l) => l.amount_minor));
    const latest = [...totals].sort((a, b) =>
      a.source === b.source ? cmp(b.created_at, a.created_at) : a.source === 'bank' ? -1 : 1,
    )[0];
    const difference =
      coverageKind === 'statement'
        ? bankMinor - (expected ?? 0n)
        : latest
          ? latest.amount_minor - (expected ?? 0n)
          : null;
    const shown =
      !['kaspi_other', 'other'].includes(method) ||
      own.length > 0 ||
      bank.length > 0 ||
      totals.length > 0;
    if (!shown) continue;
    methods.push({
      method,
      label: m.label,
      source: m.source,
      recorded: m.recorded,
      orders_paid: new Set(captures.map((f) => f.order_id)).size,
      captures_count: captures.length,
      captures_minor: String(capturesMinor),
      refunds_count: refunds.length,
      refunds_minor: String(refundsMinor),
      gifts_minor: String(
        sum([...new Map(captures.map((f) => [f.order_id, f.gift_minor])).values()]),
      ),
      expected_minor: expected === null ? null : String(expected),
      coverage: coverageKind,
      bank_count: bank.length,
      bank_minor: String(bankMinor),
      fees_minor: String(sum(bank.map((l) => l.fee_minor))),
      totals: totals.map((t) => ({
        id: t.id,
        source: t.source,
        amount_minor: String(t.amount_minor),
      })),
      difference_minor: difference === null ? null : String(difference),
      unknown_attempts: input.unknown_attempts[method] ?? 0,
    });
    // No statement for the source and no manual total: one "no bank data" item per method.
    const missing = uncovered.get(method) ?? [];
    if (missing.length && !totals.length) {
      const amount = sum(missing.map((f) => f.amount_minor));
      rows.push({
        ...base,
        key: `nobank:${method}`,
        state: 'missing_in_bank',
        rule: 'no_bank_data',
        method,
        amount_minor: String(-amount),
        pickchick_minor: String(amount),
        bank_minor: null,
        pickchick: null,
        bank: null,
        time: null,
        explanation: `Нет данных банка за день (${missing.length} операций): загрузите выписку или введите итог`,
      });
    }
    for (const t of totals) {
      const diff = expected === null ? t.amount_minor : t.amount_minor - expected;
      rows.push({
        ...base,
        key: `total:${t.id}`,
        state:
          diff === 0n ? 'matched' : expected === null ? 'missing_in_pickchick' : 'amount_differs',
        rule: 'manual_total',
        method,
        amount_minor: String(diff),
        pickchick_minor: expected === null ? null : String(expected),
        bank_minor: String(t.amount_minor),
        pickchick: null,
        bank: null,
        total: { id: t.id, source: t.source, comment: t.comment, author: t.author },
        time: t.created_at,
        explanation:
          expected === null
            ? diff === 0n
              ? 'Итог без операций'
              : 'PickChick не учитывает этот способ: касса пока не передаёт оплаты'
            : diff === 0n
              ? `Итог ${t.source === 'bank' ? 'банка' : 'ККМ'} совпадает с PickChick`
              : `Итог ${t.source === 'bank' ? 'банка' : 'ККМ'} отличается от PickChick`,
      });
    }
  }
  for (const o of input.orders) {
    const excess = o.captured_minor - o.refunded_minor - o.total_minor;
    if (excess <= 0n || o.last_capture_day !== D) continue;
    rows.push({
      ...base,
      key: `order:${o.order_id}`,
      state: 'duplicate',
      rule: 'double_payment',
      method: o.method,
      amount_minor: String(excess),
      pickchick_minor: String(o.captured_minor - o.refunded_minor),
      bank_minor: null,
      pickchick: null,
      bank: null,
      order_id: o.order_id,
      time: null,
      explanation: `Заказ оплачен больше суммы заказа (${o.total_minor} в минимальных единицах): нужен возврат или пояснение`,
    });
  }
  for (const s of input.shifts) {
    if (s.day !== D || s.discrepancy_minor === 0n) continue;
    rows.push({
      ...base,
      key: `shift:${s.shift_id}`,
      state: 'amount_differs',
      rule: 'cash_shift',
      method: 'cash',
      amount_minor: String(s.discrepancy_minor),
      pickchick_minor: null,
      bank_minor: null,
      pickchick: null,
      bank: null,
      time: s.closed_at,
      explanation: 'Расхождение наличных при закрытии кассовой смены (пересчёт минус ожидаемое)',
    });
  }
  rows.sort((a, b) => cmp(a.time ?? '', b.time ?? '') || cmp(a.key, b.key));
  const gifts = { orders: input.gifts.orders, discount_minor: String(input.gifts.discount_minor) };
  return {
    day: D,
    methods,
    rows,
    gifts,
    shifts_checked: input.shifts.filter((s) => s.day === D).length,
    fingerprint: fingerprint(D, methods, rows),
  };
}
/** Money-relevant content of a day; equal fingerprints mean nothing to re-check. */
export function fingerprint(day: string, methods: MethodSummary[], rows: Row[]) {
  const money = methods.map((m) => [
    m.method,
    m.captures_count,
    m.captures_minor,
    m.refunds_count,
    m.refunds_minor,
    m.expected_minor,
    m.bank_count,
    m.bank_minor,
    m.totals.map((t) => t.id + '=' + t.amount_minor).join(','),
  ]);
  const items = rows.map((r) => [r.key, r.state, r.amount_minor]).sort((a, b) => cmp(a[0]!, b[0]!));
  return createHash('sha256').update(JSON.stringify({ day, money, items })).digest('hex');
}
