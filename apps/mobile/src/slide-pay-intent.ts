/**
 * Slide to pay (cart bar, 27.10.2026): a released Kaspi handle opens the guarded checkout with a
 * one-shot intent that equals one press of «Оплатить через Kaspi». The intent lives only in the
 * memory of this app process, so a reload, an app restart, restored navigation state, a deep link,
 * back navigation or a remounted checkout can never replay it. It is taken at most once and only
 * while fresh; every other outcome leaves checkout waiting for an explicit press.
 */
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
