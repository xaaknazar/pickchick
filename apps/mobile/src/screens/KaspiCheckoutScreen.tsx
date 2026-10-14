import { t, localize, useLocale } from '../i18n';
import { PRICES_UPDATED } from '../cart-reprice';
import { CatalogChangeNotice } from '../components/CatalogChangeNotice';
import { recoverCommerceRead, historyOrderNeedsWatch } from '../commerce-read-recovery';
import { prepareCheckout } from '../checkout-preflight';
import { KaspiPaymentState } from '../components/KaspiPaymentState';
import {
  CheckoutSheetHeader,
  CheckoutAction,
  UpcomingPayments,
  checkoutStyle,
} from '../components/CheckoutPresentation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Modal, StyleSheet, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import type { CustomerCommerceOrder } from '@pickchick/contracts';
import type { ScreenProps } from '../model';
import { useAccount } from '../useAccount';
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
  maskedPhone,
} from '../commerce-checkout';
import { OrderStatusView } from './OrderStatusScreen';
import { CompletedOrderScreen } from './CompletedOrderScreen';
import { CommerceOrderList } from '../components/OrderHistoryCard';
import { OrdersEmpty, OrdersHeader, ordersPageStyle } from '../components/OrdersTab';
import { publishActiveOrderCount } from '../active-orders';
import { commerceActiveKind } from '../orders-tab';
import { useCommerceFeedback } from '../useCommerceFeedback';
import { checkoutError, paymentReceived, commerceStatus } from '../commerce-presentation';
import { CheckoutDetails } from './CheckoutScreen';
import { CheckoutKeyboardDone } from '../components/CheckoutKeyboard';
import { pendingPaymentKey, parsePendingPayment, type PendingPayment } from '../payment-recovery';
import { OrderSheet, useSheetDismissalLock } from '../components/OrderSheet';
import { PaymentMark } from '../components/PaymentChoice';
import { Body, Button, Caption, Empty, Icon, Page, Row } from '../components/UI';
import { cartTotal, cartLineKey, money } from '../domain';
import { colors, font } from '../theme';

type Quote = ReturnType<typeof CustomerQuoteSchema.parse>;
type Pending = PendingPayment;
const root = '/v1/customer-checkout';

