import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
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
import { paymentReceived } from './commerce-presentation';
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

type Request = (
  path: string,
  method?: 'GET' | 'POST',
  body?: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;
/** The screen's own steps before a charge: consent, /config and a fresh quote of the cart. */
export type TipTopPayQuote = (
  signal: AbortSignal,
) => Promise<{ quoteId: string; totalMinor: string } | null>;
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
  /** A live order that was paid (or is still being checked): the screen shows its statuses. */
  onOrder?: (order: CustomerCommerceOrder, method: TipTopPayMethod) => Promise<void> | void;
}) {
  const [cardOpen, setCardOpen] = useState(false);
  const [cardTotal, setCardTotal] = useState('');
  const [result, setResult] = useState<Shown | null>(null);
  const [lastMethod, setLastMethod] = useState<TipTopPayMethod | null>(null);
  const running = useRef<AbortController | null>(null);
  /** A declined live order is paid again on retry (the server allows a new attempt). */
  const retryOrder = useRef<string | null>(null);
  useEffect(() => () => running.current?.abort(), []);

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

  const run = useCallback(
    async (method: TipTopPayMethod, card?: CardFields) => {
      if (running.current) return;
      const controller = new AbortController();
      running.current = controller;
      const signal = controller.signal;
      setLastMethod(method);
      onBusy(true);
      let applePayOpen = false;
      try {
        const isLive = live?.() === true;
        // A declined live order is paid again as it is; otherwise a fresh quote (and order).
        const again = isLive ? retryOrder.current : null;
        retryOrder.current = null;
        let order: CustomerCommerceOrder | null = null;
        let quote: { quoteId: string; totalMinor: string } | null = null;
        if (again) {
          order = CustomerCommerceOrderSchema.parse(
            await request(`/orders/${again}`, 'GET', undefined, signal),
          );
          if (order.phase !== 'failed') {
            // Paid or in progress meanwhile: never a second charge, show the order.
            setResult(liveOrderShown(order));
            if (paymentReceived(order.phase) || LIVE_WAITING.has(order.phase))
              await onOrder?.(order, method);
            return;
          }
          quote = { quoteId: '', totalMinor: order.totalMinor };
        } else {
          quote = await newQuote(signal);
        }
        if (!quote || signal.aborted) return;
        const setup: CustomerTestPaymentSetup = CustomerTestPaymentSetupSchema.parse(
          await request(
            isLive ? '/payments-setup' : '/test-payments-setup',
            'GET',
            undefined,
            signal,
          ),
        );
        if (isLive !== (setup.environment === 'live'))
          throw new Error('PAYMENT_METHOD_UNAVAILABLE');
        if (isLive && !order)
          // The same create command as a Kaspi press: the order holds the kitchen admission.
          order = CustomerCommerceOrderSchema.parse(
            await request('/orders', 'POST', { key: randomKey(), quoteId: quote.quoteId }, signal),
          );
        const native = NativePayments;
        if (!native) throw new Error('PAYMENT_METHOD_UNAVAILABLE');
        let cryptogram: string;
        if (method === 'card') {
          if (!card) return;
          cryptogram = await native.cardCryptogram(cardInput(card, setup));
        } else if (method === 'apple_pay') {
          if (!native.startApplePay || !APPLE_PAY_MERCHANT_ID)
            throw new Error('PAYMENT_METHOD_UNAVAILABLE');
          applePayOpen = true;
          cryptogram = await native.startApplePay({
            merchantId: APPLE_PAY_MERCHANT_ID,
            label: 'PickChick',
            amount: walletAmount(quote.totalMinor),
            currency: 'KZT',
            countryCode: 'KZ',
          });
        } else {
          if (!native.startGooglePay || !setup.googlePay)
            throw new Error('PAYMENT_METHOD_UNAVAILABLE');
          const input = {
            gateway: setup.googlePay.gateway,
            gatewayMerchantId: setup.googlePay.gatewayMerchantId,
            merchantName: 'PickChick',
            amount: walletAmount(quote.totalMinor),
            currency: 'KZT' as const,
            countryCode: 'KZ' as const,
            test: setup.environment === 'test',
          };
          if (native.isGooglePayReady && !(await native.isGooglePayReady(input)))
            throw new Error('PAYMENT_METHOD_UNAVAILABLE');
          cryptogram = await native.startGooglePay(input);
        }
        if (isLive && order) {
          const answer = liveChargeAnswer(
            await request(
              `/orders/${order.orderId}/tiptoppay`,
              'POST',
              { method, cryptogram },
              signal,
            ),
          );
          if (applePayOpen) {
            applePayOpen = false;
            await native
              .completeApplePay?.(answer.order.phase !== 'failed' && !answer.message)
              .catch(() => undefined);
          }
          if (answer.threeDsUrl)
            // The bank's 3-D Secure page; it returns to pickchick://tiptoppay-return.
            await WebBrowser.openAuthSessionAsync(answer.threeDsUrl, RETURN_URL).catch(
              () => undefined,
            );
          const settled = await pollOrder(answer.order, signal);
          if (signal.aborted) return;
          if (settled.phase === 'failed') retryOrder.current = settled.orderId;
          setResult(liveOrderShown(settled, answer.message));
          if (paymentReceived(settled.phase) || LIVE_WAITING.has(settled.phase))
            await onOrder?.(settled, method);
          return;
        }
        let payment = CustomerTestPaymentSchema.parse(
          await request(
            '/test-payments',
            'POST',
            { quoteId: quote.quoteId, method, cryptogram },
            signal,
          ),
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
        if (signal.aborted || nativePaymentCode(e) === PAYMENT_CANCELLED) return;
        setResult({
          state: 'failed',
          message:
            (e instanceof Error && e.message === 'PAYMENT_METHOD_UNAVAILABLE') ||
            /_PAY_UNAVAILABLE$/.test(nativePaymentCode(e))
              ? 'Этот способ оплаты сейчас недоступен на телефоне. Выберите другой способ.'
              : undefined,
        });
      } finally {
        if (running.current === controller) running.current = null;
        onBusy(false);
      }
    },
    [newQuote, onBusy, poll, pollOrder, request, live, onOrder],
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
      try {
        const order = CustomerCommerceOrderSchema.parse(
          await request(`/orders/${orderId}`, 'GET', undefined),
        );
        setResult(liveOrderShown(order));
        if (order.phase === 'failed') retryOrder.current = order.orderId;
      } catch {
        // Keeps «Проверяем оплату»; the customer can ask again.
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
  }, [request, result?.id, result?.orderId]);

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
          setResult(null);
          onKaspi();
        }}
      />
    </>
  );
  return { start, sheets, cancel: () => running.current?.abort() };
}
