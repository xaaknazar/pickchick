import { tenge } from './ui-fixes.js';

/**
 * «Скидки» of the cabinet (lane bo-ui step 7; design-bo-ui 5.8): the view of GET .../ops/discounts,
 * the words for a discount, the editor form and the commands. Pure functions; the page is
 * discounts.ts. Shown only while GET branches/:id reports capabilities.discounts (the server with
 * BACKOFFICE_DISCOUNTS_ENABLED and the cloud075 rights); without it the cabinet has no section.
 * The POS does not apply discounts yet: the page says so on top.
 */
type Data = Record<string, unknown>;
export type DiscountKind = 'percent' | 'amount';
export type DiscountState = 'draft' | 'active' | 'archived';
export type DiscountScope = { categories: string[]; products: string[]; channels: string[] };
export type DiscountSchedule = {
  start_at: string | null;
  end_at: string | null;
  weekdays: number[];
  hours: { from: string; to: string }[];
};
export type Discount = {
  id: string;
  name: string;
  kind: DiscountKind;
  percent_bp: number | null;
  value_minor: string | null;
  scope: DiscountScope;
  schedule: DiscountSchedule;
  requires_manager_pin: boolean;
  combinable: boolean;
  state: DiscountState;
  revision: number;
  created_by_name: string | null;
  created_at: string;
  updated_by_name: string | null;
  updated_at: string;
  period: 'always' | 'not_started' | 'running' | 'ended';
  unknown_items: { categories: string[]; products: string[] };
  valid: boolean;
};
export type DiscountCatalog = {
  version: number;
  categories: { id: string; name: string }[];
  products: { id: string; name: string; category_id: string }[];
};
export type DiscountRevision = {
  revision: number;
  name: string;
  kind: DiscountKind;
  percent_bp: number | null;
  value_minor: string | null;
  scope: DiscountScope;
  schedule: DiscountSchedule;
  requires_manager_pin: boolean;
  combinable: boolean;
  state: DiscountState;
  changed_by_name: string | null;
  changed_at: string;
};
export type DiscountsView = {
  schema_version: 1;
  branch_id: string;
  as_of: string;
  applied_at_pos: boolean;
  published_to_edge: boolean;
  channels: string[];
  catalog: DiscountCatalog | null;
  discounts: Discount[];
  truncated: boolean;
  id?: string;
  history?: DiscountRevision[];
  history_truncated?: boolean;
};

/** The section of the cabinet (after «Промо и баннеры»), only with capabilities.discounts. */
export const DISCOUNTS_SECTION = [
  'discounts',
  'Скидки',
  'Скидки для кассы: размер, меню, каналы и время',
] as const;
/** The words the owner asked for (05.11): the POS does not apply discounts yet. */
export const DISCOUNT_BANNER =
  'Скидки пока не применяются на кассе. Включим после проверки на кассе.';
export const CHANNEL_LABELS: Record<string, string> = {
  hall: 'Зал',
  yandex_eda: 'Яндекс Еда',
  glovo: 'Glovo',
  chocofood: 'ChocoFood',
  mobile: 'Приложение',
  kiosk: 'Киоск',
};
export const DISCOUNT_CHANNELS = Object.keys(CHANNEL_LABELS);
export const STATE_LABELS: Record<DiscountState, string> = {
  draft: 'Черновик',
  active: 'Включена',
  archived: 'В архиве',
};
export const PERIOD_LABELS: Record<Discount['period'], string> = {
  always: 'без срока',
  not_started: 'ещё не началась',
  running: 'идёт',
  ended: 'период закончился',
};
export const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
export const HOUR_WINDOWS = 4;
export const NAME_MAX = 80;
export const AMOUNT_MAX_MINOR = 100000000n;
/** Shown filters of the list. */
export const FILTERS = [
  ['live', 'Действующие и черновики'],
  ['active', 'Включённые'],
  ['draft', 'Черновики'],
  ['archived', 'Архив'],
  ['all', 'Все'],
] as const;
export type Filter = (typeof FILTERS)[number][0];

