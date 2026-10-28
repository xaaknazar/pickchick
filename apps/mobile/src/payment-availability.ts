import { t } from './i18n/core.ts';
import { unavailableCartLine, type Availability, type AvailabilityStatus } from './availability.ts';
import {
  clockMinutes,
  hoursStatusAtMinute,
  restaurantHoursStatus,
  zonedMinuteOfDay,
  type RestaurantHours,
  type RestaurantHoursStatus,
} from './restaurant-hours.ts';
import type { CartLine } from './model';

/**
 * Can this customer pay right now, and if not, why (owner 28.10.2026, Drinkit reference: a closed
 * restaurant shows no payment handle on the cart bar, a red reason in the cart and a grey
 * «Пока не работаем» button). One pure decision shared by the cart bar, the cart and the slide
 * intent. It only ever HIDES or DISABLES payment: the guarded checkout keeps every server check
 * (the server stays the authority) and nothing here creates a quote, an order or an invoice.
 *
 * Sources, all already on the device:
 *  - the public availability long-poll: the server's ordering hours (`hours`, re-evaluated here
 *    on the minute so the state flips at opening/closing time) and its own `orderingOpen`
 *    (`status === 'closed'`), the server switch (`enabled: false`), connection and freshness;
 *  - the cart's own GET /config: `enabled: false` is the owner's server switch (NOT_READY);
 *  - the stop list applied to the basket (availability.ts).
 * Until the long-poll has answered once in this app run (launch, QA 28.10) the restaurant's state
 * is unknown: no payment at all, never a handle that the server would then refuse. In that
 * window only, the restaurant directory (config/restaurant-locations.json, the hours the header
 * already shows) names the reason «откроемся в 10:00»; once the server answers, its own hours
 * and `orderingOpen` decide, because a server without published hours accepts orders at any
 * time. The public capabilities `ordering_enabled` is a frozen v1 flag (always false,
 * services/api/src/capabilities.ts) and is deliberately not read.
 */
export type PaymentStop =
  /** `opensAt` is null when the server says closed without publishing its hours. */
  | { kind: 'closed'; opensAt: string | null; opensTomorrow: boolean }
  /** Payments switched off on the server (/config `enabled: false`, availability disabled). */
  | { kind: 'switched_off' }
  /** The availability long-poll cannot reach the server. */
  | { kind: 'offline' }
  /** The restaurant's stop list is not fresh: the server would not admit an order. */
  | { kind: 'stale' }
  /** Basket lines on the stop list (or a selected option that ran out). */
  | { kind: 'unavailable'; names: string[] }
  /**
   * The availability long-poll has not answered yet in this app run (the first read at launch):
   * the restaurant may be closed or switched off, so nothing is offered until it answers
   * (usually within a second). No banner, a grey «Проверяем…» button.
   */
  | { kind: 'checking' };

export type PaymentAvailability = { canPay: true } | { canPay: false; stop: PaymentStop };

export const PAYMENT_AVAILABLE: PaymentAvailability = { canPay: true };

export interface PaymentAvailabilityInput {
  /**
   * The guarded Kaspi checkout applies (cart-bar.ts slideToPayAvailable: Kaspi build, server
   * catalogue and accounts). Other builds, the design catalogue and the demonstration keep their
   * own flow unchanged.
   */
  guarded: boolean;
  now: Date | number;
  /** Public availability status (availability.ts) and the hours the server published with it. */
  status?: AvailabilityStatus;
  hours?: Availability['hours'];
  /**
   * The long-poll has answered at least once in this app run (its data is kept while it re-reads).
   * Missing or false with a `checking` / `error` status: the restaurant's state is unknown.
   */
  known?: boolean;
  /** The restaurant directory's hours (Almaty), read only while the state is unknown. */
  directory?: RestaurantHours | null;
  /** The cart's last /config answer for this customer; false = the server switch is off. */
  checkoutEnabled?: boolean | null;
  cart: readonly CartLine[];
}

const asDate = (now: Date | number) => (now instanceof Date ? now : new Date(now));

/** Status of the hours the server published (its own time zone), or null when it has none. */
export function publishedHoursStatus(
  hours: Availability['hours'] | undefined,
  now: Date | number,
): RestaurantHoursStatus | null {
  if (!hours) return null;
  const minute = zonedMinuteOfDay(asDate(now), hours.timeZone);
  return minute === null ? null : hoursStatusAtMinute(hours.openingTime, hours.closingTime, minute);
}

/** Basket lines the restaurant cannot serve now, one name per product, in basket order. */
export function unavailableCartNames(cart: readonly CartLine[]): string[] {
  const names: string[] = [];
  for (const line of cart)
    if (
      (line.product.available === false || unavailableCartLine(line) !== null) &&
      !names.includes(line.product.name)
    )
      names.push(line.product.name);
  return names;
}

