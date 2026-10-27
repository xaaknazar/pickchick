import { t } from './i18n/core.ts';
import { unavailableCartLine, type Availability, type AvailabilityStatus } from './availability.ts';
import {
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
 * The restaurant directory (config/restaurant-locations.json) is presentation only: it feeds the
 * header caption, never the payment decision, because a server without published hours accepts
 * orders at any time. The public capabilities `ordering_enabled` is a frozen v1 flag (always
 * false, services/api/src/capabilities.ts) and is deliberately not read.
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
  | { kind: 'unavailable'; names: string[] };

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
 * The decision. Reasons in order of what the customer can do about them: a closed restaurant
 * (with the next opening), the server switch, the connection, the menu freshness, the basket.
 * `checking` (first read) and `error` (an unexpected answer) are not reasons: the server
 * decides at the explicit press, exactly as before.
 */
export function paymentAvailability(input: PaymentAvailabilityInput): PaymentAvailability {
  if (!input.guarded) return PAYMENT_AVAILABLE;
  const hours = publishedHoursStatus(input.hours, input.now);
  // Closed by the published hours at this minute, or by the server's own last answer (around the
  // opening minute the server confirms within one long-poll; the stricter answer wins).
  if (hours && !hours.open)
    return {
      canPay: false,
      stop: { kind: 'closed', opensAt: hours.opensAt, opensTomorrow: hours.opensTomorrow },
    };
  if (input.status === 'closed')
    return {
      canPay: false,
      stop: { kind: 'closed', opensAt: input.hours?.openingTime ?? null, opensTomorrow: false },
    };
  if (input.status === 'disabled' || input.checkoutEnabled === false)
    return { canPay: false, stop: { kind: 'switched_off' } };
  if (input.status === 'offline') return { canPay: false, stop: { kind: 'offline' } };
  if (input.status === 'stale') return { canPay: false, stop: { kind: 'stale' } };
  const names = unavailableCartNames(input.cart);
  if (names.length) return { canPay: false, stop: { kind: 'unavailable', names } };
  return PAYMENT_AVAILABLE;
}

/** The red banner of the cart (testID cart-unavailable): the reason, in the current language. */
export function paymentStopMessage(stop: PaymentStop): string {
  switch (stop.kind) {
    case 'closed':
      if (!stop.opensAt) return t('Ресторан сейчас закрыт.');
      return stop.opensTomorrow
        ? t('откроемся завтра в {p0}', { p0: stop.opensAt })
        : t('откроемся в {p0}', { p0: stop.opensAt });
    case 'switched_off':
      return t('Оплата временно недоступна');
    case 'offline':
      return t(
        'Не удалось связаться с сервером. Проверьте интернет - связь проверяется автоматически.',
      );
    case 'stale':
      return t('Нет свежих данных от ресторана. Проверяем связь автоматически.');
    case 'unavailable':
      return t('Нет в наличии: {p0}', { p0: stop.names.map((name) => t(name)).join(', ') });
  }
}

/** Short label of the grey, disabled pay button. */
export function paymentStopLabel(stop: PaymentStop): string {
  switch (stop.kind) {
    case 'closed':
      return t('Пока не работаем');
    case 'switched_off':
      return t('Оплата недоступна');
    case 'offline':
    case 'stale':
      return t('Нет связи');
    case 'unavailable':
      return t('Проверьте корзину');
  }
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

/** The next minute boundary (+ a small margin), so a timer flips the state at 10:00 sharp. */
export function msUntilNextMinute(nowMs: number): number {
  const into = ((nowMs % 60_000) + 60_000) % 60_000;
  return 60_000 - into + 50;
}

/**
 * The cart's last /config answer per customer, so the cart bar (all tabs) knows the server
 * switch without another request: the cart reads /config whenever it opens and keeps reading
 * while the switch is off. Memory only; a new app run starts unknown (the bar shows the handle
 * and the cart, which reads /config, decides).
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
