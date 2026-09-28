import { OrderTotal, orderUI } from '../components/OrderPresentation';
import { CheckoutDetails, CheckoutHeader } from './CheckoutScreen';
import { unpaidTestOrdersEnabled } from '../order-simulator';
import { MotionPressable } from '../components/Motion';
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
import { orderStage } from '../order-status';
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
      {!flow.available && props.screenId === 'M12' ? (
        <Notice warning title="Новое оформление недоступно">
          Пока не удалось загрузить меню и проверить возможность заказа. Сохранённый сеанс и его
          незавершённые запросы остаются на устройстве; их статус проверяется отдельно.
        </Notice>
      ) : null}
      {flow.error ? (
        <Notice warning title="Не удалось обновить">
          {flow.error}
        </Notice>
      ) : null}
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

const completed = (order: TestOrder) => ['fulfilled', 'cancelled'].includes(order.state);
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
  const groups = [
    { title: 'Сейчас', orders: sorted.filter((order) => !completed(order)) },
    { title: 'История', orders: sorted.filter(completed) },
  ];
  return (
    <Page props={props} title="Мои заказы" noBack>
      <FlowNotice props={props} />
      {!flow.restored ? (
        <Loading title="Загружаем заказы" />
      ) : !flow.orders.length ? (
        <Empty
          title={
            flow.error || flow.recoveryAvailable
              ? 'Не удалось загрузить заказы'
              : 'Здесь будут ваши заказы'
          }
          detail={
            flow.error || flow.recoveryAvailable
              ? 'Обновите страницу, когда появится связь. Сохранённые заказы остаются в системе.'
              : 'Выбирайте любимые блюда. Здесь можно следить за приготовлением и смотреть историю.'
          }
          action={
            <Button
              title={flow.error ? 'Повторить' : 'Открыть меню'}
              onPress={flow.error ? flow.refresh : () => props.navigate('M06')}
            />
          }
        />
      ) : (
        groups.map((group) =>
          group.orders.length ? (
            <View key={group.title} style={{ gap: 12 }}>
              <Heading small style={orderUI.section}>
                {group.title}
              </Heading>
              {group.orders.map((order) => (
                <MotionPressable
                  key={order.order_id}
                  testID={`history-order-${order.order_id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Заказ номер ${order.number}, ${orderStage(order)}, ${money(order.snapshot.total_minor)}. Открыть заказ`}
                  onPress={() => {
                    flow.select(order.order_id);
                    props.navigate('M20');
                  }}
                  style={s.orderCard}
                >
                  <Row>
                    <View style={ui.flex}>
                      <Heading small style={orderUI.title}>
                        Заказ №{order.number}
                      </Heading>
                      <Caption style={orderUI.detail}>{orderDate(order.created_at)}</Caption>
                    </View>
                    <Icon name="chevron-forward" size={20} color={colors.muted} />
                  </Row>
                  <Row>
                    <Icon
                      name={
                        order.state === 'ready' || order.state === 'fulfilled'
                          ? 'checkmark-circle-outline'
                          : order.state === 'cancelled'
                            ? 'close-circle-outline'
                            : 'time-outline'
                      }
                      color={order.state === 'ready' ? colors.success : colors.accent}
                      size={20}
                    />
                    <Body style={[orderUI.label, { fontFamily: font.bold }]}>
                      {orderStage(order)}
                    </Body>
                  </Row>
                  <Body style={[orderUI.detail, { color: colors.muted }]}>
                    {order.snapshot.lines
                      .map((line) => `${line.name}${line.quantity > 1 ? ` ×${line.quantity}` : ''}`)
                      .join(' · ')}
                  </Body>
                  <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
                    <Caption style={orderUI.detail}>
                      {order.snapshot.service_mode === 'takeaway' ? 'С собой' : 'В зале'}
                    </Caption>
                    <Body style={orderUI.amount}>{money(order.snapshot.total_minor)}</Body>
                  </Row>
                </MotionPressable>
              ))}
            </View>
          ) : null,
        )
      )}
      {flow.orders.length >= 20 && flow.moreHistory ? (
        <Button
          title={flow.historyBusy ? 'Загружаем…' : 'Показать предыдущие заказы'}
          testID="orders-load-history"
          secondary
          disabled={flow.historyBusy}
          onPress={() => {
            void flow.loadHistory();
          }}
        />
      ) : null}
      {flow.orders.length ? (
        <Button title="Обновить заказы" secondary onPress={flow.refresh} />
      ) : null}
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
        {!flow.restored ? <Loading title="Восстанавливаем заказ" /> : null}
        <Empty
          title={flow.error ? 'Статус пока не удалось проверить' : 'Выберите заказ'}
          detail={
            flow.error
              ? 'Сохранённый сеанс остаётся на устройстве. Не создавайте замену неизвестному заказу; обновите его статус.'
              : 'Здесь появится его сохранённый на сервере статус.'
          }
          action={<Button title="Мои заказы" onPress={() => props.navigate('M19')} />}
        />
        <Button title="Обновить статус" secondary onPress={flow.refresh} />
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
      <OrderStatusScreen
        props={props}
        order={order}
        notice={
          flow.error || flow.sessionExpired || flow.recoveryAvailable ? (
            <FlowNotice props={props} />
          ) : undefined
        }
      />
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
            ? 'Результат уточнит сотрудник ресторана. Повторять оплату не нужно.'
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
  orderCard: { padding: 18, gap: 12, backgroundColor: colors.surface, borderRadius: 16 },
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