/**
 * The server says closed while the phone's clock still reads its published hours as open: the two
 * clocks disagree by a little. Nearer the opening (a phone a little ahead, or the opening minute
 * before the server confirms it) the restaurant opens at today's opening time; nearer the closing
 * (a phone a little behind) the restaurant has just closed, so the next opening is read at the
 * closing minute: «завтра» for same-day hours like 09:00-21:00, the same day for 10:00-00:00.
 * Hours open around the clock (or unreadable) give no time.
 */
function serverClosedStop(input: Pick<PaymentAvailabilityInput, 'hours' | 'now'>): PaymentStop {
  const hours = input.hours;
  const opening = clockMinutes(hours?.openingTime);
  const closing = clockMinutes(hours?.closingTime);
  if (!hours || opening === null || closing === null || opening === closing)
    return { kind: 'closed', opensAt: null, opensTomorrow: false };
  const minute = zonedMinuteOfDay(asDate(input.now), hours.timeZone);
  const DAY = 24 * 60;
  const sinceOpening = minute === null ? 0 : (minute - opening + DAY) % DAY;
  const untilClosing = minute === null ? DAY : (closing - minute + DAY) % DAY;
  if (sinceOpening <= untilClosing)
    return { kind: 'closed', opensAt: hours.openingTime, opensTomorrow: false };
  const atClosing = hoursStatusAtMinute(hours.openingTime, hours.closingTime, closing);
  return atClosing && !atClosing.open
    ? { kind: 'closed', opensAt: atClosing.opensAt, opensTomorrow: atClosing.opensTomorrow }
    : { kind: 'closed', opensAt: hours.openingTime, opensTomorrow: false };
}

/** No answer from the server yet in this app run: the first read, or a first read that failed. */
export function availabilityUnknown(input: Pick<PaymentAvailabilityInput, 'status' | 'known'>) {
  return (
    !input.known &&
    (input.status === undefined || input.status === 'checking' || input.status === 'error')
  );
}

/**
 * The decision. Reasons in order of what the customer can do about them: a closed restaurant
 * (with the next opening), the server switch, the connection, the menu freshness, the basket.
 * Nothing is payable before the server's first answer (QA 28.10: at launch a closed restaurant
 * showed the handle for seconds and a slide reached /quotes); an unexpected answer (`error`: a
 * captive portal page, a broken proxy) is no connection to the server. A re-read keeps the last
 * answer (`known`), so the handle does not blink while the menu refreshes.
 */
export function paymentAvailability(input: PaymentAvailabilityInput): PaymentAvailability {
  if (!input.guarded) return PAYMENT_AVAILABLE;
  const unknown = availabilityUnknown(input);
  const hours =
    publishedHoursStatus(input.hours, input.now) ??
    (unknown ? restaurantHoursStatus(input.directory, asDate(input.now)) : null);
  // Closed by the published hours at this minute (by the directory before the first answer), or
  // by the server's own last answer (around the opening minute the server confirms within one
  // long-poll; the stricter answer wins).
  if (hours && !hours.open)
    return {
      canPay: false,
      stop: { kind: 'closed', opensAt: hours.opensAt, opensTomorrow: hours.opensTomorrow },
    };
  if (input.status === 'closed') return { canPay: false, stop: serverClosedStop(input) };
  if (input.status === 'disabled' || input.checkoutEnabled === false)
    return { canPay: false, stop: { kind: 'switched_off' } };
  if (input.status === 'offline' || input.status === 'error')
    return { canPay: false, stop: { kind: 'offline' } };
  if (input.status === 'stale') return { canPay: false, stop: { kind: 'stale' } };
  if (unknown) return { canPay: false, stop: { kind: 'checking' } };
  const names = unavailableCartNames(input.cart);
  if (names.length) return { canPay: false, stop: { kind: 'unavailable', names } };
  return PAYMENT_AVAILABLE;
}

/**
 * The red banner of the cart (testID cart-unavailable): the reason, in the current language. One
 * short line without a closing period, like Drinkit's. Null: no banner (the first read at launch
 * is not a reason, the grey button says «Проверяем…»).
 */
export function paymentStopMessage(stop: PaymentStop): string | null {
  switch (stop.kind) {
    case 'closed':
      if (!stop.opensAt) return t('Ресторан сейчас закрыт');
      return stop.opensTomorrow
        ? t('откроемся завтра в {p0}', { p0: stop.opensAt })
        : t('откроемся в {p0}', { p0: stop.opensAt });
    case 'switched_off':
      return t('Оплата временно недоступна');
    case 'offline':
      // One short line like Drinkit's banner; the longer connection advice stays where it
      // already lived (availability.ts).
      return t('Нет связи с сервером');
    case 'stale':
      return t('Нет свежих данных от ресторана. Проверяем связь автоматически.');
    case 'unavailable':
      return t('Нет в наличии: {p0}', { p0: stop.names.map((name) => t(name)).join(', ') });
    case 'checking':
      return null;
  }
}

