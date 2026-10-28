import { useCheckoutLegal } from '../components/CheckoutLegal';
import { needsCheckoutConsent } from '../checkout-legal';
import { t, localize, useLocale } from '../i18n';
import { matchesPaidComboCart } from '../loyalty/combo-progress';
import { PRICES_UPDATED } from '../cart-reprice';
import { CatalogChangeNotice } from '../components/CatalogChangeNotice';
import { recoverCommerceRead, historyOrderNeedsWatch } from '../commerce-read-recovery';
import { PAYMENT_COMMAND, paymentRefused, prepareCheckout } from '../checkout-preflight';
import { KaspiPaymentState } from '../components/KaspiPaymentState';
import {
  CartOrderComment,
  CartPaymentFooter,
  CartUnavailableBanner,
} from '../components/CartSheet';
import { cartEditSettleMs } from '../cart-payment';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Modal,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import type { CustomerCommerceOrder } from '@pickchick/contracts';
import type { ScreenProps } from '../model';
import { useAccount } from '../useAccount';
import { accountCanAct } from '../account-access';
import { CustomerSessionError } from '../customer-session';
import { watchCommerceOrder, watchRetryDelay } from '../commerce-watch';
import {
  commerceRequest,
  CustomerCommerceOrderSchema,
  CustomerCheckoutConfigSchema,
  CustomerQuoteSchema,
  checkoutItems,
  publishedCartVersion,
  cartSignature,
  normalizedOrderComment,
} from '../commerce-checkout';
import { OrderStatusView } from './OrderStatusScreen';
import { CompletedOrderScreen } from './CompletedOrderScreen';
import { CommerceOrderList } from '../components/OrderHistoryCard';
import { OrdersEmpty, OrdersHeader, ordersPageStyle } from '../components/OrdersTab';
import { publishActiveOrderCount } from '../active-orders';
import { commerceActiveKind } from '../orders-tab';
import { useCommerceFeedback } from '../useCommerceFeedback';
import {
  EARLIER_ORDER_NOTICE,
  checkoutError,
  commerceStatus,
  earlierOrderNotice,
  paymentReceived,
} from '../commerce-presentation';
import { Cart } from './CatalogScreens';
import {
  dismissPendingPayment,
  pendingPaymentDismissed,
  pendingPaymentKey,
  parsePendingPayment,
  type PendingPayment,
} from '../payment-recovery';
import {
  closeDelay,
  closeNeedsConfirm,
  closedIntent,
  draftCanAutoSend,
  draftIsFinal,
  draftOwns,
  liveBankAction,
  noteBankCommand,
  resumableOrder,
  supportAtOnce,
} from '../checkout-resume';
import { OrderSheet, useSheetDismissalLock } from '../components/OrderSheet';
import { slidePayIntents, useSlidePayIntent } from '../useSlidePayIntent';
import { rememberPaymentMethod, usePaymentMethod } from '../usePaymentMethod';
import { PAYMENT_METHOD_NOT_CONNECTED } from '../payment-method';
import { runSlidePayIntent } from '../slide-pay-intent';
import {
  noteCheckoutSwitch,
  paymentStopLabel,
  paymentStopMessage,
  type PaymentAvailability,
} from '../payment-availability';
import { usePaymentAvailability } from '../usePaymentAvailability';
import { Body, Button, Caption, Page } from '../components/UI';
import { cartTotal, cartLineKey, money } from '../domain';
import { colors } from '../theme';

type Quote = ReturnType<typeof CustomerQuoteSchema.parse>;
type Pending = PendingPayment;
const root = '/v1/customer-checkout';

/**
 * Owner 28.10.2026 (Drinkit reference): when paying is not possible right now the cart shows the
 * reason in a red banner under the top bar and a grey, disabled pay button with a short label.
 */
function unavailableCart(availability: PaymentAvailability) {
  // The banner stays mounted (empty while paying is possible), so a reason that appears while
  // the cart is open is announced to screen readers.
  const stop = availability.canPay ? null : availability.stop;
  return {
    banner: <CartUnavailableBanner message={stop ? paymentStopMessage(stop) : null} />,
    label: stop ? paymentStopLabel(stop) : null,
  };
}

/**
 * Kaspi build cart (M09), owner 27.10.2026: there is no separate checkout page, the cart pays.
 * A signed-in customer gets the guarded checkout session below; a guest sees the same cart and
 * the pay button opens sign-in, which returns to the cart without sending anything by itself.
 */
export function KaspiCart(props: ScreenProps) {
  useLocale();
  const account = useAccount();
  const router = useRouter();
  const payment = usePaymentMethod();
  const availability = usePaymentAvailability(props.model);
  if (accountCanAct(account)) return <KaspiCheckoutScreen {...props} />;
  const discount = props.model.comboRewards?.discountMinor ?? '0';
  const total = (BigInt(cartTotal(props.model.cart)) - BigInt(discount)).toString();
  const unavailable = unavailableCart(availability);
  return (
    <Cart
      {...props}
      checkout={{
        banner: unavailable.banner,
        comment: <CartOrderComment model={props.model} />,
        footer: (blocked) => (
          <CartPaymentFooter
            totalMinor={total}
            totalText={money(total)}
            busy={false}
            disabled={blocked || !account.ready || !availability.canPay}
            unavailable={unavailable.label}
            method={payment.method}
            onPay={() => router.push({ pathname: '/auth', params: { returnTo: 'M09' } })}
          />
        ),
      }}
    />
  );
}

