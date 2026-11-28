import type { CustomerCommerceOrder } from '@pickchick/contracts';
import { paymentReceived } from './commerce-presentation.ts';
import { liveBankAction, resumableOrder } from './checkout-resume.ts';
import { matchesPaidComboCart } from './loyalty/combo-progress.ts';

/**
 * Audit 28.11 P0-2: what a TipTopPay press does when an earlier payment may still be paid. The
 * hook used to keep this in memory only; a closed cart, a restart or a slow bank then led to a
 * second order and a second charge. The intent below is saved before the charge leaves the phone
 * and every press / cart opening decides from it and from the guest's own orders (GET /orders).
 * The server answers a second order with a plain CONFLICT, so the app tells «a payment is in
 * review» from «the menu changed» by its orders, never by the error text.
 *
 * Pure functions; the storage and the requests are handed in (see startLiveOrder).
 */
export type TipTopPayIntentMethod = 'card' | 'apple_pay' | 'google_pay';
type Order = Pick<
  CustomerCommerceOrder,
  'orderId' | 'phase' | 'createdAt' | 'updatedAt' | 'expiresAt' | 'totalMinor'
> & { items?: readonly { productId: string; quantity: number }[] };

export type TipTopPayIntent = {
  /** The customer the record belongs to (also part of the storage key). */
  customerId: string;
  orderId: string;
  method: TipTopPayIntentMethod;
  /** Epoch ms of the press that created the order. */
  createdAt: number;
  /** The cart that was paid (cartSignature): a late payment clears only this cart. */
  signature?: string;
  /** Epoch ms when the charge request was about to leave the phone (this attempt). */
  sentAt?: number;
};

/** An intent older than this is ignored: the server's window is 25 minutes, orders live 30. */
export const TIPTOPPAY_INTENT_MAX_AGE_MS = 3 * 60 * 60_000;
/** A charge request sent this recently may still be on its way to the server. */
export const CHARGE_IN_FLIGHT_MS = 2 * 60_000;
/** A failed or unsent order is paid again only this soon after its press / its last attempt. */
export const RETRY_WINDOW_MS = 20 * 60_000;
/** The server cancels an order that was never sent to the bank after this long (PM decision 19.10). */
export const ORDER_TTL_MS = 30 * 60_000;
const CLOCK_SKEW_MS = 5 * 60_000;
/**
 * The server holds a guest's new order for a TipTopPay payment in review for 25 minutes from the
 * send; plus a margin for the phone's clock. Past it a 409 is a menu change, not this payment.
 */
export const HOLD_WINDOW_MS = 25 * 60_000 + CLOCK_SKEW_MS;
const METHODS: readonly string[] = ['card', 'apple_pay', 'google_pay'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export const tipTopPayIntentKey = (customerId: string | undefined) =>
  `pickchick.tiptoppay.intent.v1:${customerId}`;

const epoch = (value: unknown, now: number): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= now + CLOCK_SKEW_MS;

/**
 * The saved record, or null: broken JSON, another customer's, another shape, from the future or
 * older than TIPTOPPAY_INTENT_MAX_AGE_MS. Never throws, so a bad record never blocks a press.
 */
export function parseTipTopPayIntent(
  raw: string | null | undefined,
  context: { customerId: string | undefined; now: number },
): TipTopPayIntent | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const draft = value as Record<string, unknown>;
  if (
    !context.customerId ||
    draft.customerId !== context.customerId ||
    typeof draft.orderId !== 'string' ||
    !UUID.test(draft.orderId) ||
    typeof draft.method !== 'string' ||
    !METHODS.includes(draft.method) ||
    !epoch(draft.createdAt, context.now) ||
    context.now - draft.createdAt > TIPTOPPAY_INTENT_MAX_AGE_MS ||
    (draft.signature !== undefined &&
      (typeof draft.signature !== 'string' || draft.signature.length > 20_000)) ||
    (draft.sentAt !== undefined && !epoch(draft.sentAt, context.now))
  )
    return null;
  return {
    customerId: draft.customerId,
    orderId: draft.orderId,
    method: draft.method as TipTopPayIntentMethod,
    createdAt: draft.createdAt,
    ...(draft.signature === undefined ? {} : { signature: draft.signature as string }),
    ...(draft.sentAt === undefined ? {} : { sentAt: draft.sentAt as number }),
  };
}

