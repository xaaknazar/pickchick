import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as WebBrowser from 'expo-web-browser';
import type {
  CustomerCommerceOrder,
  CustomerTestPayment,
  CustomerTestPaymentSetup,
} from '@pickchick/contracts';
import {
  NativePayments,
  PAYMENT_CANCELLED,
  nativePaymentCode,
} from '../modules/pickchick-payments';
import {
  CustomerCommerceOrderSchema,
  CustomerTestPaymentSchema,
  CustomerTestPaymentSetupSchema,
} from './commerce-checkout';
import { checkoutError, paymentReceived } from './commerce-presentation';
// The poll delay: ends at once on abort and leaves no listener on the signal (audit 23.11 #10).
import { wait as sleep } from './commerce-watch';
import { CardPaymentSheet, TipTopPayResultSheet } from './components/TipTopPaySheets';
import {
  APPLE_PAY_MERCHANT_ID,
  cardInput,
  walletAmount,
  type CardFields,
  type PhoneWallets,
  type TipTopPayMethod,
} from './tiptoppay-checkout';
import { money } from './domain';
import {
  decideTipTopPay,
  chargeLiveOrder,
  holdAfterConflict,
  intentNeedsServer,
  isTipTopPayConflict,
  leaveForOtherMethod,
  parseTipTopPayIntent,
  showStateOf,
  startLiveOrder,
  tipTopPayIntentKey,
  type TipTopPayIntent,
} from './tiptoppay-recovery';

/** What this phone can do with the native payments module (no network). */
export function phoneWallets(): PhoneWallets {
  const module = !!NativePayments;
  let applePay: boolean;
  try {
    applePay =
      Platform.OS === 'ios' &&
      module &&
      !!APPLE_PAY_MERCHANT_ID &&
      !!NativePayments?.canMakeApplePay?.();
  } catch {
    applePay = false;
  }
  return {
    module,
    applePay,
    // Readiness is asked when the sheet opens (isGooglePayReady needs the gateway request).
    googlePay: Platform.OS === 'android' && module && !!NativePayments?.startGooglePay,
  };
}

/**
 * The saved intent of a live TipTopPay payment (tiptoppay-recovery.ts), in the phone's storage so
 * it survives the closed cart and a restart. Reading never throws: a bad record is no intent.
 */
export async function readTipTopPayIntent(
  customerId: string | undefined,
  now = Date.now(),
): Promise<TipTopPayIntent | null> {
  if (!customerId) return null;
  try {
    return parseTipTopPayIntent(await AsyncStorage.getItem(tipTopPayIntentKey(customerId)), {
      customerId,
      now,
    });
  } catch {
    return null;
  }
}
export async function saveTipTopPayIntent(intent: TipTopPayIntent) {
  await AsyncStorage.setItem(tipTopPayIntentKey(intent.customerId), JSON.stringify(intent));
}
export async function forgetTipTopPayIntent(customerId: string | undefined) {
  if (!customerId) return;
  await AsyncStorage.removeItem(tipTopPayIntentKey(customerId)).catch(() => undefined);
}
/**
 * Orders the screen already took over in this app run (a restart takes each over once; closing it
 * keeps the cart free, the pay button still shows it again).
 */
const takenOver = new Set<string>();

