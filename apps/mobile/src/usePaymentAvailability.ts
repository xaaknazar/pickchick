import { useMemo, useSyncExternalStore } from 'react';
import { AppState, type NativeEventSubscription } from 'react-native';
import { slideToPayAvailable } from './cart-bar';
import { kaspiCheckoutEnabled } from './commerce-checkout';
import type { MobileModel } from './model';
import { orderSimulatorEnabled } from './order-simulator';
import {
  checkoutEnabledFor,
  checkoutSwitchSnapshot,
  headerHoursNow,
  msUntilNextMinute,
  paymentAvailability,
  subscribeCheckoutSwitch,
  type PaymentAvailability,
} from './payment-availability';
import { restaurantLocation } from './restaurant-location';
import { useAccount } from './useAccount';

/**
 * One shared minute clock for the payment decision and the header caption: it ticks on every
 * minute boundary (so «откроемся в 10:00» and the handle flip at 10:00) and when the app comes
 * back to the foreground. One timer for all subscribers; none while nothing is mounted.
 */
let minute = Date.now();
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setTimeout> | null = null;
let foreground: NativeEventSubscription | null = null;

function tick() {
  minute = Date.now();
  for (const listener of clockListeners) listener();
  schedule();
}
function schedule() {
  if (clockTimer) clearTimeout(clockTimer);
  clockTimer = setTimeout(tick, msUntilNextMinute(Date.now()));
}
function subscribeClock(listener: () => void) {
  clockListeners.add(listener);
  if (clockListeners.size === 1) {
    minute = Date.now();
    schedule();
    foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') tick();
    });
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size) return;
    if (clockTimer) clearTimeout(clockTimer);
    clockTimer = null;
    foreground?.remove();
    foreground = null;
  };
}
const clockSnapshot = () => minute;

export function useMinuteNow(): number {
  return useSyncExternalStore(subscribeClock, clockSnapshot, clockSnapshot);
}

type AvailabilityModel = Pick<
  MobileModel,
  | 'catalogMode'
  | 'availabilityStatus'
  | 'availabilityHours'
  | 'availabilityKnown'
  | 'branch'
  | 'cart'
>;

/** The guarded Kaspi checkout applies to this model (cart-bar.ts slideToPayAvailable). */
function usePaymentGuarded(model: Pick<MobileModel, 'catalogMode'>) {
  const account = useAccount();
  return slideToPayAvailable({
    kaspiCheckout: kaspiCheckoutEnabled,
    orderSimulator: orderSimulatorEnabled,
    catalogMode: model.catalogMode,
    accountMode: account.mode,
  });
}

/** Can the signed-in (or guest) customer pay right now, and if not, why. See payment-availability.ts. */
export function usePaymentAvailability(model: AvailabilityModel): PaymentAvailability {
  const account = useAccount();
  const now = useMinuteNow();
  const observed = useSyncExternalStore(
    subscribeCheckoutSwitch,
    checkoutSwitchSnapshot,
    checkoutSwitchSnapshot,
  );
  const guarded = usePaymentGuarded(model);
  const checkoutEnabled = checkoutEnabledFor(observed, account.account?.customerId);
  // The directory's hours name the reason only before the server's first answer.
  const directory = restaurantLocation(model.branch?.id);
  return useMemo(
    () =>
      paymentAvailability({
        guarded,
        now,
        status: model.availabilityStatus,
        hours: model.availabilityHours,
        known: model.availabilityKnown,
        directory,
        checkoutEnabled,
        cart: model.cart,
      }),
    [
      guarded,
      now,
      model.availabilityStatus,
      model.availabilityHours,
      model.availabilityKnown,
      directory,
      checkoutEnabled,
      model.cart,
    ],
  );
}

/**
 * Hours and open/closed status for the header caption: «откроемся в 10:00» exactly when the
 * payment decision says closed (Kaspi build), today's hours otherwise and in other builds.
 */
export function useRestaurantHoursNow(model: AvailabilityModel) {
  const now = useMinuteNow();
  const guarded = usePaymentGuarded(model);
  const availability = usePaymentAvailability(model);
  const location = restaurantLocation(model.branch?.id);
  return useMemo(
    () =>
      headerHoursNow({
        guarded,
        availability,
        published: model.availabilityHours,
        location,
        now,
      }),
    [guarded, availability, model.availabilityHours, location, now],
  );
}
