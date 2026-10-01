import { unavailableCartLine } from '../availability';
import { KaspiPaymentState } from '../components/KaspiPaymentState';
import {
  CheckoutSheetHeader,
  CheckoutAction,
  UpcomingPayments,
  checkoutStyle,
} from '../components/CheckoutPresentation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Modal, StyleSheet, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import type { CustomerCommerceOrder } from '@pickchick/contracts';
import type { ScreenProps } from '../model';
import { useAccount } from '../useAccount';
import { CustomerSessionError } from '../customer-session';
import { watchCommerceOrder } from '../commerce-watch';
import {
  commerceRequest,
  CustomerCommerceOrderSchema,
  CustomerCheckoutConfigSchema,
  CustomerQuoteSchema,
  checkoutItems,
  cartSignature,
  maskedPhone,
} from '../commerce-checkout';
import { OrderStatusView } from './OrderStatusScreen';
import {
  checkoutError,
  paymentCopy,
  paymentReceived,
  commerceStatus,
} from '../commerce-presentation';
import { CheckoutDetails } from './CheckoutScreen';
import { OrderHeader } from '../components/OrderPresentation';
import { OrderSheet } from '../components/OrderSheet';
import { PaymentMark } from '../components/PaymentChoice';
import { Body, Button, Caption, Empty, Heading, Icon, Page, Row } from '../components/UI';
import { MotionPressable } from '../components/Motion';
import { cartTotal, cartLineKey, money } from '../domain';
import { colors, font } from '../theme';

