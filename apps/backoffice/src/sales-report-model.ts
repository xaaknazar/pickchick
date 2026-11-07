import { ApiError } from './api.js';

export type Data = Record<string, unknown>;
function object(value: unknown): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError('INVALID_RESPONSE');
  return value as Data;
}

/**
 * Sales report of the cabinet (cutover CC-7, GET .../ops/sales). Shown only when GET
 * branches/:id reports capabilities.sales_report (BACKOFFICE_SALES_REPORT_ENABLED); this module
 * parses the answer, names every code in Russian and builds the CSV. Pure, no DOM.
 */
export type SalesReport = {
  schema_version: 1;
  branch_id: string;
  view: 'sales';
  start_date: string;
  end_date: string;
  as_of: string;
  coverage: { pos: boolean; cloud: boolean; pos_received_at: string | null; discounts: boolean };
  totals: Data;
  channels: Data[];
  methods: Data[];
  by_day: Data[];
  by_hour: Data[];
  no_revenue: { kinds: Data[]; items: Data[] };
  refunds: Data[];
  shifts: Data[];
  top_items: Data[];
  truncated: { refunds: boolean; no_revenue: boolean; shifts: boolean };
};

/** Report channels (contracts 5.7) in the server's order. */
export const SALES_CHANNEL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  hall_dine_in: 'Зал',
  hall_takeaway: 'С собой',
  yandex_eda: 'Яндекс Еда',
  glovo: 'Glovo',
  mobile: 'Приложение',
  kiosk: 'Киоск',
});
/** The eight cashier methods (owner's list, contracts section 00) and the cloud payments. */
export const SALES_METHOD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  cash: 'Наличные',
  kaspi_terminal: 'Kaspi терминал',
  kaspi_manual: 'Kaspi вручную',
  aggregator_yandex_eda: 'Яндекс Еда - оплачено агрегатором',
  aggregator_glovo: 'Glovo - оплачено агрегатором',
  chocofood: 'ChocoFood',
  staff_meal: 'Питание сотрудников',
  marketing: 'Маркетинг',
  online: 'Онлайн - приложение и киоск',
});
export const NO_REVENUE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  staff_meal: 'Питание сотрудников',
  marketing: 'Маркетинг',
});
/** PosRefundReason, with the same words as the cashier screen. */
export const REFUND_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  guest_changed_mind: 'Гость передумал',
  wrong_order: 'Неверный заказ',
  quality: 'Качество блюда',
  aggregator_cancelled: 'Агрегатор отменил',
  cashier_error: 'Ошибка кассира',
  other: 'Другое',
});
export const REFUND_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  void: 'Отмена до кухни',
  refund: 'Возврат',
});
/** «Как считается» under the report: the server rules in plain words (sales-report.ts). */
export const SALES_REPORT_RULES = [
  'Дни и часы - по времени Алматы. Продажа кассы относится к дню продажи, оплата приложения и киоска - ко времени подтверждения оплаты.',
  'Продажи - все чеки периода, отменённые тоже, как в Z-отчёте кассы. Отмена до кухни и возврат уменьшают выручку в тот день, когда их провели.',
  'Выручка = продажи - отмены - возвраты. Средний чек - сумма оплаченных неотменённых чеков / число таких чеков, до возвратов.',
  'Чек, отменённый после конца периода (продажа в 23:55, отмена в 00:05), остаётся чеком своего периода, а отмена попадает в день, когда её провели: цифры закрытого дня потом не меняются.',
  'Питание сотрудников и маркетинг не входят в выручку, каналы и средний чек: они показаны отдельно в блоке «Без выручки».',
  'Отмены и возвраты кассы подтверждает начальник смены PIN-кодом. Имён сотрудников кассы в облаке нет: в отчёте - «PIN начальника смены, сотрудник» и первые 8 знаков его номера, имя по номеру - в кассе.',
  'Скидок на запуске нет: колонка скидок появится вместе с механизмом скидок.',
];

