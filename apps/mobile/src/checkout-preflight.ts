import { CustomerSessionError } from './customer-session.ts';
import { watchRetryDelay } from './commerce-watch.ts';

/** Only GETs or commands with a stable, durable idempotency identity belong here. */
export async function prepareCheckout<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    }),
): Promise<T> {
  let failures = 0;
  while (!signal.aborted) {
    try {
      const result = await operation();
      if (signal.aborted) throw new Error('CHECKOUT_CANCELLED');
      return result;
    } catch (error) {
      if (signal.aborted) break;
      const pending =
        error instanceof CustomerSessionError &&
        error.authoritative &&
        // KITCHEN_OFFLINE: branch in cloud mode (ADR-0014) whose kitchen screens are not polling.
        ['NOT_READY', 'AVAILABILITY_STALE', 'KITCHEN_OFFLINE'].includes(error.code);
      const delay = pending ? 2000 : watchRetryDelay(error, ++failures);
      if (delay === null) throw error;
      await wait(Math.min(delay, 5000));
    }
  }
  throw new Error('CHECKOUT_CANCELLED');
}
