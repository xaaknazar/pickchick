import { ApiError, type Request } from './api.js';

/**
 * Daily payment reconciliation in the cabinet (stage 2, lane rec). The server computes the day;
 * this model only loads it, keeps an unconfirmed command for recovery (same request id) and
 * builds the accountant's CSV. The section stays hidden while the server flag is off.
 */
export const METHOD_LABELS: Record<string, { label: string; source: string }> = {
  kaspi_remote: { label: 'Kaspi: счёт на телефон (приложение, киоск)', source: 'kaspi' },
  kaspi_qr: { label: 'Kaspi QR на киоске', source: 'kaspi' },
  manual_refund: { label: 'Ручные возвраты в Kaspi Pay', source: 'kaspi' },
  kaspi_pos: { label: 'Kaspi Smart POS на кассе', source: 'kaspi' },
  kaspi_other: { label: 'Kaspi: способ не определён', source: 'kaspi' },
  tiptoppay: { label: 'TipTopPay (карта)', source: 'tiptoppay' },
  cash: { label: 'Наличные на кассе', source: 'cash' },
  other: { label: 'Другие провайдеры', source: 'other' },
};
export const SOURCE_LABELS: Record<string, string> = {
  kaspi: 'Kaspi Pay',
  tiptoppay: 'TipTopPay',
  cash: 'Касса (наличные)',
  other: 'Другой источник',
};
export const STATE_LABELS: Record<string, string> = {
  matched: 'Совпадает',
  late: 'Поздно / другой день',
  amount_differs: 'Сумма отличается',
  missing_in_bank: 'Нет в банке',
  missing_in_pickchick: 'Нет в PickChick',
  duplicate: 'Повтор',
};
export const RULE_LABELS: Record<string, string> = {
  operation_id: 'По номеру операции',
  amount_time: 'По сумме и времени',
  unmatched: 'Пара не найдена',
  duplicate_line: 'Повтор строки выписки',
  manual_total: 'Итог вручную',
  no_bank_data: 'Нет данных банка',
  double_payment: 'Двойная оплата заказа',
  cash_shift: 'Закрытие кассовой смены',
};
export const STATUS_LABELS: Record<string, string> = {
  open: 'Открыто',
  in_progress: 'В работе',
  resolved: 'Решено',
  accepted: 'Принято с причиной',
};
export const COVERAGE_LABELS: Record<string, string> = {
  statement: 'Выписка',
  total: 'Итог вручную',
  none: 'Нет данных банка',
};
export type Resolution = {
  status: 'open' | 'in_progress' | 'resolved' | 'accepted';
  assignee_id: string | null;
  assignee_name: string | null;
  comment: string;
  revision: number;
  updated_at: string;
  author: string;
};
export type RecRow = {
  key: string;
  state: string;
  rule: string;
  method: string;
  amount_minor: string;
  pickchick_minor: string | null;
  bank_minor: string | null;
  pickchick: {
    id: string;
    kind: string;
    order_id: string;
    occurred_at: string;
    day: string;
    operation_id: string | null;
  } | null;
  bank: {
    id: string;
    import_id: string;
    row_number: number;
    occurred_at: string;
    day: string;
    operation_id: string | null;
    reference: string | null;
    description: string;
    fee_minor: string;
  } | null;
  total: { id: string; source: string; comment: string; author: string } | null;
  order_id: string | null;
  explanation: string;
  time: string | null;
  resolution: Resolution | null;
  stale_resolution: Resolution | null;
  item_revision: number;
  blocking: boolean;
};
export type RecMethod = {
  method: string;
  label: string;
  source: string;
  recorded: boolean;
  orders_paid: number;
  captures_count: number;
  captures_minor: string;
  refunds_count: number;
  refunds_minor: string;
  gifts_minor: string;
  expected_minor: string | null;
  coverage: 'statement' | 'total' | 'none';
  bank_count: number;
  bank_minor: string;
  fees_minor: string;
  totals: { id: string; source: string; amount_minor: string }[];
  difference_minor: string | null;
  unknown_attempts: number;
};
export type Mapping = {
  version: 1;
  source: string;
  default_method: string | null;
  encoding: 'utf-8' | 'windows-1251';
  delimiter: ',' | ';' | '\t';
  has_header: boolean;
  skip_rows: number;
  columns: Record<
    | 'occurred_at'
    | 'time'
    | 'amount'
    | 'fee'
    | 'operation_id'
    | 'reference'
    | 'method'
    | 'direction'
    | 'description',
    string | null
  >;
  date_format: 'dmy' | 'ymd' | 'iso';
  decimal_separator: ',' | '.';
  amount_unit: 'major' | 'minor';
  refund_values: string[];
  method_values: Record<string, string>;
  skip_invalid_rows: boolean;
  window_minutes: number;
};
export type RecSnapshot = {
  schema_version: 1;
  branch_id: string;
  day: string;
  as_of: string;
  role: 'manager' | 'accountant' | 'analyst';
  writable: boolean;
  actor_id: string;
  day_finished: boolean;
  state: 'open' | 'closed';
  revision: number;
  closed: { at: string; by: string; fingerprint: string } | null;
  drift: boolean;
  report: {
    day: string;
    methods: RecMethod[];
    rows: RecRow[];
    gifts: { orders: number; discount_minor: string };
    shifts_checked: number;
    fingerprint: string;
    open_items: number;
  };
  live_open_items: number;
  tiptoppay_test: { payments: number; amount_minor: string } | null;
  totals: {
    id: string;
    method: string;
    source: string;
    amount_minor: string;
    comment: string;
    created_at: string;
    author: string;
    void_reason: string | null;
    voided_at: string | null;
  }[];
  imports: {
    id: string;
    file_name: string;
    source: string;
    line_count: number;
    skipped_count: number;
    duplicate_count: number;
    created_at: string;
    author: string;
    void_reason: string | null;
    voided_at: string | null;
    days: string[] | null;
  }[];
  profiles: {
    id: string;
    name: string;
    revision: number;
    mapping: Mapping;
    archived: boolean;
    updated_at: string;
  }[];
  assignees: { id: string; name: string; role: string }[];
  history: {
    revision: number;
    kind: 'close' | 'reopen';
    reason: string;
    created_at: string;
    author: string;
  }[];
  days: { day: string; kind: string; revision: number }[];
  limits: { statement_max_chars: number; statement_max_rows: number };
};
export type Preview = {
  digest: string;
  rows: number;
  valid: boolean;
  errors: { row: number; column: string; code: string }[];
  skipped: { row: number; column: string; code: string }[];
  lines: number;
  already_imported: number;
  duplicate_import: string | null;
  days: { day: string; lines: number; amount_minor: string; closed: boolean }[];
  sample: {
    row_number: number;
    occurred_at: string;
    amount_minor: string;
    fee_minor: string;
    operation_id: string | null;
    reference: string | null;
    method: string | null;
    description: string;
  }[];
};
const fail = (): never => {
  throw new ApiError('INVALID_RESPONSE');
};
const object = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : fail();
export function parseSnapshot(value: unknown, branch: string, day: string): RecSnapshot {
  const d = object(value);
  const report = object(d['report']);
  if (
    d['schema_version'] !== 1 ||
    d['branch_id'] !== branch ||
    d['day'] !== day ||
    !['manager', 'accountant', 'analyst'].includes(String(d['role'])) ||
    typeof d['writable'] !== 'boolean' ||
    !['open', 'closed'].includes(String(d['state'])) ||
    !Number.isInteger(d['revision']) ||
    typeof d['drift'] !== 'boolean' ||
    !Array.isArray(report['methods']) ||
    !Array.isArray(report['rows']) ||
    !Array.isArray(d['totals']) ||
    !Array.isArray(d['imports']) ||
    !Array.isArray(d['profiles']) ||
    !Array.isArray(d['assignees']) ||
    !Array.isArray(d['history'])
  )
    fail();
  for (const r of report['rows'] as unknown[]) {
    const row = object(r);
    if (
      typeof row['key'] !== 'string' ||
      !(String(row['state']) in STATE_LABELS) ||
      !/^-?\d+$/.test(String(row['amount_minor'])) ||
      typeof row['blocking'] !== 'boolean'
    )
      fail();
  }
  for (const m of report['methods'] as unknown[]) {
    const method = object(m);
    if (typeof method['label'] !== 'string' || !/^-?\d+$/.test(String(method['captures_minor'])))
      fail();
  }
  return d as unknown as RecSnapshot;
}
/** Signed amount typed in tenge ("1 234,50", "-500") -> integer minor units. */
export function signedMinor(input: string): string {
  const v = input.trim().replace(/[\s\u00a0\u202f]/gu, '');
  const m = v.match(/^(-?)(\d{1,12})(?:[.,](\d{1,2}))?$/);
  if (!m) throw new Error('Укажите сумму в тенге, до двух знаков после запятой.');
  const n = BigInt(m[2]!) * 100n + BigInt((m[3] ?? '').padEnd(2, '0'));
  return String(m[1] && n > 0n ? -n : n);
}
export function tenge(minor: string | null | undefined): string {
  if (minor === null || minor === undefined || !/^-?\d+$/.test(minor)) return '-';
  const n = BigInt(minor),
    a = n < 0n ? -n : n;
  return `${n < 0n ? '-' : ''}${(a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${String(a % 100n).padStart(2, '0')} ₸`;
}
/** Plain decimal for spreadsheets: "-3000,00". */
export function decimal(minor: string | null | undefined): string {
  if (minor === null || minor === undefined || !/^-?\d+$/.test(minor)) return '';
  const n = BigInt(minor),
    a = n < 0n ? -n : n;
  return `${n < 0n ? '-' : ''}${a / 100n},${String(a % 100n).padStart(2, '0')}`;
}
const timeFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Almaty',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
export const almatyTime = (iso: string | null | undefined) =>
  iso ? timeFormat.format(new Date(iso)) : '';