export function newTipTopPayIntent(input: {
  customerId: string;
  orderId: string;
  method: TipTopPayIntentMethod;
  now: number;
  signature?: string;
}): TipTopPayIntent {
  return {
    customerId: input.customerId,
    orderId: input.orderId,
    method: input.method,
    createdAt: input.now,
    ...(input.signature === undefined ? {} : { signature: input.signature }),
  };
}

/** The charge request of this attempt is about to leave the phone. */
export function markChargeSent(intent: TipTopPayIntent, now: number): TipTopPayIntent {
  return { ...intent, sentAt: now };
}

export type ShownState = 'paid' | 'review' | 'three_ds';

/**
 * How the order screen shows an order of a payment: paid, with the bank (review) or waiting for
 * 3-D Secure. null for an order that is not (or no longer) at the bank: unsent, failed, final.
 */
export function showStateOf(order: Pick<Order, 'phase'>): ShownState | null {
  if (paymentReceived(order.phase)) return 'paid';
  if (order.phase === 'awaiting_payment') return 'three_ds';
  if (order.phase === 'sending' || order.phase === 'checking') return 'review';
  return null;
}

export type TipTopPayDecision<T extends Order = Order> =
  /** Show this order (onOrder); no new order, no charge. */
  | { kind: 'show'; order: T; state: ShownState }
  /** The charge of the intent order may still be on its way: «Проверяем оплату», no new charge. */
  | { kind: 'wait'; order: T }
  /** Pay this same order again (declined by the bank, or never sent). */
  | { kind: 'retry'; order: T }
  /** Nothing unfinished: a new order. `forget`: the saved intent has nothing left to recover. */
  | { kind: 'create'; forget: boolean };

/**
 * What a «Оплатить» press (or the opening of the cart) does, from the saved intent and the guest's
 * orders. `cart` is the signature of the cart now: a declined order is paid again only for the
 * cart it was made for. Existing orders are shown while the bank may take their money, whatever
 * the cart is; only a final outcome lets a new order be created.
 */
export function decideTipTopPay<T extends Order>(input: {
  intent: TipTopPayIntent | null;
  orders: readonly T[];
  now: number;
  cart?: string;
  /** Total and lines of the cart now: an order is paid again only for a cart it matches. */
  cartTotalMinor?: string;
  cartLines?: readonly { productId: string; quantity: number }[];
}): TipTopPayDecision<T> {
  const { intent, orders, now } = input;
  const mine = intent ? orders.find((order) => order.orderId === intent.orderId) : undefined;
  let retry: T | undefined;
  let forget = false;
  if (intent) {
    const lastAttempt = intent.sentAt ?? intent.createdAt;
    if (!mine) forget = true;
    else {
      const state = showStateOf(mine);
      if (state === 'paid') return { kind: 'show', order: mine, state };
      if (state) {
        // The bank may still answer; past the app's window the guest is not held (the server's
        // own 25-minute rule answers CONFLICT, which holdAfterConflict then shows).
        if (liveBankAction(mine, now, lastAttempt)) return { kind: 'show', order: mine, state };
      } else if (mine.phase === 'failed' || mine.phase === 'ready_to_pay') {
        if (
          mine.phase === 'ready_to_pay' &&
          intent.sentAt !== undefined &&
          now - intent.sentAt >= 0 &&
          now - intent.sentAt < CHARGE_IN_FLIGHT_MS
        )
          return { kind: 'wait', order: mine };
        if (orderStillOpen(mine, intent, now) && cartMatchesOrder(intent, mine, input))
          retry = mine;
        else forget = true;
      } else forget = true;
    }
  }
  const other = resumableOrder(
    orders.filter((order) => order.orderId !== intent?.orderId),
    now,
  );
  if (other) {
    const state = showStateOf(other);
    if (state) return { kind: 'show', order: other, state };
  }
  if (retry) return { kind: 'retry', order: retry };
  return { kind: 'create', forget };
}

