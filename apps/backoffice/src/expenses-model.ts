import { ApiError, type Request } from './api.js';

/**
 * «Расходы» (cloud077, BACKOFFICE_EXPENSES_ENABLED; docs/operations/backoffice-expenses.md).
 * Organization-wide: one section for every branch and «Общие расходы компании». The server holds
 * the articles (GET meta), checks access and refuses a closed month; the screen only shows.
 */
export type Api = (path: string, request?: Request) => Promise<unknown>;
export const EXPENSES_SECTION = [
  'expenses',
  'Расходы',
  'Ввод расходов, журнал, ОПУ, касса и аналитика по точкам',
] as const;

export type Group = { code: string; name: string; pl: string | null };
export type Category = {
  code: string;
  name: string;
  group: string;
  kind: 'revenue_auto' | 'income' | 'expense' | 'movement';
  company: boolean;
  revenue_type?: string;
  series: string | null;
};
export type Source = { code: string; name: string; short: string };
export type Meta = {
  role: 'director' | 'finance' | 'economist' | 'viewer';
  permissions: string[];
  today: string;
  groups: Group[];
  categories: Category[];
  sources: Source[];
  revenue_types: { code: string; name: string }[];
  locations: { id: string; name: string }[];
  closed_months: { month: string; closed_at: string; closed_by: string }[];
  revenue_available: boolean;
  cogs_available: boolean;
};
export type Entry = {
  id: string;
  location_id: string | null;
  date: string;
  category: string;
  source: string;
  amount_minor: string;
  pl_month: string;
  monthly: boolean;
  cell: boolean;
  counterparty: string;
  comment: string;
  revision: number;
  author?: string;
  updated_by_name?: string;
  created_at?: string;
  updated_at?: string;
};
export type Cash = {
  opening_minor: string;
  opening_source: 'manual' | 'previous' | 'none';
  cash_revenue_minor: string;
  cash_income_minor: string;
  withdrawal_minor: string;
  cash_expenses_minor: string;
  collection_minor: string;
  expected_minor: string;
  counted_minor: string | null;
  difference_minor: string | null;
  mismatch: boolean;
  comment: string;
  previous_date: string | null;
};
export type Place = {
  id: string | null;
  name: string;
  filled: boolean;
  entries: Entry[];
  rows: { location_id: string | null; category: string; pl_month: string; comment: string }[];
  revenue: { by_type: Record<string, string>; manual_minor: string; total_minor: string } | null;
  cogs_ttk_minor: string | null;
  foodcost_percent: string;
  expenses_minor: string;
  expenses_by_source: Record<string, string>;
  expense_percent: string;
  cash: Cash | null;
  status: 'filled' | 'empty' | 'mismatch';
};
export type EntryScreen = {
  date: string;
  monthly: boolean;
  closed: boolean;
  filled: number;
  total: number;
  locations: Place[];
};
export type PnlLine = {
  key: string;
  label: string;
  kind: 'header' | 'line' | 'total' | 'reference' | 'percent';
  categories?: string[];
  values: Record<string, string>;
};
export type Pnl = {
  months: string[];
  locations: { id: string; name: string }[];
  columns: string[];
  lines: PnlLine[];
  tiles: Record<string, string>;
  unallocated_months: string[];
  cogs_available: boolean;
  dishes: {
    product_id: string;
    name: string;
    revenue_minor: string;
    cogs_minor: string;
    foodcost_percent: string;
  }[];
};
export type Analytics = {
  months: string[];
  series: Record<string, string>[];
  structure: { category: string; amount_minor: string }[];
  compare: Record<string, string>[];
  sources_month: string;
  sources: Record<string, string>[];
};
export type Tab = 'entry' | 'journal' | 'pnl' | 'analytics' | 'months' | 'legacy';

/** Almaty today (UTC+5) when the server has not answered yet. */
export const almatyToday = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
export const addDays = (day: string, n: number) =>
  new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
export const addMonths = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
export const monthName = (month: string) => {
  const names = [
    'январь',
    'февраль',
    'март',
    'апрель',
    'май',
    'июнь',
    'июль',
    'август',
    'сентябрь',
    'октябрь',
    'ноябрь',
    'декабрь',
  ];
  const [y, m] = month.split('-');
  return `${names[Number(m) - 1]} ${y}`;
};
export const dayText = (day: string) => day.split('-').reverse().join('.');

/**
 * A typed amount in tenge to tiyn: spaces and a comma are accepted, a minus is a correction.
 * Empty is null (the cell is removed). Throws a message for anything else.
 */
export function parseAmount(input: string): string | null {
  const v = input.trim().replace(/\s/g, '').replace(',', '.');
  if (v === '' || v === '-') return null;
  if (!/^-?(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(v))
    throw new Error('Введите сумму числом: можно с пробелами и запятой, минус для корректировки.');
  const negative = v.startsWith('-');
  const [whole, fraction = ''] = v.replace('-', '').split('.');
  const minor = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minor === 0n) return null;
  return (negative ? '-' : '') + minor.toString();
}
/** Tiyn to a field value: «12 345» or «12 345,50», with a minus. */
export function amountText(minor: string | null | undefined): string {
  if (minor === null || minor === undefined || minor === '') return '';
  const v = BigInt(minor);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const cents = abs % 100n;
  return `${neg ? '−' : ''}${whole}${cents ? ',' + cents.toString().padStart(2, '0') : ''}`;
}
export const tenge = (minor: string | null | undefined) =>
  minor === null || minor === undefined ? '—' : `${amountText(minor) || '0'} ₸`;

const query = (q: Record<string, string>) =>
  Object.entries(q)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