const isObject = (v: unknown): v is Data =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);
/** GET .../ops/discounts as the page reads it; anything else is an invalid answer. */
export function discountsView(value: unknown, branch: string): DiscountsView {
  if (
    !isObject(value) ||
    value['schema_version'] !== 1 ||
    value['branch_id'] !== branch ||
    !Array.isArray(value['discounts']) ||
    !Array.isArray(value['channels']) ||
    typeof value['as_of'] !== 'string' ||
    !(value['catalog'] === null || isObject(value['catalog'])) ||
    (value['history'] !== undefined && !Array.isArray(value['history']))
  )
    throw new Error('INVALID_RESPONSE');
  for (const d of value['discounts'] as unknown[])
    if (
      !isObject(d) ||
      typeof d['id'] !== 'string' ||
      typeof d['name'] !== 'string' ||
      !isObject(d['scope']) ||
      !isObject(d['schedule']) ||
      typeof d['revision'] !== 'number'
    )
      throw new Error('INVALID_RESPONSE');
  return value as unknown as DiscountsView;
}
export function visible(list: readonly Discount[], filter: Filter): Discount[] {
  return list.filter((d) =>
    filter === 'all' ? true : filter === 'live' ? d.state !== 'archived' : d.state === filter,
  );
}

// --------------------------------------------------------------------------- words ----

/** «10 %», «12,5 %» or «500 ₸». */
export function valueText(d: Pick<Discount, 'kind' | 'percent_bp' | 'value_minor'>): string {
  if (d.kind === 'amount') return tenge(d.value_minor ?? '0');
  const bp = d.percent_bp ?? 0;
  const whole = Math.floor(bp / 100),
    part = bp % 100;
  return `${whole}${part ? ',' + String(part).padStart(2, '0').replace(/0$/, '') : ''} %`;
}
export function channelsText(channels: readonly string[]): string {
  if (DISCOUNT_CHANNELS.every((c) => channels.includes(c))) return 'Все каналы';
  return channels.map((c) => CHANNEL_LABELS[c] ?? c).join(', ') || '-';
}
/** What the discount applies to, with the names of the head catalog. */
export function scopeText(
  scope: DiscountScope,
  catalog: DiscountCatalog | null,
  unknown?: { categories: string[]; products: string[] },
): string {
  if (!scope.categories.length && !scope.products.length) return 'Всё меню';
  const missing = (list: string[] | undefined, id: string) =>
    list?.includes(id) ? ' (нет в меню)' : '';
  const name = (kind: 'categories' | 'products', id: string) =>
    (kind === 'categories'
      ? catalog?.categories.find((c) => c.id === id)?.name
      : catalog?.products.find((p) => p.id === id)?.name) ?? id;
  const parts = [];
  if (scope.categories.length)
    parts.push(
      'Категории: ' +
        scope.categories
          .map((id) => name('categories', id) + missing(unknown?.categories, id))
          .join(', '),
    );
  if (scope.products.length)
    parts.push(
      'Позиции: ' +
        scope.products
          .map((id) => name('products', id) + missing(unknown?.products, id))
          .join(', '),
    );
  return parts.join('; ');
}

