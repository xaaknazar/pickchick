/**
 * The one list of articles of «Расходы» (owner request 11.11.2026, section 2). The server checks
 * every record against it and gives it to the screen through GET .../expenses/meta, so an article
 * is added or renamed here only, without changing the screen. A code never changes once records
 * use it: rename the article, never recode it.
 *
 * kind:
 * - revenue_auto: revenue by payment type from the cashier and the cloud orders, never entered;
 * - income: entered income (manual revenue, other income), plus in the P&L;
 * - expense: entered expense, minus in the P&L (a negative amount is a correction in favour of
 *   the branch);
 * - movement: money movement, never in the P&L, only in the cash reconciliation.
 */
export type ExpenseKind = 'revenue_auto' | 'income' | 'expense' | 'movement';
export type ExpenseGroup = {
  code: string;
  name: string;
  /** Position of the group in the P&L; null: not in the P&L (money movement). */
  pl: 'revenue' | 'other_income' | 'cogs' | 'expense' | null;
};
export type ExpenseCategory = {
  code: string;
  name: string;
  group: string;
  kind: ExpenseKind;
  /** Revenue payment type of an automatic revenue article. */
  revenue_type?: RevenueType;
  /** Entered for the company (no branch) as well. */
  company: boolean;
  /** Analytics series (owner request section 7). */
  series: 'cogs' | 'payroll' | 'location' | 'commissions' | 'other' | null;
};

export const EXPENSE_SOURCES = Object.freeze([
  { code: 'cash', name: 'Наличные', short: 'Наличные' },
  { code: 'kaspi', name: 'Kaspi Pay / Kaspi Business', short: 'Kaspi' },
  { code: 'halyk', name: 'Halyk Bank', short: 'Halyk' },
  { code: 'bank', name: 'Расчётный счёт (другой банк)', short: 'Р/с' },
] as const);
export type ExpenseSource = (typeof EXPENSE_SOURCES)[number]['code'];
export const EXPENSE_SOURCE_CODES = EXPENSE_SOURCES.map((s) => s.code) as [
  ExpenseSource,
  ...ExpenseSource[],
];

/** Revenue payment types of the P&L and of the top of a branch (owner request section 2). */
export const REVENUE_TYPES = Object.freeze([
  { code: 'cash', name: 'Наличные' },
  { code: 'glovo', name: 'Glovo' },
  { code: 'yandex', name: 'Яндекс' },
  { code: 'wolt', name: 'Wolt' },
  { code: 'card', name: 'Kaspi / Halyk / QR' },
  { code: 'other', name: 'Прочие' },
] as const);
export type RevenueType = (typeof REVENUE_TYPES)[number]['code'];
/**
 * Cashier payment methods (cloud073 cloud_pos_tenders.method) to revenue types. Staff meal and
 * marketing are sales without revenue and are never revenue. Cloud orders (app, kiosk) are paid
 * by Kaspi and count as `card`.
 */
export const POS_METHOD_REVENUE: Readonly<Record<string, RevenueType | null>> = Object.freeze({
  cash: 'cash',
  kaspi_terminal: 'card',
  kaspi_manual: 'card',
  aggregator_yandex_eda: 'yandex',
  aggregator_glovo: 'glovo',
  aggregator_wolt: 'wolt',
  chocofood: 'other',
  staff_meal: null,
  marketing: null,
});

export const EXPENSE_GROUPS: readonly ExpenseGroup[] = Object.freeze([
  { code: 'revenue', name: 'Выручка (вкл. НДС)', pl: 'revenue' },
  { code: 'other_income', name: 'Прочие поступления', pl: 'other_income' },
  { code: 'cogs', name: 'Сырьевая себестоимость', pl: 'cogs' },
  { code: 'household', name: 'Хозтовары и посуда', pl: 'expense' },
  { code: 'adjustments', name: 'Корректировки', pl: 'expense' },
  { code: 'payroll', name: 'Расходы на оплату труда', pl: 'expense' },
  { code: 'location', name: 'Расходы на точку', pl: 'expense' },
  { code: 'commissions', name: 'Комиссии', pl: 'expense' },
  { code: 'taxes', name: 'Налоги', pl: 'expense' },
  { code: 'marketing', name: 'Маркетинговые расходы', pl: 'expense' },
  { code: 'other', name: 'Прочие расходы', pl: 'expense' },
  { code: 'movement', name: 'Движение денег (не входит в ОПУ)', pl: null },
]);

const c = (
  code: string,
  name: string,
  group: string,
  kind: ExpenseKind,
  series: ExpenseCategory['series'],
  extra: Partial<ExpenseCategory> = {},
): ExpenseCategory => ({
  code,
  name,
  group,
  kind,
  company: kind !== 'revenue_auto',
  series,
  ...extra,
});

