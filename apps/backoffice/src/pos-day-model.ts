import { ApiError } from './api.js';
import {
  REFUND_KIND_LABELS,
  REFUND_REASON_LABELS,
  SALES_CHANNEL_LABELS,
  SALES_METHOD_LABELS,
  almatyTime,
  csvTenge,
  csvTextCell,
  dayLabel,
  money,
} from './sales-report-model.js';

/**
 * «Касса» of the cabinet (lane bo-ui, GET .../ops/pos-day, design-bo-ui.md 5.1): parsing, Russian
 * names, the receipt filters and the three CSV exports. Shown only when GET branches/:id reports
 * capabilities.pos_day (BACKOFFICE_POS_DAY_ENABLED). Pure, no DOM. Money is whole tiyn in strings
 * from the server; the screen shows «11 670 ₸», the CSV tenge with a comma («116,70»).
 */
export type Data = Record<string, unknown>;
export type PosStaff = { name: string; employee_id: string; role: string };
export type PosDayTerminal = { terminal_id: string; label: string; first_seen_at: string | null };
export type PosDay = {
  schema_version: 1;
  branch_id: string;
  view: 'pos-day';
  date: string;
  terminal_id: string | null;
  as_of: string;
  coverage: {
    pos_tables: boolean;
    cashier_reports: boolean;
    last_received_at: string | null;
    cashier_reports_at: string | null;
  };
  terminals: PosDayTerminal[];
  shifts: Data[];
  totals: Data | null;
  channels: Data[];
  methods: Data[];
  sales: Data[];
  fiscal_summary: Data | null;
  staff: Record<string, PosStaff>;
  truncated: { sales: boolean; earlier_sales: boolean };
  limits: { sales: number; earlier_sales: number };
};

function object(value: unknown): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError('INVALID_RESPONSE');
  return value as Data;
}
const list = (v: unknown) => {
  if (!Array.isArray(v)) throw new ApiError('INVALID_RESPONSE');
  return v.map(object);
};
const MINOR = /^-?(0|[1-9][0-9]{0,17})$/;
const minorFields = (row: Data) => {
  for (const [key, v] of Object.entries(row))
    if (key.endsWith('_minor') && v !== null && !(typeof v === 'string' && MINOR.test(v)))
      throw new ApiError('INVALID_RESPONSE');
};
/** Strict enough to never render a foreign or half answer. */
export function posDay(value: unknown, branch: string): PosDay {
  const o = object(value);
  if (
    o['schema_version'] !== 1 ||
    o['branch_id'] !== branch ||
    o['view'] !== 'pos-day' ||
    typeof o['date'] !== 'string' ||
    typeof o['as_of'] !== 'string'
  )
    throw new ApiError('INVALID_RESPONSE');
  const coverage = object(o['coverage']);
  if (
    typeof coverage['pos_tables'] !== 'boolean' ||
    typeof coverage['cashier_reports'] !== 'boolean'
  )
    throw new ApiError('INVALID_RESPONSE');
  const truncated = object(o['truncated']);
  if (typeof truncated['sales'] !== 'boolean' || typeof truncated['earlier_sales'] !== 'boolean')
    throw new ApiError('INVALID_RESPONSE');
  const staff = object(o['staff']);
  const day = {
    ...o,
    terminals: list(o['terminals']),
    shifts: list(o['shifts']),
    channels: list(o['channels']),
    methods: list(o['methods']),
    sales: list(o['sales']),
    totals: o['totals'] === null ? null : object(o['totals']),
    fiscal_summary: o['fiscal_summary'] === null ? null : object(o['fiscal_summary']),
    staff,
  } as PosDay;
  for (const row of [...day.channels, ...day.methods, ...day.sales]) minorFields(row);
  if (day.totals) minorFields(day.totals);
  for (const sale of day.sales)
    for (const key of ['tenders', 'refunds', 'fiscal', 'lines'])
      if (!Array.isArray(sale[key])) throw new ApiError('INVALID_RESPONSE');
  return day;
}

// ------------------------------------------------------------------------------ names ----