export class ExpensesModel {
  meta: Meta | null = null;
  /** null: not asked yet; false: the server has no «Расходы» (flag off) or no access. */
  available: boolean | null = null;
  error = '';
  tab: Tab = 'entry';
  period: 'day' | 'month' = 'day';
  date = almatyToday();
  month = almatyToday().slice(0, 7);
  /** Selected place: a branch id, '' = «Общие расходы компании». */
  place: string | undefined;
  screen: EntryScreen | null = null;
  /** Writes in flight (the indicator «Сохраняю...»). */
  saving = 0;
  saveError = '';
  loading = false;
  private scopeKey = '';
  constructor(
    private api: Api,
    private changed: () => void,
  ) {}

  get can() {
    const p = this.meta?.permissions ?? [];
    return { write: p.includes('expenses.write'), close: p.includes('expenses.close') };
  }
  category(code: string) {
    return this.meta?.categories.find((c) => c.code === code);
  }
  locationName(id: string | null) {
    if (id === null || id === 'company') return 'Общие расходы компании';
    return this.meta?.locations.find((l) => l.id === id)?.name ?? 'Точка';
  }
  isClosed(month: string) {
    return !!this.meta?.closed_months.some((m) => m.month === month);
  }

  /** Asks the server once per login whether the section exists for this person. */
  async probe(scope: string) {
    if (this.scopeKey === scope && this.available !== null) return this.available;
    this.scopeKey = scope;
    this.available = null;
    this.meta = null;
    this.screen = null;
    try {
      this.meta = (await this.api('expenses/meta')) as Meta;
      this.available = true;
      this.date = this.meta.today;
      this.month = this.meta.today.slice(0, 7);
    } catch {
      this.available = false;
    }
    this.changed();
    return this.available;
  }
  async reloadMeta() {
    this.meta = (await this.api('expenses/meta')) as Meta;
    this.changed();
  }
  private fail(e: unknown) {
    return explain(e);
  }

  async loadScreen() {
    this.loading = true;
    this.error = '';
    try {
      this.screen = (await this.api(
        'expenses/entry?' +
          query(
            this.period === 'day'
              ? { period: 'day', date: this.date }
              : { period: 'month', month: this.month },
          ),
      )) as EntryScreen;
    } catch (e) {
      this.error = this.fail(e);
    } finally {
      this.loading = false;
      this.changed();
    }
  }
  /** Runs a write; reloads the screen after it. Returns the error text or ''. */
  async write(path: string, body: unknown, reload = true): Promise<string> {
    this.saving++;
    this.saveError = '';
    this.changed();
    try {
      await this.api(path, { method: 'POST', body });
      if (reload && this.tab === 'entry') await this.loadScreen();
      return '';
    } catch (e) {
      this.saveError = this.fail(e);
      if (e instanceof ApiError && e.reason === 'MONTH_CLOSED')
        await this.reloadMeta().catch(() => {});
      return this.saveError;
    } finally {
      this.saving--;
      this.changed();
    }
  }
  periodBody() {
    return this.period === 'day'
      ? { period: 'day', date: this.date }
      : { period: 'month', month: this.month };
  }
  cell(location: string | null, category: string, source: string, amount: string | null) {
    return this.write('expenses/cell', {
      ...this.periodBody(),
      location_id: location,
      category,
      source,
      amount_minor: amount,
    });
  }
  row(location: string | null, category: string, plMonth: string, comment: string) {
    return this.write('expenses/row', {
      ...this.periodBody(),
      location_id: location,
      category,
      pl_month: plMonth,
      comment,
    });
  }
  saveEntry(id: string | null, body: Record<string, unknown>) {
    return this.write(id ? `expenses/entries/${id}` : 'expenses/entries', body);
  }
  deleteEntry(id: string) {
    return this.write(`expenses/entries/${id}/delete`, {});
  }
  cash(location: string, opening: string | null, counted: string | null, comment: string) {
    return this.write('expenses/cash', {
      location_id: location,
      date: this.date,
      opening_minor: opening,
      counted_minor: counted,
      comment,
    });
  }
  async read<T>(path: string, q: Record<string, string>): Promise<T> {
    return (await this.api(`expenses/${path}?${query(q)}`)) as T;
  }
  async readPlain<T>(path: string): Promise<T> {
    return (await this.api(`expenses/${path}`)) as T;
  }
}

export function explain(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.reason === 'MONTH_CLOSED') return 'Месяц закрыт, данные только для просмотра.';
    if (e.code === 'FORBIDDEN') return 'Нет доступа: раздел выдаёт руководитель.';
    if (e.code === 'INVALID_REQUEST')
      return 'Сервер не принял данные: проверьте дату (будущие дни нельзя), статью и сумму.';
    if (e.code === 'CONFLICT') return 'Такая запись уже есть или месяц уже в этом состоянии.';
    if (e.code === 'NOT_FOUND') return 'Запись не найдена: возможно, её уже удалили.';
    if (e.code === 'NETWORK') return 'Нет связи с сервером. Попробуйте ещё раз.';
    if (e.code === 'SERVICE_UNAVAILABLE') return 'Раздел «Расходы» на сервере выключен.';
  }
  return 'Не удалось выполнить действие. Попробуйте ещё раз.';
}

/** CSV for Excel: UTF-8 with BOM, «;» between columns (the Russian Excel opens it as a table). */
export function excel(rows: (string | number)[][]) {
  const cell = (v: string | number) => {
    const s = String(v);
    return /[";\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n');
}
/** Tiyn to a number cell for Excel: «12345,5». */
export const excelAmount = (minor: string | null | undefined) => {
  if (!minor) return '';
  const v = BigInt(minor);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const cents = abs % 100n;
  return `${neg ? '-' : ''}${abs / 100n}${cents ? ',' + cents.toString().padStart(2, '0') : ''}`;
};