/** One durable create command per customer. Never reissues a bank invoice on reconnect. */
export function KaspiCheckoutScreen(props: ScreenProps) {
  useLocale();
  const { account } = useAccount();
  return <KaspiCheckoutSession {...props} key={account?.customerId ?? 'guest'} />;
}
function KaspiCheckoutSession(props: ScreenProps) {
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
  const cartOnlySignature = cartSignature(props.model.cart, props.model.diningMode);
  const comment = normalizedOrderComment(props.model.orderComment);
  const signature = cartSignature(props.model.cart, props.model.diningMode, comment);
  const signatureRef = useRef(signature);
  signatureRef.current = signature;
  const key = pendingPaymentKey(customerId);
  useSheetDismissalLock(
    restoring ||
      busy ||
      connectionPaused ||
      paidMoment ||
      Boolean(pending.current && !order) ||
      Boolean(order && !paymentReceived(order.phase) && order.phase !== 'failed'),
  );
  const access = auth.withOrderAccess;
  const request = useCallback(
    (path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, signal?: AbortSignal) => {
      if (!customerId || !access) return Promise.reject(new Error('UNAUTHORIZED'));
      return access(customerId, (token) =>
        commerceRequest(`${root}${path}`, method, body, token, signal),
      );
    },
    [customerId, access],
  );
  const accept = useCallback(
    async (value: unknown) => {
      const current = CustomerCommerceOrderSchema.parse(value);
      if (
        ((orderRef.current && !paymentReceived(orderRef.current.phase)) || pending.current) &&
        paymentReceived(current.phase) &&
        !paidSeen.current.has(current.orderId)
      ) {
        paidSeen.current.add(current.orderId);
        setPaidMoment(true);
      }
      // Publish the accepted identity before cart/storage changes can trigger another recovery.
      orderRef.current = current;
      setOrder(current);
      if (pending.current && (paymentReceived(current.phase) || current.phase === 'failed')) {
        // A newer cart or changed modifiers are never cleared by an older payment.
        if (paymentReceived(current.phase) && pending.current.signature === signatureRef.current) {
          props.model.clearCart(
            cart.current.map((line) => ({ id: cartLineKey(line), quantity: line.quantity })),
          );
          props.model.setOrderComment('');
        }
        await AsyncStorage.removeItem(key);
        pending.current = null;
      } else if (pending.current && pending.current.orderId !== current.orderId) {
        pending.current = { ...pending.current, orderId: current.orderId };
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
    setLoaded(false);
    setRestoring(true);
    setError(null);
    setQuote(null);
    setOrder(null);
    const run = async () => {
      const raw = await AsyncStorage.getItem(key);
      const draft = parsePendingPayment(raw);
      if (!active || controller.signal.aborted || lock.current) return;
      pending.current = draft;
      setRestoring(false);
      if (draft) {
        const existing = CustomerCommerceOrderSchema.parse(
          await prepareCheckout(() => recover(draft, controller.signal), controller.signal),
        );
        if (!active || controller.signal.aborted || lock.current) return;
        await acceptRef.current(existing);
        if (props.screenId !== 'M19' || existing.phase !== 'failed') return;
        orderRef.current = null;
        setOrder(null);
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
    return () => {
      active = false;
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
        await acceptRef.current(next);
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
          if (next.phase === 'failed') {
            if (pending.current?.orderId === next.orderId) {
              await AsyncStorage.removeItem(key);
              pending.current = null;
            }
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
    async (discardUnattempted = false) => {
      if (discardUnattempted) {
        // MENU_CHANGED on pay guarantees no bank attempt and a durable local cancellation.
        await AsyncStorage.removeItem(key);
        pending.current = null;
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
  const displayedCartTotal = cartTotal(props.model.cart);
  useEffect(() => {
    if (!orderRef.current) setQuote(null);
  }, [displayedCartTotal]);
  const submit = async () => {
    if (lock.current || !cart.current.length) return;
    const acceptedTotal = quote?.totalMinor ?? cartTotal(cart.current);
    lock.current = true;
    bootstrap.current?.abort();
    const controller = new AbortController();
    preparation.current = controller;
    const deadline = setTimeout(() => controller.abort('timeout'), 60_000);
    setBusy(true);
    setConnectionPaused(false);
    setError(null);
    setPriceNotice('');
    const prepared = <T,>(operation: () => Promise<T>) =>
      prepareCheckout(operation, controller.signal);
    try {
      // Restore the exact previous intent before any new quote/order is created.
      const raw = await AsyncStorage.getItem(key);
      if (raw) {
        const draft = parsePendingPayment(raw)!;
        pending.current = draft;
        await accept(await prepared(() => recover(draft, controller.signal)));
        return;
      }
      const result = await prepared(() => request('/orders', 'GET', undefined, controller.signal));
      const existing = (result as { orders: unknown[] }).orders
        .map((value) => CustomerCommerceOrderSchema.parse(value))
        .find((value) => !paymentReceived(value.phase) && value.phase !== 'failed');
      if (existing) {
        await accept(existing);
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
    setPaymentPaused(false);
    setError(null);
    const controller = new AbortController();
    preparation.current = controller;
    const deadline = setTimeout(() => controller.abort('timeout'), 60_000);
    try {
      await accept(
        await prepareCheckout(
          () => request(`/orders/${order.orderId}/payment`, 'POST', undefined, controller.signal),
          controller.signal,
        ),
      );
    } catch (e) {
      if (e instanceof CustomerSessionError && e.authoritative && e.code === 'MENU_CHANGED')
        await refreshChangedMenu(true);
      else if (controller.signal.aborted) setPaymentPaused(true);
      else setError(e);
    } finally {
      clearTimeout(deadline);
      if (preparation.current === controller) preparation.current = null;
      lock.current = false;
      setBusy(false);
    }
  }, [order, request, accept, refreshChangedMenu]);
  useEffect(() => {
    // Explicit consent is persisted before order creation. Admission can arrive later.
    // Existing pre-consent drafts retain the manual action; no charge on a passive history visit.
    if (
      order?.phase === 'ready_to_pay' &&
      pending.current?.sendInvoice &&
      !busy &&
      !error &&
      !paymentPaused
    )
      void pay();
  }, [order?.phase, busy, error, paymentPaused, pay]);
  const retry = () => {
    setError(null);
    setRefresh((c) => c + 1);
  };
  const total = quote ? quote.totalMinor : cartTotal(props.model.cart);
  // Keep the failure itself for payment/recovery guards; transient failures have no UI copy.
  const visibleError = error ? checkoutError(error) : '';
  const historyNeedsRefresh = !!error && !visibleError && watchRetryDelay(error, 1) === null;
  const unsupportedComment =
    loaded &&
    !!config &&
    config.orderCommentEnabled !== true &&
    !!normalizedOrderComment(props.model.orderComment);
  const footer =
    props.screenId !== 'M19' && props.model.cart.length ? (
      <>
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
          {priceNotice || props.model.catalogUpdateNotice ? (
            <CatalogChangeNotice
              message={priceNotice || props.model.catalogUpdateNotice!}
              totals={props.model.cartChanges}
            />
          ) : null}
        </>
        <Row style={s.total}>
          <Body style={s.totalLabel}>
            {t('Итого')}
            {localize(' ')}
            <Caption>
              · {localize(props.model.cart.reduce((n, line) => n + line.quantity, 0))}
              {t('шт.')}
            </Caption>
          </Body>
          <Body testID="kaspi-checkout-total" style={s.totalAmount}>
            {localize(money(total))}
          </Body>
        </Row>
        <CheckoutAction
          testID="kaspi-checkout-submit"
          title={localize(busy ? 'Готовим счёт…' : 'Оплатить через')}
          kaspi={!busy}
          onPress={() => void submit()}
          disabled={busy}
        />
      </>
    ) : undefined;
  if ((busy || connectionPaused || pending.current) && !order)
    return (
      <KaspiPaymentState
        canReturnToCheckout={!pending.current}
        onContinue={() => {}}
        onRetry={() => {}}
        onCart={() => {
          if (pending.current) return;
          preparation.current?.abort('user');
          setConnectionPaused(false);
        }}
        extraAction={
          connectionPaused || (error && pending.current) ? (
            <Button
              title={t('Проверить оплату')}
              onPress={() => (pending.current ? retry() : void submit())}
            />
          ) : undefined
        }
      />
    );
  if (order && (!paymentReceived(order.phase) || paidMoment))
    return (
      <KaspiPaymentState
        order={order}
        paid={paidMoment && paymentReceived(order.phase)}
        onContinue={() => setPaidMoment(false)}
        onCart={() => props.navigate('M09')}
        onRetry={() => {
          if (order.phase !== 'failed') return;
          orderRef.current = null;
          setOrder(null);
          setQuote(null);
          setError(null);
          setLoaded(false);
          setRefresh((c) => c + 1);
        }}
        extraAction={
          order.phase === 'ready_to_pay' &&
          (!pending.current?.sendInvoice || paymentPaused || !!error) ? (
            <Button
              title={localize(t('Отправить счёт на {p0}', { p0: money(order.totalMinor) }))}
              onPress={() => void pay()}
              disabled={busy}
            />
          ) : undefined
        }
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
    if (props.inSheet) return status(props);
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
  return (
    <Page
      props={props}
      title={localize(props.screenId === 'M19' ? 'Заказы' : 'Оформление')}
      contentStyle={props.screenId === 'M19' ? ordersPageStyle.content : checkoutStyle.content}
      footerStyle={checkoutStyle.footer}
      footer={footer}
      keyboardFooter={props.screenId === 'M12' ? <CheckoutKeyboardDone /> : undefined}
      header={
        props.screenId === 'M19' ? (
          <OrdersHeader />
        ) : (
          <CheckoutSheetHeader
            title={t('Оформление')}
            testID="checkout-close"
            onBack={props.goBack}
            action={
              !loaded ? (
                <ActivityIndicator
                  color={colors.accent}
                  accessibilityLabel={t('Проверяем ваш заказ')}
                />
              ) : undefined
            }
            back
          />
        )
      }
    >
      {visibleError && (props.screenId === 'M19' || !busy) ? (
        <View style={s.warning} accessibilityLiveRegion="polite">
          <Body>{localize(visibleError)}</Body>
          <Button secondary title={t('Попробовать снова')} onPress={retry} />
        </View>
      ) : null}
      {props.screenId === 'M19' &&
      (!loaded || (!!error && !visibleError && !historyNeedsRefresh && !history.length)) ? (
        <View style={s.loading}>
          <ActivityIndicator color={colors.accent} />
          <Caption>{t('Проверяем ваш заказ')}</Caption>
        </View>
      ) : null}
      {props.screenId === 'M19' && historyNeedsRefresh ? (
        <Button title={t('Показать заказы')} secondary onPress={retry} />
      ) : null}
      {props.screenId === 'M19' ? (
        <>
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
        </>
      ) : props.model.cart.length ? (
        <CheckoutDetails
          props={props}
          commentEnabled={config?.orderCommentEnabled !== false}
          commentEditable={!busy}
          restaurantName={config?.restaurant}
          details={
            quote && quote.totalMinor !== cartTotal(props.model.cart) ? (
              <Caption>
                {t('Сумма обновлена по меню ресторана. Проверьте её перед оплатой.')}
              </Caption>
            ) : undefined
          }
          paymentContent={
            <>
              <View style={checkoutStyle.paymentPanel}>
                <Row style={{ minHeight: 64, padding: 14, gap: 12 }}>
                  <PaymentMark method="kaspi" size={36} />
                  <View style={s.flex}>
                    <Body style={{ fontFamily: font.medium, fontSize: 15 }}>Kaspi.kz</Body>
                    <Caption style={{ fontSize: 12, lineHeight: 18 }}>
                      {t('Счёт придёт на')}
                      {localize(maskedPhone(auth.account?.phone))}
                    </Caption>
                  </View>
                  <Icon name="checkmark-circle" color={colors.accent} size={22} />
                </Row>
                <UpcomingPayments />
              </View>
              <Caption style={{ fontSize: 12, lineHeight: 18, marginHorizontal: 8 }}>
                {t('Фискальный чек пока не выпускается - Webkassa подключается.')}
              </Caption>
            </>
          }
        />
      ) : (
        <Empty
          title={t('В корзине пока пусто')}
          detail={t('Выберите любимые блюда.')}
          action={<Button title={t('В меню')} onPress={() => props.navigate('M06')} />}
        />
      )}
    </Page>
  );
}

const s = StyleSheet.create({
  commentUnavailable: { gap: 8, paddingVertical: 4 },
  savedComment: { gap: 4, padding: 14, borderRadius: 16, backgroundColor: colors.surface },
  total: { justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, paddingVertical: 4 },
  totalLabel: { fontFamily: font.heading, fontSize: 20, lineHeight: 28 },
  totalAmount: { fontFamily: font.heading, fontSize: 24, lineHeight: 34 },
  flex: { flex: 1, minWidth: 0, gap: 3 },
  card: { gap: 12, padding: 18, borderRadius: 22, backgroundColor: colors.surface },
  loading: { padding: 24, alignItems: 'center', gap: 12 },
  warning: { padding: 16, gap: 12, borderRadius: 18, backgroundColor: colors.warningSurface },
});
