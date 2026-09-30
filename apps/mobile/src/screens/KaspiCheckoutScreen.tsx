import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { Image } from 'expo-image';
import type { CustomerCommerceOrder } from '@pickchick/contracts';
import type { ScreenProps } from '../model';
import { useAccount } from '../useAccount';
import { CustomerSessionError } from '../customer-session';
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
import { OrderHeader, OrderTotal, orderUI } from '../components/OrderPresentation';
import { PaymentMark } from '../components/PaymentChoice';
import {
  Body,
  Button,
  Caption,
  Empty,
  Heading,
  Icon,
  Page,
  Row,
  SummaryRow,
} from '../components/UI';
import { MotionPressable } from '../components/Motion';
import { cartTotal, cartLineKey, money } from '../domain';
import { colors, font } from '../theme';
import { menuPhotos } from '../menu-photo-assets';

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
  const [watchCycle, setWatchCycle] = useState(0);
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
      orderRef.current = current;
      setOrder(current);
      if (pending.current && (paymentReceived(current.phase) || current.phase === 'failed')) {
        // A newer cart or changed modifiers are never cleared by an older payment.
        if (paymentReceived(current.phase) && pending.current.signature === signatureRef.current)
          props.model.clearCart(
            cart.current.map((line) => ({ id: cartLineKey(line), quantity: line.quantity })),
          );
        await AsyncStorage.removeItem(key);
        pending.current = null;
      }
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
        const existing = await recover(draft);
        if (active) await acceptRef.current(existing);
        return;
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
          branchId: props.model.branch?.id,
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
    if (
      error ||
      !order ||
      !foreground ||
      ['failed', 'handed_over', 'attention'].includes(order.phase)
    )
      return;
    let active = true;
    const controller = new AbortController();
    const watch = async () => {
      try {
        const next = await request(
          `/orders/${order.orderId}/watch?after=${order.revision}`,
          'GET',
          undefined,
          controller.signal,
        );
        if (active) {
          setError('');
          await acceptRef.current(next);
        }
      } catch (e) {
        if (active) setError(checkoutError(e));
      }
    };
    // A new long poll starts when the previous one completes, even if unchanged.
    void watch().finally(() => {
      if (active) setWatchCycle((c) => c + 1);
    });
    return () => {
      active = false;
      controller.abort();
    };
    // Errors stop the stream until an explicit retry. No rapid network retry loop.
  }, [request, order?.orderId, order?.revision, foreground, error, watchCycle]);
  const submit = async () => {
    if (lock.current || !quote || Date.parse(quote.expiresAt) <= Date.now()) {
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
    if (order) setWatchCycle((c) => c + 1);
    else setRefresh((c) => c + 1);
  };
  const total = quote ? quote.totalMinor : cartTotal(props.model.cart);
  const footer = order ? (
    <>
      {order.phase === 'ready_to_pay' && !pending.current?.sendInvoice ? (
        <Button
          title={`Отправить счёт на ${money(order.totalMinor)}`}
          onPress={() => void pay()}
          disabled={busy}
          style={orderUI.action}
        />
      ) : null}
      <Button title="В меню" secondary onPress={() => props.navigate('M06')} />
    </>
  ) : props.screenId !== 'M19' && props.model.cart.length ? (
    <>
      <OrderTotal value={money(total)} />
      <Button
        testID="kaspi-checkout-submit"
        title={busy ? 'Готовим счёт…' : `Получить счёт в Kaspi · ${money(total)}`}
        onPress={() => void submit()}
        disabled={!loaded || !quote || busy || !!error}
        style={orderUI.action}
        textStyle={orderUI.actionText}
      />
      <Caption style={s.center}>Списание подтвердите в Kaspi.kz</Caption>
    </>
  ) : undefined;
  if (order && paymentReceived(order.phase))
    return (
      <OrderStatusView
        props={props}
        order={commerceStatus(order)}
        notice={
          error ? (
            <View style={s.warning}>
              <Body>{error}</Body>
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
  return (
    <Page
      props={props}
      title={order ? 'Ваш заказ' : 'Способ оплаты'}
      footer={footer}
      header={
        order || props.screenId === 'M19' ? (
          <OrderHeader
            title={order?.restaurant ?? 'Заказы'}
            onClose={props.goBack}
            testID="kaspi-order-close"
          />
        ) : (
          <OrderHeader title="Способ оплаты" testID="checkout-close" onClose={props.goBack} back />
        )
      }
    >
      {error ? (
        <View style={s.warning} accessibilityLiveRegion="polite">
          <Body>{error}</Body>
          <Button secondary title="Проверить соединение" onPress={retry} />
        </View>
      ) : null}
      {!loaded && !order ? (
        <View style={s.loading}>
          <ActivityIndicator color={colors.accent} />
          <Caption>Проверяем ваш заказ</Caption>
        </View>
      ) : null}
      {order ? (
        <KaspiOrderContent order={order} props={props} phone={auth.account?.phone} />
      ) : props.screenId === 'M19' ? (
        <>
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
            <>
              <SummaryRow label="Блюда" value={money(total)} />
              {quote && quote.totalMinor !== cartTotal(props.model.cart) ? (
                <Caption>
                  Сумма обновлена по меню ресторана. Проверьте её перед продолжением.
                </Caption>
              ) : null}
              <Button title="Изменить заказ" secondary onPress={props.goBack} />
            </>
          }
          paymentContent={
            <View style={s.card}>
              <Heading small>Оплата</Heading>
              <Row>
                <PaymentMark method="kaspi" size={44} />
                <View style={s.flex}>
                  <Body style={s.bold}>Kaspi.kz</Body>
                  <Caption>{maskedPhone(auth.account?.phone)}</Caption>
                </View>
                <Icon name="checkmark-circle" color={colors.accent} />
              </Row>
              <Caption>
                Пришлём счёт на номер вашего аккаунта. После оплаты статус обновится здесь.
              </Caption>
              <View style={s.note}>
                <Icon name="receipt-outline" size={18} color={colors.muted} />
                <Caption style={s.flex}>
                  Фискальный чек пока не выпускается - Webkassa подключается.
                </Caption>
              </View>
            </View>
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

export function KaspiOrderContent({
  order,
  props,
  phone,
}: {
  order: CustomerCommerceOrder;
  props: ScreenProps;
  phone?: string;
}) {
  const copy = paymentCopy[order.phase],
    paid = paymentReceived(order.phase);
  return (
    <>
      <View style={s.hero}>
        <View style={s.mark}>
          {paid ? (
            <Icon name="checkmark" size={36} color={colors.success} />
          ) : (
            <PaymentMark method="kaspi" size={52} />
          )}
        </View>
        {order.displayNumber ? <Body style={s.number}>№ {order.displayNumber}</Body> : null}
        <Heading style={s.title}>{copy.title}</Heading>
        <Caption style={s.center}>{copy.detail}</Caption>
        <Body style={s.amount}>{money(order.totalMinor)}</Body>
        {!paid ? <Caption>{maskedPhone(phone)}</Caption> : null}
      </View>
      <View style={s.steps} accessibilityLabel={`Шаг ${Math.min(copy.step + 1, 3)} из 3`}>
        {['Счёт', 'Оплата', 'Кухня'].map((label, i) => (
          <View key={label} style={s.step}>
            <View style={[s.rail, i <= copy.step && s.railActive]} />
            <Caption style={s.center}>{label}</Caption>
          </View>
        ))}
      </View>
      <View style={s.card}>
        <Row>
          <Heading small>Ваш заказ</Heading>
          <Caption>{order.serviceMode === 'takeaway' ? 'С собой' : 'В зале'}</Caption>
        </Row>
        {order.items.map((item, i) => {
          const product = props.model.products.find((p) => p.id === item.productId);
          return (
            <Row key={`${item.productId}:${i}`} style={s.item}>
              {product ? (
                <Image
                  source={menuPhotos[product.id] ?? product.image}
                  contentFit="contain"
                  style={s.photo}
                />
              ) : (
                <View style={s.photo}>
                  <Icon name="restaurant-outline" color={colors.muted} />
                </View>
              )}
              <View style={s.flex}>
                <Body style={s.bold}>{item.title}</Body>
                {item.modifiers.length ? <Caption>{item.modifiers.join(' · ')}</Caption> : null}
                <Caption>{item.quantity} шт.</Caption>
              </View>
            </Row>
          );
        })}
      </View>
      <View style={s.note}>
        <Icon name="receipt-outline" size={20} color={colors.muted} />
        <View style={s.flex}>
          <Body>Чек</Body>
          <Caption>
            {order.receipt === 'deferred'
              ? 'Webkassa в процессе подключения. Фискальный чек не выпущен.'
              : order.receipt === 'issued'
                ? 'Чек выпущен. Получить его можно в ресторане.'
                : 'Ожидаем фискальный чек.'}
          </Caption>
        </View>
      </View>
    </>
  );
}
const s = StyleSheet.create({
  flex: { flex: 1, minWidth: 0, gap: 4 },
  bold: { fontFamily: font.bold },
  card: { backgroundColor: colors.surface, borderRadius: 22, padding: 18, gap: 16 },
  note: { flexDirection: 'row', gap: 10, paddingTop: 12, alignItems: 'flex-start' },
  warning: { backgroundColor: colors.warningSurface, borderRadius: 18, padding: 16, gap: 12 },
  loading: { padding: 24, gap: 12, alignItems: 'center' },
  hero: { alignItems: 'center', paddingVertical: 20, paddingHorizontal: 8, gap: 12 },
  mark: {
    height: 88,
    width: 88,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 28,
    backgroundColor: colors.surface,
  },
  title: { fontSize: 28, lineHeight: 36, textAlign: 'center', fontFamily: font.heading },
  center: { textAlign: 'center' },
  number: { color: colors.accent, fontFamily: font.bold, fontSize: 20 },
  amount: { fontFamily: font.bold, fontSize: 34, lineHeight: 44, fontVariant: ['tabular-nums'] },
  steps: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  step: { flex: 1, gap: 8 },
  rail: { height: 4, borderRadius: 2, backgroundColor: colors.border },
  railActive: { backgroundColor: colors.accent },
  item: { alignItems: 'flex-start', gap: 12 },
  photo: {
    width: 68,
    height: 68,
    borderRadius: 14,
    backgroundColor: '#FFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