/**
 * A declined or unsent order may be paid again only before the server's deadline of the order
 * (its own `expiresAt`, else created + the unpaid TTL) and within the retry window counted from
 * the press itself: a new attempt mark (`sentAt`) never extends the life of the order.
 */
function orderStillOpen(order: Order, intent: TipTopPayIntent, now: number): boolean {
  if (now - intent.createdAt > RETRY_WINDOW_MS) return false;
  const deadlines = [Date.parse(order.expiresAt ?? ''), Date.parse(order.createdAt) + ORDER_TTL_MS];
  const known = deadlines.filter(Number.isFinite);
  return !known.length || now < Math.min(...known);
}

const perProduct = (lines: readonly { productId: string; quantity: number }[]) => {
  const sums = new Map<string, number>();
  for (const line of lines)
    sums.set(line.productId, (sums.get(line.productId) ?? 0) + line.quantity);
  return [...sums].sort(([a], [b]) => (a < b ? -1 : 1)).join('|');
};

/**
 * The order was made for the cart on screen: the intent's signature agrees (when it has one) and
 * the order's total and lines agree with the cart's (when the screen says them). An intent without
 * a signature (an order remembered in memory only) needs the substance to agree: its order is
 * never paid for a cart it was not made for.
 */
function cartMatchesOrder(
  intent: TipTopPayIntent,
  order: Order,
  cart: {
    cart?: string;
    cartTotalMinor?: string;
    cartLines?: readonly { productId: string; quantity: number }[];
  },
): boolean {
  const known = cart.cartTotalMinor !== undefined && cart.cartLines !== undefined;
  const substance = known
    ? cart.cartTotalMinor === order.totalMinor &&
      perProduct(cart.cartLines ?? []) === perProduct(order.items ?? [])
    : undefined;
  if (intent.signature === undefined) return substance === true;
  if (cart.cart !== undefined && !matchesPaidComboCart(intent.signature, cart.cart)) return false;
  return substance !== false;
}

/**
 * After the server answered CONFLICT: is it this guest's TipTopPay payment in review? Only the
 * order of the saved intent counts (the order view carries no payment method, so another order
 * in a bank wait may be a Kaspi invoice), and only inside the server's own window from the send.
 * null: the CONFLICT is something else (a menu change) and takes its usual path.
 */
export function holdAfterConflict<T extends Order>(
  orders: readonly T[],
  intent: TipTopPayIntent | null,
  now: number,
): { order: T; state: ShownState } | null {
  const mine = intent ? orders.find((order) => order.orderId === intent.orderId) : undefined;
  if (!intent || !mine) return null;
  const state = showStateOf(mine);
  if (state === 'paid') return { order: mine, state };
  if (!state || now - (intent.sentAt ?? intent.createdAt) > HOLD_WINDOW_MS) return null;
  return { order: mine, state };
}

/**
 * A Kaspi press while this guest's TipTopPay payment is not over: its order (in review or paid)
 * is shown, or its charge that may still be on its way is waited for. null: nothing holds Kaspi.
 */
export function guardKaspiPress<T extends Order>(
  intent: TipTopPayIntent | null,
  orders: readonly T[],
  now: number,
): { kind: 'show'; order: T; state: ShownState } | { kind: 'wait'; order: T } | null {
  if (!intent) return null;
  const decision = decideTipTopPay({ intent, orders, now });
  if (decision.kind === 'show' && decision.order.orderId === intent.orderId) return decision;
  if (decision.kind === 'wait') return decision;
  return null;
}

/** The cart opened: only an intent whose charge reached the bank can have anything to show. */
export function intentNeedsServer(intent: TipTopPayIntent | null): boolean {
  return !!intent && intent.sentAt !== undefined;
}

/**
 * A paid order of the saved intent: the cart is cleared only when it is the cart that was paid.
 * null when there is nothing to settle (not paid, no intent, another order).
 */