export const POS_DAY_METHODS = [
  'cash',
  'kaspi_terminal',
  'kaspi_manual',
  'aggregator_yandex_eda',
  'aggregator_glovo',
  'chocofood',
  'staff_meal',
  'marketing',
] as const;
export const POS_DAY_CHANNELS = ['hall_dine_in', 'hall_takeaway', 'yandex_eda', 'glovo'] as const;
export const POS_SALE_STATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  paid: 'Оплачен',
  voided: 'Отменён',
});
export const FISCAL_STATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  pending: 'Не оформлен',
  recorded: 'Оформлен',
  not_required: 'Не нужен',
});
export const FISCAL_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  sale: 'Продажа',
  refund: 'Возврат',
});
export const SHIFT_STATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  open: 'Открыта',
  closed: 'Закрыта',
  unknown: 'Нет отчёта смены',
});
export const CONFIRMATION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  drawer: 'Наличные в кассе',
  cashier_attested: 'Отметил кассир',
  aggregator_attested: 'Оплачено на площадке',
  manager_approved: 'Разрешил начальник смены',
});
export const SERVICE_MODE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  dine_in: 'В зале',
  takeaway: 'С собой',
});
export const REVENUE_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  revenue: 'Выручка',
  staff_meal: 'Питание сотрудников',
  marketing: 'Маркетинг',
});
export const label = (map: Readonly<Record<string, string>>, code: unknown) =>
  map[String(code)] ?? String(code ?? '-');
export const methodLabel = (code: unknown) => label(SALES_METHOD_LABELS, code);
export const channelLabel = (code: unknown) => label(SALES_CHANNEL_LABELS, code);
export const refundKindLabel = (code: unknown) => label(REFUND_KIND_LABELS, code);
export const refundReasonLabel = (code: unknown) => label(REFUND_REASON_LABELS, code);
const short = (v: unknown) => (typeof v === 'string' ? v.slice(0, 8) : '-');

/** «Касса 2» by the server's order; an unknown desk shows its short code. */
export function terminalLabel(day: { terminals: PosDayTerminal[] }, id: unknown): string {
  if (typeof id !== 'string') return 'Касса не известна';
  return day.terminals.find((t) => t.terminal_id === id)?.label ?? `Касса ${id.slice(0, 4)}`;
}
/** The employee card name of an edge staff id, or the short code when nobody is linked. */
export function staffLabel(day: { staff: Record<string, PosStaff> }, id: unknown): string {
  if (typeof id !== 'string' || !id) return '-';
  return day.staff[id]?.name ?? `Сотрудник ${short(id)} (нет карточки)`;
}
/** «№12 · Касса 2»: numbers repeat across cash desks. */
export function receiptName(day: { terminals: PosDayTerminal[] }, sale: Data) {
  return `№${String(sale['display_number'])} · ${terminalLabel(day, sale['terminal_id'])}`;
}
/** Almaty «HH:MM». */
export function almatyClock(v: unknown) {
  if (typeof v !== 'string' || !v) return '-';
  return almatyTime(v).slice(11);
}
/** The Webkassa column of a receipt: its number, «не оформлен» or «не нужен». */
export function webkassaText(sale: Data) {
  const receipt = (sale['fiscal'] as Data[]).find((f) => f['kind'] === 'sale');
  if (!receipt) return 'нет записи';
  if (receipt['state'] === 'recorded') return String(receipt['receipt_number']);
  return receipt['state'] === 'pending' ? 'не оформлен' : 'не нужен';
}
export const tendersText = (sale: Data) =>
  (sale['tenders'] as Data[])
    .map((t) => `${methodLabel(t['method'])} ${money(t['amount_minor'])}`)
    .join(', ');
export const saleStateText = (sale: Data) =>
  sale['state'] === 'voided'
    ? 'Отменён'
    : BigInt(String(sale['refunded_minor'] ?? '0')) > 0n
      ? 'Оплачен, есть возврат'
      : 'Оплачен';

// ------------------------------------------------------------------------- filters ----

export type ReceiptFilters = {
  query: string;
  method: string;
  channel: string;
  state: '' | 'paid' | 'voided' | 'refunded' | 'no_revenue' | 'fiscal_pending';
};
export const RECEIPT_STATE_FILTERS: readonly [ReceiptFilters['state'], string][] = [
  ['', 'Все чеки'],
  ['paid', 'Оплачен'],
  ['voided', 'Отменён'],
  ['refunded', 'С возвратом'],
  ['no_revenue', 'Без выручки'],
  ['fiscal_pending', 'Webkassa не оформлен'],
];
/**
 * Search by order number («12», «№12»), aggregator or ChocoFood number and Webkassa receipt
 * number, plus method, channel and state; the cash desk is the picker above (server side).
 */
