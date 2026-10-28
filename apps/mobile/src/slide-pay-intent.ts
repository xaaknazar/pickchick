/**
 * Slide to pay (cart bar, 27.10.2026): a released Kaspi handle opens the guarded checkout - in
 * the Kaspi build the cart with payment (M09) - with a one-shot intent that equals one press of
 * its «Оплатить с Kaspi.kz». The intent lives only in the
 * memory of this app process, so a reload, an app restart, restored navigation state, a deep link,
 * back navigation or a remounted checkout can never replay it. It is taken at most once and only
 * while fresh; every other outcome leaves checkout waiting for an explicit press.
 */
import { draftCanAutoSend } from './checkout-resume.ts';
import type { PendingPayment } from './payment-recovery.ts';

export const SLIDE_PAY_INTENT_TTL_MS = 30_000;
/** A clock moved backwards by more than this invalidates the intent instead of extending it. */
const CLOCK_SKEW_MS = 2_000;
const pattern = /^(\d{13})\.([0-9a-f-]{36})$/;

export interface SlidePayIntents {
  /** Registers a fresh intent and returns the route parameter that carries it. */
  issue(): string;
  /** True exactly once for an intent issued by this registry and still fresh. */
  take(raw: unknown): boolean;
}

export function createSlidePayIntents(options: {
  now: () => number;
  nonce: () => string;
  ttlMs?: number;
}): SlidePayIntents {
  const ttl = options.ttlMs ?? SLIDE_PAY_INTENT_TTL_MS;
  const issued = new Map<string, number>();
  const prune = (now: number) => {
    for (const [value, at] of issued)
      if (now - at > ttl || at - now > CLOCK_SKEW_MS) issued.delete(value);
  };
  return {
    issue() {
      const now = options.now();
      prune(now);
      const nonce = options.nonce().toLowerCase();
      const value = `${String(Math.trunc(now)).padStart(13, '0')}.${nonce}`;
      if (!pattern.test(value)) throw new Error('SLIDE_PAY_INTENT');
      issued.set(value, now);
      return value;
    },
    take(raw) {
      if (typeof raw !== 'string' || !pattern.test(raw)) return false;
      const at = issued.get(raw);
      // Consumed before anything else: no second caller, remount or re-render can take it again.
      issued.delete(raw);
      if (at === undefined) return false;
      const now = options.now();
      prune(now);
      return now - at <= ttl && at - now <= CLOCK_SKEW_MS;
    },
  };
}

/** What the Kaspi checkout knows when a slide intent arrives. */
export interface SlidePayCheckout {
  /** The saved payment intent is still being read from storage. */
  restoring: boolean;
  signedIn: boolean;
  /** A create or payment command of this screen is running. */
  busy: boolean;
  /** The saved payment intent read by this screen, if any. */
  saved: PendingPayment | null;
  /** An order is already shown on this screen. */
  order: boolean;
  cartLines: number;
  /**
   * Paying is not possible right now (payment-availability.ts: closed, server switch, connection,
   * stop list). The cart shows the reason; the slide is dropped, never kept for later.
   */
  blocked?: boolean;
  now: number;
}

/**
 * A saved intent holds the checkout when it knows its order or may still send its own invoice.
 * The same rule as the press itself (submit): an older intent that never became a known order is
 * dropped by the press, so it does not stop a slide either (audit 0.2 / 2.1).
 */
export function savedIntentHoldsCheckout(saved: PendingPayment | null, now: number): boolean {
  return !!saved && (!!saved.orderId || draftCanAutoSend(saved, now));
}

export type SlidePayOutcome = 'wait' | 'dropped' | 'pressed';

/**
 * One slide equals one press of «Оплатить через Kaspi». The intent waits, unconsumed, until the
 * saved intent is read and the customer is signed in. Then it is consumed, and the press runs
 * only on a free checkout: nothing running, no holding intent, no order on screen, a basket,
 * and a restaurant that can take the payment now.
 * Any other outcome drops it for good; the customer continues with the regular button.
 */
export function runSlidePayIntent(
  intents: SlidePayIntents,
  raw: string | null,
  checkout: SlidePayCheckout,
  press: () => void,
): SlidePayOutcome {
  if (!raw || checkout.restoring || !checkout.signedIn) return 'wait';
  if (!intents.take(raw)) return 'dropped';
  if (
    checkout.blocked ||
    checkout.busy ||
    checkout.order ||
    checkout.cartLines < 1 ||
    savedIntentHoldsCheckout(checkout.saved, checkout.now)
  )
    return 'dropped';
  press();
  return 'pressed';
}