const list = (v: unknown) => {
  if (!Array.isArray(v)) throw new ApiError('INVALID_RESPONSE');
  return v.map(object);
};
/** Strict enough to never render a foreign or half answer. */
export function salesReport(value: unknown, branch: string): SalesReport {
  const o = object(value);
  if (
    o['schema_version'] !== 1 ||
    o['branch_id'] !== branch ||
    o['view'] !== 'sales' ||
    typeof o['start_date'] !== 'string' ||
    typeof o['end_date'] !== 'string'
  )
    throw new ApiError('INVALID_RESPONSE');
  const coverage = object(o['coverage']);
  if (
    typeof coverage['pos'] !== 'boolean' ||
    !(coverage['pos_received_at'] === null || typeof coverage['pos_received_at'] === 'string')
  )
    throw new ApiError('INVALID_RESPONSE');
  const noRevenue = object(o['no_revenue']);
  const truncated = object(o['truncated']);
  for (const key of ['refunds', 'no_revenue', 'shifts'])
    if (typeof truncated[key] !== 'boolean') throw new ApiError('INVALID_RESPONSE');
  const report = {
    ...o,
    totals: object(o['totals']),
    channels: list(o['channels']),
    methods: list(o['methods']),
    by_day: list(o['by_day']),
    by_hour: list(o['by_hour']),
    no_revenue: { kinds: list(noRevenue['kinds']), items: list(noRevenue['items']) },
    refunds: list(o['refunds']),
    shifts: list(o['shifts']),
    top_items: list(o['top_items']),
  } as SalesReport;
  for (const row of [...report.channels, ...report.methods, ...report.by_day])
    for (const [key, v] of Object.entries(row))
      if (key.endsWith('_minor') && !(typeof v === 'string' && /^-?(0|[1-9][0-9]{0,17})$/.test(v)))
        throw new ApiError('INVALID_RESPONSE');
  return report;
}