export function settlePaidIntent(input: {
  order: Pick<Order, 'orderId' | 'phase'>;
  intent: TipTopPayIntent | null;
  cart: string;
}): { clearCart: boolean } | null {
  const { order, intent, cart } = input;
  if (!paymentReceived(order.phase) || !intent || intent.orderId !== order.orderId) return null;
  return {
    clearCart: intent.signature !== undefined && matchesPaidComboCart(intent.signature, cart),
  };
}

/** The guest leaves a declined payment for another method: nothing is left to retry or recover. */
export async function leaveForOtherMethod(
  clearRetry: () => void,
  forgetIntent: () => Promise<void>,
) {
  clearRetry();
  await forgetIntent();
}

type ChargeAnswer<T extends Order> = { order: T; threeDsUrl?: string; message?: string };
export type ChargeDeps<T extends Order> = {
  /** Writes the intent with the «sent» mark. */
  markSent(intent: TipTopPayIntent): Promise<void>;
  /** The charge request itself: never tied to the screen (it is not cut by leaving it). */
  charge(): Promise<ChargeAnswer<T>>;
  completeApplePay?(success: boolean): Promise<void>;
  openThreeDs(url: string): Promise<void>;
  poll(order: T): Promise<T>;
  /** The screen is gone: only the poll and the interface stop. */
  aborted(): boolean;
};
export type ChargeResult<T extends Order> =
  { kind: 'left' } | { kind: 'settled'; order: T; message?: string };

/**
 * The charge of a live order: the intent is marked as sent first, the request is never cut, the
 * wallet is told the answer, and 3-D Secure opens even if the screen has been left (the guest
 * must be able to finish it). After a left screen only the poll is skipped; the saved intent
 * brings the result back when the cart is opened again.
 */
export async function chargeLiveOrder<T extends Order>(
  deps: ChargeDeps<T>,
  intent: TipTopPayIntent,
  options: { applePay: boolean; now(): number },
): Promise<ChargeResult<T>> {
  await deps.markSent(markChargeSent(intent, options.now())).catch(() => undefined);
  const answer = await deps.charge();
  if (options.applePay)
    await deps
      .completeApplePay?.(answer.order.phase !== 'failed' && !answer.message)
      .catch(() => undefined);
  if (answer.threeDsUrl) await deps.openThreeDs(answer.threeDsUrl).catch(() => undefined);
  if (deps.aborted()) return { kind: 'left' };
  const settled = await deps.poll(answer.order);
  if (deps.aborted()) return { kind: 'left' };
  return {
    kind: 'settled',
    order: settled,
    ...(answer.message ? { message: answer.message } : {}),
  };
}

const isConflict = (error: unknown) =>
  !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'CONFLICT';
export const isTipTopPayConflict = isConflict;

type Quote = { quoteId: string; totalMinor: string; signature?: string };
export type LiveStartDeps<T extends Order = CustomerCommerceOrder> = {
  customerId: string;
  method: TipTopPayIntentMethod;
  /** Signature of the cart now. */
  cart?: string;
  cartTotalMinor?: string;
  cartLines?: readonly { productId: string; quantity: number }[];
  /** An order the hook remembers in memory (a retry) when storage holds no intent. */
  fallbackOrderId?: string | null;
  now(): number;
  /** The raw saved record, or null. */
  readIntent(): Promise<string | null>;
  writeIntent(intent: TipTopPayIntent): Promise<void>;
  forgetIntent(): Promise<void>;
  listOrders(): Promise<T[]>;
  /** One order by id, null when the server does not know it. */
  readOrder(orderId: string): Promise<T | null>;
  /** The press's own consent, config and fresh quote; null when a stop was shown instead. */
  newQuote(): Promise<Quote | null>;
  /** The payment setup read and its checks, after the quote and before an order exists. */
  prepare(): Promise<void>;
  createOrder(quoteId: string): Promise<T>;
};
export type LiveStart<T extends Order = CustomerCommerceOrder> =
  | { kind: 'show'; order: T; state: ShownState; hold: boolean }
  | { kind: 'wait'; order: T }
  | { kind: 'stop' }
  /** Another press of this guest is deciding right now. */
  | { kind: 'busy' }
  | { kind: 'pay'; order: T; intent: TipTopPayIntent; totalMinor: string; created: boolean };