type Request = (
  path: string,
  method?: 'GET' | 'POST',
  body?: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;
/** The screen's own steps before a charge: consent, /config and a fresh quote of the cart. */
export type TipTopPayQuote = (
  signal: AbortSignal,
) => Promise<{ quoteId: string; totalMinor: string; signature?: string } | null>;
type Shown = Pick<CustomerTestPayment, 'state' | 'message'> & { id?: string; orderId?: string };

/** The live charge answer: the order view plus the 3-D Secure link or the bank's words. */
export function liveChargeAnswer(value: unknown): {
  order: CustomerCommerceOrder;
  threeDsUrl?: string;
  message?: string;
} {
  if (!value || typeof value !== 'object') throw new Error('INVALID_RESPONSE');
  const { threeDsUrl, message, ...view } = value as Record<string, unknown>;
  const order = CustomerCommerceOrderSchema.parse(view);
  return {
    order,
    ...(typeof threeDsUrl === 'string' && /^https:\/\//.test(threeDsUrl) ? { threeDsUrl } : {}),
    ...(typeof message === 'string' && message.trim()
      ? { message: message.trim().slice(0, 200) }
      : {}),
  };
}
/** What the payment sheet shows for a live order view (the order screen takes over when paid). */
export function liveOrderShown(order: CustomerCommerceOrder, message?: string): Shown {
  if (paymentReceived(order.phase)) return { state: 'paid', orderId: order.orderId };
  if (order.phase === 'failed')
    return { state: 'failed', orderId: order.orderId, ...(message ? { message } : {}) };
  return { state: 'pending', orderId: order.orderId };
}
/** Phases while the bank's answer is still coming (3-D Secure, a lost answer). */
const LIVE_WAITING = new Set(['sending', 'checking', 'ready_to_pay', 'awaiting_payment']);

const RETURN_URL = 'pickchick://tiptoppay-return';
const randomKey = () => randomUUID();
const POLL_MS = 2000;
const POLL_LIMIT_MS = 45_000;

/**
 * TipTopPay card / Apple Pay / Google Pay of the cart (owner 18.11.2026, «Полностью нативно»).
 * TEST terminal only for now: the server charges a quote in its sandbox, so no order is created,
 * no kitchen job, no receipt, and the cart stays as it is. One tap = one fresh quote = at most
 * one charge (the server keys the charge by quote, the bank by our payment id).
 */
export function useTipTopPayCheckout({
  request,
  newQuote,
  onBusy,
  onKaspi,
  test,
  live,
  onOrder,
  customerId,
  cart,
  cartTotal,
  cartLines,
}: {
  request: Request;
  newQuote: TipTopPayQuote;
  onBusy(busy: boolean): void;
  onKaspi(): void;
  test: boolean;
  /**
   * The server pays real orders on the LIVE terminal (/config paymentEnvironment 'live',
   * 23.11.2026): the press creates the order, charges it, and hands it to the order screen.
   */
  live?: () => boolean;
  /**
   * A live order that was paid (or is still being checked): the screen shows its statuses.
   * `hold`: it is an earlier payment in review that holds the guest's new order (the screen
   * says so). A paid order clears the cart that was paid through the saved intent (accept).
   */
  onOrder?: (
    order: CustomerCommerceOrder,
    method: TipTopPayMethod,
    info?: { hold?: boolean },
  ) => Promise<void> | void;
  /** The signed-in customer: the saved intent of a live payment belongs to them. */
  customerId?: string;
  /** Signature of the cart now (cartSignature): a declined order is paid again for this cart only. */
  cart?: () => string | undefined;
  /** Total and lines of the cart now: a declined order is paid again only for a cart it matches. */
  cartTotal?: () => string | undefined;
  cartLines?: () => { productId: string; quantity: number }[];
}) {
  const [cardOpen, setCardOpen] = useState(false);
  const [cardTotal, setCardTotal] = useState('');
  const [result, setResult] = useState<Shown | null>(null);
  const [lastMethod, setLastMethod] = useState<TipTopPayMethod | null>(null);
  const running = useRef<AbortController | null>(null);
  /** A declined live order is paid again on retry (the server allows a new attempt). */
  const retryOrder = useRef<string | null>(null);
  /**
   * Leaving the screen stops the poll and every update of the interface, never the charge
   * request itself (audit 28.11 P0-2): the server charges the card either way, and the saved
   * intent brings the result back when the cart is opened again.
   */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      running.current?.abort();
    };
  }, []);

  const poll = useCallback(
    async (payment: CustomerTestPayment, signal: AbortSignal) => {
      const started = Date.now();
      let current = payment;
      while (current.state === 'pending' && Date.now() - started < POLL_LIMIT_MS) {
        await sleep(POLL_MS, signal);
        if (signal.aborted) break;
        try {
          current = CustomerTestPaymentSchema.parse(
            await request(`/test-payments/${payment.id}`, 'GET', undefined, signal),
          );
        } catch {
          // A dropped read keeps the last known state; the loop asks again.
        }
      }
      return current;
    },
    [request],
  );

  const pollOrder = useCallback(
    async (order: CustomerCommerceOrder, signal: AbortSignal) => {
      const started = Date.now();
      let current = order;
      while (LIVE_WAITING.has(current.phase) && Date.now() - started < POLL_LIMIT_MS) {
        await sleep(POLL_MS, signal);
        if (signal.aborted) break;
        try {
          current = CustomerCommerceOrderSchema.parse(
            await request(`/orders/${order.orderId}`, 'GET', undefined, signal),
          );
        } catch {
          // A dropped read keeps the last known state; the loop asks again.
        }
      }
      return current;
    },
    [request],
  );

  /** The saved intent is dropped for good: the remembered retry order goes with it. */
  const forgetIntent = useCallback(() => {
    retryOrder.current = null;
    return forgetTipTopPayIntent(customerId);
  }, [customerId]);
  /** The guest's orders (GET /orders), parsed. */
  const listOrders = useCallback(
    async (signal?: AbortSignal) => {
      const value = (await request('/orders', 'GET', undefined, signal)) as { orders?: unknown };
      if (!value || !Array.isArray(value.orders)) throw new Error('INVALID_RESPONSE');
      return value.orders.map((order) => CustomerCommerceOrderSchema.parse(order));
    },
    [request],
  );
  /** One order by id; null when the server does not know it. */
  const readOrder = useCallback(
    async (orderId: string, signal?: AbortSignal) => {
      try {
        return CustomerCommerceOrderSchema.parse(
          await request(`/orders/${orderId}`, 'GET', undefined, signal),
        );
      } catch (error) {
        const known = error as { code?: unknown; status?: unknown };
        if (known?.code === 'NOT_FOUND' || known?.status === 404) return null;
        throw error;
      }
    },
    [request],
  );

  const run = useCallback(
    async (method: TipTopPayMethod, card?: CardFields) => {
      if (running.current) return;
      const controller = new AbortController();
      running.current = controller;
      const signal = controller.signal;
      // The charge request is not cut by leaving the screen (see `alive`).
      const chargeSignal = new AbortController().signal;
      setLastMethod(method);
      onBusy(true);
      let applePayOpen = false;
      let liveRun = false;
      /**
       * The live order whose charge request has left the phone (audit 26.11 P0-5). Once it has,
       * a network error is an unknown outcome, not a decline: the bank may have charged it.
       */
      let chargedOrder: string | null = null;
      let intent: TipTopPayIntent | null = null;
      // The order an unreadable start leaves open: never a new one, it could be a second charge.
      let again: string | null = null;
      const box: {
        knownOrder: string | null;
        readFailed: boolean;
        setup: CustomerTestPaymentSetup | null;
      } = { knownOrder: null, readFailed: false, setup: null };
      const cartNow = cart?.();
      const totalNow = cartTotal?.();
      const linesNow = cartLines?.();
      try {
        const isLive = live?.() === true;
        liveRun = isLive;
        const fallback = isLive ? retryOrder.current : null;
        retryOrder.current = null;
        box.knownOrder = fallback;
        const readSetup = async () => {
          const value: CustomerTestPaymentSetup = CustomerTestPaymentSetupSchema.parse(
            await request(
              isLive ? '/payments-setup' : '/test-payments-setup',
              'GET',
              undefined,
              signal,
            ),
          );
          if (isLive !== (value.environment === 'live'))
            throw new Error('PAYMENT_METHOD_UNAVAILABLE');
          box.setup = value;
        };
        let order: CustomerCommerceOrder | null = null;
        let totalMinor = '';
        let quoteId = '';
        if (isLive) {
          if (!customerId) throw new Error('UNAUTHORIZED');
          // Before any quote or order: the saved intent and the guest's orders decide (audit
          // 28.11 P0-2). An earlier payment that may still be paid is shown, never paid twice.
          const read = async <T,>(operation: () => Promise<T>) => {
            try {
              return await operation();
            } catch (failure) {
              box.readFailed = true;
              throw failure;
            }
          };
          const start = await startLiveOrder({
            customerId: customerId ?? '',
            method,
            ...(cartNow === undefined ? {} : { cart: cartNow }),
            ...(totalNow === undefined ? {} : { cartTotalMinor: totalNow }),
            ...(linesNow === undefined ? {} : { cartLines: linesNow }),
            fallbackOrderId: fallback,
            now: Date.now,
            readIntent: async () => {
              // A read that throws is not «no intent»: startLiveOrder stops with CHECKOUT_STORAGE.
              const saved = await AsyncStorage.getItem(tipTopPayIntentKey(customerId));
              box.knownOrder =
                parseTipTopPayIntent(saved, { customerId, now: Date.now() })?.orderId ?? fallback;
              return saved;
            },
            writeIntent: saveTipTopPayIntent,
            forgetIntent,
            listOrders: () => read(() => listOrders(signal)),
            readOrder: (orderId) => read(() => readOrder(orderId, signal)),
            newQuote: async () => {
              box.readFailed = false;
              return newQuote(signal);
            },
            prepare: async () => {
              box.readFailed = false;
              await readSetup();
            },
            createOrder: async (id) => {
              // The same create command as a Kaspi press: the order holds the kitchen admission.
              return CustomerCommerceOrderSchema.parse(
                await request('/orders', 'POST', { key: randomKey(), quoteId: id }, signal),
              );
            },
          });
          if (signal.aborted) return;
          if (start.kind === 'stop' || start.kind === 'busy') return;
          if (start.kind === 'wait') {
            // Its charge may still be on its way: «Проверяем оплату», no second charge.
            retryOrder.current = start.order.orderId;
            setResult({ state: 'pending', orderId: start.order.orderId });
            return;
          }
          if (start.kind === 'show') {
            // An earlier payment (or its result): the order screen takes over, no new order.
            await onOrder?.(start.order, method, { hold: start.hold });
            if (start.state === 'paid') await forgetIntent();
            return;
          }
          order = start.order;
          intent = start.intent;
          totalMinor = start.totalMinor;
          again = start.created ? null : order.orderId;
        } else {
          const quote = await newQuote(signal);
          if (!quote || signal.aborted) return;
          totalMinor = quote.totalMinor;
          quoteId = quote.quoteId;
          await readSetup();
        }
        if (signal.aborted || !box.setup) return;
        const ready: CustomerTestPaymentSetup = box.setup;
        const native = NativePayments;
        if (!native) throw new Error('PAYMENT_METHOD_UNAVAILABLE');
        let cryptogram: string;
        if (method === 'card') {
          if (!card) return;
          cryptogram = await native.cardCryptogram(cardInput(card, ready));
        } else if (method === 'apple_pay') {
          if (!native.startApplePay || !APPLE_PAY_MERCHANT_ID)
            throw new Error('PAYMENT_METHOD_UNAVAILABLE');
          applePayOpen = true;
          cryptogram = await native.startApplePay({
            merchantId: APPLE_PAY_MERCHANT_ID,
            label: 'PickChick',
            amount: walletAmount(totalMinor),
            currency: 'KZT',
            countryCode: 'KZ',
          });
        } else {
          if (!native.startGooglePay || !ready.googlePay)
            throw new Error('PAYMENT_METHOD_UNAVAILABLE');
          const input = {
            gateway: ready.googlePay.gateway,
            gatewayMerchantId: ready.googlePay.gatewayMerchantId,
            merchantName: 'PickChick',
            amount: walletAmount(totalMinor),
            currency: 'KZT' as const,
            countryCode: 'KZ' as const,
            test: ready.environment === 'test',
          };
          if (native.isGooglePayReady && !(await native.isGooglePayReady(input)))
            throw new Error('PAYMENT_METHOD_UNAVAILABLE');
          cryptogram = await native.startGooglePay(input);
        }
        if (isLive && order && intent) {
          const target = order;
          const charged = await chargeLiveOrder(
            {
              // «Sent» is written before the request leaves: a restart that finds the order still
              // unpaid then knows the charge may be on its way (CHARGE_IN_FLIGHT_MS).
              markSent: saveTipTopPayIntent,
              charge: async () => {
                const order = target;
                chargedOrder = order.orderId;
                return liveChargeAnswer(
                  await request(
                    `/orders/${order.orderId}/tiptoppay`,
                    'POST',
                    { method, cryptogram },
                    chargeSignal,
                  ),
                );
              },
              completeApplePay: async (success) => {
                if (!applePayOpen) return;
                applePayOpen = false;
                await native.completeApplePay?.(success);
              },
              // The bank's 3-D Secure page; it returns to pickchick://tiptoppay-return. It opens
              // even after the screen was left, so the guest can finish what the bank asks.
              openThreeDs: async (url) => {
                await WebBrowser.openAuthSessionAsync(url, RETURN_URL);
              },
              poll: (answered) => pollOrder(answered, signal),
              aborted: () => signal.aborted,
            },
            intent,
            { applePay: method === 'apple_pay', now: Date.now },
          );
          // Left the screen after the charge: the intent stays and the cart brings the result back.
          if (charged.kind === 'left') return;
          const settled = charged.order;
          if (settled.phase === 'failed') retryOrder.current = settled.orderId;
          setResult(liveOrderShown(settled, charged.message));
          if (paymentReceived(settled.phase) || LIVE_WAITING.has(settled.phase))
            await onOrder?.(settled, method);
          if (paymentReceived(settled.phase)) await forgetIntent();
          return;
        }
        let payment = CustomerTestPaymentSchema.parse(
          await request('/test-payments', 'POST', { quoteId, method, cryptogram }, signal),
        );
        if (applePayOpen) {
          applePayOpen = false;
          await native.completeApplePay?.(payment.state !== 'failed').catch(() => undefined);
        }
        if (payment.state === 'pending' && payment.threeDsUrl) {
          // The bank's 3-D Secure page; it returns to pickchick://tiptoppay-return.
          await WebBrowser.openAuthSessionAsync(payment.threeDsUrl, RETURN_URL).catch(
            () => undefined,
          );
        }
        if (payment.state === 'pending') payment = await poll(payment, signal);
        if (!signal.aborted) setResult(payment);
      } catch (e) {
        if (applePayOpen) await NativePayments?.completeApplePay?.(false).catch(() => undefined);
        // The server held this guest for a payment in review (CONFLICT, no charge was sent):
        // that payment is shown with its text, not «Банк не подтвердил оплату».
        if (liveRun && isTipTopPayConflict(e) && !signal.aborted) {
          try {
            const hold = holdAfterConflict(await listOrders(), intent, Date.now());
            if (hold) {
              await onOrder?.(hold.order, method, { hold: hold.state !== 'paid' });
              return;
            }
          } catch {
            // Falls through to the plain outcome below.
          }
        }
        // A start that could not read its orders keeps the order it knew: a new one could be a
        // second charge if the first one went through meanwhile.
        if (liveRun && box.readFailed && box.knownOrder) again = box.knownOrder;
        // A retry that could not even read its order keeps that order: a new one could be a
        // second charge if the first one went through meanwhile.
        if (!chargedOrder && again) chargedOrder = again;
        if (chargedOrder) {
          // The answer was lost after the charge was sent: never «Деньги не списаны» and never a
          // new order. The sheet shows «Проверяем оплату»; «Обновить» reads this same order, and
          // «Попробовать ещё раз» pays it again only once the server says it failed.
          retryOrder.current = chargedOrder;
          if (!signal.aborted) setResult({ state: 'pending', orderId: chargedOrder });
          return;
        }
        if (signal.aborted || nativePaymentCode(e) === PAYMENT_CANCELLED) return;
        const said = e instanceof Error ? checkoutError(e) : '';
        setResult({
          state: 'failed',
          message:
            (e instanceof Error && e.message === 'PAYMENT_METHOD_UNAVAILABLE') ||
            /_PAY_UNAVAILABLE$/.test(nativePaymentCode(e))
              ? 'Этот способ оплаты сейчас недоступен на телефоне. Выберите другой способ.'
              : said || undefined,
        });
      } finally {
        if (running.current === controller) running.current = null;
        if (alive.current) onBusy(false);
      }
    },
    [
      newQuote,
      onBusy,
      poll,
      pollOrder,
      request,
      live,
      onOrder,
      customerId,
      cart,
      listOrders,
      readOrder,
      cartTotal,
      cartLines,
      forgetIntent,
    ],
  );

  /**
   * The cart opened (also after a restart, or back from 3-D Secure): a saved intent whose order is
   * paid or with the bank is handed to the order screen, once per app run (a paid one clears the
   * cart that was paid); a charge that may still be on its way is shown as «Проверяем оплату»; an
   * intent with nothing left to recover is dropped. Never charges, never creates an order.
   */
  const resume = useCallback(
    async (signal: AbortSignal) => {
      if (!customerId || running.current) return;
      const saved = await readTipTopPayIntent(customerId);
      // From local data alone: an intent whose charge never left the phone has nothing to show.
      if (!saved || !intentNeedsServer(saved) || signal.aborted || !alive.current) return;
      let orders: CustomerCommerceOrder[];
      try {
        orders = await listOrders(signal);
        if (!orders.some((order) => order.orderId === saved.orderId)) {
          const one = await readOrder(saved.orderId, signal);
          if (one) orders = [...orders, one];
        }
      } catch {
        return;
      }
      if (signal.aborted || !alive.current || running.current) return;
      const decision = decideTipTopPay({ intent: saved, orders, now: Date.now() });
      if (decision.kind === 'show') {
        const id = decision.order.orderId;
        if (decision.state !== 'paid' && takenOver.has(id)) return;
        takenOver.add(id);
        try {
          await onOrder?.(decision.order, saved.method, { hold: decision.state !== 'paid' });
        } catch (failure) {
          // Not shown: the next opening may try again.
          takenOver.delete(id);
          throw failure;
        }
        if (decision.state === 'paid') await forgetIntent();
      } else if (decision.kind === 'wait') {
        if (takenOver.has(decision.order.orderId)) return;
        takenOver.add(decision.order.orderId);
        retryOrder.current = decision.order.orderId;
        setResult({ state: 'pending', orderId: decision.order.orderId });
      } else if (decision.kind === 'create' && decision.forget) await forgetIntent();
      // retry: the next press decides it again from the saved intent (startLiveOrder).
    },
    [customerId, listOrders, readOrder, onOrder, forgetIntent],
  );

  /** One press of «Оплатить» with a TipTopPay method. */
  const start = useCallback(
    (method: TipTopPayMethod, totalMinor: string) => {
      if (running.current) return;
      if (method === 'card') {
        setCardTotal(money(totalMinor));
        setCardOpen(true);
        return;
      }
      void run(method);
    },
    [run],
  );

  const refresh = useCallback(async () => {
    const orderId = result?.orderId;
    if (orderId) {
      let order: CustomerCommerceOrder;
      try {
        order = CustomerCommerceOrderSchema.parse(
          await request(`/orders/${orderId}`, 'GET', undefined),
        );
      } catch {
        // Keeps «Проверяем оплату»; the customer can ask again.
        return;
      }
      setResult(liveOrderShown(order));
      if (order.phase === 'failed') retryOrder.current = order.orderId;
      // Paid or with the bank: the order screen takes over, as after the press itself (audit
      // 28.11 P0-2: the sheet alone said «Оплата прошла» and the cart stayed full). A paid order
      // clears the cart that was paid and drops its intent.
      const state = showStateOf(order);
      if (state) {
        const saved = await readTipTopPayIntent(customerId);
        await onOrder?.(order, lastMethod ?? saved?.method ?? 'card');
        if (state === 'paid') await forgetIntent();
        setResult(null);
      }
      return;
    }
    const id = result?.id;
    if (!id) return;
    try {
      setResult(
        CustomerTestPaymentSchema.parse(await request(`/test-payments/${id}`, 'GET', undefined)),
      );
    } catch {
      // Keeps «Проверяем оплату»; the customer can ask again.
    }
  }, [request, result?.id, result?.orderId, customerId, lastMethod, onOrder, forgetIntent]);

  const sheets = (
    <>
      <CardPaymentSheet
        visible={cardOpen}
        totalText={cardTotal}
        test={test}
        onClose={() => setCardOpen(false)}
        onPay={(card) => {
          setCardOpen(false);
          void run('card', card);
        }}
      />
      <TipTopPayResultSheet
        payment={result}
        test={test}
        onClose={() => setResult(null)}
        onRefresh={() => void refresh()}
        onRetry={() => {
          setResult(null);
          if (lastMethod === 'card') setCardOpen(true);
          else if (lastMethod) void run(lastMethod);
        }}
        onKaspi={() => {
          // Declined, and the guest leaves for another method: nothing is left to recover, and the
          // remembered order must never pull a later payment of another cart.
          if (result?.state === 'failed')
            void leaveForOtherMethod(
              () => {
                retryOrder.current = null;
              },
              () => forgetTipTopPayIntent(customerId),
            );
          else retryOrder.current = null;
          setResult(null);
          onKaspi();
        }}
      />
    </>
  );
  return { start, sheets, resume, cancel: () => running.current?.abort() };
}
