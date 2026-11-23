import { CustomerSessionError } from './customer-session.ts';

/** Only reads can retry automatically. Payment commands retain their own durable intent. */
export function watchRetryDelay(error: unknown, failures: number): number | null {
  if (!(error instanceof CustomerSessionError)) return null;
  if (
    error.code !== 'NETWORK_UNAVAILABLE' &&
    !(error.authoritative && [408, 429, 500, 502, 503, 504].includes(error.status))
  )
    return null;
  return Math.min(30_000, 1000 * 2 ** Math.min(Math.max(failures - 1, 0), 5));
}

/**
 * A delay that ends at once on abort (also when already aborted) and leaves no listener behind
 * on the signal, however many times a loop waits on the same one.
 */
export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

/**
 * The revision a watch asks after: the one the screen shows when the watch starts, then the one of
 * each answer this watch accepted. The loop reads again right after an answer, before React
 * renders, so the cursor moves here and not with the render (the server would answer a repeated
 * revision at once). It never takes a revision from anywhere else: a ref that holds a newer copy
 * of the order than the screen shows would make the watch wait while the screen stays old.
 */
export function createWatchCursor<R>(shown: { orderId: string; revision: R }) {
  let revision = shown.revision;
  return {
    after: () => revision,
    accepted(next: { orderId: string; revision: R }) {
      if (next.orderId === shown.orderId) revision = next.revision;
    },
  };
}

/** Foreground, sequential long polling. Abort cancels both HTTP and reconnect timers. */
export async function watchCommerceOrder<T>(options: {
  signal: AbortSignal;
  read: (signal: AbortSignal) => Promise<T>;
  accept: (value: T) => Promise<void>;
  onError: (error: unknown, reconnecting: boolean) => void;
  onRecovered: () => void;
  wait?: typeof wait;
}): Promise<void> {
  let failures = 0;
  while (!options.signal.aborted) {
    let value: T;
    try {
      value = await options.read(options.signal);
    } catch (error) {
      if (options.signal.aborted) return;
      const delay = watchRetryDelay(error, ++failures);
      options.onError(error, delay !== null);
      if (delay === null) return;
      await (options.wait ?? wait)(delay, options.signal);
      continue;
    }
    if (options.signal.aborted) return;
    try {
      await options.accept(value);
    } catch (error) {
      if (!options.signal.aborted) options.onError(error, false);
      return;
    }
    if (options.signal.aborted) return;
    failures = 0;
    options.onRecovered();
  }
}