const minorText = (v: unknown) => {
  const s = String(v ?? '0');
  if (!/^-?(0|[1-9][0-9]*)$/.test(s)) throw new Error('Invalid amount');
  const n = BigInt(s);
  return {
    sign: n < 0n ? '-' : '',
    whole: (n < 0n ? -n : n) / 100n,
    part: (n < 0n ? -n : n) % 100n,
  };
};
/** «1 234,50 ₸» for the screen; whole tenge without «,00». */
export function money(v: unknown) {
  const { sign, whole, part } = minorText(v);
  return `${sign}${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${part ? ',' + part.toString().padStart(2, '0') : ''} ₸`;
}
/** «1234,50» for spreadsheets (Russian decimal comma, no thousands separator). */
export function csvTenge(v: unknown) {
  const { sign, whole, part } = minorText(v);
  return `${sign}${whole},${part.toString().padStart(2, '0')}`;
}
/** Almaty date and time «19.11.2026 13:05». */
export function almatyTime(v: unknown) {
  if (typeof v !== 'string' || !v) return '-';
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Almaty',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(v));
  const p = (type: string) => parts.find((x) => x.type === type)?.value ?? '';
  return `${p('day')}.${p('month')}.${p('year')} ${p('hour')}:${p('minute')}`;
}
export const dayLabel = (day: unknown) => {
  const [y, m, d] = String(day).split('-');
  return `${d}.${m}.${y}`;
};
/** Who approved a void or refund: the back-office login, or the cashier's manager PIN. */
export function approverLabel(row: Data) {
  if (typeof row['approved_by_name'] === 'string' && row['approved_by_name'])
    return row['approved_by_name'];
  if (typeof row['approved_by_staff_id'] === 'string')
    return `PIN начальника смены, сотрудник ${row['approved_by_staff_id'].slice(0, 8)}`;
  return '-';
}
/** Free text from people (names, reasons) is never read by a spreadsheet as a formula. */
export const csvTextCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
};
/** The rows of the CSV export: one block per table, blocks separated by an empty row. */
export function salesCsv(r: SalesReport): string[][] {
  const t = r.totals;
  const label = (map: Readonly<Record<string, string>>, code: unknown) =>
    map[String(code)] ?? String(code);
  return [
    [
      'Отчёт продаж PickChick',
      `${dayLabel(r.start_date)} - ${dayLabel(r.end_date)}`,
      'Asia/Almaty',
    ],
    [
      'Касса',
      r.coverage.pos
        ? r.coverage.pos_received_at
          ? 'данные получены ' + almatyTime(r.coverage.pos_received_at)
          : 'данных пока нет'
        : 'данные не поступают',
    ],
    [],
    ['Итоги', 'Значение'],
    ['Чеки', String(t['checks'])],
    ['Отменено до кухни, чеков', String(t['voided_checks'])],
    ['Продажи, ₸', csvTenge(t['sales_minor'])],
    ['Отмены до кухни, ₸', csvTenge(t['voids_minor'])],
    ['Возвраты, ₸', csvTenge(t['refunds_minor'])],
    ['Выручка, ₸', csvTenge(t['revenue_minor'])],
    ['Средний чек, ₸', csvTenge(t['average_check_minor'])],
    ['Скидки, ₸', csvTenge(t['discount_minor'])],
    ['Без выручки, чеков', String(t['no_revenue_checks'])],
    ['Без выручки, ₸', csvTenge(t['no_revenue_minor'])],
    [],
    [
      'Канал',
      'Чеки',
      'Отменено чеков',
      'Продажи, ₸',
      'Отмены, ₸',
      'Возвраты, ₸',
      'Выручка, ₸',
      'Средний чек, ₸',
    ],
    ...r.channels.map((c) => [
      label(SALES_CHANNEL_LABELS, c['channel']),
      String(c['checks']),
      String(c['voided_checks']),
      csvTenge(c['sales_minor']),
      csvTenge(c['voids_minor']),
      csvTenge(c['refunds_minor']),
      csvTenge(c['revenue_minor']),
      csvTenge(c['average_check_minor']),
    ]),
    [],
    ['Способ оплаты', 'В выручке', 'Оплат', 'Продажи, ₸', 'Отмены, ₸', 'Возвраты, ₸', 'Итого, ₸'],
    ...r.methods.map((m) => [
      label(SALES_METHOD_LABELS, m['method']),
      m['revenue'] === true ? 'да' : 'нет',
      String(m['payments']),
      csvTenge(m['sales_minor']),
      csvTenge(m['voids_minor']),
      csvTenge(m['refunds_minor']),
      csvTenge(m['net_minor']),
    ]),
    [],
    ['День', 'Чеки', 'Продажи, ₸', 'Отмены, ₸', 'Возвраты, ₸', 'Выручка, ₸', 'Без выручки, ₸'],
    ...r.by_day.map((d) => [
      dayLabel(d['day']),
      String(d['checks']),
      csvTenge(d['sales_minor']),
      csvTenge(d['voids_minor']),
      csvTenge(d['refunds_minor']),
      csvTenge(d['revenue_minor']),
      csvTenge(d['no_revenue_minor']),
    ]),
    [],
    ['Час', 'Чеки', 'Продажи, ₸'],
    ...r.by_hour.map((h) => [
      `${String(h['hour']).padStart(2, '0')}:00`,
      String(h['checks']),
      csvTenge(h['sales_minor']),
    ]),
    [],
    ['Без выручки', 'Чеки', 'Отменено чеков', 'Сумма, ₸'],
    ...r.no_revenue.kinds.map((k) => [
      label(NO_REVENUE_LABELS, k['revenue_kind']),
      String(k['checks']),
      String(k['voided_checks']),
      csvTenge(k['total_minor']),
    ]),
    [],
    ['Заказ', 'Вид', 'Состояние', 'Сумма, ₸', 'Получатель', 'Причина', 'Подтвердил', 'Время'],
    ...r.no_revenue.items.map((i) => [
      '№' + String(i['display_number']),
      label(NO_REVENUE_LABELS, i['revenue_kind']),
      i['state'] === 'voided' ? 'отменён' : 'оплачен',
      csvTenge(i['total_minor']),
      csvTextCell(i['beneficiary']),
      csvTextCell(i['reason']),
      typeof i['approval_manager_staff_id'] === 'string'
        ? `PIN начальника смены, сотрудник ${i['approval_manager_staff_id'].slice(0, 8)}`
        : '-',
      almatyTime(i['sold_at']),
    ]),
    [],
    [
      'Время',
      'Канал',
      'Заказ',
      'Вид',
      'Сумма, ₸',
      'Причина',
      'Комментарий',
      'Подтвердил',
      'Способы оплаты',
    ],
    ...r.refunds.map((v) => [
      almatyTime(v['created_at']),
      label(SALES_CHANNEL_LABELS, v['channel']),
      v['display_number'] === null
        ? String(v['order_id']).slice(0, 8)
        : '№' + String(v['display_number']),
      label(REFUND_KIND_LABELS, v['kind']),
      csvTenge(v['amount_minor']),
      v['reason_code'] ? label(REFUND_REASON_LABELS, v['reason_code']) : '-',
      csvTextCell(v['reason']),
      csvTextCell(approverLabel(v)),
      (Array.isArray(v['methods']) ? (v['methods'] as Data[]) : [])
        .map((m) => `${label(SALES_METHOD_LABELS, m['method'])} ${csvTenge(m['amount_minor'])}`)
        .join(', '),
    ]),
  ];
}
/** UTF-8 with BOM, «;» separated, every cell quoted (Excel with the Russian locale). */
export function salesCsvText(rows: string[][]) {
  return (
    '﻿' + rows.map((r) => r.map((s) => '"' + s.replaceAll('"', '""') + '"').join(';')).join('\r\n')
  );
}