const dayParts = (iso: string) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Almaty',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
/** The Almaty calendar day of an instant, YYYY-MM-DD. */
export function almatyDay(iso: string): string {
  const p = dayParts(iso);
  return `${p['year']}-${p['month']}-${p['day']}`;
}
/** The instant (ISO UTC) of 00:00 Almaty of a calendar day YYYY-MM-DD. */
export function almatyMidnight(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const offset = (t: number) => {
    const p = dayParts(new Date(t).toISOString());
    return (
      Date.UTC(
        +p['year']!,
        +p['month']! - 1,
        +p['day']!,
        +p['hour']!,
        +p['minute']!,
        +p['second']!,
      ) - t
    );
  };
  let t = guess - offset(guess);
  t = guess - offset(t);
  return new Date(t).toISOString();
}
export const shiftDay = (day: string, days: number) => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
const dotted = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;
const isMidnight = (iso: string) => almatyMidnight(almatyDay(iso)) === new Date(iso).toISOString();
const clock = (iso: string) => {
  const p = dayParts(iso);
  return `${p['hour']}:${p['minute']}`;
};
/** The last day of the period, inclusive (end_at is the next midnight), or null. */
export function lastDay(endAt: string): string {
  return isMidnight(endAt) ? shiftDay(almatyDay(endAt), -1) : almatyDay(endAt);
}
/** «с 20.11.2026 по 30.11.2026», «с 20.11.2026», «по 30.11.2026» or «Без срока». */
export function periodText(s: Pick<DiscountSchedule, 'start_at' | 'end_at'>): string {
  const parts = [];
  if (s.start_at)
    parts.push(
      'с ' +
        dotted(almatyDay(s.start_at)) +
        (isMidnight(s.start_at) ? '' : ' ' + clock(s.start_at)),
    );
  if (s.end_at)
    parts.push(
      isMidnight(s.end_at)
        ? 'по ' + dotted(lastDay(s.end_at))
        : 'до ' + dotted(almatyDay(s.end_at)) + ' ' + clock(s.end_at),
    );
  return parts.join(' ') || 'Без срока';
}
export function daysText(weekdays: readonly number[]): string {
  if (weekdays.length === 7) return 'Каждый день';
  return (
    [...weekdays]
      .sort((a, b) => a - b)
      .map((d) => WEEKDAYS[d - 1] ?? String(d))
      .join(', ') || '-'
  );
}
export function hoursText(hours: readonly { from: string; to: string }[]): string {
  if (!hours.length) return 'Весь день';
  return [...hours]
    .sort((a, b) => a.from.localeCompare(b.from))
    .map((h) => `${h.from}-${h.to}`)
    .join(', ');
}
export function whenText(s: DiscountSchedule): string {
  return `${periodText(s)}; ${daysText(s.weekdays)}; ${hoursText(s.hours)}`;
}
export function conditionsText(d: Pick<Discount, 'requires_manager_pin' | 'combinable'>): string {
  return [
    d.requires_manager_pin ? 'PIN начальника смены' : 'Без PIN',
    d.combinable ? 'вместе с другими скидками' : 'не суммируется',
  ].join(', ');
}
/** «Включена, идёт» and the like: the state in words, never by colour alone. */
export function stateText(d: Pick<Discount, 'state' | 'period'>): string {
  if (d.state === 'archived') return STATE_LABELS.archived;
  return `${STATE_LABELS[d.state]}, ${PERIOD_LABELS[d.period]}`;
}
/** The state changes a discount offers: on and off, and the archive (final). */
export function stateActions(d: Pick<Discount, 'state'>): DiscountState[] {
  return d.state === 'draft'
    ? ['active', 'archived']
    : d.state === 'active'
      ? ['draft', 'archived']
      : [];
}
export const ACTION_LABELS: Record<DiscountState, string> = {
  active: 'Включить',
  draft: 'Выключить',
  archived: 'В архив',
};
export const ACTION_TEXTS: Record<DiscountState, string> = {
  active:
    'Скидка станет включённой. На кассе она начнёт работать только после обновления кассы: сейчас касса скидки не применяет.',
  draft: 'Скидка станет черновиком.',
  archived: 'Скидка уйдёт в архив. Архив нельзя вернуть, а название освободится для новой скидки.',
};
export const ACTION_REASONS: Record<DiscountState, string> = {
  active: 'Включение скидки',
  draft: 'Выключение скидки',
  archived: 'Скидка в архив',
};

// ---------------------------------------------------------------------------- form ----