/** One durable create command per customer. Never reissues a bank invoice on reconnect. */
export function KaspiCheckoutScreen(props: ScreenProps) {
  useLocale();
  const { account } = useAccount();
  return <LegalCheckoutSession {...props} key={account?.customerId ?? 'guest'} />;
}
function LegalCheckoutSession(props: ScreenProps) {
  const legal = useCheckoutLegal();
  return (
    <>
      <KaspiCheckoutSession {...props} authorizeLegal={legal.authorize} />
      {legal.dialog}
    </>
  );
}
function KaspiCheckoutSession(
  props: ScreenProps & { authorizeLegal: (signal?: AbortSignal) => Promise<void> },
) {
  useLocale();
  const auth = useAccount(),
    customerId = auth.account?.customerId;
  // The customer's active method (item 6b, 27.10.2026): the cart bar handle shows it and this
  // cart pays with it. Only Kaspi.kz is available today, so it is always Kaspi here.
  const payment = usePaymentMethod();
  // Can this customer pay right now (owner 28.10.2026): closed, server switch, connection, stop
  // list. Only hides or disables the payment; submit() keeps every server check of its own.
  const availability = usePaymentAvailability(props.model);
  // 320 x 568 class screens (KaspiPaymentState «tight»): the earlier-order notice is smaller.
  const tightScreen = useWindowDimensions().height < 620;
  // A press or slide with a method this cart cannot pay with (no flow yet): said, never silent.
  const [methodStop, setMethodStop] = useState(false);
  useEffect(() => setMethodStop(false), [payment.method]);
  const [config, setConfig] = useState<ReturnType<
    typeof CustomerCheckoutConfigSchema.parse
  > | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [order, setOrder] = useState<CustomerCommerceOrder | null>(null);
  const [history, setHistory] = useState<CustomerCommerceOrder[]>([]);
  const [initialRating, setInitialRating] = useState<number | undefined>();
  const [receiptError, setReceiptError] = useState<string | null>(null);
  useEffect(() => setReceiptError(null), [order?.orderId]);
  const reviews = useCommerceFeedback(order, props.screenId === 'M19');
  const [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  const [restoring, setRestoring] = useState(true);
  const [connectionPaused, setConnectionPaused] = useState(false);
  const [paymentPaused, setPaymentPaused] = useState(false);
  const preparation = useRef<AbortController | null>(null);
  // The order whose payment command (POST /payment) this screen is sending right now; the state
  // twin re-renders it as «Отправляем счёт» while the command runs (review 28.10.2026).
  const payingOrder = useRef<string | null>(null);
  const [commandFor, setCommandFor] = useState<string | null>(null);
  // Re-renders the connecting scene once a create intent is saved: its wait is the restaurant's.
  const [, setIntentSaved] = useState<string | null>(null);
  // The order watch, stopped at once by closeOrder so a late answer never reopens a closed screen.
  const orderWatch = useRef<AbortController | null>(null);
  // «Проверить ещё раз» on a stuck payment screen: its read, and a fresh watch after it.
  const recheckRun = useRef<AbortController | null>(null);
  useEffect(() => () => recheckRun.current?.abort(), []);
  const [rechecking, setRechecking] = useState(false);
  const [watchRun, setWatchRun] = useState(0);
  const bootstrap = useRef<AbortController | null>(null);
  useEffect(() => () => preparation.current?.abort(), []);
  const [paidMoment, setPaidMoment] = useState(false);
  const paidSeen = useRef(new Set<string>());
  const [priceNotice, setPriceNotice] = useState('');
  const orderRef = useRef<CustomerCommerceOrder | null>(null);
  const [refresh, setRefresh] = useState(0),
    [foreground, setForeground] = useState(AppState.currentState !== 'background');
  const pending = useRef<Pending | null>(null),
    lock = useRef(false);
  const cart = useRef(props.model.cart);
  cart.current = props.model.cart;
  const giftIndex = props.model.comboRewards?.selected
    ? props.model.comboRewards.giftItemIndex
    : undefined;
  const giftDiscount = props.model.comboRewards?.discountMinor ?? '0';
  const localTotal = (BigInt(cartTotal(props.model.cart)) - BigInt(giftDiscount)).toString();
  const cartOnlySignature = cartSignature(props.model.cart, props.model.diningMode, '', giftIndex);
  // Lines, modifiers, gift and «В зале / С собой»: what a cart edit changes.
  const lastCartKey = useRef<string | null>(null);
  const comment = normalizedOrderComment(props.model.orderComment);
  const signature = cartSignature(props.model.cart, props.model.diningMode, comment, giftIndex);
  const signatureRef = useRef(signature);
  signatureRef.current = signature;
  const key = pendingPaymentKey(customerId);
  const [leaving, setLeaving] = useState(false);
  const [resumeNotice, setResumeNotice] = useState('');
  // An earlier order the pay tap (or the cart's own restore) reopened instead of a new one: while
  // the bank may act on it and the cart differs, its screen says so (QA 28.10, item 19).
  const [reopened, setReopened] = useState<string | null>(null);
  // Audit 2.0: only a running command, a pending intent or an order the bank may still charge
  // locks the sheet. Attention, refused and old unbilled orders never do; "close" always wins.
  const lockedAt = Date.now();
  // The cart (27.10.2026) is not locked while it only reads storage: closing it then leaves any
  // saved intent for PaymentRecovery, and it opens/edits without the lock jumping the sheet.
  // A found intent, a running command or a chargeable order locks it as before.
  useSheetDismissalLock(
    !leaving &&
      ((restoring && props.screenId !== 'M09') ||
        busy ||
        connectionPaused ||
        paidMoment ||
        Boolean(pending.current && !order) ||
        Boolean(
          order &&
          draftOwns(pending.current, order.orderId) &&
          !draftIsFinal(order, pending.current, lockedAt),
        ) ||
        Boolean(order && liveBankAction(order, lockedAt))),
  );
  // Only the order created by the saved intent may send its invoice without a new tap; an older
  // unpaid order opened from «Заказы» always waits for «Отправить счёт».
  const autoSends = (target: CustomerCommerceOrder) =>
    draftOwns(pending.current, target.orderId) && draftCanAutoSend(pending.current, Date.now());
  const access = auth.withOrderAccess;
  const request = useCallback(
    async (path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, signal?: AbortSignal) => {
      if (!customerId || !access) return Promise.reject(new Error('UNAUTHORIZED'));
      if (needsCheckoutConsent(path, method)) await props.authorizeLegal(signal);
      return access(customerId, (token) =>
        commerceRequest(`${root}${path}`, method, body, token, signal),
      );
    },
    [customerId, access, props.authorizeLegal],
  );
  const accept = useCallback(
    async (value: unknown, adopt = true) => {
      const current = CustomerCommerceOrderSchema.parse(value);
      // The saved intent belongs to this order, or this is the answer to its own create command.
      // Another order (opened from «Заказы» or watched there) never adopts, settles or clears it.
      const draft =
        pending.current &&
        (pending.current.orderId ? pending.current.orderId === current.orderId : adopt)
          ? pending.current
          : null;
      if (
        ((orderRef.current && !paymentReceived(orderRef.current.phase)) || draft) &&
        paymentReceived(current.phase) &&
        !paidSeen.current.has(current.orderId)
      ) {
        paidSeen.current.add(current.orderId);
        setPaidMoment(true);
      }
      // Publish the accepted identity before cart/storage changes can trigger another recovery.
      orderRef.current = current;
      setOrder(current);
      // Paid, failed, attention or an old unbilled order: the intent has nothing left to do.
      if (draft && draftIsFinal(current, draft, Date.now())) {
        // A newer cart or changed modifiers are never cleared by an older payment.
        if (
          paymentReceived(current.phase) &&
          matchesPaidComboCart(draft.signature, signatureRef.current)
        ) {
          props.model.clearCart(
            cart.current.map((line) => ({ id: cartLineKey(line), quantity: line.quantity })),
          );
          props.model.setOrderComment('');
          props.model.comboRewards?.select(false);
        }
        if (paymentReceived(current.phase)) props.model.comboRewards?.refresh();
        await AsyncStorage.removeItem(key);
        pending.current = null;
      } else if (draft && !draft.orderId) {
        pending.current = { ...draft, orderId: current.orderId };
        await AsyncStorage.setItem(key, JSON.stringify(pending.current));
      }
      return current;
    },
    [key, props.model.clearCart],
  );
  const recover = useCallback(
    async (draft: Pending, signal?: AbortSignal) => {
      try {
        return draft.orderId
          ? await request(`/orders/${draft.orderId}`, 'GET', undefined, signal)
          : await request('/orders', 'POST', { key: draft.key, quoteId: draft.quoteId }, signal);
      } catch (e) {
        // Only a definitive server rejection allows discarding an unconsumed quote.
        if (e instanceof CustomerSessionError && e.authoritative && e.code === 'QUOTE_EXPIRED') {
          await AsyncStorage.removeItem(key);
          pending.current = null;
        }
        throw e;
      }
    },
    [request, key],
  );
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    // A burst of cart edits in the cart sheet re-reads once (27.10.2026); see cartEditSettleMs.
    const settle = cartEditSettleMs(props.screenId, lastCartKey.current, cartOnlySignature);
    lastCartKey.current = cartOnlySignature;
    if (!foreground || (orderRef.current && props.screenId !== 'M19')) return;
    let active = true;
    const controller = new AbortController();
    bootstrap.current = controller;
    const read = (path: string) =>
      recoverCommerceRead({
        read: (signal) => request(path, 'GET', undefined, signal),
        signal: controller.signal,
        ...(path === '/config'
          ? {
              accept: (value: unknown) => CustomerCheckoutConfigSchema.parse(value).enabled,
              onPending: () => {
                // The owner's server switch is off: the cart and the cart bar say so (28.10).
                if (active) noteCheckoutSwitch(customerId, false);
                if (active && props.screenId === 'M19') {
                  setError(new Error('NOT_READY'));
                  setLoaded(true);
                }
              },
            }
          : {}),
        active: AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
        subscribe: (listener) => {
          const subscription = AppState.addEventListener('change', (state) =>
            listener(state === 'active'),
          );
          return () => subscription.remove();
        },
        onFailure: (cause) => {
          if (active && props.screenId === 'M19') {
            setError(cause);
            setLoaded(true);
          }
        },
        onRecovered: () => {
          if (active) setError(null);
        },
      });
    // The old quote and error belong to the old cart: dropped at once, also while settling.
    setError(null);
    setQuote(null);
    setOrder(null);
    setReopened(null);
    const run = async () => {
      const raw = await AsyncStorage.getItem(key);
      const draft = parsePendingPayment(raw);
      if (!active || controller.signal.aborted || lock.current) return;
      pending.current = draft;
      setRestoring(false);
      if (draft && !draft.orderId && !draftCanAutoSend(draft, Date.now())) {
        // An old intent that never became a known order: nothing was billed, nothing to send.
        await AsyncStorage.removeItem(key);
        pending.current = null;
      } else if (
        draft &&
        // «Заказы» and the cart (27.10.2026) do not reopen an intent the customer closed in this
        // app run; the cart's pay button restores it first (submit), the checkout route at once.
        !((props.screenId === 'M19' || props.screenId === 'M09') && pendingPaymentDismissed(draft))
      ) {
        const existing = CustomerCommerceOrderSchema.parse(
          await prepareCheckout(() => recover(draft, controller.signal), controller.signal),
        );
        if (!active || controller.signal.aborted || lock.current) return;
        const unbilled =
          existing.phase === 'ready_to_pay' || existing.phase === 'awaiting_restaurant';
        if (unbilled && draftIsFinal(existing, draft, Date.now())) {
          // Audit 2.1: an old intent never sends its invoice later without a new tap. The order
          // stays in «Заказы»; the cart is free for a new order.
          await AsyncStorage.removeItem(key);
          pending.current = null;
          if (props.screenId !== 'M19')
            setResumeNotice(
              t(
                'Прошлый заказ не оплачен: счёт не отправлялся, деньги не списаны. Он остаётся в «Заказах».',
              ),
            );
        } else {
          if (props.screenId !== 'M19') setReopened(existing.orderId);
          await acceptRef.current(existing);
          if (props.screenId !== 'M19' || !['failed', 'attention'].includes(existing.phase)) return;
          // The Orders tab shows a settled order in its list, not as a payment screen.
          orderRef.current = null;
          setOrder(null);
        }
      } else if (draft) {
        // Closed in «Заказы» (audit 2.4): the tab shows its list, not the intent. The intent
        // stays saved for the checkout and the next start, and no other order touches it here.
        pending.current = null;
      }
      if (props.screenId !== 'M19') {
        // Passive configuration only; price/admission checks belong to the explicit pay action.
        const setup = CustomerCheckoutConfigSchema.parse(await read('/config'));
        if (active) noteCheckoutSwitch(customerId, setup.enabled);
        if (active && !controller.signal.aborted && !lock.current) setConfig(setup);
        return;
      }
      const result = await read('/orders');
      const orders = (result as { orders: unknown[] }).orders.map((v) =>
        CustomerCommerceOrderSchema.parse(v),
      );
      if (!active) return;
      setHistory(orders);
    };
    const start = () => {
      // The pay button (submit) aborts a re-read that has not started yet.
      if (!active || controller.signal.aborted) return;
      setLoaded(false);
      setRestoring(true);
      void run()
        .catch((e) => {
          if (active && !controller.signal.aborted) setError(e);
        })
        .finally(() => {
          if (active) {
            setLoaded(true);
            setRestoring(false);
          }
        });
    };
    const timer = settle ? setTimeout(start, settle) : null;
    if (!timer) start();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      controller.abort();
    };
  }, [
    request,
    recover,
    key,
    refresh,
    props.screenId,
    props.model.branch?.id,
    cartOnlySignature,
    props.model.diningMode,
    foreground,
  ]);

  useEffect(() => {
    if (!order || !foreground || ['failed', 'handed_over', 'attention'].includes(order.phase))
      return;
    const controller = new AbortController();
    orderWatch.current = controller;
    void watchCommerceOrder({
      signal: controller.signal,
      read: (signal) =>
        request(`/orders/${order.orderId}/watch?after=${order.revision}`, 'GET', undefined, signal),
      accept: async (next) => {
        // A watch answer is never the create command of a pending intent.
        await acceptRef.current(next, false);
      },
      // Connection recovery keeps the last confirmed order on screen without banners.
      onError: () => {},
      onRecovered: () => {},
    });
    return () => {
      controller.abort();
      if (orderWatch.current === controller) orderWatch.current = null;
    };
    // watchRun: «Проверить ещё раз» starts a fresh watch after its own read.
  }, [request, order?.orderId, order?.revision, order?.phase, foreground, watchRun]);
  useEffect(() => {
    if (props.screenId !== 'M19' || order || !foreground) return;
    const controller = new AbortController();
    for (const item of history.filter((entry) => historyOrderNeedsWatch(entry.phase))) {
      let revision = item.revision;
      void watchCommerceOrder({
        signal: controller.signal,
        read: (signal) =>
          request(`/orders/${item.orderId}/watch?after=${revision}`, 'GET', undefined, signal),
        accept: async (value) => {
          const next = CustomerCommerceOrderSchema.parse(value);
          revision = next.revision;
          if (
            pending.current?.orderId === next.orderId &&
            draftIsFinal(next, pending.current, Date.now())
          ) {
            await AsyncStorage.removeItem(key);
            pending.current = null;
          }
          if (next.phase === 'failed') {
            setHistory((items) => items.filter((entry) => entry.orderId !== next.orderId));
          } else
            setHistory((items) =>
              items.map((entry) => (entry.orderId === next.orderId ? next : entry)),
            );
        },
        onError: () => {},
        onRecovered: () => {},
      });
    }
    return () => controller.abort();
  }, [props.screenId, order, foreground, history, request, key]);

  // Tab badge mirrors the list already loaded here; no extra request or poll.
  const activeCount =
    props.screenId === 'M19'
      ? history.filter((item) => commerceActiveKind(item.phase) !== null).length
      : null;
  useEffect(() => {
    if (activeCount !== null) publishActiveOrderCount(activeCount);
  }, [activeCount]);
  useEffect(
    () => () => {
      if (props.screenId === 'M19') publishActiveOrderCount(0);
    },
    [props.screenId],
  );
  useEffect(() => {
    if (!paidMoment || !foreground) return;
    const timer = setTimeout(() => setPaidMoment(false), 2000);
    return () => clearTimeout(timer);
  }, [paidMoment, foreground]);
  const refreshChangedMenu = useCallback(
    async (discardUnattempted?: string) => {
      if (discardUnattempted) {
        // MENU_CHANGED on pay guarantees no bank attempt and a durable local cancellation.
        // Only that order's own intent is dropped (audit 2.4: «Заказы» may show another order).
        if (draftOwns(pending.current, discardUnattempted)) {
          await AsyncStorage.removeItem(key);
          pending.current = null;
        }
        orderRef.current = null;
        setOrder(null);
      }
      setQuote(null);
      const refreshed = await props.model.refreshCatalog?.();
      setPriceNotice(PRICES_UPDATED);
      setError(refreshed ? null : new Error('NETWORK_UNAVAILABLE'));
      // A second explicit press is required. This path never creates an order or invoice.
    },
    [key, props.model.refreshCatalog],
  );
  const displayedCartTotal = localTotal;
  useEffect(() => {
    if (!orderRef.current) setQuote(null);
  }, [displayedCartTotal]);
  const submit = async () => {
    if (lock.current || !cart.current.length) return;
    // This session sends Kaspi invoices only; another active method never sends one. Until that
    // method has its own flow, the press (or the slide) stops here with a visible message:
    // nothing is created, quoted or sent.
    if (payment.method !== 'kaspi') {
      setMethodStop(true);
      return;
    }
    setMethodStop(false);
    lock.current = true;
    setBusy(true);
    try {
      await props.authorizeLegal();
    } catch {
      lock.current = false;
      setBusy(false);
      return;
    }
    const acceptedTotal = quote?.totalMinor ?? localTotal;
    bootstrap.current?.abort();
    const controller = new AbortController();
    preparation.current = controller;
    const deadline = setTimeout(() => controller.abort('timeout'), 60_000);
    setBusy(true);
    setConnectionPaused(false);
    setError(null);
    setPriceNotice('');
    setResumeNotice('');
    setReopened(null);
    const prepared = <T,>(operation: () => Promise<T>) =>
      prepareCheckout(operation, controller.signal);
    try {
      // Restore the exact previous intent before any new quote/order is created.
      const raw = await AsyncStorage.getItem(key);
      if (raw) {
        const draft = parsePendingPayment(raw)!;
        if (draft.orderId || draftCanAutoSend(draft, Date.now())) {
          pending.current = draft;
          const previous = CustomerCommerceOrderSchema.parse(
            await prepared(() => recover(draft, controller.signal)),
          );
          // Shown while it can still bill or charge, or to report its paid/failed outcome.
          if (
            !draftIsFinal(previous, draft, Date.now()) ||
            paymentReceived(previous.phase) ||
            previous.phase === 'failed'
          ) {
            setReopened(previous.orderId);
            await accept(previous);
            return;
          }
        }
        // Audit 0.2 / 2.1: an old, unbilled or attention intent never holds the checkout.
        await AsyncStorage.removeItem(key);
        pending.current = null;
      }
      const result = await prepared(() => request('/orders', 'GET', undefined, controller.signal));
      // Only an order the bank may still charge is resumed; unbilled or attention orders stay
      // in «Заказы» and the current cart becomes a new order.
      const existing = resumableOrder(
        (result as { orders: unknown[] }).orders.map((value) =>
          CustomerCommerceOrderSchema.parse(value),
        ),
        Date.now(),
      );
      if (existing) {
        setReopened(existing.orderId);
        await accept(existing);
        return;
      }
      // A held gift may no longer be available for a NEW order. Existing intents above
      // still recover normally, including an unknown payment after a network failure.
      if (props.model.comboRewards?.selected && (giftIndex === undefined || giftDiscount === '0')) {
        setError(new Error('GIFT_UNAVAILABLE'));
        props.model.comboRewards.refresh();
        return;
      }
      const setup = await prepared(async () => {
        const value = CustomerCheckoutConfigSchema.parse(
          await request('/config', 'GET', undefined, controller.signal),
        );
        noteCheckoutSwitch(customerId, value.enabled);
        if (!value.enabled) throw new CustomerSessionError('NOT_READY', 503, true);
        return value;
      });
      setConfig(setup);
      if (!setup.orderCommentEnabled && comment) {
        setError(new Error('COMMENT_UNAVAILABLE'));
        return;
      }
      const quoteKey = randomUUID();
      const currentQuote = CustomerQuoteSchema.parse(
        await prepared(() =>
          request(
            '/quotes',
            'POST',
            {
              key: quoteKey,
              branchId: setup.branchId,
              ...(publishedCartVersion(cart.current, setup.branchId) === undefined
                ? {}
                : { catalog_version: publishedCartVersion(cart.current, setup.branchId) }),
              serviceMode: props.model.diningMode,
              items: checkoutItems(cart.current),
              ...(giftIndex === undefined ? {} : { giftItemIndex: giftIndex }),
              ...(comment ? { kitchenComment: comment } : {}),
            },
            controller.signal,
          ),
        ),
      );
      if (signature !== signatureRef.current) return;
      const displayedTotal = acceptedTotal;
      setQuote(currentQuote);
      if (String(currentQuote.totalMinor) !== String(displayedTotal)) {
        setPriceNotice(PRICES_UPDATED);
        return;
      }
      const draft: Pending = {
        key: randomUUID(),
        quoteId: currentQuote.quoteId,
        signature,
        sendInvoice: true,
        // Bounds the automatic invoice to this tap (audit 2.1).
        createdAt: Date.now(),
      };
      await AsyncStorage.setItem(key, JSON.stringify(draft)).catch(() => {
        throw new Error('CHECKOUT_STORAGE');
      });
      pending.current = draft;
      setIntentSaved(draft.key);
      await accept(await prepared(() => recover(draft, controller.signal)));
    } catch (e) {
      // Transport failures stay on the connecting scene; only a final actionable outcome returns.
      if (
        e instanceof CustomerSessionError &&
        e.authoritative &&
        !pending.current &&
        ['MENU_CHANGED', 'CONFLICT', 'QUOTE_EXPIRED'].includes(e.code)
      )
        await refreshChangedMenu();
      else if (controller.signal.reason === 'timeout') setConnectionPaused(true);
      else if (!controller.signal.aborted) setError(e);
    } finally {
      clearTimeout(deadline);
      if (preparation.current === controller) preparation.current = null;
      lock.current = false;
      setIntentSaved(null);
      setBusy(false);
      setLoaded(true);
    }
  };
  // Slide to pay from the cart bar: the bar opens the cart with payment (M09, 27.10.2026; there
  // is no separate checkout page). A fresh intent of this app process is taken once, after the
  // saved intent is read, and equals one press of «Оплатить» below. Nothing else runs on its own:
  // a holding intent, an order or a running command keeps the screen as it is, and any stop
  // (consent, prices, comment, gift, stop list, network) waits for a new explicit press.
  const slideIntent = useSlidePayIntent(props.screenId === 'M09' && !props.preview);
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    runSlidePayIntent(
      slidePayIntents,
      slideIntent,
      {
        restoring,
        signedIn: !!customerId,
        busy: lock.current,
        saved: pending.current,
        order: !!orderRef.current,
        cartLines: cart.current.length,
        blocked: !availability.canPay,
        now: Date.now(),
      },
      () => void submitRef.current(),
    );
  }, [slideIntent, restoring, customerId]);
  const pay = useCallback(async () => {
    if (lock.current || !order) return;
    lock.current = true;
    setBusy(true);
    try {
      await props.authorizeLegal();
    } catch {
      lock.current = false;
      setBusy(false);
      setPaymentPaused(true);
      return;
    }
    setPaymentPaused(false);
    setError(null);
    const controller = new AbortController();
    preparation.current = controller;
    const deadline = setTimeout(() => controller.abort('timeout'), 60_000);
    // Bounds "the bank may still answer" for this order even when it was created long ago.
    noteBankCommand(order.orderId, Date.now());
    // The handle and «Способ оплаты» show the method of the last payment sent (item 6b).
    rememberPaymentMethod(customerId, 'kaspi', 'payment');
    // While this command runs the bank may act even if the screen still shows ready_to_pay: the X
    // asks first and keeps the intent (closedIntent).
    payingOrder.current = order.orderId;
    setCommandFor(order.orderId);
    try {
      await accept(
        await prepareCheckout(
          () => request(`/orders/${order.orderId}/payment`, 'POST', undefined, controller.signal),
          controller.signal,
          undefined,
          PAYMENT_COMMAND,
        ),
      );
    } catch (e) {
      if (e instanceof CustomerSessionError && e.authoritative && e.code === 'MENU_CHANGED')
        await refreshChangedMenu(order.orderId);
      else if (paymentRefused(e)) {
        // Audit 2.1: the restaurant refused to bill this order (stop list, closed, not ready,
        // kitchen offline). No attempt exists and no money was taken. Drop its intent so nothing
        // re-sends it, return to the cart with the reason and refresh the menu.
        if (draftOwns(pending.current, order.orderId)) {
          await AsyncStorage.removeItem(key).catch(() => undefined);
          pending.current = null;
        }
        orderRef.current = null;
        setOrder(null);
        setQuote(null);
        const code = (e as CustomerSessionError).code;
        setError(new Error(code === 'NOT_READY' ? 'ORDER_NOT_ACCEPTED' : code));
        void props.model.refreshCatalog?.();
      } else if (controller.signal.aborted) setPaymentPaused(controller.signal.reason !== 'user');
      else setError(e);
    } finally {
      clearTimeout(deadline);
      if (preparation.current === controller) preparation.current = null;
      payingOrder.current = null;
      setCommandFor(null);
      lock.current = false;
      setBusy(false);
    }
  }, [
    order,
    request,
    accept,
    refreshChangedMenu,
    key,
    props.model.refreshCatalog,
    props.authorizeLegal,
    customerId,
  ]);
  useEffect(() => {
    // Explicit consent is persisted before order creation. Admission can arrive later.
    // Existing pre-consent drafts retain the manual action; no charge on a passive history visit.
    // A draft older than a few minutes (or from build 20) never sends an invoice by itself.
    if (order?.phase === 'ready_to_pay' && autoSends(order) && !busy && !error && !paymentPaused)
      void pay();
  }, [order?.phase, order?.orderId, busy, error, paymentPaused, pay]);
  const retry = () => {
    setError(null);
    setRefresh((c) => c + 1);
  };
  /**
   * «Проверить ещё раз» on a stuck screen (owner 28.10.2026): one read of the order now and a
   * fresh watch. Read only: it never sends, creates or cancels anything.
   */
  const recheck = async () => {
    const target = order;
    if (!target || recheckRun.current) return;
    const controller = new AbortController();
    recheckRun.current = controller;
    setRechecking(true);
    try {
      const value = await request(`/orders/${target.orderId}`, 'GET', undefined, controller.signal);
      if (!controller.signal.aborted && orderRef.current?.orderId === target.orderId)
        await acceptRef.current(value, false);
    } catch {
      // The watch keeps listening; a failed check changes nothing on screen.
    } finally {
      if (recheckRun.current === controller) recheckRun.current = null;
      setRechecking(false);
      if (!controller.signal.aborted) setWatchRun((value) => value + 1);
    }
  };
  /**
   * Audit 0.2 / 2.0 / 2.4: leave a payment screen without touching the order or the bank. An
   * unbilled order also withdraws its automatic invoice; an order the bank may still charge
   * keeps its intent for recovery at the next app start, but is not pushed back this session,
   * and never sends an invoice by itself again (closedIntent).
   * Owner 28.10.2026: the glass X returns to the cart itself (`to: 'cart'`), the cart keeps its
   * lines and the customer may change them and pay again; «Заказы» returns to its list.
   */
  const closeOrder = async (to: 'cart' | 'leave' = 'leave') => {
    const draft = pending.current;
    const shown = order ?? orderRef.current;
    const current = shown && orderRef.current?.orderId === shown.orderId ? orderRef.current : shown;
    // Only the intent of the closed order (or of a create still in flight) is affected; leaving an
    // older order opened from «Заказы» never touches the intent of another order.
    const intent = closedIntent(
      draft,
      current ?? undefined,
      Date.now(),
      !!current && payingOrder.current === current.orderId,
    );
    // Review 28.10.2026: first, synchronously, stop everything that could still adopt an answer
    // (the running command, the start's recovery of the intent, «Проверить ещё раз», the order
    // watch) and settle the intent in memory; only then write storage. A POST /orders or watch
    // answer landing during that write can then never write the intent back or send its invoice
    // (prepareCheckout drops an aborted answer). Every way out below reads again or leaves.
    preparation.current?.abort('user');
    bootstrap.current?.abort();
    recheckRun.current?.abort();
    orderWatch.current?.abort();
    let saved: Promise<void> | null = null;
    if (intent === 'remove') {
      pending.current = null;
      saved = AsyncStorage.removeItem(key);
    } else if (intent === 'keep' && draft) {
      dismissPendingPayment(draft.key);
      if (draft.sendInvoice !== false) {
        const kept: Pending = { ...draft, sendInvoice: false };
        pending.current = kept;
        saved = AsyncStorage.setItem(key, JSON.stringify(kept));
      }
    }
    await saved?.catch(() => undefined);
    if (props.screenId === 'M19') {
      orderRef.current = null;
      setOrder(null);
      setPaidMoment(false);
      setError(null);
      setRefresh((c) => c + 1);
      return;
    }
    if (to === 'cart') {
      // The kept intent waits in storage for the next app start or the next explicit tap (submit
      // restores it before anything new); the cart itself is free, as when it is opened again.
      if (pending.current && pendingPaymentDismissed(pending.current)) pending.current = null;
      setConnectionPaused(false);
      setPaymentPaused(false);
      setPaidMoment(false);
      backToCart();
      return;
    }
    setLeaving(true);
  };
  /**
   * The X and «Вернуться в корзину» of a payment screen (owner 28.10.2026): the cart (M09) returns
   * to the cart itself; «Заказы» returns to its list at once (as before); the recovery route M12
   * (opened by PaymentRecovery at start) closes like its «Закрыть», since it restores a saved
   * intent at once by design. A connecting screen without a saved intent has created nothing: it
   * only stops the attempt. The confirmation itself (closeNeedsConfirm) is asked by
   * KaspiPaymentState.
   */
  const dismissPayment = () => {
    if (!order && !pending.current) {
      preparation.current?.abort('user');
      setConnectionPaused(false);
      return;
    }
    void closeOrder(props.screenId === 'M09' ? 'cart' : 'leave');
  };
  const dismissLabel = props.screenId === 'M19' ? t('К списку заказов') : t('Закрыть оплату');
  // «Заказы» keeps its own «К списку заказов» below; the cart offers the way back to it.
  const stuckReturnLabel =
    props.screenId === 'M19'
      ? null
      : props.screenId === 'M09'
        ? t('Вернуться в корзину')
        : t('Закрыть');
  const dismissNeedsConfirm = () =>
    props.screenId !== 'M19' &&
    closeNeedsConfirm(order ?? undefined, Date.now(), {
      draft: pending.current,
      commandRunning: !!order && payingOrder.current === order.orderId,
    });
  useEffect(() => {
    // The sheet lock is released in this render; close the sheet afterwards.
    if (leaving) props.goBack?.();
  }, [leaving]);
  // The red banner says why paying is impossible right now (owner 28.10): an earlier refusal of
  // the server (RESTAURANT_CLOSED after a phone clock a little behind at closing) is not shown
  // under it with a «Попробовать снова» that does nothing, and does not come back when the
  // restaurant opens (QA 28.10). Only the cart itself: an order on screen, a saved intent or a
  // running command keep their failure for the payment guards.
  useEffect(() => {
    if (props.screenId === 'M19' || availability.canPay || !error) return;
    if (orderRef.current || pending.current || lock.current) return;
    setError(null);
  }, [availability.canPay, error, props.screenId]);
  const total = quote ? quote.totalMinor : localTotal;
  // Keep the failure itself for payment/recovery guards; transient failures have no UI copy.
  const visibleError = error ? checkoutError(error) : '';
  const historyNeedsRefresh = !!error && !visibleError && watchRetryDelay(error, 1) === null;
  const unsupportedComment =
    loaded &&
    !!config &&
    config.orderCommentEnabled !== true &&
    !!normalizedOrderComment(props.model.orderComment);
  // The cart is the checkout (27.10.2026): its footer carries the guards' notices and pays.
  // Paying impossible right now (28.10.2026): a grey, disabled button with a short reason.
  const unavailable = unavailableCart(availability);
  const cartFooter = (blocked: boolean) => (
    <CartPaymentFooter
      totalMinor={total}
      totalText={money(total)}
      busy={busy}
      disabled={busy || blocked || !availability.canPay}
      unavailable={busy ? null : unavailable.label}
      method={payment.method}
      onPay={() => {
        if (availability.canPay) void submit();
      }}
      notices={
        <>
          {methodStop && payment.method !== 'kaspi' ? (
            <View testID="cart-pay-method-stop" style={s.warning} accessibilityLiveRegion="polite">
              <Body>{localize(t(PAYMENT_METHOD_NOT_CONNECTED))}</Body>
              <Button
                secondary
                title={t('Выбрать Kaspi.kz')}
                testID="cart-pay-method-kaspi"
                onPress={() => payment.choose('kaspi')}
              />
            </View>
          ) : null}
          {unsupportedComment ? (
            <View style={s.commentUnavailable}>
              <Caption>
                {t('Комментарий временно недоступен. Удалите его, чтобы оформить заказ.')}
              </Caption>
              <Button
                secondary
                title={t('Удалить комментарий')}
                onPress={() => props.model.setOrderComment('')}
              />
            </View>
          ) : null}
          {/* The cart body already shows the menu update (with «Понятно»); the footer adds only
              the quote's own price stop, never the same notice twice. */}
          {priceNotice && priceNotice !== props.model.catalogUpdateNotice ? (
            <CatalogChangeNotice message={priceNotice} totals={props.model.cartChanges} />
          ) : null}
        </>
      }
    />
  );
  // In the cart a stopped or failed payment returns to the cart view itself, not to a new sheet.
  const backToCart = () => {
    orderRef.current = null;
    setOrder(null);
    setQuote(null);
    setError(null);
    setLoaded(false);
    setRefresh((c) => c + 1);
  };
  if ((busy || connectionPaused || pending.current) && !order)
    return (
      <KaspiPaymentState
        canReturnToCheckout={!pending.current}
        returnLabel={t('Вернуться в корзину')}
        onContinue={() => {}}
        onRetry={() => {}}
        onCart={() => {
          if (pending.current) return;
          preparation.current?.abort('user');
          setConnectionPaused(false);
        }}
        extraAction={
          connectionPaused || (error && pending.current) ? (
            // Without a saved intent nothing was ordered or billed: this is a connection retry.
            <Button
              title={localize(pending.current ? 'Проверить оплату' : t('Повторить попытку'))}
              onPress={() => (pending.current ? retry() : void submit())}
            />
          ) : undefined
        }
        onClose={pending.current ? () => void closeOrder() : undefined}
        closeLabel={props.screenId === 'M19' ? t('К списку заказов') : 'Закрыть'}
        // «Заказы» is a tab, not the checkout: its list is reachable at once (audit 2.4).
        closeDelayMs={props.screenId === 'M19' ? 0 : closeDelay(undefined, Date.now())}
        // Owner 28.10.2026: the glass X at once, top right, back to the cart (or the list).
        onDismiss={dismissPayment}
        dismissLabel={dismissLabel}
        dismissNeedsConfirm={dismissNeedsConfirm}
        safeTop={!props.inSheet}
        // Review 28.10.2026: a create command (POST /orders, NOT_READY retried up to 60 s) is the
        // restaurant's wait: after 20 s it says so, with the way back (it retries by itself).
        intentKey={pending.current && !pending.current.orderId ? pending.current.key : undefined}
        stuckReturnLabel={stuckReturnLabel}
        // «Заказы» with a cart: the buttons stay above the cart bar docked on the tab bar.
        bottomInset={props.cartBottomInset}
      />
    );
  if (order && (!paymentReceived(order.phase) || paidMoment))
    return (
      <KaspiPaymentState
        order={order}
        paid={paidMoment && paymentReceived(order.phase)}
        notice={
          // QA 28.10 (item 19): a pay tap that reopened an earlier order at the bank, while the
          // cart now differs from it, says at once which order this is and why no new one.
          props.screenId !== 'M19' &&
          reopened === order.orderId &&
          earlierOrderNotice(order, { lines: props.model.cart.length, totalMinor: localTotal }) ? (
            <View
              testID="kaspi-earlier-order"
              style={[s.earlier, tightScreen && s.tightEarlier]}
              accessibilityLiveRegion="polite"
            >
              <Caption style={[s.earlierText, tightScreen && s.tightEarlierText]}>
                {t(EARLIER_ORDER_NOTICE, { p0: money(order.totalMinor) })}
              </Caption>
            </View>
          ) : undefined
        }
        onContinue={() => setPaidMoment(false)}
        onCart={() => (props.screenId === 'M19' ? props.navigate('M09') : backToCart())}
        onRetry={() => {
          if (order.phase !== 'failed') return;
          backToCart();
        }}
        extraAction={
          // While its command runs the screen reads «Отправляем счёт»: no second «Отправить счёт».
          order.phase === 'ready_to_pay' &&
          commandFor !== order.orderId &&
          (!autoSends(order) || paymentPaused || !!error) ? (
            <Button
              title={localize(t('Отправить счёт на {p0}', { p0: money(order.totalMinor) }))}
              onPress={() => void pay()}
              disabled={busy}
            />
          ) : undefined
        }
        onClose={busy ? undefined : () => void closeOrder()}
        closeLabel={props.screenId === 'M19' ? t('К списку заказов') : 'Закрыть'}
        // The Orders tab is not a modal: going back to the list touches nothing (audit 2.4).
        closeDelayMs={
          props.screenId === 'M19' && closeDelay(order, Date.now()) !== null
            ? 0
            : closeDelay(order, Date.now())
        }
        // Sending or checking too long, an expired invoice or a restaurant that does not answer:
        // a person settles it (audit 0.2).
        support={supportAtOnce(order, Date.now())}
        // Owner 28.10.2026: the glass X at once on every payment state; a stuck «sending» or
        // restaurant wait explains itself and offers a read-only check and the way back.
        onDismiss={paidMoment && paymentReceived(order.phase) ? undefined : dismissPayment}
        dismissLabel={dismissLabel}
        dismissNeedsConfirm={dismissNeedsConfirm}
        safeTop={!props.inSheet}
        onRecheck={() => void recheck()}
        rechecking={rechecking}
        stuckReturnLabel={stuckReturnLabel}
        // Review 28.10.2026: POST /payment still running (up to 60 s) is shown and waits as
        // «sending»; the wait of the intent that created this order goes on (waitSince).
        paymentCommand={commandFor === order.orderId}
        intentKey={draftOwns(pending.current, order.orderId) ? pending.current.key : undefined}
        bottomInset={props.cartBottomInset}
      />
    );
  if (order && paymentReceived(order.phase)) {
    const status = (statusProps: ScreenProps, onBeforeGame?: () => void) =>
      order.phase === 'handed_over' ? (
        <CompletedOrderScreen
          key={order.orderId}
          props={statusProps}
          order={order}
          initialRating={initialRating}
          review={reviews.detail?.feedback ?? reviews.ratings[order.orderId]}
          reviewLoading={reviews.loading || (!reviews.detail && !reviews.error)}
          reviewSaving={reviews.saving}
          reviewError={reviews.error}
          reviewUnavailable={
            reviews.detail && !reviews.detail.enabled
              ? 'Оценка этого заказа пока недоступна.'
              : undefined
          }
          onSaveReview={reviews.detail?.enabled ? reviews.save : undefined}
          onRetryReview={reviews.retry}
          receiptError={receiptError}
          preparationStartedAt={reviews.detail?.preparationStartedAt}
          readyAt={reviews.detail?.readyAt}
          onOpenReceipt={
            order.receiptUrl?.startsWith('https://')
              ? () => {
                  void Linking.openURL(order.receiptUrl!).catch(() =>
                    setReceiptError('Не удалось открыть чек. Попробуйте ещё раз.'),
                  );
                }
              : undefined
          }
        />
      ) : (
        <OrderStatusView
          props={statusProps}
          order={commerceStatus(order)}
          onBeforeGame={onBeforeGame}
          afterItems={
            order.kitchenComment ? (
              <View testID="order-kitchen-comment" style={s.savedComment}>
                <Caption>{t('Комментарий к заказу')}</Caption>
                <Body>{order.kitchenComment}</Body>
              </View>
            ) : undefined
          }
          receipt={{
            // Status only: the tracker has no receipt link; the completed order opens it.
            caption:
              order.receipt === 'deferred'
                ? 'Фискальный чек пока не выпускается - Webkassa подключается.'
                : order.receipt === 'issued'
                  ? 'Чек выпущен. Ссылка на него уточняется.'
                  : 'Ожидаем фискальный чек',
          }}
        />
      );
    // A repeated order in the cart sheet shows that cart, not a second cart sheet on top.
    const sheetProps: ScreenProps =
      props.screenId === 'M19'
        ? props
        : { ...props, navigate: (next) => (next === 'M09' ? backToCart() : props.navigate(next)) };
    if (props.inSheet) return status(sheetProps);
    const close = () => {
      orderRef.current = null;
      setOrder(null);
      setInitialRating(undefined);
      setRefresh((value) => value + 1);
    };
    return (
      <Modal transparent animationType="none" visible onRequestClose={close}>
        <OrderSheet
          raised
          name={order.phase === 'handed_over' ? 'Завершённый заказ' : 'Статус заказа'}
          onClose={close}
        >
          {(dismiss) => status({ ...props, inSheet: true, goBack: dismiss }, close)}
        </OrderSheet>
      </Modal>
    );
  }
  const notices = (
    <>
      {visibleError && (props.screenId === 'M19' || (!busy && availability.canPay)) ? (
        <View style={s.warning} accessibilityLiveRegion="polite">
          <Body>{localize(visibleError)}</Body>
          <Button secondary title={t('Попробовать снова')} onPress={retry} />
        </View>
      ) : null}
      {resumeNotice && props.screenId !== 'M19' && !busy ? (
        <View testID="checkout-resume-notice" style={s.warning} accessibilityLiveRegion="polite">
          <Body>{resumeNotice}</Body>
        </View>
      ) : null}
    </>
  );
  if (props.screenId !== 'M19')
    return (
      <Cart
        {...props}
        checkout={{
          restaurant: config?.restaurant,
          banner: unavailable.banner,
          notices,
          comment:
            config?.orderCommentEnabled !== false ? (
              <CartOrderComment model={props.model} editable={!busy} />
            ) : undefined,
          footer: cartFooter,
        }}
      />
    );
  return (
    <Page
      props={props}
      title={t('Заказы')}
      contentStyle={ordersPageStyle.content}
      header={<OrdersHeader />}
    >
      {notices}
      {!loaded || (!!error && !visibleError && !historyNeedsRefresh && !history.length) ? (
        <View style={s.loading}>
          <ActivityIndicator color={colors.accent} />
          <Caption>{t('Проверяем ваш заказ')}</Caption>
        </View>
      ) : null}
      {historyNeedsRefresh ? (
        <Button title={t('Показать заказы')} secondary onPress={retry} />
      ) : null}
      {!history.length && loaded && !error ? (
        <OrdersEmpty onMenu={() => props.navigate('M06')} />
      ) : null}
      <CommerceOrderList
        orders={history}
        products={props.model.products}
        ratings={reviews.ratings}
        onOpen={(item) => {
          setInitialRating(undefined);
          setOrder(item);
        }}
        onRate={(item, stars) => {
          setInitialRating(stars);
          setOrder(item);
        }}
      />
    </Page>
  );
}

const s = StyleSheet.create({
  commentUnavailable: { gap: 8, paddingVertical: 4 },
  savedComment: { gap: 4, padding: 14, borderRadius: 16, backgroundColor: colors.surface },
  card: { gap: 12, padding: 18, borderRadius: 22, backgroundColor: colors.surface },
  loading: { padding: 24, alignItems: 'center', gap: 12 },
  warning: { padding: 16, gap: 12, borderRadius: 18, backgroundColor: colors.warningSurface },
  // On the dark payment scene, like its order card (KaspiPaymentState orderCard).
  earlier: {
    width: '100%',
    maxWidth: 360,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginBottom: 12,
    borderRadius: 18,
    backgroundColor: '#0B2255',
  },
  earlierText: { color: '#DCE6FA', fontSize: 14, lineHeight: 20, textAlign: 'center' },
  tightEarlier: { paddingVertical: 8, paddingHorizontal: 12, marginBottom: 6 },
  tightEarlierText: { fontSize: 13, lineHeight: 18 },
});
