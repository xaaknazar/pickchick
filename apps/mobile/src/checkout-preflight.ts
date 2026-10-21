import { CustomerSessionError } from './customer-session.ts';
import { watchRetryDelay } from './commerce-watch.ts';

export interface CheckoutRetryPolicy {
  /** Authoritative "not yet" answers: retried every 2 s until the caller's deadline. */
  pending: readonly string[];
  /** Authoritative answers that end the attempt at once, even when their status is 5xx. */
  final: readonly string[];
}

/** Quote and order creation within one explicit tap. */
export const ORDER_PREPARATION: CheckoutRetryPolicy = {
  pending: ['NOT_READY', 'AVAILABILITY_STALE'],
  // KITCHEN_OFFLINE: branch in cloud mode (ADR-0014) whose kitchen screens are not polling.
  // The customer gets an honest answer at once instead of a minute of spinner (audit 2.5).
  final: ['KITCHEN_OFFLINE'],
};

/**
 * The bank command. A refusal is shown and the order returns to the cart; it is never repeated
 * in the background, so a later "yes" cannot send an invoice nobody asked for (audit 2.1).
 */
export const PAYMENT_COMMAND: CheckoutRetryPolicy = {
  pending: ['AVAILABILITY_STALE'],
  final: ['KITCHEN_OFFLINE', 'NOT_READY', 'ITEM_STOPPED', 'RESTAURANT_CLOSED'],
};

/** Codes for which /payment refused to bill the order: no attempt, no money taken. */
export const paymentRefused = (error: unknown) =>
  error instanceof CustomerSessionError &&
  error.authoritative &&
  PAYMENT_COMMAND.final.includes(error.code);

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
  policy: CheckoutRetryPolicy = ORDER_PREPARATION,
): Promise<T> {
  let failures = 0;
  while (!signal.aborted) {
    try {
      const result = await operation();
      if (signal.aborted) throw new Error('CHECKOUT_CANCELLED');
      return result;
    } catch (error) {
      if (signal.aborted) break;
      const authoritative = error instanceof CustomerSessionError && error.authoritative;
      if (authoritative && policy.final.includes(error.code)) throw error;
      const pending = authoritative && policy.pending.includes(error.code);
      const delay = pending ? 2000 : watchRetryDelay(error, ++failures);
      if (delay === null) throw error;
      await wait(Math.min(delay, 5000));
    }
  }
  throw new Error('CHECKOUT_CANCELLED');
}
