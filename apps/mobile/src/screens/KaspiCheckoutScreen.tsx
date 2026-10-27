import { useCheckoutLegal } from '../components/CheckoutLegal';
import { needsCheckoutConsent } from '../checkout-legal';
import { t, localize, useLocale } from '../i18n';
import { matchesPaidComboCart } from '../loyalty/combo-progress';
import { PRICES_UPDATED } from '../cart-reprice';
import { CatalogChangeNotice } from '../components/CatalogChangeNotice';
import { recoverCommerceRead, historyOrderNeedsWatch } from '../commerce-read-recovery';
import { PAYMENT_COMMAND, paymentRefused, prepareCheckout } from '../checkout-preflight';
import { KaspiPaymentState } from '../components/KaspiPaymentState';
import { CartOrderComment, CartPaymentFooter } from '../components/CartSheet';
import { cartEditSettleMs } from '../cart-payment';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Modal, StyleSheet, View } from 'react-native';
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
import { checkoutError, paymentReceived, commerceStatus } from '../commerce-presentation';
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
  draftCanAutoSend,
  draftIsFinal,
  draftOwns,
  liveBankAction,
  noteBankCommand,
  resumableOrder,
  supportAtOnce,
} from '../checkout-resume';
import { OrderSheet, useSheetDismissalLock } from '../components/OrderSheet';
import { Body, Button, Caption, Page } from '../components/UI';
import { cartTotal, cartLineKey, money } from '../domain';
import { colors } from '../theme';

type Quote = ReturnType<typeof CustomerQuoteSchema.parse>;
type Pending = PendingPayment;
const root = '/v1/customer-checkout';

/**
 * Kaspi build cart (M09), owner 27.10.2026: there is no separate checkout page, the cart pays.
 * A signed-in customer gets the guarded checkout session below; a guest sees the same cart and
 * the pay button opens sign-in, which returns to the cart without sending anything by itself.
 */
export function KaspiCart(props: ScreenProps) {
  useLocale();
  const account = useAccount();
  const router = useRouter();
  if (accountCanAct(account)) return <KaspiCheckoutScreen {...props} />;
  const discount = props.model.comboRewards?.discountMinor ?? '0';
  const total = (BigInt(cartTotal(props.model.cart)) - BigInt(discount)).toString();
  return (
    <Cart
      {...props}
      checkout={{
        comment: <CartOrderComment model={props.model} />,
        footer: (blocked) => (
          <CartPaymentFooter
            totalMinor={total}
            totalText={money(total)}
            busy={false}
            disabled={blocked || !account.ready}
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
    return () => controller.abort();
  }, [request, order?.orderId, order?.revision, order?.phase, foreground]);
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
      setBusy(false);
      setLoaded(true);
    }
  };
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
      } else if (controller.signal.aborted) setPaymentPaused(true);
      else setError(e);
    } finally {
      clearTimeout(deadline);
      if (preparation.current === controller) preparation.current = null;
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
   * Audit 0.2 / 2.0 / 2.4: leave a payment screen without touching the order or the bank. An
   * unbilled order also withdraws its automatic invoice; an order the bank may still charge
   * keeps its intent for recovery at the next app start, but is not pushed back this session.
   */
  const closeOrder = async () => {
    const draft = pending.current;
    const shown = order ?? orderRef.current;
    const current = shown && orderRef.current?.orderId === shown.orderId ? orderRef.current : shown;
    // Only the intent of the closed order (or of a create still in flight) is affected; leaving an
    // older order opened from «Заказы» never touches the intent of another order.
    const own = !!current && draftOwns(draft, current.orderId);
    if (own && !liveBankAction(current, Date.now(), draft.createdAt)) {
      await AsyncStorage.removeItem(key).catch(() => undefined);
      pending.current = null;
    } else if (draft && (own || !current)) dismissPendingPayment(draft.key);
    preparation.current?.abort('user');
    if (props.screenId === 'M19') {
      orderRef.current = null;
      setOrder(null);
      setPaidMoment(false);
      setError(null);
      setRefresh((c) => c + 1);
      return;
    }
    setLeaving(true);
  };
  useEffect(() => {
    // The sheet lock is released in this render; close the sheet afterwards.
    if (leaving) props.goBack?.();
  }, [leaving]);
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
  const cartFooter = (blocked: boolean) => (
    <CartPaymentFooter
      totalMinor={total}
      totalText={money(total)}
      busy={busy}
      disabled={busy || blocked}
      onPay={() => void submit()}
      notices={
        <>
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
      />
    );
  if (order && (!paymentReceived(order.phase) || paidMoment))
    return (
      <KaspiPaymentState
        order={order}
        paid={paidMoment && paymentReceived(order.phase)}
        onContinue={() => setPaidMoment(false)}
        onCart={() => (props.screenId === 'M19' ? props.navigate('M09') : backToCart())}
        onRetry={() => {
          if (order.phase !== 'failed') return;
          backToCart();
        }}
        extraAction={
          order.phase === 'ready_to_pay' && (!autoSends(order) || paymentPaused || !!error) ? (
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
      {visibleError && (props.screenId === 'M19' || !busy) ? (
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
});
