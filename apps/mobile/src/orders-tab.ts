import { t, dateLocale } from './i18n/core.ts';
/**
 * Pure presentation helpers for the Orders tab (M19). They only arrange data the app
 * already holds; no network reads, payment decisions or order transitions live here.
 */

export const ALMATY_TIME_ZONE = 'Asia/Almaty';
// Same Intl approach as the profile and birth-date helpers: the restaurant calendar,
// not the device time zone, decides which day an order belongs to.
const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: ALMATY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const clockFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: ALMATY_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function toDate(value: string | number | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) {
  return parts.find((item) => item.type === type)?.value ?? '';
}

/** `YYYY-MM-DD` of the Almaty calendar day, or null for an unreadable timestamp. */
export function almatyDayKey(value: string | number | Date): string | null {
  const date = toDate(value);
  if (!date) return null;
  const parts = dayFormat.formatToParts(date);
  const key = `${part(parts, 'year')}-${part(parts, 'month')}-${part(parts, 'day')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null;
}

/** `HH:MM` on the Almaty clock; empty for an unreadable timestamp. */
export function almatyClock(value: string | number | Date): string {
  const date = toDate(value);
  if (!date) return '';
  const parts = clockFormat.formatToParts(date);
  const hour = part(parts, 'hour');
  const minute = part(parts, 'minute');
  return hour && minute ? `${hour === '24' ? '00' : hour}:${minute}` : '';
}

function shiftDay(key: string, days: number): string {
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day! + days));
  return date.toISOString().slice(0, 10);
}

/** «Сегодня», «Вчера», «2 октября» (with the year when it is not the current one). */
export function historyDayLabel(key: string, now: number | Date = Date.now()): string {
  const today = almatyDayKey(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !today) return t('Ранее');
  if (key === today) return t('Сегодня');
  if (key === shiftDay(today, -1)) return t('Вчера');
  const [year, month, day] = key.split('-').map(Number);
  const monthName = new Intl.DateTimeFormat(dateLocale(), {
    timeZone: ALMATY_TIME_ZONE,
    day: 'numeric',
    month: 'long',
  }).format(new Date(Date.UTC(year!, month! - 1, day!, 12)));
  return year === Number(today.slice(0, 4)) ? monthName : `${monthName} ${year}`;
}

export interface DayGroup<T> {
  key: string;
  label: string;
  items: T[];
}

/** Groups an already sorted list by Almaty day, keeping the incoming order. */
export function groupByAlmatyDay<T>(
  items: readonly T[],
  createdAt: (item: T) => string,
  now: number | Date = Date.now(),
): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const key = almatyDayKey(createdAt(item)) ?? 'unknown';
    let group = groups.find((candidate) => candidate.key === key);
    if (!group) {
      group = { key, label: historyDayLabel(key, now), items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

export type PhotoCell =
  | { kind: 'photo'; productId: string; index: number }
  | { kind: 'empty' }
  | { kind: 'more'; count: number };
export interface PhotoTileLayout {
  shape: 'single' | 'halves' | 'grid';
  cells: PhotoCell[];
}

/**
 * 1 position: one photo; 2: two halves; 3-4: a 2×2 grid with empty cells;
 * 5+: three photos and a «+N» cell, where N = positions - 3.
 */
export function photoTileLayout(productIds: readonly string[]): PhotoTileLayout {
  const photo = (index: number): PhotoCell => ({
    kind: 'photo',
    productId: productIds[index]!,
    index,
  });
  if (productIds.length <= 1)
    return { shape: 'single', cells: productIds.length ? [photo(0)] : [{ kind: 'empty' }] };
  if (productIds.length === 2) return { shape: 'halves', cells: [photo(0), photo(1)] };
  if (productIds.length <= 4)
    return {
      shape: 'grid',
      cells: [0, 1, 2, 3].map((index) =>
        index < productIds.length ? photo(index) : { kind: 'empty' as const },
      ),
    };
  return {
    shape: 'grid',
    cells: [photo(0), photo(1), photo(2), { kind: 'more', count: productIds.length - 3 }],
  };
}

export interface OrderLineView {
  productId: string;
  title: string;
  quantity: number;
}

/** «Master Combo ×2, Pick Combo, Фингер Дуо». */
export function itemsSummary(items: readonly OrderLineView[]): string {
  return items
    .map((item) => (item.quantity > 1 ? `${t(item.title)} ×${item.quantity}` : t(item.title)))
    .join(', ');
}

export const serviceLabel = (mode: 'takeaway' | 'dine_in') =>
  mode === 'takeaway' ? t('С собой') : t('В зале');

/** «№ 12 · 12:32 · С собой»; three or more positions show the piece count instead. */
export function historyMetaParts(order: {
  number: string | null;
  createdAt: string;
  serviceMode: 'takeaway' | 'dine_in';
  items: readonly OrderLineView[];
}): string[] {
  const quantity = order.items.reduce((sum, item) => sum + item.quantity, 0);
  return [
    order.number ? `№ ${order.number}` : '',
    almatyClock(order.createdAt),
    order.items.length >= 3 ? t('{p0} шт.', { p0: quantity }) : serviceLabel(order.serviceMode),
  ].filter(Boolean);
}

export interface RatingCandidate {
  id: string;
  createdAt: string;
  /** Handed over to the guest, so the existing rating flow accepts it. */
  rateable: boolean;
  rated: boolean;
}

/** The single history order that shows «Как вам заказ?»: the newest unrated handed-over one. */
export function latestUnratedOrderId(orders: readonly RatingCandidate[]): string | null {
  let latest: RatingCandidate | null = null;
  for (const order of orders) {
    if (!order.rateable || order.rated) continue;
    if (!latest || Date.parse(order.createdAt) > Date.parse(latest.createdAt)) latest = order;
  }
  return latest?.id ?? null;
}

export const activeSectionTitle = (count: number) =>
  count > 1 ? t('Сейчас · {p0}', { p0: count }) : 'Сейчас';

export type ActiveKind = 'progress' | 'ready' | 'payment';
export type CommercePhase =
  | 'awaiting_restaurant'
  | 'ready_to_pay'
  | 'sending'
  | 'awaiting_payment'
  | 'checking'
  | 'failed'
  | 'paid'
  | 'preparing'
  | 'ready'
  | 'handed_over'
  | 'attention';

/** Bank-paid orders: kitchen states are tracked, unpaid ones wait for payment. */
export function commerceActiveKind(phase: CommercePhase): ActiveKind | null {
  if (phase === 'paid' || phase === 'preparing') return 'progress';
  if (phase === 'ready') return 'ready';
  if (
    ['awaiting_restaurant', 'ready_to_pay', 'sending', 'awaiting_payment', 'checking'].includes(
      phase,
    )
  )
    return 'payment';
  return null;
}

export type TestState = 'awaiting_test_payment' | 'preparing' | 'ready' | 'fulfilled' | 'cancelled';
export function testActiveKind(state: TestState): ActiveKind | null {
  if (state === 'preparing') return 'progress';
  if (state === 'ready') return 'ready';
  if (state === 'awaiting_test_payment') return 'payment';
  return null;
}

const kindRank: Record<ActiveKind, number> = { ready: 0, progress: 1, payment: 2 };
/** «Сейчас» order: ready for pickup first, then the kitchen, then unpaid; stable otherwise. */
export function sortActive<T extends { kind: ActiveKind }>(orders: readonly T[]): T[] {
  return [...orders].sort((a, b) => kindRank[a.kind] - kindRank[b.kind]);
}

/** Number shown on the «Заказы» tab: everything listed under «Сейчас». */
export function activeOrderCount<T>(
  orders: readonly T[],
  kind: (order: T) => ActiveKind | null,
): number {
  return orders.filter((order) => kind(order) !== null).length;
}

/** Badge and lit stage bars (Кухня / Сборка / Выдача) of an order in progress. */
export function progressStage(stage: 'paid' | 'cooking' | 'assembly'): {
  badge: string;
  bars: number;
} {
  if (stage === 'assembly') return { badge: 'Собираем', bars: 2 };
  if (stage === 'cooking') return { badge: 'Готовим', bars: 1 };
  return { badge: 'Оплачен', bars: 0 };
}

/** `4:12` for an invoice countdown in seconds. */
export function countdownLabel(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}