type Quote = ReturnType<typeof CustomerQuoteSchema.parse>;
type Pending = {
  key: string;
  quoteId: string;
  signature: string;
  orderId?: string;
  sendInvoice?: boolean;
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
  const [quote, setQuote] = useState<Quote | null>(null);
  const [order, setOrder] = useState<CustomerCommerceOrder | null>(null);
  const [history, setHistory] = useState<CustomerCommerceOrder[]>([]);
  const [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [paidMoment, setPaidMoment] = useState(false);
  const paidSeen = useRef(new Set<string>());
  const [watchCycle, setWatchCycle] = useState(0);
  const [watchError, setWatchError] = useState('');
  const orderRef = useRef<CustomerCommerceOrder | null>(null);
  const [refresh, setRefresh] = useState(0),
    [foreground, setForeground] = useState(AppState.currentState !== 'background');
  const pending = useRef<Pending | null>(null),
    lock = useRef(false);
  const cart = useRef(props.model.cart);
  cart.current = props.model.cart;
  const signature = cartSignature(props.model.cart, props.model.diningMode);
  const signatureRef = useRef(signature);
  signatureRef.current = signature;
  const key = `pickchick.commerce.pending.v1:${customerId}`;
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
        if (paymentReceived(current.phase) && pending.current.signature === signatureRef.current)
          props.model.clearCart(
            cart.current.map((line) => ({ id: cartLineKey(line), quantity: line.quantity })),
          );
        await AsyncStorage.removeItem(key);
        pending.current = null;
      }
      setOrder(current);
      return current;
    },
    [key, props.model.clearCart],
  );
  const recover = useCallback(
    async (draft: Pending) => {
      try {
        return await request('/orders', 'POST', { key: draft.key, quoteId: draft.quoteId });
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
    if (orderRef.current && props.screenId !== 'M19') return;
    let active = true;
    setLoaded(false);
    setError('');
    setQuote(null);
    setOrder(null);
    const run = async () => {
      const raw = await AsyncStorage.getItem(key);
      let draft: Pending | null = null;
      if (raw) {
        const parsed = JSON.parse(raw) as Pending;
        if (
          !/^[a-f0-9-]{36}$/.test(parsed.key) ||
          !/^[a-f0-9-]{36}$/.test(parsed.quoteId) ||
          typeof parsed.signature !== 'string'
        )
          throw new Error('INVALID_PENDING');
        draft = parsed;
      }
      if (!active) return;
      pending.current = draft;
      if (draft) {
        const existing = CustomerCommerceOrderSchema.parse(await recover(draft));
        if (!active) return;
        await acceptRef.current(existing);
        if (props.screenId !== 'M19' || existing.phase !== 'failed') return;
        orderRef.current = null;
        setOrder(null);
      }
      const result = await request('/orders');
      const orders = (result as { orders: unknown[] }).orders.map((v) =>
        CustomerCommerceOrderSchema.parse(v),
      );
      if (!active) return;
      setHistory(orders);
      if (props.screenId === 'M19') return;
      const unfinished = orders.find((o) => !paymentReceived(o.phase) && o.phase !== 'failed');
      if (unfinished) {
        setOrder(unfinished);
        return;
      }
      const setup = CustomerCheckoutConfigSchema.parse(await request('/config'));
      if (!active) return;
      setConfig(setup);
      if (!setup.enabled) throw new Error('NOT_READY');
      if (!cart.current.length) return;
      const currentSignature = signatureRef.current;
      const priced = CustomerQuoteSchema.parse(
        await request('/quotes', 'POST', {
          key: randomUUID(),
          branchId: setup.branchId,
          serviceMode: props.model.diningMode,
          items: checkoutItems(cart.current),
        }),
      );
      if (active && currentSignature === signatureRef.current) setQuote(priced);
    };
    void run()
      .catch((e) => {
        if (active) setError(checkoutError(e));
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [
    request,
    recover,
    key,
    refresh,
    props.screenId,
    props.model.branch?.id,
    signature,
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
      onError: (cause, reconnecting) =>
        setWatchError(
          reconnecting
            ? 'Связь прервалась. Восстанавливаем статус заказа автоматически.'
            : checkoutError(cause),
        ),
      onRecovered: () => setWatchError(''),
    });
    return () => controller.abort();
  }, [request, order?.orderId, order?.revision, order?.phase, foreground, watchCycle]);
  useEffect(() => {
    if (props.screenId !== 'M19' || order || !foreground) return;
    const controller = new AbortController();
    for (const item of history.filter(
      (entry) => !paymentReceived(entry.phase) && !['failed', 'attention'].includes(entry.phase),
    )) {
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
  const submit = async () => {
    if (
      lock.current ||
      !quote ||
      quote.serviceMode !== props.model.diningMode ||
      Date.parse(quote.expiresAt) <= Date.now()
    ) {
      if (quote) setError('Цена требует обновления. Нажмите «Проверить соединение».');
      return;
    }
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const draft: Pending = {
        key: randomUUID(),
        quoteId: quote.quoteId,
        signature,
        sendInvoice: true,
      };
      // If storage fails, no order and no payment is submitted.
      await AsyncStorage.setItem(key, JSON.stringify(draft)).catch(() => {
        throw new Error('CHECKOUT_STORAGE');
      });
      pending.current = draft;
      await accept(await recover(draft));
    } catch (e) {
      setError(checkoutError(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const pay = useCallback(async () => {
    if (lock.current || !order) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await accept(await request(`/orders/${order.orderId}/payment`, 'POST'));
    } catch (e) {
      setError(checkoutError(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }, [order, request, accept]);
  useEffect(() => {
    // Explicit consent is persisted before order creation. Admission can arrive later.
    // Existing pre-consent drafts retain the manual action; no charge on a passive history visit.
    if (order?.phase === 'ready_to_pay' && pending.current?.sendInvoice && !busy && !error)
      void pay();
  }, [order?.phase, busy, error, pay]);
  const retry = () => {
    setError('');
    setWatchError('');
    if (order) setWatchCycle((c) => c + 1);
    else setRefresh((c) => c + 1);
  };
  const total = quote ? quote.totalMinor : cartTotal(props.model.cart);
  const availabilityError = props.model.cart.some((line) => !!unavailableCartLine(line))
    ? 'Некоторые позиции закончились. Вернитесь в корзину, чтобы заменить их.'
    : props.model.availabilityFresh === false
      ? 'Проверяем наличие в ресторане. Оплата станет доступна после подключения.'
      : '';
  const statusError = error || watchError;
  const footer =
    props.screenId !== 'M19' && props.model.cart.length ? (
      <>
        <>
          {availabilityError ? (
            <Caption accessibilityRole="alert">{availabilityError}</Caption>
          ) : null}
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
          title={busy ? 'Готовим счёт…' : 'Оплатить через'}
          kaspi={!busy}
          onPress={() => void submit()}
          disabled={
            props.model.cart.some((line) => !!unavailableCartLine(line)) ||
            props.model.availabilityFresh === false ||
            !loaded ||
            !quote ||
            quote.serviceMode !== props.model.diningMode ||
            busy ||
            !!error
          }
        />
      </>
    ) : undefined;
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
          order.phase === 'ready_to_pay' && !pending.current?.sendInvoice ? (
            <Button
              title={`Отправить счёт на ${money(order.totalMinor)}`}
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
    const status = (statusProps: ScreenProps) => (
      <OrderStatusView
        props={statusProps}
        order={commerceStatus(order)}
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
      setRefresh((value) => value + 1);
    };
    return (
      <Modal transparent animationType="none" visible onRequestClose={close}>
        <OrderSheet raised name="Статус заказа" onClose={close}>
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
      {error ? (
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
              detail="Здесь появятся ваши заказы с оплатой Kaspi."
              action={<Button title="Выбрать блюда" onPress={() => props.navigate('M06')} />}
            />
          ) : null}
          {history.map((item) => (
            <MotionPressable
              key={item.orderId}
              accessibilityRole="button"
              accessibilityLabel={`Открыть заказ ${item.displayNumber ?? ''}`}
              style={s.card}
              onPress={() => setOrder(item)}
            >
              <Row>
                <Heading small>
                  {item.displayNumber ? `№ ${item.displayNumber}` : 'Заказ PickChick'}
                </Heading>
                <Body>{money(item.totalMinor)}</Body>
              </Row>
              <Body>{paymentCopy[item.phase].title}</Body>
              <Caption>{item.items.map((p) => p.title).join(', ')}</Caption>
            </MotionPressable>
          ))}
        </>
      ) : props.model.cart.length ? (
        <CheckoutDetails
          props={props}
          restaurantName={config?.restaurant}
          details={
            quote && quote.totalMinor !== cartTotal(props.model.cart) ? (
              <Caption>Сумма обновлена по меню ресторана. Проверьте её перед оплатой.</Caption>
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
                      Счёт придёт на {maskedPhone(auth.account?.phone)}
                    </Caption>
                  </View>
                  <Icon name="checkmark-circle" color={colors.accent} size={22} />
                </Row>
                <UpcomingPayments />
              </View>
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
  total: { justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, paddingVertical: 4 },
  totalLabel: { fontFamily: font.heading, fontSize: 20, lineHeight: 28 },
  totalAmount: { fontFamily: font.heading, fontSize: 24, lineHeight: 34 },
  flex: { flex: 1, minWidth: 0, gap: 3 },
  card: { gap: 12, padding: 18, borderRadius: 22, backgroundColor: colors.surface },
  loading: { padding: 24, alignItems: 'center', gap: 12 },
  warning: { padding: 16, gap: 12, borderRadius: 18, backgroundColor: colors.warningSurface },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
});