/** Short label of the grey, disabled pay button. */
export function paymentStopLabel(stop: PaymentStop): string {
  switch (stop.kind) {
    case 'closed':
      return t('Пока не работаем');
    // A stale restaurant stop list: the customer's phone may well be online, so the label names
    // the payment, not the customer's connection.
    case 'switched_off':
    case 'stale':
      return t('Оплата недоступна');
    case 'offline':
      return t('Нет связи');
    case 'unavailable':
      return t('Проверьте корзину');
    case 'checking':
      return t('Проверяем…');
  }
}

/**
 * Two sentences for one screen-reader hint («откроемся в 10:00. Открыть состав заказа»): the
 * first loses its own closing mark so VoiceOver never reads «..».
 */
export function joinSentences(first: string, second: string): string {
  const head = first.trim().replace(/[.!?…]+$/u, '');
  return head ? `${head}. ${second}` : second;
}

/**
 * What a screen reader should announce when the cart's reason banner changes while the cart is
 * open (for example at 00:00): the new reason, once. Nothing on the first render (the reason is
 * read with the screen) and nothing when the banner goes away.
 */
export function bannerAnnouncement(
  previous: string | null | undefined,
  next: string | null,
): string | null {
  return previous !== undefined && next && next !== previous ? next : null;
}

/**
 * Hours for the header caption: the server's published hours when it has them (the same ones
 * the payment decision uses), otherwise the restaurant directory (Almaty), as before.
 */
export function restaurantHoursNow(input: {
  published?: Availability['hours'];
  location?: RestaurantHours | null;
  now: Date | number;
}): { hours: RestaurantHours | null; status: RestaurantHoursStatus | null } {
  if (input.published) {
    const status = publishedHoursStatus(input.published, input.now);
    if (status)
      return {
        hours: {
          opening_time: input.published.openingTime,
          closing_time: input.published.closingTime,
        },
        status,
      };
  }
  return {
    hours: input.location ?? null,
    status: restaurantHoursStatus(input.location, asDate(input.now)),
  };
}

/**
 * The header caption's hours and state (QA 28.10): the header says «откроемся в 10:00» exactly
 * when the payment decision is «closed», so the header and the cart bar never disagree (a server
 * that publishes no hours takes orders at night: today's hours and the handle, not «откроемся»
 * next to a handle). Builds without the guarded Kaspi checkout, the design catalogue and the
 * demonstration show today's hours as before 28.10.
 */
export function headerHoursNow(input: {
  guarded: boolean;
  availability: PaymentAvailability;
  published?: Availability['hours'];
  location?: RestaurantHours | null;
  now: Date | number;
}): { hours: RestaurantHours | null; status: RestaurantHoursStatus | null } {
  const shown = restaurantHoursNow(input);
  const stop = input.availability.canPay ? null : input.availability.stop;
  if (!input.guarded || stop?.kind !== 'closed') return { hours: shown.hours, status: null };
  if (stop.opensAt)
    return {
      hours: shown.hours,
      status: { open: false, opensAt: stop.opensAt, opensTomorrow: stop.opensTomorrow },
    };
  // Closed by the server without an opening time of its own: the directory's, if it says closed.
  return shown.status && !shown.status.open ? shown : { hours: shown.hours, status: null };
}

/** The next minute boundary (+ a small margin), so a timer flips the state at 10:00 sharp. */
export function msUntilNextMinute(nowMs: number): number {
  const into = ((nowMs % 60_000) + 60_000) % 60_000;
  return 60_000 - into + 50;
}

/**
 * The cart's last /config answer per customer, so the cart bar (all tabs) knows the server
 * switch without another request: the cart reads /config whenever it opens and keeps reading
 * while the switch is off. Memory only; a new app run starts unknown (once availability has
 * answered, the bar shows the handle and the cart, which reads /config, decides).
 */
export interface CheckoutSwitchObservation {
  customerId: string;
  enabled: boolean;
}
let observation: CheckoutSwitchObservation | null = null;
const switchListeners = new Set<() => void>();

export function noteCheckoutSwitch(customerId: string | null | undefined, enabled: boolean) {
  if (!customerId) return;
  if (observation?.customerId === customerId && observation.enabled === enabled) return;
  observation = { customerId, enabled };
  for (const listener of switchListeners) listener();
}

export function subscribeCheckoutSwitch(listener: () => void) {
  switchListeners.add(listener);
  return () => {
    switchListeners.delete(listener);
  };
}

export function checkoutSwitchSnapshot(): CheckoutSwitchObservation | null {
  return observation;
}

/** Only the signed-in customer's own observation counts. */
export function checkoutEnabledFor(
  value: CheckoutSwitchObservation | null,
  customerId: string | null | undefined,
): boolean | null {
  return value && customerId && value.customerId === customerId ? value.enabled : null;
}
