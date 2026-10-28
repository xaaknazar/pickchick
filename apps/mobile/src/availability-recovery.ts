import { createCatalogRecovery } from './catalog-recovery.ts';
import type { Availability } from './availability.ts';

export class AvailabilityRequestError extends Error {
  readonly retryable: boolean;
  constructor(status: number) {
    super(`Availability HTTP ${status}`);
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}

/** Each successful public read renews the stop list. Only reads enter this loop. */
export function createAvailabilityRecovery(options: {
  read(signal: AbortSignal, signature: string): Promise<Availability>;
  onChecking(): void;
  onSuccess(value: Availability): void;
  onFailure(error: unknown, retrying: boolean): void;
  random?: () => number;
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
        // Confirm with one immediate snapshot before announcing an outage. Never retry
        // malformed data, HTTP rejections/rate limits, lifecycle aborts or payment commands.
        if (
          !signature ||
          signal.aborted ||
          !retryable(error) ||
          error instanceof AvailabilityRequestError
        )
          throw error;
        signature = '';
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
