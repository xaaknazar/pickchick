import { getLocale, t } from './i18n/core.ts';
// Presentation only: whether ordering is accepted stays server-owned. These helpers
// read the published hours from config/restaurant-locations.json for the M05 status.

export interface RestaurantHours {
  opening_time?: string | null;
  closing_time?: string | null;
}

export type RestaurantHoursStatus =
  /** `closesAt` is null when the restaurant is open around the clock. */
  | { open: true; closesAt: string | null }
  | { open: false; opensAt: string; opensTomorrow: boolean };

const DAY = 24 * 60;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:MM" -> minutes after midnight; "00:00" is midnight. */
export function clockMinutes(value: string | null | undefined): number | null {
  const match = typeof value === 'string' ? CLOCK.exec(value) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Status at `minute` (0-1439, restaurant local time). A closing time at or before
 * the opening time belongs to the next day: 10:00-00:00 closes at midnight and
 * 10:00-02:00 stays open until 02:00. Equal times mean open around the clock.
 */
export function hoursStatusAtMinute(
  openingTime: string,
  closingTime: string,
  minute: number,
): RestaurantHoursStatus | null {
  const opening = clockMinutes(openingTime);
  const closing = clockMinutes(closingTime);
  if (opening === null || closing === null || !(minute >= 0 && minute < DAY)) return null;
  if (opening === closing) return { open: true, closesAt: null };
  const overnight = closing < opening;
  const open = overnight
    ? minute >= opening || minute < closing
    : minute >= opening && minute < closing;
  if (open) return { open: true, closesAt: closingTime };
  // Closed after a same-day closing time: the next opening is tomorrow.
  return { open: false, opensAt: openingTime, opensTomorrow: !overnight && minute >= closing };
}

/** Minutes after midnight in Almaty, whatever the device time zone. */
export function almatyMinuteOfDay(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Almaty',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value ?? NaN);
  // Some engines still print midnight as 24:00.
  return (part('hour') % 24) * 60 + part('minute');
}

/**
 * Minutes after midnight in `timeZone` (the zone the server publishes with its ordering hours),
 * whatever the device time zone; null for an unknown zone or an invalid date.
 */
export function zonedMinuteOfDay(now: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((item) => item.type === type)?.value ?? NaN);
    const minute = (part('hour') % 24) * 60 + part('minute');
    return Number.isInteger(minute) && minute >= 0 && minute < DAY ? minute : null;
  } catch {
    return null;
  }
}

export function restaurantHoursStatus(
  hours: RestaurantHours | null | undefined,
  now: Date,
): RestaurantHoursStatus | null {
  if (!hours?.opening_time || !hours.closing_time) return null;
  return hoursStatusAtMinute(hours.opening_time, hours.closing_time, almatyMinuteOfDay(now));
}

/**
 * Header caption on Меню, События and Заказы (owner 28.10.2026, Drinkit): today's hours while
 * the restaurant is open, «откроемся в 10:00» (or «откроемся завтра в 10:00») while it is closed.
 * Presentation only; the RU source is localized by the caller.
 */
export function headerHoursCaption(
  hours: RestaurantHours | null | undefined,
  status: RestaurantHoursStatus | null,
): string {
  if (status && !status.open)
    return status.opensTomorrow
      ? t('откроемся завтра в {p0}', { p0: status.opensAt })
      : t('откроемся в {p0}', { p0: status.opensAt });
  if (hours?.opening_time && hours.closing_time)
    return `${hours.opening_time}-${hours.closing_time}`;
  if (hours?.closing_time) return t('до {p0}', { p0: hours.closing_time });
  return 'Часы работы не указаны';
}

/** "Открыто" + " · до 00:00", or "Закрыто" + " · откроется в 10:00". */
export function hoursStatusText(status: RestaurantHoursStatus): { state: string; detail: string } {
  if (status.open)
    return {
      state: 'Открыто',
      detail: status.closesAt ? t('до {p0}', { p0: status.closesAt }) : 'круглосуточно',
    };
  return {
    state: 'Закрыто',
    detail: t('откроется {p0}в {p1}', {
      p0: status.opensTomorrow ? 'завтра ' : '',
      p1: status.opensAt,
    }),
  };
}

/**
 * "1 ресторан", "2 ресторана", "5 ресторанов", "21 ресторан"; KK «1 мейрамхана», EN «1 restaurant»
 * / «2 restaurants» (review 29.10.2026: EN showed «Алматы · 1 ресторан»).
 */
export function restaurantCountLabel(count: number): string {
  const locale = getLocale();
  if (locale === 'en') return `${count} ${count === 1 ? 'restaurant' : 'restaurants'}`;
  if (locale === 'kk') return `${count} мейрамхана`;
  const ones = count % 10;
  const tens = count % 100;
  const noun =
    ones === 1 && tens !== 11
      ? 'ресторан'
      : ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)
        ? 'ресторана'
        : 'ресторанов';
  return `${count} ${noun}`;
}