export type DiscountForm = {
  name: string;
  kind: DiscountKind;
  /** «10» or «12,5» for a percent; «500» or «500,50» tenge for an amount. */
  value: string;
  channels: string[];
  whole: boolean;
  categories: string[];
  products: string[];
  /** Almaty calendar days, inclusive; '' = no bound. */
  startDay: string;
  endDay: string;
  /** The stored bounds, kept as they are while their day is not changed. */
  startKeep: string | null;
  endKeep: string | null;
  weekdays: number[];
  hours: { from: string; to: string }[];
  pin: boolean;
  combinable: boolean;
};
export function emptyForm(): DiscountForm {
  return {
    name: '',
    kind: 'percent',
    value: '',
    channels: ['hall'],
    whole: true,
    categories: [],
    products: [],
    startDay: '',
    endDay: '',
    startKeep: null,
    endKeep: null,
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    hours: [],
    pin: true,
    combinable: false,
  };
}
const bpText = (bp: number) =>
  valueText({ kind: 'percent', percent_bp: bp, value_minor: null }).replace(' %', '');
const minorText = (minor: string) => {
  const n = BigInt(minor),
    part = n % 100n;
  return `${n / 100n}${part ? ',' + part.toString().padStart(2, '0') : ''}`;
};
export function formOf(d: Discount | DiscountRevision): DiscountForm {
  return {
    name: d.name,
    kind: d.kind,
    value: d.kind === 'amount' ? minorText(d.value_minor ?? '0') : bpText(d.percent_bp ?? 0),
    channels: [...d.scope.channels],
    whole: !d.scope.categories.length && !d.scope.products.length,
    categories: [...d.scope.categories],
    products: [...d.scope.products],
    startDay: d.schedule.start_at ? almatyDay(d.schedule.start_at) : '',
    endDay: d.schedule.end_at ? lastDay(d.schedule.end_at) : '',
    startKeep: d.schedule.start_at,
    endKeep: d.schedule.end_at,
    weekdays: [...d.schedule.weekdays],
    hours: d.schedule.hours.map((h) => ({ ...h })),
    pin: d.requires_manager_pin,
    combinable: d.combinable,
  };
}
/** «12,5» -> 1250 (1..100 %, at most two decimals), or null. */
export function percentBp(text: string): number | null {
  const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bp >= 100 && bp <= 10000 ? bp : null;
}
/** «1 500,50» -> '150050' tiyn (more than 0, at most 1 000 000 ₸), or null. */
export function amountMinor(text: string): string | null {
  const m = /^(\d{1,7})(?:[.,](\d{1,2}))?$/.exec(text.replace(/\s/g, ''));
  if (!m) return null;
  const minor = BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
  return minor > 0n && minor <= AMOUNT_MAX_MINOR ? minor.toString() : null;
}
const CLOCK = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const CLOCK_END = /^(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00)$/;
export const FORM_ERRORS = {
  name: 'Введите название скидки: от 1 до 80 символов, в одну строку.',
  percent: 'Процент скидки - от 1 до 100, не больше двух знаков после запятой.',
  amount: 'Сумма скидки - больше 0 и не больше 1 000 000 ₸, не больше двух знаков после запятой.',
  channels: 'Выберите хотя бы один канал, где действует скидка.',
  items: 'Выберите категории или позиции меню или отметьте «Всё меню».',
  period: 'Дата окончания не может быть раньше даты начала.',
  weekdays: 'Выберите хотя бы один день недели.',
  hours:
    'Часы: начало раньше конца (ЧЧ:ММ, конец до 24:00), промежутки не пересекаются, не больше четырёх.',
};
/**
 * The discount_save payload of the form, or the reasons in words why it is not valid (the same
 * rules as the server, discounts.ts).
 */
