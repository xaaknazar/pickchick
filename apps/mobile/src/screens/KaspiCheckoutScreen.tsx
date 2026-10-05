import {
  recoverCommerceRead,
  historyOrderNeedsWatch,
  checkoutReadError,
} from '../commerce-read-recovery';
import { prepareCheckout } from '../checkout-preflight';
import { TestPaymentState } from '../components/TestPaymentState';
import { KaspiPaymentState } from '../components/KaspiPaymentState';
import {
  CheckoutSheetHeader,
  CheckoutAction,
  checkoutStyle,
} from '../components/CheckoutPresentation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Modal,
  Platform,
  StyleSheet,
  View,
} from 'react-native';
import * as ExpoLinking from 'expo-linking';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import type { CustomerCommerceOrder, CustomerTestPayment } from '@pickchick/contracts';
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
  parseHostedPayment,
  parseHostedTestPayment,
  CustomerTestPaymentSchema,
} from '../commerce-checkout';
import { OrderStatusView } from './OrderStatusScreen';
import { CompletedOrderScreen } from './CompletedOrderScreen';
import { OrderHistoryCard } from '../components/OrderHistoryCard';
import { useCommerceFeedback } from '../useCommerceFeedback';
import { checkoutError, paymentReceived, commerceStatus } from '../commerce-presentation';
import { CheckoutDetails } from './CheckoutScreen';
import { CheckoutKeyboardDone } from '../components/CheckoutKeyboard';
import { OrderHeader } from '../components/OrderPresentation';
import { OrderSheet } from '../components/OrderSheet';
import { availablePaymentMethods, type CommercePaymentMethod } from '../payment-methods';
import { PaymentChoice, paymentName } from '../components/PaymentChoice';
import { Body, Button, Caption, Empty, Icon, Page, Row } from '../components/UI';
import { cartTotal, cartLineKey, money } from '../domain';
import { colors, font } from '../theme';

type Quote = ReturnType<typeof CustomerQuoteSchema.parse>;
type Pending = {
  key: string;
  quoteId: string;
  signature: string;
  orderId?: string;
  sendInvoice?: boolean;
  paymentMethod?: CommercePaymentMethod;
};
const root = '/v1/customer-checkout';

