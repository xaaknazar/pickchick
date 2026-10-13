import { OrderTotal, orderUI } from '../components/OrderPresentation';
import {
  OrdersEmpty,
  OrdersHeader,
  OrdersMoreButton,
  OrdersOverview,
  ordersPageStyle,
  type ActiveOrderModel,
  type HistoryOrderModel,
} from '../components/OrdersTab';
import { latestUnratedOrderId, progressStage, testActiveKind } from '../orders-tab';
import { RepeatOrder } from '../components/RepeatOrder';
import { CheckoutDetails, CheckoutHeader } from './CheckoutScreen';
import { unpaidTestOrdersEnabled } from '../order-simulator';
import { useState } from 'react';
import { Text, TextInput, View, StyleSheet } from 'react-native';
import type { TestOrder } from '@pickchick/test-order-flow/contracts';
import type { ScreenProps } from '../model';
import {
  Body,
  Button,
  Caption,
  Card,
  Empty,
  Heading,
  Icon,
  Loading,
  NavRow,
  Notice,
  Page,
  Row,
  styles as ui,
} from '../components/UI';
import { colors, font } from '../theme';
import { paymentName } from '../components/PaymentChoice';
import { money, cartTotal } from '../domain';
import { cartMatchesOrder } from '../test-order-session';
import { restaurantLocation } from '../restaurant-location';

export { orderStage } from '../order-status';
import { orderScene, orderStage } from '../order-status';
import { OrderStatusScreen } from './OrderStatusScreen';
function ContinueSession({ props }: { props: ScreenProps }) {
  const flow = props.model.testFlow;
  if (!flow.sessionExpired) return null;
  return (
    <Button
      title="Восстановить доступ"
      testID="test-continue-session"
      secondary
      disabled={flow.busy}
      onPress={() => {
        void flow.continueSession();
      }}
    />
  );
}
function FlowNotice({ props }: { props: ScreenProps }) {
  const flow = props.model.testFlow;
  return (
    <>
      <ContinueSession props={props} />
      {flow.recoveryAvailable ? (
        <Button
          title="Восстановить проверку"
          testID="test-recover-pending"
          secondary
          disabled={flow.busy}
          onPress={() => {
            void flow.recoverPending().then((order) => {
              if (order) props.navigate('M20');
            });
          }}
        />
      ) : null}
    </>
  );
}
function OrderLines({ order }: { order: TestOrder }) {
  return (
    <View style={s.section}>
      <Heading small style={orderUI.section}>
        Состав заказа
      </Heading>
      {order.snapshot.lines.map((line) => (
        <View key={'line_id' in line ? line.line_id : line.id} style={s.line}>
          <Row style={{ alignItems: 'flex-start' }}>
            <Body style={[orderUI.label, ui.flex]}>{line.name}</Body>
            <Body style={orderUI.label}>{line.quantity} шт.</Body>
          </Row>
          {'selections' in line && line.selections.length ? (
            <Caption style={orderUI.detail}>
              {line.selections
                .map((s) => s.option_label + (s.quantity > 1 ? ` ×${s.quantity}` : ''))
                .join(' · ')}
            </Caption>
          ) : null}
          <Body style={[orderUI.label, { fontFamily: font.bold }]}>
            {money(line.line_total_minor)}
          </Body>
        </View>
      ))}
      <OrderTotal value={money(order.snapshot.total_minor)} />
    </View>
  );
}

