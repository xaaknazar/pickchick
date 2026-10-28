import { createCatalogRecovery } from './catalog-recovery.ts';
import type { Availability } from './availability.ts';

export class AvailabilityRequestError extends Error {
  readonly retryable: boolean;
  constructor(status: number) {
    super(`Availability HTTP ${status}`);
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}

/**
 * The pause before the confirmation snapshot of a dropped long-poll (owner 28.10.2026). Sent at
 * once, the snapshot usually went over the same dead connection (a keep-alive socket the carrier or
 * a proxy had just closed, a radio still waking up) and failed with it, so one drop still cost a
 * whole failed read cycle. A short pause lets the client open a fresh connection, and most single
 * drops recover inside the cycle. Short enough that a real outage is reported about as fast.
 */
export const CONFIRMATION_DELAY_MS = 400;

/** Waits `ms`, or less when `signal` aborts (the app went to the background, the reader stopped). */
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (ms <= 0 || signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Each successful public read renews the stop list. Only reads enter this loop. */
export function createAvailabilityRecovery(options: {
  read(signal: AbortSignal, signature: string): Promise<Availability>;
  onChecking(): void;
  onSuccess(value: Availability): void;
  onFailure(error: unknown, retrying: boolean): void;
  random?: () => number;
  /** The pause before the confirmation snapshot: CONFIRMATION_DELAY_MS unless a test says. */
  confirmationDelayMs?: number;
}) {
  let signature = '';
  const retryable = (error: unknown) =>
    (!(error instanceof AvailabilityRequestError) || error.retryable) &&
    !(error instanceof SyntaxError) &&
    !(error instanceof Error && error.message === 'INVALID_AVAILABILITY');
  const recovery = createCatalogRecovery({
    load: async (signal) => {
      try {
        return await options.read(signal, signature);
      } catch (error) {
        // A proxy/radio can drop an idle long poll while ordinary GETs still work.
        // Confirm with one snapshot, after a short pause, before announcing an outage. Never
        // retry malformed data, HTTP rejections/rate limits, lifecycle aborts or payment commands.
        if (
          !signature ||
          signal.aborted ||
          !retryable(error) ||
          error instanceof AvailabilityRequestError
        )
          throw error;
        signature = '';
        await pause(options.confirmationDelayMs ?? CONFIRMATION_DELAY_MS, signal);
        // Sent to the background or stopped during the pause: no request at all.
        if (signal.aborted) throw error;
        return options.read(signal, '');
      }
    },
    onLoading: options.onChecking,
    onSuccess: (value) => {
      signature = value.enabled ? value.signature : '';
      options.onSuccess(value);
    },
    onFailure: (error) => {
      signature = '';
      options.onFailure(error, retryable(error));
    },
    isRetryable: retryable,
    successDelay: (value) => (value.enabled ? 100 : 15_000),
    random: options.random,
  });
  return {
    setActive(active: boolean) {
      if (!active) signature = '';
      recovery.setActive(active);
    },
    stop: recovery.stop,
  };
}