export function almatyDay(date: Date) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Almaty',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
export function previousDay(day: string) {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}
export function decodeStatement(bytes: ArrayBuffer, encoding: Mapping['encoding']) {
  return new TextDecoder(encoding === 'windows-1251' ? 'windows-1251' : 'utf-8').decode(bytes);
}
/** Form state of a mapping profile; every value is text as typed by the accountant. */
export type MappingDraft = {
  source: string;
  default_method: string;
  encoding: Mapping['encoding'];
  delimiter: Mapping['delimiter'];
  has_header: boolean;
  skip_rows: string;
  occurred_at: string;
  time: string;
  amount: string;
  fee: string;
  operation_id: string;
  reference: string;
  method: string;
  direction: string;
  description: string;
  date_format: Mapping['date_format'];
  decimal_separator: Mapping['decimal_separator'];
  amount_unit: Mapping['amount_unit'];
  refund_values: string;
  method_values: string;
  skip_invalid_rows: boolean;
  window_minutes: string;
};
const COLUMNS = [
  'occurred_at',
  'time',
  'amount',
  'fee',
  'operation_id',
  'reference',
  'method',
  'direction',
  'description',
] as const;
export function draftFromMapping(m: Mapping | null): MappingDraft {
  return {
    source: m?.source ?? 'kaspi',
    default_method: m?.default_method ?? '',
    encoding: m?.encoding ?? 'utf-8',
    delimiter: m?.delimiter ?? ';',
    has_header: m?.has_header ?? true,
    skip_rows: String(m?.skip_rows ?? 0),
    ...(Object.fromEntries(COLUMNS.map((c) => [c, m?.columns[c] ?? ''])) as Record<
      (typeof COLUMNS)[number],
      string
    >),
    date_format: m?.date_format ?? 'dmy',
    decimal_separator: m?.decimal_separator ?? ',',
    amount_unit: m?.amount_unit ?? 'major',
    refund_values: (m?.refund_values ?? []).join(', '),
    method_values: Object.entries(m?.method_values ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    skip_invalid_rows: m?.skip_invalid_rows ?? false,
    window_minutes: String(m?.window_minutes ?? 10),
  };
}
export function mappingFromDraft(d: MappingDraft): Mapping {
  const sourceName = SOURCE_LABELS[d.source] ?? d.source;
  const inSource = (method: string) => {
    if (METHOD_LABELS[method]?.source !== d.source)
      throw new Error(`Способ «${method}» не относится к источнику «${sourceName}».`);
    return method;
  };
  if (!d.occurred_at.trim()) throw new Error('Укажите колонку даты операции.');
  if (!d.amount.trim()) throw new Error('Укажите колонку суммы.');
  const columns = Object.fromEntries(
    COLUMNS.map((c) => [c, d[c].trim() ? d[c].trim() : null]),
  ) as Mapping['columns'];
  if (!d.has_header && Object.values(columns).some((v) => v !== null && !/^[1-9]\d{0,2}$/.test(v)))
    throw new Error('Без строки заголовка укажите номера колонок: 1, 2, 3…');
  const methodValues: Record<string, string> = {};
  for (const line of d.method_values.split('\n')) {
    if (!line.trim()) continue;
    const at = line.indexOf('=');
    if (at < 1) throw new Error('Значения способа: по одному на строку, «значение=способ».');
    methodValues[line.slice(0, at).trim()] = inSource(line.slice(at + 1).trim());
  }
  const skip = Number(d.skip_rows),
    window = Number(d.window_minutes);
  if (!Number.isInteger(skip) || skip < 0 || skip > 50)
    throw new Error('Строк до заголовка: от 0 до 50.');
  if (!Number.isInteger(window) || window < 1 || window > 120)
    throw new Error('Окно сопоставления: от 1 до 120 минут.');
  return {
    version: 1,
    source: d.source,
    default_method: d.default_method ? inSource(d.default_method) : null,
    encoding: d.encoding,
    delimiter: d.delimiter,
    has_header: d.has_header,
    skip_rows: skip,
    columns,
    date_format: d.date_format,
    decimal_separator: d.decimal_separator,
    amount_unit: d.amount_unit,
    refund_values: d.refund_values
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
    method_values: methodValues,
    skip_invalid_rows: d.skip_invalid_rows,
    window_minutes: window,
  };
}
export const CSV_HEADER = [
  'День',
  'Тип строки',
  'Способ оплаты',
  'Состояние',
  'Правило сопоставления',
  'Время PickChick',
  'Сумма PickChick, ₸',
  'Заказ',
  'Операция PickChick',
  'Время банка',
  'Сумма банка / итог, ₸',
  'Операция банка',
  'Ссылка банка',
  'Комиссия банка, ₸',
  'Разница, ₸',
  'Пояснение',
  'Ответственный',
  'Статус решения',
  'Комментарий',
];
const decision = (r: RecRow) =>
  r.state === 'matched'
    ? ''
    : r.resolution
      ? (STATUS_LABELS[r.resolution.status] ?? r.resolution.status)
      : r.stale_resolution
        ? 'Не решено (решение устарело)'
        : 'Не решено';
/** Every amount of the day with its explanation, for the accountant (one sheet, ";"-separated). */
export function dayCsv(d: RecSnapshot): string[][] {
  const out: string[][] = [CSV_HEADER];
  for (const m of d.report.methods) {
    const external =
      m.coverage === 'statement'
        ? m.bank_minor
        : m.coverage === 'total'
          ? ([...m.totals].sort((a, b) =>
              a.source === 'bank' ? -1 : b.source === 'bank' ? 1 : 0,
            )[0]?.amount_minor ?? null)
          : null;
    out.push([
      d.day,
      'Итог по способу',
      m.label,
      COVERAGE_LABELS[m.coverage] ?? m.coverage,
      '',
      '',
      decimal(m.expected_minor),
      '',
      '',
      '',
      decimal(external),
      '',
      '',
      decimal(m.fees_minor),
      decimal(m.difference_minor),
      `Заказов оплачено ${m.orders_paid}; оплат ${m.captures_count} на ${decimal(m.captures_minor)}; возвратов ${m.refunds_count} на ${decimal(m.refunds_minor)}; подарки ${decimal(m.gifts_minor)}` +
        (m.recorded ? '' : '; PickChick не учитывает этот способ'),
      '',
      '',
      '',
    ]);
  }
  if (d.report.gifts.orders > 0)
    out.push([
      d.day,
      'Подарки без оплаты',
      'Pick Combo (подарок)',
      '',
      '',
      '',
      decimal(d.report.gifts.discount_minor),
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '0,00',
      `Заказов: ${d.report.gifts.orders}. Скидка подарком, денег нет`,
      '',
      '',
      '',
    ]);
  for (const r of d.report.rows) {
    const res = r.resolution ?? r.stale_resolution;
    out.push([
      d.day,
      r.total ? 'Итог вручную' : r.pickchick || r.bank ? 'Операция' : 'Проверка дня',
      METHOD_LABELS[r.method]?.label ?? r.method,
      STATE_LABELS[r.state] ?? r.state,
      RULE_LABELS[r.rule] ?? r.rule,
      almatyTime(r.pickchick?.occurred_at),
      decimal(r.pickchick_minor),
      r.order_id ?? '',
      r.pickchick?.operation_id ?? '',
      almatyTime(r.bank?.occurred_at ?? (r.total ? r.time : null)),
      decimal(r.bank_minor),
      r.bank?.operation_id ?? '',
      r.bank?.reference ?? '',
      decimal(r.bank?.fee_minor),
      decimal(r.amount_minor),
      r.explanation +
        (r.total ? ` (${r.total.source === 'bank' ? 'банк' : 'ККМ'}: ${r.total.comment})` : '') +
        (r.bank?.description ? ` / ${r.bank.description}` : ''),
      res?.assignee_name ?? '',
      decision(r),
      res?.comment ?? '',
    ]);
  }
  return out;
}
/** UTF-8 with BOM for Excel; numbers stay numbers, any other cell cannot start a formula. */
export function csvText(rows: string[][]) {
  const cell = (v: string) =>
    '"' +
    (/^-?\d+(,\d+)?$/.test(v) || !/^[=+\-@\t\r]/.test(v) ? v : "'" + v).replaceAll('"', '""') +
    '"';
  return '﻿' + rows.map((row) => row.map(cell).join(';')).join('\r\n');
}
type Pending = {
  actor: string;
  branch: string;
  body: { request_id: string; reason: string; command: Record<string, unknown> };
};
const REASONS: Record<string, string> = {
  DAY_CLOSED: 'День закрыт. Чтобы что-то изменить, откройте его заново с причиной.',
  DAY_NOT_CLOSED: 'День уже открыт.',
  DAY_NOT_FINISHED: 'День ещё не закончился по времени Алматы - закрыть его можно завтра.',
  DIFFERENCES_OPEN:
    'Есть нерешённые расхождения: решите их или примите с причиной, затем закройте день.',
  DUPLICATE_IMPORT:
    'Этот файл уже загружен. Чтобы загрузить его заново, сначала отмените прежнюю загрузку.',
  STATEMENT_INVALID: 'Файл не соответствует профилю. Проверьте его кнопкой «Проверить файл».',
  ITEM_CHANGED: 'Расхождение изменилось: пришли новые данные. Обновите день и проверьте ещё раз.',
  TOTAL_EXISTS: 'Итог для этого способа и источника уже введён - замените его.',
  REVISION_CHANGED: 'Данные уже изменил другой сотрудник. Обновите день.',
  ASSIGNEE_UNKNOWN: 'Ответственный должен иметь доступ к кабинету этой точки.',
  PROFILE_NAME_TAKEN: 'Профиль с таким названием уже есть.',
  RECONCILIATION_NOT_INSTALLED: 'Сверка ещё не установлена на сервере (миграция 071).',
};
const CODES: Record<string, string> = {
  FORBIDDEN: 'Только просмотр: изменять сверку могут управляющий и бухгалтер точки.',
  UNAUTHORIZED: 'Войдите заново.',
  INVALID_REQUEST: 'Проверьте введённые данные.',
  NOT_FOUND: 'Запись не найдена. Обновите день.',
  CONFLICT: 'Данные уже изменились. Обновите день.',
  PAYLOAD_TOO_LARGE: 'Файл слишком большой: разделите выписку на части.',
  SERVICE_UNAVAILABLE: 'Сверка временно недоступна. Повторите позже.',
};
export function explain(e: unknown) {
  if (e instanceof ApiError)
    return (
      (e.reason ? REASONS[e.reason] : undefined) ??
      CODES[e.code] ??
      'Ответ сервера не подтверждён. Повторите проверку результата.'
    );
  return e instanceof Error ? e.message : 'Не удалось выполнить операцию.';
}
export class ReconciliationModel {
  actor = '';
  branch = '';
  day: string;
  data: RecSnapshot | null = null;
  /** Server flag off or an API without this section: nothing is shown. */
  unavailable = false;
  pending: Pending | null = null;
  preview: Preview | null = null;
  busy = false;
  error = '';
  notice = '';
  private generation = 0;
  private storageBroken = false;
  constructor(
    private api: (path: string, request?: Request) => Promise<unknown>,
    private storage: Storage,
    private changed: () => void,
    private now: () => Date = () => new Date(),
  ) {
    this.day = previousDay(almatyDay(this.now()));
  }
  get today() {
    return almatyDay(this.now());
  }
  /** Re-render after a view-only change (a selected file, a form option). */
  refresh() {
    this.changed();
  }
  private key() {
    return 'pickchick.reconciliation.v1:' + this.actor;
  }
  clear() {
    this.generation++;
    this.actor = '';
    this.branch = '';
    this.data = null;
    this.pending = null;
    this.preview = null;
    this.busy = false;
    this.error = '';
    this.notice = '';
    this.unavailable = false;
    this.storageBroken = false;
  }
  async scope(actor: string, branch: string) {
    if (this.actor === actor && this.branch === branch) return;
    this.clear();
    this.actor = actor;
    this.branch = branch;
    try {
      const raw = this.storage.getItem(this.key());
      if (raw) {
        const p = JSON.parse(raw) as Pending;
        if (p.actor !== actor || !p.body?.request_id || !p.body.command) throw Error();
        if (p.branch === branch) this.pending = p;
      }
    } catch {
      this.storageBroken = true;
      this.error =
        'Журнал восстановления недоступен. Изменения заблокированы; обновите страницу или обратитесь к администратору.';
    }
    await this.load();
  }
  async setDay(day: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > this.today) return;
    this.day = day;
    this.preview = null;
    this.notice = '';
    await this.load();
  }
  async load() {
    if (!this.actor || !this.branch) return;
    const generation = ++this.generation,
      day = this.day;
    this.busy = true;
    this.changed();
    try {
      const d = parseSnapshot(
        await this.api(`branches/${this.branch}/reconciliation?day=${day}`),
        this.branch,
        day,
      );
      if (generation === this.generation) {
        this.data = d;
        this.unavailable = false;
        if (!this.storageBroken) this.error = '';
      }
    } catch (e) {
      if (generation === this.generation) {
        this.data = null;
        this.unavailable =
          e instanceof ApiError &&
          ((e.code === 'SERVICE_UNAVAILABLE' && e.reason === 'RECONCILIATION_DISABLED') ||
            e.code === 'NOT_FOUND');
        this.error = this.unavailable ? '' : explain(e);
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.changed();
      }
    }
  }
  get writable() {
    return (
      !!this.data &&
      this.data.writable &&
      this.data.role !== 'analyst' &&
      !this.busy &&
      !this.pending &&
      !this.storageBroken
    );
  }
  async send(command: Record<string, unknown>, reason: string) {
    if (!this.writable) return false;
    const p: Pending = {
      actor: this.actor,
      branch: this.branch,
      body: { request_id: crypto.randomUUID(), reason, command },
    };
    try {
      this.storage.setItem(this.key(), JSON.stringify(p));
      if (this.storage.getItem(this.key()) !== JSON.stringify(p)) throw Error();
    } catch {
      this.storageBroken = true;
      this.error = 'Браузер не сохранил запрос. Он не отправлен. Проверьте доступность хранилища.';
      this.changed();
      return false;
    }
    this.pending = p;
    return this.recover();
  }
  async recover() {
    if (!this.pending || this.busy) return false;
    const p = this.pending,
      generation = this.generation;
    this.busy = true;
    this.error = '';
    this.notice = '';
    this.changed();
    let ok = false;
    try {
      const result = await this.api(`branches/${p.branch}/reconciliation/commands`, {
        method: 'POST',
        body: p.body,
      });
      if (!result || typeof result !== 'object') throw new ApiError('INVALID_RESPONSE');
      if (generation !== this.generation) return false;
      this.storage.removeItem(this.key());
      this.pending = null;
      this.preview = p.body.command['type'] === 'import' ? null : this.preview;
      this.notice = notices[String(p.body.command['type'])] ?? 'Сохранено на сервере.';
      ok = true;
    } catch (e) {
      if (generation === this.generation) {
        this.error = explain(e);
        // A rejected command (400/409) was not applied; anything else may have been committed
        // with a lost reply, so the request stays for "Проверить результат" with the same id.
        if (e instanceof ApiError && [400, 403, 404, 409].includes(e.status)) {
          try {
            this.storage.removeItem(this.key());
            this.pending = null;
          } catch {
            this.storageBroken = true;
          }
        }
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.changed();
      }
    }
    if (ok) await this.load();
    return ok;
  }
  /** Parse a statement on the server without storing it. */
  async check(mapping: Mapping, content: string) {
    if (!this.writable) return null;
    const generation = this.generation;
    this.busy = true;
    this.error = '';
    this.preview = null;
    this.changed();
    try {
      const p = (await this.api(`branches/${this.branch}/reconciliation/preview`, {
        method: 'POST',
        body: { mapping, content },
      })) as Preview;
      if (!p || typeof p !== 'object' || !Array.isArray(p.errors) || !Array.isArray(p.days))
        throw new ApiError('INVALID_RESPONSE');
      if (generation === this.generation) this.preview = p;
      return p;
    } catch (e) {
      if (generation === this.generation) this.error = explain(e);
      return null;
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.changed();
      }
    }
  }
}
const notices: Record<string, string> = {
  import: 'Выписка загружена. Сверка пересчитана.',
  void_import: 'Загрузка отменена: её строки больше не участвуют в сверке.',
  total: 'Итог сохранён.',
  void_total: 'Итог отменён. История сохранена.',
  item: 'Решение по расхождению сохранено.',
  accept: 'Расхождения приняты с причиной.',
  close: 'День закрыт. Изменения возможны только после повторного открытия с причиной.',
  reopen: 'День открыт заново. Причина записана в журнал.',
  profile: 'Профиль выписки сохранён.',
};
