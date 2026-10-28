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
 * The payment screen offers the support contact at once: a stale bank wait, or an order the
 * restaurant has not admitted for longer than a waiting screen offers "close" (lane 0.2:
 * «awaiting_restaurant»). No money was taken there, but only a person can say why.
 */
export function supportAtOnce(order: Order, now: number): boolean {
  if (staleBankAction(order, now)) return true;
  if (order.phase !== 'awaiting_restaurant') return false;
  const seen = [time(order.createdAt), time(order.updatedAt)].filter(Number.isFinite);
  return seen.length > 0 && now - Math.max(...seen) >= STUCK_AFTER_MS;
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
 * Owner 28.10.2026: every payment screen also has its glass X at once (closeNeedsConfirm); this
 * delay only governs the bottom «Закрыть» and the support contact that comes with it.
 */
export function closeDelay(order: Order | undefined, now: number): number | null {
  if (!order) return STUCK_AFTER_MS;
  if (paymentReceived(order.phase) || order.phase === 'failed') return null;
  return liveBankAction(order, now) ? STUCK_AFTER_MS : 0;
}

/**
 * Owner 28.10.2026 (TestFlight 25): a «sending» or «waiting for the restaurant» screen that has
 * not moved for this long says so honestly and offers «Проверить ещё раз» / «Вернуться в корзину».
 */
export const STUCK_NOTICE_MS = 20_000;
export type PaymentStuck = 'bank' | 'restaurant';

/**
 * Why a payment screen is stuck, measured from the moment this app run first saw the wait in its
 * phase (`since`, waitSince, the phone's clock; `phase` from paymentWaitPhase): «bank» while the
 * invoice is still being sent to Kaspi, «restaurant» while the restaurant has not admitted the
 * order. Every other phase has its own actions (Kaspi.kz, retry, the cart).
 */
export function paymentStuck(
  phase: Order['phase'] | undefined,
  since: number,
  now: number,
): PaymentStuck | null {
  if (!(now - since >= STUCK_NOTICE_MS)) return null;
  return phase === 'sending' ? 'bank' : phase === 'awaiting_restaurant' ? 'restaurant' : null;
}

/**
 * The phase a payment screen shows and waits as (owner 28.10.2026, review): the order's own,
 * except two waits the order phase does not tell:
 * - this screen's payment command (POST /payment) still runs on «ready_to_pay»: the invoice is
 *   being sent, so the screen says «Отправляем счёт» and a long wait is the bank's;
 * - the connecting scene of a create command (a saved intent without its order yet, POST /orders
 *   retrying): the restaurant has not taken the order and nothing can be billed, the restaurant's
 *   wait. A connecting scene without one (quote, a known order being read) has no phase.
 */
export function paymentWaitPhase(
  phase: Order['phase'] | undefined,
  context: { commandRunning?: boolean; creating?: boolean } = {},
): Order['phase'] | undefined {
  if (phase === undefined) return context.creating ? 'awaiting_restaurant' : undefined;
  return phase === 'ready_to_pay' && context.commandRunning ? 'sending' : phase;
}

/** Waits remembered in this app run: the last few orders (and create intents) are enough. */
const WAITS_KEPT = 32;
const waits = new Map<string, { phase: string; since: number }>();

/**
 * When this app run first saw a payment wait (`id`: an order, or a create intent on the
 * connecting scene) in this phase, on the phone clock (the order's own times may come from
 * another clock). An order reopened later (X, then «Оплатить» again) keeps its first time, so a
 * «sending» that has lasted for minutes says so at once instead of «Подождите немного» for another
 * 20 s. A new phase starts again; `from` hands over the wait of the create intent that became this
 * order. A clock that moved backwards starts again from now.
 */
export function waitSince(id: string, phase: string, now: number, from?: string): number {
  const seen = waits.get(id);
  if (seen?.phase === phase && seen.since <= now) return seen.since;
  const handed = from === undefined ? undefined : waits.get(from);
  const since = handed?.phase === phase && handed.since <= now ? handed.since : now;
  waits.delete(id);
  waits.set(id, { phase, since });
  if (waits.size > WAITS_KEPT) waits.delete(waits.keys().next().value as string);
  return since;
}

/**
 * The glass X of a payment screen asks «Закрыть оплату?» first only while the bank may still act
 * for this order: its invoice is being sent, waits in Kaspi or is being checked (within its
 * window), this screen's own payment command is still running, or a saved intent names an order
 * this screen has not read yet. Unbilled, refused, failed and paid orders close at once.
 */
export function closeNeedsConfirm(
  order: (Order & { orderId: string }) | undefined,
  now: number,
  context: { draft?: PendingPayment | null; commandRunning?: boolean } = {},
): boolean {
  if (!order) return !!context.draft?.orderId;
  if (paymentReceived(order.phase) || ['failed', 'attention'].includes(order.phase)) return false;
  if (context.commandRunning) return true;
  const draft = context.draft ?? null;
  return liveBankAction(order, now, draftOwns(draft, order.orderId) ? draft.createdAt : undefined);
}

/**
 * What closing a payment screen does with the saved intent (audit 0.2 / 2.0 / 2.4, owner 28.10):
 * - «remove»: nothing can be billed for it any more: its order is not at the bank (unbilled,
 *   refused, final), or it never became a known order (a create command cut short by the close:
 *   the app never sent a payment for it, and the server cancels such an order unpaid by its TTL);
 * - «keep»: the bank may still act (sending, an invoice in Kaspi, checking, a payment command of
 *   this screen still running) or its order could not be read: it stays saved for recovery, is
 *   not pushed back this app run, and its automatic invoice is withdrawn (`sendInvoice: false`):
 *   only a new explicit tap may pay again, and that tap reopens this same order first (submit);
 * - «none»: the intent belongs to another order («Заказы» may show an older one).
 */
export function closedIntent(
  draft: PendingPayment | null,
  order: (Order & { orderId: string }) | undefined,
  now: number,
  commandRunning = false,
): 'remove' | 'keep' | 'none' {
  if (!draft) return 'none';
  if (!order) return draft.orderId ? 'keep' : 'remove';
  if (!draftOwns(draft, order.orderId)) return 'none';
  return commandRunning || liveBankAction(order, now, draft.createdAt) ? 'keep' : 'remove';
}