export function filterReceipts(sales: Data[], f: ReceiptFilters): Data[] {
  const q = f.query.trim().toLocaleUpperCase().replace(/^№\s*/, '');
  return sales.filter((s) => {
    if (q) {
      const numbers = [
        String(s['display_number']),
        String(s['external_order_ref'] ?? ''),
        ...(s['fiscal'] as Data[]).map((r) => String(r['receipt_number'] ?? '')),
      ].map((v) => v.toLocaleUpperCase());
      if (!numbers.some((v) => v && (v === q || (q.length >= 3 && v.includes(q))))) return false;
    }
    if (f.method && !(s['tenders'] as Data[]).some((t) => t['method'] === f.method)) return false;
    if (f.channel && s['channel'] !== f.channel) return false;
    switch (f.state) {
      case 'paid':
        return s['state'] === 'paid';
      case 'voided':
        return s['state'] === 'voided';
      case 'refunded':
        return (s['refunds'] as Data[]).some((r) => r['kind'] === 'refund');
      case 'no_revenue':
        return s['revenue_kind'] !== 'revenue';
      case 'fiscal_pending':
        return (s['fiscal'] as Data[]).some((r) => r['state'] === 'pending' && r['in_day']);
      default:
        return true;
    }
  });
}

/** Webkassa receipts of the day: unrecorded first (longest wait first), recorded, not required. */
export function webkassaRows(day: PosDay) {
  const rows = day.sales.flatMap((sale) =>
    (sale['fiscal'] as Data[])
      .filter((f) => f['in_day'] === true)
      .map((f) => {
        const refund =
          f['kind'] === 'refund'
            ? (sale['refunds'] as Data[]).find((r) => r['refund_id'] === f['refund_id'])
            : undefined;
        const since = String(refund?.['created_at'] ?? sale['sold_at']);
        return {
          receipt: f,
          sale,
          since,
          terminal_id: String(refund?.['terminal_id'] ?? sale['terminal_id']),
          waiting_minutes:
            f['state'] === 'pending'
              ? Math.max(0, Math.floor((Date.parse(day.as_of) - Date.parse(since)) / 60000))
              : null,
        };
      }),
  );
  const rank = (s: unknown) => (s === 'pending' ? 0 : s === 'recorded' ? 1 : 2);
  return rows.sort(
    (a, b) =>
      rank(a.receipt['state']) - rank(b.receipt['state']) ||
      a.since.localeCompare(b.since) ||
      String(a.receipt['receipt_id']).localeCompare(String(b.receipt['receipt_id'])),
  );
}
/** «12 мин», «2 ч 05 мин». */
export function waitingText(minutes: number | null) {
  if (minutes === null) return '-';
  if (minutes < 60) return `${minutes} мин`;
  return `${Math.floor(minutes / 60)} ч ${String(minutes % 60).padStart(2, '0')} мин`;
}

// ---------------------------------------------------------------------------- CSV ----