export const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = Object.freeze([
  c('rev_cash', 'Наличные', 'revenue', 'revenue_auto', null, { revenue_type: 'cash' }),
  c('rev_glovo', 'Glovo', 'revenue', 'revenue_auto', null, { revenue_type: 'glovo' }),
  c('rev_yandex', 'Яндекс', 'revenue', 'revenue_auto', null, { revenue_type: 'yandex' }),
  c('rev_wolt', 'Wolt', 'revenue', 'revenue_auto', null, { revenue_type: 'wolt' }),
  c('rev_card', 'Kaspi / Halyk / QR', 'revenue', 'revenue_auto', null, { revenue_type: 'card' }),
  c('rev_other', 'Прочие', 'revenue', 'revenue_auto', null, { revenue_type: 'other' }),
  c('rev_manual', 'Выручка вручную (нет в источнике)', 'revenue', 'income', null, {
    company: false,
  }),
  c('other_income', 'Прочее поступление', 'other_income', 'income', null),
  c('suppliers', 'Поставщики (продукты, напитки, упаковка)', 'cogs', 'expense', 'cogs'),
  c('workshop', 'Цех (полуфабрикаты и мясо)', 'cogs', 'expense', 'cogs'),
  c('household', 'Хоз.товары', 'household', 'expense', 'other'),
  c('stationery', 'Канц.товар / бренд.посуда', 'household', 'expense', 'other'),
  c('adj_glovo', 'Корректировка Glovo', 'adjustments', 'expense', 'other'),
  c('adj_yandex', 'Корректировка Яндекс', 'adjustments', 'expense', 'other'),
  c('adj_acquiring', 'Корректировка эквайринга', 'adjustments', 'expense', 'other'),
  c('cash_shortage', 'Недостача / излишек по кассе', 'adjustments', 'expense', 'other'),
  c('pay_site', 'Заработная плата объекта', 'payroll', 'expense', 'payroll'),
  c('pay_marketing', 'ЗП маркетинг', 'payroll', 'expense', 'payroll'),
  c('pay_workshop', 'ЗП цех', 'payroll', 'expense', 'payroll'),
  c('pay_office', 'ЗП офис', 'payroll', 'expense', 'payroll'),
  c('pay_bloggers', 'ЗП блогеры', 'payroll', 'expense', 'payroll'),
  c('inventory', 'Инвентарь / оборудование', 'location', 'expense', 'location'),
  c('taxi', 'Такси', 'location', 'expense', 'location'),
  c('staff_transport', 'Развозка', 'location', 'expense', 'location'),
  c('staff_food', 'Стафф (питание персонала)', 'location', 'expense', 'location'),
  c('head_office', 'Затраты ГО (головной офис)', 'location', 'expense', 'location'),
  c('rent', 'Аренда', 'location', 'expense', 'location'),
  c('utilities', 'Коммунальные услуги', 'location', 'expense', 'location'),
  c('workshop_costs', 'Расходы цех', 'location', 'expense', 'location'),
  c('repair_equipment', 'Ремонт оборудования', 'location', 'expense', 'location'),
  c('repair_premises', 'Ремонт помещения', 'location', 'expense', 'location'),
  c(
    'communication',
    'Связь (ОФД, интернет, мобильная связь ККМ)',
    'location',
    'expense',
    'location',
  ),
  c('tech_support', 'Техническая поддержка', 'location', 'expense', 'location'),
  c(
    'sanitation',
    'Дезинфекция / вывоз мусора / жироуловитель / вытяжка',
    'location',
    'expense',
    'location',
  ),
  c('app_development', 'Разработка приложения', 'location', 'expense', 'location'),
  c('uniform', 'Униформа', 'location', 'expense', 'location'),
  c('furniture', 'Мебель', 'location', 'expense', 'location'),
  c('upkeep_other', 'Прочие расходы на содержание объекта', 'location', 'expense', 'location'),
  c('fee_glovo', 'Комиссия Glovo', 'commissions', 'expense', 'commissions'),
  c('fee_yandex', 'Комиссия Яндекс', 'commissions', 'expense', 'commissions'),
  c('fee_bank', 'Комиссия банка', 'commissions', 'expense', 'commissions'),
  c('taxes', 'Налоги', 'taxes', 'expense', 'other'),
  c('marketing_services', 'Услуги по маркетингу / рекламе', 'marketing', 'expense', 'other'),
  c('printing', 'Распечатка', 'marketing', 'expense', 'other'),
  c('other', 'Прочие расходы', 'other', 'expense', 'other'),
  c('cash_withdrawal', 'Снятие денег со счёта (пришли в кассу)', 'movement', 'movement', null),
  c('cash_collection', 'Инкассация (наличные ушли на счёт)', 'movement', 'movement', null),
]);

const byCode = new Map(EXPENSE_CATEGORIES.map((v) => [v.code, v]));
const groupByCode = new Map(EXPENSE_GROUPS.map((v) => [v.code, v]));
export const expenseCategory = (code: string) => byCode.get(code);
export const expenseGroup = (code: string) => groupByCode.get(code);
/** Articles a person enters (every article but automatic revenue). */
export const enterable = (code: string) => {
  const v = byCode.get(code);
  return !!v && v.kind !== 'revenue_auto';
};
/** Payroll and rent: the shares the P&L tiles show (owner request section 6). */
export const PAYROLL_GROUP = 'payroll';
export const RENT_CATEGORY = 'rent';
