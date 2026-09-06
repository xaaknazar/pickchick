import { useState } from 'react';
import { ScrollView, Text, TextInput, View, StyleSheet, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { TestOrder } from '@pickchick/test-order-flow/contracts';
import type { ScreenProps } from '../model';
import {
  Body,
  Button,
  Caption,
  Card,
  Empty,
  Heading,
  Logo,
  NavRow,
  Notice,
  Page,
  Pill,
  Row,
  SummaryRow,
  styles as ui,
} from '../components/UI';
import { colors, font } from '../theme';
import { money, cartTotal } from '../domain';
import { assets } from '../assets';
import { cartMatchesOrder } from '../test-order-session';

const statusNames: Record<TestOrder['state'], string> = {
  awaiting_test_payment: 'Ждёт тестовой оплаты',
  preparing: 'Готовится',
  ready: 'Можно забирать',
  fulfilled: 'Выдан',
  cancelled: 'Отменён',
};
function ContinueSession({ props }: { props: ScreenProps }) {
  const flow = props.model.testFlow;
  if (!flow.sessionExpired) return null;
  return (
    <Button
      title="Продлить тестовый доступ"
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
      <Notice warning title="Тестовый контур">
        Заказ сохраняется на сервере и связан с тестовой кухней. Деньги не списываются, ресторан его
        не готовит.
      </Notice>
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
      {flow.observedAt ? (
        <Caption>
          Статус проверен в{' '}
          {new Date(flow.observedAt).toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })}
        </Caption>
      ) : null}
    </>
  );
}
function OrderLines({ order }: { order: TestOrder }) {
  return (
    <Card>
      <Heading small>Состав заказа</Heading>
      {order.snapshot.lines.map((line) => (
        <SummaryRow
          key={line.id}
          label={`${line.quantity} × ${line.name}`}
          value={money(line.line_total_minor)}
        />
      ))}
      <SummaryRow label="Итого по серверу" value={money(order.snapshot.total_minor)} strong />
    </Card>
  );
}

export function ConnectedCheckout(props: ScreenProps) {
  const flow = props.model.testFlow;
  const unknown = flow.orders.find((order) => order.payment_state === 'simulated_unknown');
  const matching = flow.orders.find(
    (order) =>
      order.state === 'awaiting_test_payment' &&
      cartMatchesOrder(order, props.model.cart, props.model.diningMode),
  );
  const pending = unknown ?? matching ?? null;
  const submit = async () => {
    if (pending) flow.select(pending.order_id);
    const order = pending ?? (await flow.submit());
    if (order) props.navigate(order.payment_state === 'simulated_unknown' ? 'M14' : 'M13');
  };
  return (
    <Page
      props={props}
      title="Оформление"
      footer={
        <Button
          testID="test-checkout-create"
          title={
            flow.busy
              ? 'Сохраняем заказ…'
              : pending
                ? `Продолжить ${pending.number}`
                : 'Создать тестовый заказ'
          }
          disabled={flow.busy || (!pending && props.model.cart.length === 0)}
          onPress={() => {
            void submit();
          }}
        />
      }
    >
      <Heading>Проверим ваш{`\n`}заказ</Heading>
      <FlowNotice props={props} />
      {unknown ? (
        <Notice warning>
          Прежде чем создавать другой заказ, нужно уточнить результат проверки {unknown.number}.
          Новая корзина остаётся на устройстве.
        </Notice>
      ) : null}
      <Card>
        <Heading small>{props.model.branch?.name ?? 'Тестовая точка PickChick'}</Heading>
        <Body>{props.model.diningMode === 'takeaway' ? 'С собой' : 'В зале'}</Body>
      </Card>
      {pending ? (
        <OrderLines order={pending} />
      ) : (
        <Card>
          {props.model.cart.map((line) => (
            <SummaryRow
              key={line.product.id}
              label={`${line.quantity} × ${line.product.name}`}
              value={money((BigInt(line.product.priceMinor) * BigInt(line.quantity)).toString())}
            />
          ))}
          <SummaryRow label="Предварительно" value={money(cartTotal(props.model.cart))} strong />
          <Caption>Окончательная сумма будет рассчитана и сохранена сервером.</Caption>
        </Card>
      )}
      <Button title="Kaspi ещё подключается" disabled testID="checkout-pay-disabled" />
      {flow.current?.state === 'awaiting_test_payment' &&
      flow.current.order_id !== pending?.order_id ? (
        <NavRow
          title={`Ранее созданный ${flow.current.number}`}
          subtitle="Открыть отдельно от этой корзины"
          onPress={() => props.navigate('M20')}
        />
      ) : null}
      <Caption>
        В первой проверке используется отдельный симулятор. Он не выдаёт банковское подтверждение
        или фискальный чек.
      </Caption>
    </Page>
  );
}

