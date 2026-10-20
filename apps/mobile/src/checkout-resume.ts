import type { CustomerCommerceOrder } from '@pickchick/contracts';
import { paymentReceived } from './commerce-presentation.ts';
import type { PendingPayment } from './payment-recovery.ts';

/**
 * When a saved payment intent or an earlier unpaid order may hold the checkout (audit 0.2, 2.0,
 * 2.1, 2.4). Only an order that may still take the customer's money blocks a second invoice;
 * everything else returns the customer to the cart, the list or a new order.
 */
type Order = Pick<CustomerCommerceOrder, 'phase' | 'createdAt' | 'updatedAt' | 'expiresAt'> & {
  orderId?: string;
};

/** A saved intent sends the invoice by itself only this soon after the customer's tap. */
export const AUTO_SEND_WINDOW_MS = 5 * 60_000;
/** Sending/checking without a known invoice deadline: resumed this long after the last change. */
export const BANK_RESUME_WINDOW_MS = 15 * 60_000;
/** A late bank answer after the invoice deadline. */
export const INVOICE_GRACE_MS = 2 * 60_000;
/** A waiting payment screen offers "close" after this long. */
export const STUCK_AFTER_MS = 90_000;

const BANK_PHASES = ['sending', 'awaiting_payment', 'checking'];
const time = (value: string | null | undefined) => (value ? Date.parse(value) : NaN);

/**
 * Payment commands this app session sent, by order. The customer view carries no attempt time,
 * so an explicit "send invoice" on an older unpaid order would otherwise look stale at once and
 * a new tap could start a second order while the first invoice is still being issued.
 */
const bankCommands = new Map<string, number>();
export function noteBankCommand(orderId: string, at: number) {
  bankCommands.set(orderId, at);
}

/** The bank may still take money for this order: never start a second order meanwhile. */
export function liveBankAction(order: Order, now: number, since?: number): boolean {
  if (!BANK_PHASES.includes(order.phase)) return false;
  const deadline = time(order.expiresAt);
  if (Number.isFinite(deadline)) return now < deadline + INVOICE_GRACE_MS;
  const sent = order.orderId === undefined ? undefined : bankCommands.get(order.orderId);
  const seen = [time(order.createdAt), time(order.updatedAt), since ?? NaN, sent ?? NaN].filter(
    Number.isFinite,
  );
  return !seen.length || now < Math.max(...seen) + BANK_RESUME_WINDOW_MS;
}

/**
 * A bank wait that outlived its window (sending or checking too long, an expired invoice): the
 * app can no longer settle it by itself, so the screen offers the support contact at once.
 */
export function staleBankAction(order: Order, now: number): boolean {
  return BANK_PHASES.includes(order.phase) && !liveBankAction(order, now);
}

/**
 * The saved intent belongs to this order. An intent without an order id meets its order only
 * through its own create command; the Orders tab never lends it to another order.
 */
export function draftOwns(draft: PendingPayment | null, orderId: string): draft is PendingPayment {
  return !!draft && draft.orderId === orderId;
}

/** The order a new "pay" tap must show instead of creating another one. */
export function resumableOrder<T extends Order>(orders: readonly T[], now: number): T | undefined {
  return orders.find((order) => liveBankAction(order, now));
}

/** A fresh, explicit tap within the last few minutes. Drafts of build 20 carry no time. */
export function draftCanAutoSend(draft: PendingPayment | null, now: number): boolean {
  return (
    !!draft?.sendInvoice &&
    typeof draft.createdAt === 'number' &&
    now - draft.createdAt >= 0 &&
    now - draft.createdAt <= AUTO_SEND_WINDOW_MS
  );
}

/** Nothing is left for the saved intent to recover: remove it so it never reopens checkout. */
export function draftIsFinal(order: Order, draft: PendingPayment, now: number): boolean {
  if (paymentReceived(order.phase) || order.phase === 'failed' || order.phase === 'attention')
    return true;
  if (order.phase === 'ready_to_pay' || order.phase === 'awaiting_restaurant')
    return !draftCanAutoSend(draft, now);
  return !liveBankAction(order, now, draft.createdAt);
}

/**
 * Milliseconds before a payment screen offers "close": at once when no bank action can be
 * running, after a short wait while the bank may still answer, null when the screen has its own
 * final actions (paid, failed). An undefined order is the reconnecting state.
 */
export function closeDelay(order: Order | undefined, now: number): number | null {
  if (!order) return STUCK_AFTER_MS;
  if (paymentReceived(order.phase) || order.phase === 'failed') return null;
  return liveBankAction(order, now) ? STUCK_AFTER_MS : 0;
}