export function formPayload(
  f: DiscountForm,
): { payload: Data; errors: [] } | { payload: null; errors: string[] } {
  const errors: string[] = [];
  const name = f.name.trim();
  // eslint-disable-next-line no-control-regex
  if (!name || name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name))
    errors.push(FORM_ERRORS.name);
  const bp = f.kind === 'percent' ? percentBp(f.value) : null;
  const minor = f.kind === 'amount' ? amountMinor(f.value) : null;
  if (f.kind === 'percent' && bp === null) errors.push(FORM_ERRORS.percent);
  if (f.kind === 'amount' && minor === null) errors.push(FORM_ERRORS.amount);
  const channels = DISCOUNT_CHANNELS.filter((c) => f.channels.includes(c));
  if (!channels.length) errors.push(FORM_ERRORS.channels);
  const categories = f.whole ? [] : [...new Set(f.categories)].sort();
  const products = f.whole ? [] : [...new Set(f.products)].sort();
  if (!f.whole && !categories.length && !products.length) errors.push(FORM_ERRORS.items);
  const keep = (day: string, stored: string | null, read: (iso: string) => string) =>
    stored && read(stored) === day ? new Date(stored).toISOString() : null;
  const start_at = f.startDay
    ? (keep(f.startDay, f.startKeep, almatyDay) ?? almatyMidnight(f.startDay))
    : null;
  const end_at = f.endDay
    ? (keep(f.endDay, f.endKeep, lastDay) ?? almatyMidnight(shiftDay(f.endDay, 1)))
    : null;
  if (start_at && end_at && Date.parse(end_at) <= Date.parse(start_at))
    errors.push(FORM_ERRORS.period);
  const weekdays = [...new Set(f.weekdays)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  if (!weekdays.length) errors.push(FORM_ERRORS.weekdays);
  const hours = [...f.hours].sort((a, b) => a.from.localeCompare(b.from));
  if (
    hours.length > HOUR_WINDOWS ||
    hours.some(
      (h, i) =>
        !CLOCK.test(h.from) ||
        !CLOCK_END.test(h.to) ||
        h.to <= h.from ||
        (i > 0 && h.from < hours[i - 1]!.to),
    )
  )
    errors.push(FORM_ERRORS.hours);
  if (errors.length) return { payload: null, errors };
  return {
    payload: {
      name,
      kind: f.kind,
      percent_bp: bp,
      value_minor: minor,
      scope: { categories, products, channels },
      schedule: {
        start_at,
        end_at,
        weekdays,
        hours: hours.map((h) => ({ from: h.from, to: h.to })),
      },
      requires_manager_pin: f.pin,
      combinable: f.combinable,
    },
    errors: [],
  };
}
export const saveCommand = (id: string, revision: number, payload: Data) => ({
  type: 'discount_save',
  id,
  expected_revision: revision,
  payload,
});
export const stateCommand = (id: string, revision: number, state: DiscountState) => ({
  type: 'discount_state',
  id,
  state,
  expected_revision: revision,
});
/** The server reasons of the discount commands in words (the generic text otherwise). */
export const DISCOUNT_ERRORS: Record<string, string> = {
  DISCOUNT_NAME_TAKEN: 'Скидка с таким названием уже есть. Выберите другое название.',
  DISCOUNT_ARCHIVED: 'Скидка в архиве: её нельзя изменить или включить. Создайте новую.',
  DISCOUNT_PERIOD_ENDED: 'Период скидки уже закончился. Измените даты и включите её снова.',
  CATALOG_ITEM_NOT_FOUND:
    'Некоторых категорий или позиций уже нет в опубликованном меню. Уберите их из скидки.',
  CATALOG_NOT_PUBLISHED:
    'Меню ещё не опубликовано: выберите «Всё меню» или сначала опубликуйте меню.',
  CONFLICT: 'Скидку уже изменили в другом окне. Обновите список и повторите.',
  NOT_FOUND: 'Скидка не найдена. Обновите список.',
  NOT_READY: 'Скидки пока недоступны на сервере. Обновите страницу позже.',
};