/** One durable create command per customer. Never reissues a bank invoice on reconnect. */
export function KaspiCheckoutScreen(props: ScreenProps) {
  const { account } = useAccount();
  return <KaspiCheckoutSession {...props} key={account?.customerId ?? 'guest'} />;
}
function KaspiCheckoutSession(props: ScreenProps) {
  const auth = useAccount(),
    customerId = auth.account?.customerId;
  const [config, setConfig] = useState<ReturnType<
    typeof CustomerCheckoutConfigSchema.parse
  > | null>(null);
  const [selectedMethod, setSelectedMethod] = useState<CommercePaymentMethod>('kaspi');
  const methods = availablePaymentMethods(config?.paymentMethods, Platform.OS);
  useEffect(() => {
    if (config && !methods.includes(selectedMethod)) setSelectedMethod(methods[0] ?? 'kaspi');
  }, [config, selectedMethod]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [testPayment, setTestPayment] = useState<CustomerTestPayment | null>(null);
  const [testError, setTestError] = useState('');
  const [testCycle, setTestCycle] = useState(0);
  const [order, setOrder] = useState<CustomerCommerceOrder | null>(null);
  const [history, setHistory] = useState<CustomerCommerceOrder[]>([]);
  const [initialRating, setInitialRating] = useState<number | undefined>();
  const [receiptError, setReceiptError] = useState<string | null>(null);
  useEffect(() => setReceiptError(null), [order?.orderId]);
  const reviews = useCommerceFeedback(order, props.screenId === 'M19');
  const [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [connectionPaused, setConnectionPaused] = useState(false);
  const [paymentPaused, setPaymentPaused] = useState(false);
  const preparation = useRef<AbortController | null>(null);
  const bootstrap = useRef<AbortController | null>(null);
  useEffect(() => () => preparation.current?.abort(), []);
  const [paidMoment, setPaidMoment] = useState(false);
  const paidSeen = useRef(new Set<string>());
  const [watchCycle, setWatchCycle] = useState(0);
  const [watchError, setWatchError] = useState('');
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
  const key = `pickchick.commerce.pending.v1:${customerId}`;
  const testKey = `pickchick.commerce.test-payment.v1:${customerId}`;
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
  const acceptTest = useCallback(
    async (value: unknown) => {
      const payment = CustomerTestPaymentSchema.parse(value);
      const safe = { ...payment };
      delete safe.checkoutUrl;
      await AsyncStorage.setItem(testKey, JSON.stringify({ id: payment.id }));
      setTestPayment(safe);
      setSelectedMethod(payment.method);
      return payment;
    },
    [testKey],
  );
  const testPaymentRef = useRef(testPayment);
  testPaymentRef.current = testPayment;
  const restoreTest = useCallback(
    async (signal?: AbortSignal, read?: (path: string) => Promise<unknown>) => {
      const raw = await AsyncStorage.getItem(testKey);
      if (!raw) return false;
      const saved = JSON.parse(raw) as { id?: string; quoteId?: string; method?: string };
      if (saved.id && /^[a-f0-9-]{36}$/.test(saved.id)) {
        await acceptTest(
          await (read
            ? read(`/test-payments/${saved.id}`)
            : request(`/test-payments/${saved.id}`, 'GET', undefined, signal)),
        );
      } else if (
        saved.quoteId &&
        /^[a-f0-9-]{36}$/.test(saved.quoteId) &&
        ['card', 'apple_pay', 'google_pay'].includes(saved.method ?? '')
      ) {
        await acceptTest(
          await request(
            '/test-payments',
            'POST',
            { quoteId: saved.quoteId, method: saved.method },
            signal,
          ),
        );
      } else throw new Error('INVALID_PENDING');
      return true;
    },
    [testKey, acceptTest, request],
  );
  const accept = useCallback(
    async (value: unknown) => {
      const current = CustomerCommerceOrderSchema.parse(value);
      if (
        orderRef.current &&
        !paymentReceived(orderRef.current.phase) &&
        paymentReceived(current.phase) &&
        !paidSeen.current.has(current.orderId)
      ) {
        paidSeen.current.add(current.orderId);
        setPaidMoment(true);
      }
      // Publish the accepted identity before cart/storage changes can trigger another recovery.
      orderRef.current = current;
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
      }
      setSelectedMethod(current.paymentMethod ?? pending.current?.paymentMethod ?? 'kaspi');
      setOrder(current);
      return current;
    },
    [key, props.model.clearCart],
  );
  const recover = useCallback(
    async (draft: Pending, signal?: AbortSignal) => {
      try {
        return await request('/orders', 'POST', { key: draft.key, quoteId: draft.quoteId }, signal);
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
    if ((orderRef.current || testPaymentRef.current) && props.screenId !== 'M19') return;
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
                  setError(
                    'Ресторан пока не готов принимать заказы. Корзина сохранена - проверяем доступность автоматически.',
                  );
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
            setError(checkoutReadError(cause, props.screenId === 'M19'));
            setLoaded(true);
          }
        },
        onRecovered: () => {
          if (active) setError('');
        },
      });
    setLoaded(false);
    setError('');
    setQuote(null);
    setOrder(null);
    let recoveringCommand = false;
    const draftCommandError = (cause: unknown) =>
      recoveringCommand ? checkoutError(cause) : checkoutReadError(cause, props.screenId === 'M19');
    const run = async () => {
      if (props.screenId !== 'M19' && (await restoreTest(controller.signal))) return;
      const raw = await AsyncStorage.getItem(key);
      let draft: Pending | null = null;
      if (raw) {
        const parsed = JSON.parse(raw) as Pending;
        if (
          !/^[a-f0-9-]{36}$/.test(parsed.key) ||
          !/^[a-f0-9-]{36}$/.test(parsed.quoteId) ||
          typeof parsed.signature !== 'string' ||
          (parsed.paymentMethod !== undefined &&
            !['kaspi', 'card', 'apple_pay', 'google_pay'].includes(parsed.paymentMethod))
        )
          throw new Error('INVALID_PENDING');
        draft = parsed;
      }
      if (!active || controller.signal.aborted || lock.current) return;
      pending.current = draft;
      if (draft) {
        recoveringCommand = true;
        const existing = CustomerCommerceOrderSchema.parse(await recover(draft));
        recoveringCommand = false;
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
        if (active && !controller.signal.aborted && props.screenId === 'M19')
          setError(draftCommandError(e));
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    request,
    recover,
    restoreTest,
    key,
    refresh,
    props.screenId,
    props.model.branch?.id,
    cartOnlySignature,
    props.model.diningMode,
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
      onError: (cause, reconnecting) => setWatchError(reconnecting ? '' : checkoutError(cause)),
      onRecovered: () => setWatchError(''),
    });
    return () => controller.abort();
  }, [request, order?.orderId, order?.revision, order?.phase, foreground, watchCycle]);
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
        onError: (_cause, reconnecting) =>
          setWatchError(
            reconnecting
              ? 'Обновляем статусы заказов после восстановления связи.'
              : 'Не удалось обновить статусы заказов.',
          ),
        onRecovered: () => setWatchError(''),
      });
    }
    return () => controller.abort();
  }, [props.screenId, order, foreground, history, request, key]);

  useEffect(() => {
    if (!paidMoment || !foreground) return;
    const timer = setTimeout(() => setPaidMoment(false), 2000);
    return () => clearTimeout(timer);
  }, [paidMoment, foreground]);
  useEffect(() => {
    if (!testPayment || testPayment.state !== 'pending' || !foreground) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const poll = async () => {
      let delay = 2000;
      try {
        await acceptTest(
          await request(`/test-payments/${testPayment.id}`, 'GET', undefined, controller.signal),
        );
        if (!controller.signal.aborted) setTestError('');
        failures = 0;
      } catch (cause) {
        if (!controller.signal.aborted)
          setTestError(
            'Не удалось проверить тестовую оплату. Проверьте соединение или войдите снова.',
          );
        const retryDelay = watchRetryDelay(cause, ++failures);
        if (retryDelay === null) return;
        delay = Math.min(retryDelay, 5000);
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [testPayment?.id, testPayment?.state, foreground, testCycle, request, acceptTest]);
  const submit = async () => {
    if (lock.current || !cart.current.length) return;
    lock.current = true;
    bootstrap.current?.abort();
    const controller = new AbortController();
    preparation.current = controller;
    const deadline = setTimeout(() => controller.abort('timeout'), 60_000);
    setBusy(true);
    setConnectionPaused(false);
    setError('');
    setPriceNotice('');
    const prepared = <T,>(operation: () => Promise<T>) =>
      prepareCheckout(operation, controller.signal);
    try {
      // Restore the exact previous intent before any new quote/order is created.
      if (await prepared(() => restoreTest(controller.signal))) return;
      const raw = await AsyncStorage.getItem(key);
      if (raw) {
        const draft = JSON.parse(raw) as Pending;
        if (
          !/^[a-f0-9-]{36}$/.test(draft.key) ||
          !/^[a-f0-9-]{36}$/.test(draft.quoteId) ||
          typeof draft.signature !== 'string' ||
          (draft.paymentMethod !== undefined &&
            !['kaspi', 'card', 'apple_pay', 'google_pay'].includes(draft.paymentMethod))
        )
          throw new Error('INVALID_PENDING');
        pending.current = draft;
        await accept(await prepared(() => recover(draft, controller.signal)));
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
      if (!availablePaymentMethods(setup.paymentMethods, Platform.OS).includes(selectedMethod)) {
        setError('Способ оплаты сейчас недоступен. Выберите другой способ.');
        return;
      }
      if (!setup.orderCommentEnabled && comment) {
        setError('Комментарий временно недоступен. Удалите его, чтобы оформить заказ.');
        return;
      }
      if (!(setup.paymentEnvironment === 'test' && selectedMethod !== 'kaspi')) {
        const result = await prepared(() =>
          request('/orders', 'GET', undefined, controller.signal),
        );
        const existing = (result as { orders: unknown[] }).orders
          .map((value) => CustomerCommerceOrderSchema.parse(value))
          .find((value) => !paymentReceived(value.phase) && value.phase !== 'failed');
        if (existing) {
          await accept(existing);
          return;
        }
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
      const displayedTotal = quote?.totalMinor ?? cartTotal(cart.current);
      setQuote(currentQuote);
      if (String(currentQuote.totalMinor) !== String(displayedTotal)) {
        setPriceNotice('Сумма заказа изменилась. Проверьте её и нажмите оплату ещё раз.');
        return;
      }
      if (setup.paymentEnvironment === 'test' && selectedMethod !== 'kaspi') {
        const intent = { quoteId: currentQuote.quoteId, method: selectedMethod };
        await AsyncStorage.setItem(testKey, JSON.stringify(intent));
        const payment = await acceptTest(
          await prepared(() => request('/test-payments', 'POST', intent, controller.signal)),
        );
        if (payment.state === 'pending' && payment.checkoutUrl) {
          const hosted = parseHostedTestPayment(payment, currentQuote.quoteId);
          if (!controller.signal.aborted)
            await (Platform.OS === 'web' ? Linking : ExpoLinking).openURL(hosted.checkoutUrl!);
        }
        return;
      }
      const draft: Pending = {
        key: randomUUID(),
        quoteId: currentQuote.quoteId,
        signature,
        sendInvoice: true,
        paymentMethod: selectedMethod,
      };
      await AsyncStorage.setItem(key, JSON.stringify(draft)).catch(() => {
        throw new Error('CHECKOUT_STORAGE');
      });
      pending.current = draft;
      await accept(await prepared(() => recover(draft, controller.signal)));
    } catch (e) {
      // Transport failures stay on the connecting scene; only a final actionable outcome returns.
      if (controller.signal.reason === 'timeout') setConnectionPaused(true);
      else if (!controller.signal.aborted)
        setError(
          config?.paymentEnvironment === 'test' && selectedMethod !== 'kaspi'
            ? 'Не удалось подготовить тестовую оплату. Корзина сохранена - проверьте соединение.'
            : checkoutError(e),
        );
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
    setError('');
    const controller = new AbortController();
    preparation.current = controller;
    const deadline = setTimeout(() => controller.abort('timeout'), 60_000);
    try {
      const method = pending.current?.paymentMethod ?? order.paymentMethod ?? 'kaspi';
      if (method !== (order.paymentMethod ?? 'kaspi')) {
        await accept(
          await request(
            `/orders/${order.orderId}/payment-method`,
            'POST',
            { method },
            controller.signal,
          ),
        );
      }
      if (method !== 'kaspi') {
        const hosted = parseHostedPayment(
          await request(
            `/orders/${order.orderId}/hosted-payment`,
            'POST',
            undefined,
            controller.signal,
          ),
          order.orderId,
        );
        await accept(
          await request(`/orders/${order.orderId}`, 'GET', undefined, controller.signal),
        );
        if (controller.signal.aborted) return;
        // expo-linking navigates the current web tab; keep checkout mounted while the bank page opens.
        await (Platform.OS === 'web' ? Linking : ExpoLinking).openURL(hosted.checkoutUrl);
        return;
      }
      await accept(
        await prepareCheckout(
          () => request(`/orders/${order.orderId}/payment`, 'POST', undefined, controller.signal),
          controller.signal,
        ),
      );
    } catch (e) {
      if (controller.signal.aborted) setPaymentPaused(true);
      else setError(checkoutError(e));
    } finally {
      clearTimeout(deadline);
      if (preparation.current === controller) preparation.current = null;
      lock.current = false;
      setBusy(false);
    }
  }, [order, request, accept]);
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
    setError('');
    setWatchError('');
    if (order) setWatchCycle((c) => c + 1);
    else setRefresh((c) => c + 1);
  };
  const total = quote ? quote.totalMinor : cartTotal(props.model.cart);
  const statusError = error || watchError;
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
              <Caption>Комментарий временно недоступен. Удалите его, чтобы оформить заказ.</Caption>
              <Button
                secondary
                title="Удалить комментарий"
                onPress={() => props.model.setOrderComment('')}
              />
            </View>
          ) : null}
          {priceNotice ? <Caption accessibilityRole="alert">{priceNotice}</Caption> : null}
        </>
        <Row style={s.total}>
          <Body style={s.totalLabel}>
            Итого{' '}
            <Caption>· {props.model.cart.reduce((n, line) => n + line.quantity, 0)} шт.</Caption>
          </Body>
          <Body testID="kaspi-checkout-total" style={s.totalAmount}>
            {money(total)}
          </Body>
        </Row>
        <CheckoutAction
          testID="kaspi-checkout-submit"
          title={
            busy
              ? 'Готовим оплату…'
              : selectedMethod === 'kaspi'
                ? 'Оплатить через'
                : `Оплатить · ${paymentName(selectedMethod)}`
          }
          kaspi={!busy && selectedMethod === 'kaspi'}
          onPress={() => void submit()}
          disabled={busy}
        />
      </>
    ) : undefined;
  const openTest = async () => {
    if (!testPayment || lock.current) return;
    lock.current = true;
    try {
      const payment = await acceptTest(
        await request('/test-payments', 'POST', {
          quoteId: testPayment.quoteId,
          method: testPayment.method,
        }),
      );
      if (payment.state === 'pending' && payment.checkoutUrl) {
        const hosted = parseHostedTestPayment(payment, testPayment.quoteId);
        await (Platform.OS === 'web' ? Linking : ExpoLinking).openURL(hosted.checkoutUrl!);
      } else if (payment.state === 'pending')
        setTestError('Тестовая страница уже открывалась. Проверяем результат через сервер.');
    } catch {
      setTestError('Не удалось открыть тестовую оплату. Результат проверит сервер.');
    } finally {
      lock.current = false;
    }
  };
  if (
    testPayment ||
    ((busy || connectionPaused) &&
      config?.paymentEnvironment === 'test' &&
      selectedMethod !== 'kaspi')
  )
    return (
      <TestPaymentState
        payment={testPayment}
        error={testError || error}
        onClose={props.goBack}
        onRetry={() => setTestCycle((c) => c + 1)}
        onOpen={testPayment?.state === 'pending' ? () => void openTest() : undefined}
        onFinish={() => {
          void AsyncStorage.removeItem(testKey).then(() => {
            setTestPayment(null);
            setTestError('');
            setRefresh((c) => c + 1);
          });
        }}
      />
    );
  if ((busy || connectionPaused) && !order)
    return (
      <KaspiPaymentState
        onContinue={() => {}}
        onRetry={() => {}}
        onCart={() => {
          preparation.current?.abort('user');
          setConnectionPaused(false);
        }}
        extraAction={
          connectionPaused ? <Button title="Продолжить" onPress={() => void submit()} /> : undefined
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
          setError('');
          setLoaded(false);
          setRefresh((c) => c + 1);
        }}
        extraAction={
          (order.phase === 'ready_to_pay' && (!pending.current?.sendInvoice || paymentPaused)) ||
          (order.phase === 'awaiting_payment' && (order.paymentMethod ?? 'kaspi') !== 'kaspi') ? (
            <Button
              title={
                (pending.current?.paymentMethod ?? order.paymentMethod ?? 'kaspi') === 'kaspi'
                  ? `Отправить счёт на ${money(order.totalMinor)}`
                  : 'Открыть страницу оплаты'
              }
              onPress={() => void pay()}
              disabled={busy}
            />
          ) : undefined
        }
        notice={
          statusError ? (
            <View style={s.warning}>
              <Body>{statusError}</Body>
              <Button secondary title="Проверить соединение" onPress={retry} />
            </View>
          ) : undefined
        }
      />
    );
  if (order && paymentReceived(order.phase)) {
    const status = (statusProps: ScreenProps) =>
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
          afterItems={
            order.kitchenComment ? (
              <View testID="order-kitchen-comment" style={s.savedComment}>
                <Caption>Комментарий к заказу</Caption>
                <Body>{order.kitchenComment}</Body>
              </View>
            ) : undefined
          }
          notice={
            statusError ? (
              <View style={s.warning}>
                <Body>{statusError}</Body>
                <Button secondary title="Проверить соединение" onPress={retry} />
              </View>
            ) : undefined
          }
          receipt={
            <View style={s.note}>
              <Icon name="receipt-outline" color={colors.muted} />
              <Caption style={s.flex}>
                {order.receipt === 'deferred'
                  ? 'Фискальный чек пока не выпускается - Webkassa подключается.'
                  : order.receipt === 'issued'
                    ? 'Чек выпущен. Ссылка на него уточняется.'
                    : 'Ожидаем фискальный чек'}
              </Caption>
            </View>
          }
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
          {(dismiss) => status({ ...props, inSheet: true, goBack: dismiss })}
        </OrderSheet>
      </Modal>
    );
  }
  return (
    <Page
      props={props}
      title={props.screenId === 'M19' ? 'Заказы' : 'Оформление'}
      contentStyle={checkoutStyle.content}
      footerStyle={checkoutStyle.footer}
      footer={footer}
      keyboardFooter={props.screenId === 'M12' ? <CheckoutKeyboardDone /> : undefined}
      header={
        props.screenId === 'M19' ? (
          <OrderHeader title="Заказы" onClose={props.goBack} testID="kaspi-order-close" />
        ) : (
          <CheckoutSheetHeader
            title="Оформление"
            testID="checkout-close"
            onBack={props.goBack}
            action={
              !loaded ? (
                <ActivityIndicator color={colors.accent} accessibilityLabel="Проверяем ваш заказ" />
              ) : undefined
            }
            back
          />
        )
      }
    >
      {error && (props.screenId === 'M19' || !busy) ? (
        <View style={s.warning} accessibilityLiveRegion="polite">
          <Body>{error}</Body>
          <Button secondary title="Проверить соединение" onPress={retry} />
        </View>
      ) : null}
      {!loaded && props.screenId === 'M19' ? (
        <View style={s.loading}>
          <ActivityIndicator color={colors.accent} />
          <Caption>Проверяем ваш заказ</Caption>
        </View>
      ) : null}
      {props.screenId === 'M19' ? (
        <>
          {watchError ? <Caption accessibilityLiveRegion="polite">{watchError}</Caption> : null}
          {!history.length && loaded && !error ? (
            <Empty
              title="Заказов пока нет"
              detail="Здесь появятся ваши заказы."
              action={<Button title="Выбрать блюда" onPress={() => props.navigate('M06')} />}
            />
          ) : null}
          {history.map((item) => (
            <OrderHistoryCard
              key={item.orderId}
              order={item}
              products={props.model.products}
              savedRating={reviews.ratings[item.orderId]?.rating}
              onOpen={() => {
                setInitialRating(undefined);
                setOrder(item);
              }}
              onRate={
                item.phase === 'handed_over'
                  ? (stars) => {
                      setInitialRating(stars);
                      setOrder(item);
                    }
                  : undefined
              }
            />
          ))}
        </>
      ) : props.model.cart.length ? (
        <CheckoutDetails
          props={props}
          commentEnabled={config?.orderCommentEnabled !== false}
          commentEditable={!busy}
          restaurantName={config?.restaurant}
          details={
            quote && quote.totalMinor !== cartTotal(props.model.cart) ? (
              <Caption>Сумма обновлена по меню ресторана. Проверьте её перед оплатой.</Caption>
            ) : undefined
          }
          paymentContent={
            <>
              {config?.paymentEnvironment === 'test' && selectedMethod !== 'kaspi' ? (
                <Body testID="test-payment-disclaimer">Тестовая оплата - деньги не спишутся</Body>
              ) : null}
              <PaymentChoice
                model={props.model}
                methods={methods}
                selected={selectedMethod}
                onSelect={setSelectedMethod}
                disabled={busy || !config}
              />
              {selectedMethod === 'kaspi' ? (
                <Caption>Счёт придёт на {maskedPhone(auth.account?.phone)}</Caption>
              ) : (
                <Caption>
                  Откроется защищённая платёжная страница. После оплаты вернитесь в PickChick.
                </Caption>
              )}
              <Caption style={{ fontSize: 12, lineHeight: 18, marginHorizontal: 8 }}>
                Фискальный чек пока не выпускается - Webkassa подключается.
              </Caption>
            </>
          }
        />
      ) : (
        <Empty
          title="В корзине пока пусто"
          detail="Выберите любимые блюда."
          action={<Button title="В меню" onPress={() => props.navigate('M06')} />}
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
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
});