const orderDate = (value: string) =>
  new Date(value).toLocaleString('ru-RU', {
    timeZone: 'Asia/Almaty',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
function StageTrack({ order }: { order: TestOrder }) {
  if (order.state === 'cancelled' || order.state === 'awaiting_test_payment') return null;
  const current =
    order.state === 'fulfilled'
      ? 3
      : order.state === 'ready'
        ? 2
        : orderStage(order) === 'На сборке'
          ? 1
          : 0;
  return (
    <View style={s.section} accessibilityLabel={`Этап заказа: ${orderStage(order)}`}>
      {['Готовим на кухне', 'Собираем заказ', 'Можно забирать', 'Заказ выдан'].map(
        (label, index) => (
          <Row key={label} style={{ minHeight: 36 }}>
            <View style={[s.step, index <= current && { backgroundColor: colors.accent }]}>
              <Icon
                name={
                  index < current || order.state === 'fulfilled'
                    ? 'checkmark'
                    : index === current
                      ? 'ellipse'
                      : 'ellipse-outline'
                }
                size={16}
                color={index <= current ? colors.orangeInk : colors.muted}
              />
            </View>
            <Body
              style={[
                orderUI.label,
                ui.flex,
                {
                  color: index === current ? colors.text : colors.muted,
                  fontFamily: index === current ? font.bold : font.body,
                },
              ]}
            >
              {label}
            </Body>
            {index === current && order.state !== 'fulfilled' ? (
              <Caption style={{ color: colors.accentText }}>Сейчас</Caption>
            ) : null}
          </Row>
        ),
      )}
    </View>
  );
}

export function ConnectedCheckout(props: ScreenProps) {
  const flow = props.model.testFlow;
  const unknown = flow.orders.find((order) => order.payment_state === 'simulated_unknown');
  const matching = flow.orders.find(
    (order) =>
      (order.state === 'awaiting_test_payment' ||
        (unpaidTestOrdersEnabled &&
          order.payment_state === 'not_started' &&
          ['preparing', 'ready'].includes(order.state))) &&
      cartMatchesOrder(order, props.model.cart, props.model.diningMode, props.model.paymentMethod),
  );
  const pending = unknown ?? matching ?? null;
  const branchId = pending?.branch_id ?? props.model.branch?.id;
  const branch = props.model.branches.find((candidate) => candidate.id === branchId);
  const location = restaurantLocation(branchId);
  const submit = async () => {
    if (pending) flow.select(pending.order_id);
    const order = pending ?? (await flow.submit());
    if (order) {
      if (['preparing', 'ready'].includes(order.state)) {
        props.model.clearCart(
          order.snapshot.lines.map((line) => ({
            id: 'line_id' in line ? line.line_id : line.id,
            quantity: line.quantity,
          })),
        );
      }
      props.navigate(
        ['preparing', 'ready'].includes(order.state)
          ? 'M17'
          : order.payment_state === 'simulated_unknown'
            ? 'M14'
            : 'M13',
      );
    }
  };
  return (
    <Page
      props={props}
      title="Оформление"
      header={<CheckoutHeader props={props} />}
      footer={
        <>
          <OrderTotal value={money(pending?.snapshot.total_minor ?? cartTotal(props.model.cart))} />
          <Button
            style={orderUI.action}
            textStyle={orderUI.actionText}
            testID="test-checkout-create"
            title={
              flow.busy
                ? 'Сохраняем заказ…'
                : pending
                  ? `Продолжить ${pending.number}`
                  : unpaidTestOrdersEnabled
                    ? 'Отправить на кухню'
                    : 'Продолжить оформление'
            }
            disabled={flow.busy || (!pending && (!flow.available || props.model.cart.length === 0))}
            onPress={() => {
              void submit();
            }}
          />
        </>
      }
    >
      <CheckoutDetails
        props={props}
        lockedMode={pending?.snapshot.service_mode}
        restaurantName={location?.name ?? branch?.name}
        address={location ? `${location.city}, ${location.address}` : undefined}
        details={pending ? <OrderLines order={pending} /> : undefined}
      />
      <FlowNotice props={props} />
      {!flow.available ? (
        <Button title="Обновить меню" secondary onPress={props.model.refresh} />
      ) : null}
      {unknown ? (
        <Notice warning>
          Прежде чем создавать другой заказ, нужно уточнить результат проверки {unknown.number}.
          Новая корзина остаётся на устройстве.
        </Notice>
      ) : null}
      {unpaidTestOrdersEnabled && !pending ? (
        <Caption>
          Заказ поступит на кухню без списания денег. Статус приготовления появится в приложении.
        </Caption>
      ) : null}
      {flow.current?.state === 'awaiting_test_payment' &&
      flow.current.order_id !== pending?.order_id ? (
        <NavRow
          title={`Ранее созданный ${flow.current.number}`}
          subtitle="Открыть отдельно от этой корзины"
          onPress={() => props.navigate('M20')}
        />
      ) : null}
      {!unpaidTestOrdersEnabled ? <Caption>Деньги не списываются.</Caption> : null}
    </Page>
  );
}

export function ConnectedHistory(props: ScreenProps) {
  const flow = props.model.testFlow;
  const sorted = [...flow.orders].sort(
    (a, b) => b.created_at.localeCompare(a.created_at) || b.order_id.localeCompare(a.order_id),
  );
  const open = (order: TestOrder) => {
    flow.select(order.order_id);
    props.navigate('M20');
  };
  const lines = (order: TestOrder) =>
    order.snapshot.lines.map((line) => ({
      productId: line.id,
      title: line.name,
      quantity: line.quantity,
    }));
  const method = (order: TestOrder) =>
    'payment_method' in order.snapshot ? paymentName(order.snapshot.payment_method) : 'Kaspi';
  const restaurant = (order: TestOrder) =>
    restaurantLocation(order.branch_id)?.name ??
    props.model.branches.find((branch) => branch.id === order.branch_id)?.name ??
    'PickChick';
  const active: ActiveOrderModel[] = sorted.flatMap((order) => {
    const kind = testActiveKind(order.state);
    if (!kind) return [];
    const unknown = order.payment_state === 'simulated_unknown';
    const stage = progressStage(orderStage(order) === 'На сборке' ? 'assembly' : 'cooking');
    return [
      {
        id: order.order_id,
        kind,
        number: order.number,
        scene: orderScene(order),
        badge:
          kind === 'ready'
            ? 'Готов'
            : kind === 'payment'
              ? unknown
                ? 'Уточняем оплату'
                : 'Ждём оплату'
              : stage.badge,
        bars: stage.bars,
        serviceMode: order.snapshot.service_mode,
        items: lines(order),
        totalMinor: order.snapshot.total_minor,
        place: `${restaurant(order)} · ${method(order)}`,
        paymentMethod: method(order),
        paymentNote: unknown ? 'уточняем результат' : 'ждём подтверждения',
        openTestID: `history-order-${order.order_id}`,
        onOpen: () => open(order),
        // Same continuation as opening the order: the payment step lives on M20.
        onPay: kind === 'payment' && !unknown ? () => open(order) : undefined,
        payTestID: `history-order-pay-${order.order_id}`,
      },
    ];
  });
  const finished = sorted.filter((order) => !testActiveKind(order.state));
  // The list has no saved review per order; the newest handed-over order asks for one.
  const rateId = latestUnratedOrderId(
    finished.map((order) => ({
      id: order.order_id,
      createdAt: order.created_at,
      rateable: order.state === 'fulfilled',
      rated: false,
    })),
  );
  const history: HistoryOrderModel[] = finished.map((order) => ({
    id: order.order_id,
    number: order.number,
    createdAt: order.created_at,
    serviceMode: order.snapshot.service_mode,
    items: lines(order),
    totalMinor: order.snapshot.total_minor,
    // Test orders never move money, so a cancellation never claims a refund.
    status: order.state === 'cancelled' ? 'cancelled' : 'done',
    statusText: order.state === 'cancelled' ? 'Отменён' : undefined,
    openTestID: `history-order-${order.order_id}`,
    onOpen: () => open(order),
    repeat:
      order.state === 'fulfilled' ? (
        <RepeatOrder order={order} props={props} variant="link" />
      ) : undefined,
    rate:
      order.order_id === rateId
        ? {
            onRate: () => {
              flow.select(order.order_id);
              props.navigate('M35');
            },
            testID: (stars: number) => `history-order-rate-${order.order_id}-${stars}`,
          }
        : null,
  }));
  return (
    <Page
      props={props}
      title="Заказы"
      noBack
      header={<OrdersHeader />}
      contentStyle={ordersPageStyle.content}
    >
      <FlowNotice props={props} />
      {!flow.restored || (!flow.orders.length && !!flow.error) ? (
        <Loading title="Загружаем заказы" />
      ) : !flow.orders.length ? (
        <OrdersEmpty onMenu={() => props.navigate('M06')} />
      ) : (
        <OrdersOverview
          active={active}
          history={history}
          products={props.model.products}
          footer={
            <>
              {flow.orders.length >= 20 && flow.moreHistory ? (
                <OrdersMoreButton
                  title={flow.historyBusy ? 'Загружаем…' : 'Показать предыдущие заказы'}
                  testID="orders-load-history"
                  disabled={flow.historyBusy}
                  onPress={() => {
                    void flow.loadHistory();
                  }}
                />
              ) : null}
              <OrdersMoreButton title="Обновить заказы" onPress={flow.refresh} />
            </>
          }
        />
      )}
    </Page>
  );
}

export function ConnectedOrder(props: ScreenProps) {
  const flow = props.model.testFlow;
  const order = flow.current;
  const [reason, setReason] = useState('Отмена по просьбе клиента');
  if (!order)
    return (
      <Page props={props} title="Заказ">
        <FlowNotice props={props} />
        {!flow.restored || flow.error ? (
          <Loading title="Загружаем заказ" />
        ) : (
          <Empty
            title="Выберите заказ"
            detail="Здесь появятся статус и состав заказа."
            action={<Button title="Мои заказы" onPress={() => props.navigate('M19')} />}
          />
        )}
      </Page>
    );
  const unknown = order.payment_state === 'simulated_unknown';
  const canPay = order.state === 'awaiting_test_payment' && !unknown;
  const pay = async (outcome: 'approved' | 'declined' | 'unknown') => {
    const next = await flow.pay(outcome);
    if (next) {
      if (next.payment_state === 'simulated_approved')
        props.model.clearCart(
          next.snapshot.lines.map((line) => ({
            id: 'line_id' in line ? line.line_id : line.id,
            quantity: line.quantity,
          })),
        );
      props.navigate(
        next.payment_state === 'simulated_unknown'
          ? 'M14'
          : next.payment_state === 'simulated_declined'
            ? 'M15'
            : 'M17',
      );
    }
  };
  const receipt = props.screenId === 'M21';
  const cancel = props.screenId === 'M22';
  if (!receipt && !cancel && !canPay && !unknown)
    return (
      <OrderStatusScreen props={props} order={order} notice={<ContinueSession props={props} />} />
    );
  return (
    <Page
      props={props}
      title={receipt ? 'Электронный чек' : cancel ? 'Отмена заказа' : `Заказ №${order.number}`}
      footer={
        cancel ? (
          <Button
            testID="test-cancel-order"
            title="Отменить заказ"
            disabled={
              flow.busy ||
              reason.trim().length < 3 ||
              unknown ||
              ['fulfilled', 'cancelled'].includes(order.state)
            }
            onPress={() => {
              void flow.cancel(reason).then((next) => {
                if (next) props.navigate('M20');
              });
            }}
          />
        ) : undefined
      }
    >
      <FlowNotice props={props} />
      <View accessibilityLiveRegion="polite" style={s.status}>
        <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <Heading testID="connected-order-state" style={orderUI.title}>
            {unknown ? 'Уточняем результат' : orderStage(order)}
          </Heading>
          <Text
            testID="connected-order-number"
            accessibilityLabel={`Заказ номер ${order.number}`}
            style={s.number}
          >
            {order.number}
          </Text>
        </Row>
        <Body style={orderUI.label}>
          {unknown
            ? 'Ресторан уточняет результат оплаты.'
            : order.state === 'preparing'
              ? orderStage(order) === 'На сборке'
                ? 'Всё приготовили. Проверяем состав и собираем ваш заказ.'
                : 'Ваши блюда уже на кухне. Здесь появится следующий этап приготовления.'
              : order.state === 'ready'
                ? 'Подходите к стойке выдачи и назовите номер заказа.'
                : order.state === 'fulfilled'
                  ? 'Приятного аппетита! Расскажите, как вам заказ.'
                  : order.state === 'cancelled'
                    ? (order.cancellation_reason ?? 'Заказ отменён.')
                    : 'Подтвердите передачу заказа на кухню без оплаты.'}
        </Body>
      </View>
      <View style={s.section}>
        <Row>
          <Icon name="location-outline" color={colors.muted} />
          <Body style={[orderUI.label, ui.flex]}>
            {restaurantLocation(order.branch_id)?.name ?? 'Ресторан PickChick'}
          </Body>
        </Row>
        <Caption style={orderUI.detail}>
          {order.snapshot.service_mode === 'takeaway' ? 'С собой' : 'В зале'} ·{' '}
          {orderDate(order.created_at)}
        </Caption>
      </View>
      {receipt ? (
        <View style={s.section}>
          <Row>
            <Icon name="receipt-outline" color={colors.accent} />
            <Heading small style={orderUI.section}>
              Официальный чек
            </Heading>
          </Row>
          <Body style={orderUI.label}>Оплата и чеки - в процессе подключения.</Body>
          <Caption style={orderUI.detail}>
            По этому заказу деньги не списывались, фискальный чек не выпускался. Состав заказа ниже
            не является чеком.
          </Caption>
        </View>
      ) : null}
      {canPay && !receipt && !cancel ? (
        <Card>
          <Heading small>
            {'payment_method' in order.snapshot
              ? paymentName(order.snapshot.payment_method)
              : 'Kaspi'}{' '}
            · без списания
          </Heading>
          <Caption>Оплата и чеки - в процессе подключения.</Caption>
          <Button
            testID="test-payment-approve"
            title={
              flow.busy
                ? 'Проверяем…'
                : `Продолжить без оплаты · ${money(order.snapshot.total_minor)}`
            }
            disabled={flow.busy}
            onPress={() => {
              void pay('approved');
            }}
          />
          <Button
            testID="test-payment-unknown"
            title="Уточнить результат"
            secondary
            disabled={flow.busy}
            onPress={() => {
              void pay('unknown');
            }}
          />
          <Button
            title="Отметить отказ"
            secondary
            disabled={flow.busy}
            onPress={() => {
              void pay('declined');
            }}
          />
        </Card>
      ) : null}
      {!receipt && !cancel ? <StageTrack order={order} /> : null}
      <OrderLines order={order} />
      {cancel ? (
        <Card>
          <Heading small>Причина отмены</Heading>
          <TextInput
            testID="test-cancel-reason"
            accessibilityLabel="Причина отмены заказа"
            // Native owns edits; reason keeps the latest draft for remount and submission.
            defaultValue={reason}
            onChangeText={setReason}
            autoCorrect={false}
            spellCheck={false}
            smartInsertDelete={false}
            maxLength={300}
            multiline
            style={[s.input, ui.body]}
          />
        </Card>
      ) : null}
      <Button
        title="Обновить статус"
        testID="test-refresh-order"
        secondary
        onPress={flow.refresh}
      />
      {!receipt && !cancel && order.state === 'fulfilled' ? (
        <Button
          title="Оценить заказ"
          testID="order-rate"
          style={orderUI.action}
          textStyle={orderUI.actionText}
          onPress={() => props.navigate('M35')}
        />
      ) : null}
      {!cancel ? (
        <NavRow
          title="Написать в поддержку"
          subtitle="Помощь по этому заказу"
          testID="order-support"
          onPress={() => props.navigate('M31')}
        />
      ) : null}
      {!receipt ? (
        <NavRow
          title="Официальный чек"
          subtitle="Оплата и чеки - в процессе подключения"
          onPress={() => props.navigate('M21')}
        />
      ) : null}
      {!cancel && !unknown && !['fulfilled', 'cancelled'].includes(order.state) ? (
        <NavRow
          title="Отменить заказ"
          testID="test-open-cancel"
          onPress={() => props.navigate('M22')}
        />
      ) : null}
      <Button
        title="Мои заказы"
        testID="test-open-history"
        secondary
        onPress={() => props.navigate('M19')}
      />
    </Page>
  );
}
const s = StyleSheet.create({
  section: { gap: 12 },
  line: { gap: 6, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
  step: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.raised,
  },
  status: { gap: 12, padding: 20, borderRadius: 16, backgroundColor: colors.raised },
  number: { color: colors.accentText, fontFamily: font.heading, fontSize: 28, lineHeight: 36 },
  input: {
    minHeight: 90,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    color: colors.text,
    padding: 14,
    textAlignVertical: 'top',
  },
});