const stamp = (v: unknown) => (typeof v === 'string' && v ? almatyTime(v) : '');
const header = (day: PosDay, title: string) => [
  [title, dayLabel(day.date), 'Asia/Almaty'],
  [
    'Касса',
    day.terminal_id ? terminalLabel(day, day.terminal_id) : 'все кассы',
    day.coverage.last_received_at
      ? 'данные получены ' + almatyTime(day.coverage.last_received_at)
      : 'данные кассы не поступали',
  ],
  [],
];
/** «Z-отчёты за день»: one row per shift, cash, Kaspi terminal and the eight methods. */
export function zCsv(day: PosDay): string[][] {
  return [
    ...header(day, 'Z-отчёты кассы PickChick'),
    [
      'Касса',
      'Смена',
      'Состояние',
      'Открыта',
      'Закрыта',
      'Разменный фонд, ₸',
      'Внесения, ₸',
      'Изъятия, ₸',
      'Наличные продажи, ₸',
      'Наличные возвраты, ₸',
      'Ожидается наличных, ₸',
      'Пересчитано, ₸',
      'Расхождение, ₸',
      'Kaspi терминал по кассе, ₸',
      'Kaspi терминал введено, ₸',
      'Kaspi терминал разница, ₸',
      'Чеки Webkassa не оформлены',
      ...POS_DAY_METHODS.flatMap((m) => [
        `${methodLabel(m)}: продажи, ₸`,
        `${methodLabel(m)}: возвраты, ₸`,
      ]),
    ],
    ...day.shifts.map((s) => {
      const cash = (s['cash'] as Data | null) ?? {};
      const terminal = (s['terminal'] as Data | null) ?? {};
      const methods = ((s['received'] as Data)['methods'] as Data[]) ?? [];
      const opt = (v: unknown) => (v === null || v === undefined ? '' : csvTenge(v));
      return [
        terminalLabel(day, s['terminal_id']),
        short(s['shift_id']),
        label(SHIFT_STATE_LABELS, s['state']),
        stamp(s['opened_at']),
        stamp(s['closed_at']),
        opt(cash['opening_cash_minor']),
        opt(cash['cash_in_minor']),
        opt(cash['cash_out_minor']),
        opt(cash['cash_sales_minor']),
        opt(cash['cash_refunds_minor']),
        opt(cash['expected_cash_minor']),
        opt(cash['counted_cash_minor']),
        opt(cash['discrepancy_minor']),
        opt(terminal['expected_minor']),
        opt(terminal['reported_minor']),
        opt(terminal['discrepancy_minor']),
        String((s['flags'] as Data)['fiscal_pending']),
        ...POS_DAY_METHODS.flatMap((m) => {
          const row = methods.find((x) => x['method'] === m);
          return [csvTenge(row?.['sales_minor'] ?? '0'), csvTenge(row?.['refunds_minor'] ?? '0')];
        }),
      ];
    }),
  ];
}
/** «Чеки кассы за день»: one row per receipt with the money in tenge. */
export function receiptsCsv(day: PosDay, sales: Data[] = day.sales): string[][] {
  return [
    ...header(day, 'Чеки кассы PickChick'),
    [
      'Дата и время',
      'Номер',
      'Касса',
      'Кассир',
      'Канал',
      'Номер агрегатора или ChocoFood',
      'Вид',
      'Сумма, ₸',
      'Оплата',
      'Внесено наличными, ₸',
      'Сдача, ₸',
      'Состояние',
      'Возвращено, ₸',
      'Webkassa',
      'Получатель или причина',
      'Чек за день',
    ],
    ...sales.map((s) => [
      stamp(s['sold_at']),
      String(s['display_number']),
      terminalLabel(day, s['terminal_id']),
      csvTextCell(staffLabel(day, s['cashier_staff_id'])),
      channelLabel(s['channel']),
      csvTextCell(s['external_order_ref'] ?? ''),
      label(REVENUE_KIND_LABELS, s['revenue_kind']),
      csvTenge(s['total_minor']),
      (s['tenders'] as Data[])
        .map((t) => `${methodLabel(t['method'])} ${csvTenge(t['amount_minor'])}`)
        .join(', '),
      s['cash_tendered_minor'] === null ? '' : csvTenge(s['cash_tendered_minor']),
      s['change_minor'] === null ? '' : csvTenge(s['change_minor']),
      saleStateText(s),
      csvTenge(s['refunded_minor']),
      csvTextCell(webkassaText(s)),
      csvTextCell(s['beneficiary'] ?? s['reason'] ?? ''),
      s['of_day'] === true ? 'да' : `нет, чек ${dayLabel(s['business_date'])}`,
    ]),
  ];
}
/** «Чеки Webkassa за день»: number, kind, amount, order number, cash desk, time, state. */
export function webkassaCsv(day: PosDay): string[][] {
  return [
    ...header(day, 'Чеки Webkassa PickChick'),
    [
      'Номер чека',
      'Вид',
      'Сумма, ₸',
      'Номер заказа',
      'Касса',
      'Время операции',
      'Состояние',
      'Внёс',
      'Когда внесён',
    ],
    ...webkassaRows(day).map((r) => [
      csvTextCell(r.receipt['receipt_number'] ?? ''),
      label(FISCAL_KIND_LABELS, r.receipt['kind']),
      csvTenge(r.receipt['amount_minor']),
      String(r.sale['display_number']),
      terminalLabel(day, r.terminal_id),
      stamp(r.since),
      label(FISCAL_STATE_LABELS, r.receipt['state']),
      csvTextCell(
        r.receipt['recorded_by_staff_id'] ? staffLabel(day, r.receipt['recorded_by_staff_id']) : '',
      ),
      stamp(r.receipt['recorded_at']),
    ]),
  ];
}

/** «Как считается» under «Касса»: the server rules (pos-day.ts) in plain words. */
export const POS_DAY_RULES = [
  'День - календарный день Алматы. Кассовая смена относится к дню, когда её открыли: смена, закрытая после полуночи, и её чеки остаются в дне открытия. Поэтому суммы здесь могут отличаться от «Продаж», где чек считается по времени продажи.',
  'Продажи - все чеки дня, отменённые тоже, как в Z-отчёте. Выручка = продажи - отмены - возвраты, сделанные в сменах этого дня. Возврат сегодня по чеку прошлого дня уменьшает сегодняшнюю выручку; такой чек показан в списке с пометкой даты.',
  'Питание сотрудников и маркетинг не входят в выручку и средний чек: они показаны в «Без выручки».',
  'Для открытой смены показаны только чеки, которые уже получило облако. Это не X-отчёт кассы.',
  'Чек Webkassa пробивается вручную в кабинете Webkassa, касса хранит его номер. Исправить номер можно только на кассе, по PIN начальника смены.',
  'Имена сотрудников видны, если учётная запись кассы создана с номером из scripts/edge-staff-id.mjs. Иначе показан короткий код.',
];