/**
 * The start of a live TipTopPay press, up to the wallet or card: reads the saved intent and the
 * orders, follows decideTipTopPay, and saves the intent of a new order right after it is created
 * and before anything can be charged. Creates no quote and no order while an earlier payment may
 * still be paid.
 */
/** Guests whose press is deciding right now (two taps, or a screen reopened during one). */
const deciding = new Set<string>();

export async function startLiveOrder<T extends Order>(
  deps: LiveStartDeps<T>,
): Promise<LiveStart<T>> {
  if (deciding.has(deps.customerId)) return { kind: 'busy' };
  deciding.add(deps.customerId);
  try {
    return await decideAndStart(deps);
  } finally {
    deciding.delete(deps.customerId);
  }
}

async function decideAndStart<T extends Order>(deps: LiveStartDeps<T>): Promise<LiveStart<T>> {
  const now = deps.now();
  let stored: string | null;
  try {
    stored = await deps.readIntent();
  } catch {
    // A read that failed is not «no intent»: nothing is created or charged until it works.
    throw new Error('CHECKOUT_STORAGE');
  }
  const parsed = parseTipTopPayIntent(stored, { customerId: deps.customerId, now });
  // An order remembered in memory only has no signature: it is paid again only when the cart on
  // screen agrees with it in substance (decideTipTopPay), never because the cart "is the same".
  const intent =
    parsed ??
    (deps.fallbackOrderId
      ? newTipTopPayIntent({
          customerId: deps.customerId,
          orderId: deps.fallbackOrderId,
          method: deps.method,
          now,
        })
      : null);
  let orders = await deps.listOrders();
  if (intent && !orders.some((order) => order.orderId === intent.orderId)) {
    const one = await deps.readOrder(intent.orderId);
    if (one) orders = [...orders, one];
  }
  const decision = decideTipTopPay({
    intent,
    orders,
    now,
    ...(deps.cart === undefined ? {} : { cart: deps.cart }),
    ...(deps.cartTotalMinor === undefined ? {} : { cartTotalMinor: deps.cartTotalMinor }),
    ...(deps.cartLines === undefined ? {} : { cartLines: deps.cartLines }),
  });
  if (decision.kind === 'show')
    return {
      kind: 'show',
      order: decision.order,
      state: decision.state,
      hold: decision.state !== 'paid',
    };
  if (decision.kind === 'wait') return { kind: 'wait', order: decision.order };
  const save = async (value: TipTopPayIntent) => {
    try {
      await deps.writeIntent(value);
    } catch {
      // Nothing is charged without a saved intent.
      throw new Error('CHECKOUT_STORAGE');
    }
  };
  if (decision.kind === 'retry' && intent) {
    await deps.prepare();
    // A new attempt of the same order: the earlier «sent» mark is gone.
    const again: TipTopPayIntent = { ...intent, method: deps.method };
    delete again.sentAt;
    await save(again);
    return {
      kind: 'pay',
      order: decision.order,
      intent: again,
      totalMinor: decision.order.totalMinor,
      created: false,
    };
  }
  if (decision.kind === 'create' && decision.forget)
    await deps.forgetIntent().catch(() => undefined);
  const quote = await deps.newQuote();
  if (!quote) return { kind: 'stop' };
  await deps.prepare();
  let order: T;
  try {
    order = await deps.createOrder(quote.quoteId);
  } catch (error) {
    if (!isConflict(error)) throw error;
    // The server's CONFLICT: a payment in review, or a changed menu. The orders tell which.
    const hold = holdAfterConflict(await deps.listOrders(), intent, deps.now());
    if (!hold) throw error;
    return { kind: 'show', order: hold.order, state: hold.state, hold: hold.state !== 'paid' };
  }
  const created = newTipTopPayIntent({
    customerId: deps.customerId,
    orderId: order.orderId,
    method: deps.method,
    now: deps.now(),
    ...(quote.signature === undefined
      ? deps.cart === undefined
        ? {}
        : { signature: deps.cart }
      : { signature: quote.signature }),
  });
  await save(created);
  return { kind: 'pay', order, intent: created, totalMinor: quote.totalMinor, created: true };
}