export function ConnectedHistory(props: ScreenProps) {
  const flow = props.model.testFlow;
  return (
    <Page props={props} title="Мои заказы" noBack>
      <FlowNotice props={props} />
      <Button
        title="Обновить заказы"
        testID="test-refresh-order"
        secondary
        onPress={flow.refresh}
      />
      {!flow.orders.length ? (
        <Empty
          title="Заказов пока нет"
          detail="Соберите корзину, чтобы проверить передачу заказа на тестовую кухню."
          action={<Button title="Открыть меню" onPress={() => props.navigate('M06')} />}
        />
      ) : (
        flow.orders.map((order) => (
          <Card key={order.order_id}>
            <NavRow
              title={order.number}
              subtitle={`${statusNames[order.state]} · ${money(order.snapshot.total_minor)}`}
              onPress={() => {
                flow.select(order.order_id);
                props.navigate('M20');
              }}
            />
            <Caption>
              {new Date(order.created_at).toLocaleString('ru-RU')} ·{' '}
              {order.snapshot.service_mode === 'takeaway' ? 'С собой' : 'В зале'}
            </Caption>
          </Card>
        ))
      )}
    </Page>
  );
}

export function ConnectedOrder(props: ScreenProps) {
  const flow = props.model.testFlow;
  const order = flow.current;
  const [reason, setReason] = useState('Проверка отмены тестового заказа');
  if (!order)
    return (
      <Page props={props} title="Заказ">
        <Empty
          title="Выберите заказ"
          detail="Здесь появится его сохранённый на сервере статус."
          action={<Button title="Мои заказы" onPress={() => props.navigate('M19')} />}
        />
      </Page>
    );
  const unknown = order.payment_state === 'simulated_unknown';
  const canPay = order.state === 'awaiting_test_payment' && !unknown;
  const pay = async (outcome: 'approved' | 'declined' | 'unknown') => {
    const next = await flow.pay(outcome);
    if (next) {
      if (next.payment_state === 'simulated_approved')
        props.model.clearCart(next.snapshot.lines.map(({ id, quantity }) => ({ id, quantity })));
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
  const ready = order.state === 'ready' && !receipt && !cancel && props.screenId !== 'M20';
  if (ready) return <ConnectedReady props={props} order={order} />;
  return (
    <Page
      props={props}
      title={receipt ? 'Электронный чек' : cancel ? 'Отмена заказа' : order.number}
    >
      <FlowNotice props={props} />
      <View style={[s.status, ready && s.ready]}>
        <Pill>Тестовый заказ</Pill>
        <Body testID="connected-order-state">{statusNames[order.state]}</Body>
        <Heading style={ready ? { color: '#241208' } : undefined}>
          {unknown ? 'Уточняем результат' : statusNames[order.state]}
        </Heading>
        <Text
          testID="connected-order-number"
          style={[s.number, ready && { color: '#241208' }]}
          adjustsFontSizeToFit
          numberOfLines={1}
        >
          {order.number}
        </Text>
        <Body style={ready ? { color: '#241208' } : undefined}>
          {unknown
            ? 'Повторная попытка заблокирована. Результат проверит оператор тестового контура.'
            : order.state === 'preparing'
              ? 'Задания уже появились на двух кухонных экранах.'
              : order.state === 'ready'
                ? 'Тестовая сборка завершена. Оператор может отметить выдачу.'
                : order.state === 'fulfilled'
                  ? 'Выдача подтверждена на кухне. Заказ убран с табло.'
                  : order.state === 'cancelled'
                    ? (order.cancellation_reason ?? 'Заказ отменён.')
                    : 'Следующий шаг — проверка симулятора оплаты.'}
        </Body>
      </View>
      {receipt ? (
        <Notice title="Фискального чека нет">
          Этот заказ создан только для проверки связи экранов. Фискализация не запускалась; кассовый
          чек не подменяется макетом.
        </Notice>
      ) : null}
      {canPay && !receipt && !cancel ? (
        <Card>
          <Heading small>Симулятор для проверки</Heading>
          <Caption>Только тестовые состояния, без обращения к банку.</Caption>
          <Button
            testID="test-payment-approve"
            title={flow.busy ? 'Проверяем…' : 'Тест: подтвердить и передать на кухню'}
            disabled={flow.busy}
            onPress={() => {
              void pay('approved');
            }}
          />
          <Button
            testID="test-payment-unknown"
            title="Тест: неизвестный результат"
            secondary
            disabled={flow.busy}
            onPress={() => {
              void pay('unknown');
            }}
          />
          <Button
            title="Тест: отказ"
            secondary
            disabled={flow.busy}
            onPress={() => {
              void pay('declined');
            }}
          />
        </Card>
      ) : null}
      {order.tasks.length ? (
        <Card>
          <Heading small>Кухня</Heading>
          {order.tasks.map((task) => (
            <SummaryRow
              key={task.task_id}
              label={`${task.station === 'prep' ? 'Приготовление' : 'Сборка'} · ${task.title}`}
              value={task.state === 'done' ? 'Готово' : 'В очереди'}
            />
          ))}
        </Card>
      ) : null}
      <OrderLines order={order} />
      {cancel ? (
        <Card>
          <Heading small>Причина отмены</Heading>
          <TextInput
            testID="test-cancel-reason"
            accessibilityLabel="Причина отмены тестового заказа"
            value={reason}
            onChangeText={setReason}
            maxLength={300}
            multiline
            style={[s.input, ui.body]}
          />
          <Button
            testID="test-cancel-order"
            title="Отменить тестовый заказ"
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
        </Card>
      ) : null}
      <Button
        title="Обновить статус"
        testID="test-refresh-order"
        secondary
        onPress={flow.refresh}
      />
      {!receipt ? <NavRow title="Информация о чеке" onPress={() => props.navigate('M21')} /> : null}
      {!cancel && !unknown && !['fulfilled', 'cancelled'].includes(order.state) ? (
        <NavRow
          title="Отменить тестовый заказ"
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
function ConnectedReady({ props, order }: { props: ScreenProps; order: TestOrder }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [numberWidth, setNumberWidth] = useState<number | null>(null);
  const numberFontSize = Math.min(
    112,
    Math.max(1, numberWidth ?? width - 48) / (order.number.length * 0.72),
  );
  return (
    <View
      testID={`screen-${props.screenId}`}
      style={[
        s.readyPage,
        { paddingTop: insets.top + 24, paddingBottom: Math.max(insets.bottom, 24) },
      ]}
    >
      <Image
        source={assets.orange}
        style={[StyleSheet.absoluteFill, { opacity: 0.3 }]}
        contentFit="cover"
      />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.readyContent}>
        <Row>
          <View style={ui.flex}>
            <Heading style={s.readyTitle}>Готово!</Heading>
            <Body style={s.readyInk}>Тестовая сборка завершена</Body>
          </View>
          <Logo size={48} />
        </Row>
        <View onLayout={({ nativeEvent }) => setNumberWidth(nativeEvent.layout.width)}>
          <Text
            testID="connected-order-number"
            accessibilityLabel={`Тестовый заказ ${order.number}`}
            style={[s.readyNumber, { fontSize: numberFontSize }]}
            adjustsFontSizeToFit
            numberOfLines={1}
          >
            {order.number}
          </Text>
        </View>
        <Body
          testID="connected-order-state"
          style={[s.readyInk, { textAlign: 'center', fontFamily: font.bold, fontSize: 22 }]}
        >
          Можно забирать
        </Body>
        <Body style={[s.readyInk, { textAlign: 'center' }]}>
          Это тест: ресторан не готовит этот заказ. Выдачу в системе подтвердит оператор.
        </Body>
        <View style={ui.flex} />
        <Button
          title="Состав и чек"
          testID="test-ready-details"
          secondary
          onPress={() => props.navigate('M20')}
        />
        <Button
          title="Обновить статус"
          testID="test-refresh-order"
          secondary
          onPress={props.model.testFlow.refresh}
        />
        <Button
          title="Мои заказы"
          testID="test-open-history"
          secondary
          onPress={() => props.navigate('M19')}
        />
        {props.model.testFlow.error ? <Notice warning>{props.model.testFlow.error}</Notice> : null}
        <ContinueSession props={props} />
        <Caption style={[s.readyInk, { textAlign: 'center' }]}>
          {props.model.branch?.name ?? 'Тестовая точка · Алматы'}
        </Caption>
      </ScrollView>
    </View>
  );
}
const s = StyleSheet.create({
  status: { gap: 16, padding: 22, borderRadius: 28, backgroundColor: colors.raised },
  ready: { backgroundColor: colors.accent },
  number: { color: colors.text, fontFamily: font.display, fontSize: 56 },
  readyPage: { flex: 1, backgroundColor: colors.accent },
  readyContent: { paddingHorizontal: 24, gap: 24, flexGrow: 1 },
  readyTitle: { color: colors.orangeInk, fontSize: 46, lineHeight: 52 },
  readyInk: { color: colors.orangeInk },
  readyNumber: {
    color: colors.orangeInk,
    fontFamily: font.display,
    fontSize: 112,
    letterSpacing: -3,
    textAlign: 'center',
    marginVertical: 32,
  },
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
