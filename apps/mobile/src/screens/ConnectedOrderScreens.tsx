import { unpaidTestOrdersEnabled } from '../order-simulator';
import { MotionPressable } from '../components/Motion';
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
  Loading,
  NavRow,
  Notice,
  Page,
  Pill,
  Row,
  SummaryRow,
  styles as ui,
} from '../components/UI';
import { colors, font } from '../theme';
import { PaymentChoice, paymentName } from '../components/PaymentChoice';
import {
  money,
  cartTotal,
  cartLineKey,
  lineUnitPrice,
  selectionDescription,
  preparationMinutes,
} from '../domain';
import { assets } from '../assets';
import { cartMatchesOrder } from '../test-order-session';
import { restaurantLocation } from '../restaurant-location';

export function orderStage(order: TestOrder): string {
  if (
    order.state === 'preparing' &&
    order.tasks.every((task) => task.station !== 'prep' || task.state === 'done')
  )
    return 'На сборке';
  return statusNames[order.state];
}
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
      {!flow.available ? (
        <Notice warning title="Новое оформление недоступно">
          Свежее меню и разрешение тестовых заказов ещё не получены. Сохранённый сеанс и его
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
          key={'line_id' in line ? line.line_id : line.id}
          label={`${line.quantity} × ${line.name}${'selections' in line && line.selections.length ? ` · ${line.selections.map((s) => s.option_label + (s.quantity > 1 ? ` ×${s.quantity}` : '')).join(' · ')}` : ''}`}
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
      footer={
        <Button
          testID="test-checkout-create"
          title={
            flow.busy
              ? 'Сохраняем заказ…'
              : pending
                ? `Продолжить ${pending.number}`
                : unpaidTestOrdersEnabled
                  ? 'Отправить на кухню'
                  : 'Перейти к тестовой оплате'
          }
          disabled={flow.busy || (!pending && (!flow.available || props.model.cart.length === 0))}
          onPress={() => {
            void submit();
          }}
        />
      }
    >
      <Heading>Проверим ваш{`\n`}заказ</Heading>
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
      <Card>
        <Heading small>{branch?.name ?? location?.name ?? 'Ресторан PickChick'}</Heading>
        {location ? (
          <Caption>
            {location.city}, {location.address}
          </Caption>
        ) : null}
        <Body>
          {(pending?.snapshot.service_mode ?? props.model.diningMode) === 'takeaway'
            ? 'С собой'
            : 'В зале'}{' '}
          · Приготовим за ~
          {pending && 'estimated_minutes' in pending.snapshot
            ? pending.snapshot.estimated_minutes.min
            : preparationMinutes(props.model.cart)}{' '}
          мин
        </Body>
      </Card>
      {pending ? (
        <OrderLines order={pending} />
      ) : (
        <Card>
          {props.model.cart.map((line) => (
            <SummaryRow
              key={cartLineKey(line)}
              label={`${line.quantity} × ${line.product.name}${selectionDescription(line) ? ` · ${selectionDescription(line)}` : ''}`}
              value={money((BigInt(lineUnitPrice(line)) * BigInt(line.quantity)).toString())}
            />
          ))}
          <SummaryRow label="Предварительно" value={money(cartTotal(props.model.cart))} strong />
          <Caption>Окончательная сумма будет рассчитана и сохранена сервером.</Caption>
        </Card>
      )}
      {unpaidTestOrdersEnabled && !pending ? (
        <Notice title="Тестовый заказ без оплаты">
          Заказ увидит тестовая кухня. Подтверждения приготовления, сборки и выдачи появятся здесь
          автоматически. Деньги не списываются, чек не создаётся.
        </Notice>
      ) : pending ? (
        <SummaryRow
          label="Способ оплаты"
          value={
            'payment_method' in pending.snapshot
              ? paymentName(pending.snapshot.payment_method)
              : 'Тестовая оплата'
          }
        />
      ) : (
        <PaymentChoice model={props.model} />
      )}
      {!unpaidTestOrdersEnabled ? (
        <Caption>
          Имитация оплаты: деньги не списываются, заказ поступит на тестовые экраны кухни. Ресторан
          его не готовит.
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
      {!unpaidTestOrdersEnabled ? (
        <Caption>
          В первой проверке используется отдельный симулятор. Он не выдаёт банковское подтверждение
          или фискальный чек.
        </Caption>
      ) : null}
    </Page>
  );
}

export function ConnectedHistory(props: ScreenProps) {
  const flow = props.model.testFlow;
  return (
    <Page props={props} title="Мои заказы" noBack>
      <FlowNotice props={props} />
      {!flow.restored ? (
        <Loading title="Восстанавливаем тестовый сеанс" />
      ) : !flow.orders.length && (flow.error || flow.recoveryAvailable) ? (
        <Empty
          title={
            flow.error ? 'Историю пока не удалось проверить' : 'Сохранена незавершённая проверка'
          }
          detail="Неизвестный результат не означает отсутствие заказов. Используйте восстановление или обновите статус; сохранённая проверка не удаляется."
        />
      ) : !flow.orders.length ? (
        <Empty
          title="Заказов пока нет"
          detail="Соберите корзину, чтобы проверить передачу заказа на тестовую кухню."
          action={<Button title="Открыть меню" onPress={() => props.navigate('M06')} />}
        />
      ) : (
        flow.orders.map((order) => (
          <MotionPressable
            key={order.order_id}
            accessibilityRole="button"
            accessibilityLabel={`Заказ номер ${order.number}, ${orderStage(order)}, ${money(order.snapshot.total_minor)}. Открыть заказ`}
            onPress={() => {
              flow.select(order.order_id);
              props.navigate('M20');
            }}
          >
            <Card>
              <Row style={{ flexWrap: 'wrap', justifyContent: 'space-between' }}>
                <Heading small>{order.number}</Heading>
                <Pill>{orderStage(order)}</Pill>
              </Row>
              <Caption>{new Date(order.created_at).toLocaleString('ru-RU')}</Caption>
              <Row style={{ flexWrap: 'wrap', justifyContent: 'space-between' }}>
                <Caption>
                  {order.snapshot.service_mode === 'takeaway' ? 'С собой' : 'В зале'}
                </Caption>
                <Body style={{ fontFamily: font.bold, fontVariant: ['tabular-nums'] }}>
                  {money(order.snapshot.total_minor)}
                </Body>
              </Row>
            </Card>
          </MotionPressable>
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
        <FlowNotice props={props} />
        {!flow.restored ? <Loading title="Восстанавливаем тестовый сеанс" /> : null}
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
  const ready = order.state === 'ready' && !receipt && !cancel && props.screenId !== 'M20';
  if (ready) return <ConnectedReady props={props} order={order} />;
  return (
    <Page
      props={props}
      title={receipt ? 'Электронный чек' : cancel ? 'Отмена заказа' : `Заказ №${order.number}`}
      footer={
        cancel ? (
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
        ) : undefined
      }
    >
      <FlowNotice props={props} />
      <View accessibilityLiveRegion="polite" style={[s.status, ready && s.ready]}>
        <Pill>Тестовый заказ</Pill>
        <Heading testID="connected-order-state" style={ready ? { color: '#241208' } : undefined}>
          {unknown ? 'Уточняем результат' : orderStage(order)}
        </Heading>
        <Text
          testID="connected-order-number"
          accessibilityLabel={`Заказ номер ${order.number}`}
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
              ? orderStage(order) === 'На сборке'
                ? 'Кухня подтвердила приготовление. Собираем ваш тестовый заказ.'
                : 'Заказ передан на тестовую кухню. Статус обновится после её подтверждения.'
              : order.state === 'ready'
                ? 'Тестовая сборка завершена. Оператор может отметить выдачу.'
                : order.state === 'fulfilled'
                  ? 'Выдача подтверждена на кухне. Заказ убран с табло.'
                  : order.state === 'cancelled'
                    ? (order.cancellation_reason ?? 'Заказ отменён.')
                    : 'Следующий шаг - проверка симулятора оплаты.'}
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
          <Heading small>
            {'payment_method' in order.snapshot
              ? paymentName(order.snapshot.payment_method)
              : 'Kaspi'}{' '}
            · тестовая оплата
          </Heading>
          <Caption>Только тестовые состояния, без обращения к банку.</Caption>
          <Button
            testID="test-payment-approve"
            title={
              flow.busy ? 'Проверяем…' : `Оплатить ${money(order.snapshot.total_minor)} · тест`
            }
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
          <Heading small>Этапы заказа</Heading>
          <SummaryRow
            label="Кухня"
            value={
              order.tasks.some((task) => task.station === 'prep' && task.state !== 'done')
                ? 'Готовится'
                : 'Готово'
            }
          />
          <SummaryRow
            label="Сборка"
            value={
              order.tasks.some((task) => task.station === 'assembly' && task.state === 'done')
                ? 'Готово'
                : orderStage(order) === 'На сборке'
                  ? 'Собирается'
                  : 'Ожидает кухню'
            }
          />
          <SummaryRow
            label="Выдача"
            value={
              order.state === 'fulfilled'
                ? 'Выдан'
                : order.state === 'ready'
                  ? 'Можно забирать'
                  : 'Ожидает сборку'
            }
          />
        </Card>
      ) : null}
      <OrderLines order={order} />
      {cancel ? (
        <Card>
          <Heading small>Причина отмены</Heading>
          <TextInput
            testID="test-cancel-reason"
            accessibilityLabel="Причина отмены тестового заказа"
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
  const branch = props.model.branches.find((candidate) => candidate.id === order.branch_id);
  const location = restaurantLocation(order.branch_id);
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
            accessibilityLabel={`Заказ номер ${order.number}`}
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
          {branch?.name ?? location?.name ?? 'Ресторан PickChick'}
          {location ? ` · ${location.city}, ${location.address}` : ''}
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
