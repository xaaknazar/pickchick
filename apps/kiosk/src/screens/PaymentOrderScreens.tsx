import { useEffect, useRef, useState } from 'react';
import type { KioskModel } from '../model';
import { visiblePaymentQr } from '../qr';
import { kioskOrderNumber, qrScanInstructions } from '../presentation';
import { copy } from '../i18n';
import {
  Body,
  Button,
  Footer,
  Header,
  Heading,
  Icon,
  ScreenSurface,
  ScrollArea,
  Wrapper,
  type ScreenContext,
} from '../components/UI';
import { PaymentStatus } from '../components/PaymentStatus';
import { OrderTicket } from '../components/OrderTicket';
export function PaymentScreen({ model, context }: { model: KioskModel; context: ScreenContext }) {
  const t = copy(context.locale);
  const unknown =
    model.order?.payment_state === 'simulated_unknown' ||
    model.order?.payment_state === 'unknown' ||
    model.recoveryRequired;
  const declined = model.order?.payment_state === 'simulated_declined';
  const total = model.order?.snapshot.total_minor ?? model.cartTotalMinor;
  const qr = model.qrPayment;
  const qrExpired = !!qr?.expiresAt && Date.parse(qr.expiresAt) <= Date.now();
  const qrPayload = visiblePaymentQr(qr, unknown, Date.now());
  const showQr = !!qrPayload;

  const title = unknown
    ? t.unknownTitle
    : declined
      ? t.declined
      : model.commercial
        ? context.locale === 'ru'
          ? 'Ожидаем оплату Kaspi'
          : 'Kaspi төлемін күтеміз'
        : t.waiting;
  const message = unknown
    ? t.unknownBody
    : model.commercial
      ? showQr
        ? qrScanInstructions(context.locale)
        : context.locale === 'ru'
          ? qrExpired
            ? 'Время действия QR истекло. Проверяем результат оплаты. Не оплачивайте повторно.'
            : 'Готовим QR или проверяем результат оплаты. Не оплачивайте повторно.'
          : qrExpired
            ? 'QR мерзімі аяқталды. Төлем нәтижесі тексерілуде. Қайта төлемеңіз.'
            : 'QR дайындалуда немесе төлем нәтижесі тексерілуде. Қайта төлемеңіз.'
      : t.testPayment;
  return (
    <ScreenSurface testID="kiosk-screen-payment">
      <Header {...context} title={t.payment} />
      <ScrollArea fill>
        <Wrapper flex={1} padding={40} gap={28} justify="center">
          <PaymentStatus
            state={unknown ? 'unknown' : declined ? 'declined' : 'waiting'}
            title={title}
            total={total}
            reference={
              model.order?.number && model.order.number !== '-'
                ? `${context.locale === 'ru' ? 'Заказ' : 'Тапсырыс'} ${kioskOrderNumber(model.order.number)}`
                : model.paymentMethod === 'kaspi'
                  ? 'Kaspi'
                  : t.card
            }
            message={message}
            qrPayload={qrPayload}
          />
          {!unknown && !model.commercial ? (
            <Wrapper gap={16}>
              <Button
                label={t.decline}
                tone="secondary"
                testID="kiosk-payment-decline"
                size="compact"
                busy={model.busy}
                onPress={() => void model.pay('declined')}
              />
              <Button
                label={t.unknown}
                tone="secondary"
                testID="kiosk-payment-unknown"
                size="compact"
                busy={model.busy}
                onPress={() => void model.pay('unknown')}
              />
            </Wrapper>
          ) : (
            <Button label={t.help} tone="secondary" onPress={context.onHelp} />
          )}
        </Wrapper>
      </ScrollArea>
      <Footer>
        <Button
          testID={
            model.commercial || unknown || declined
              ? 'kiosk-payment-retry'
              : 'kiosk-payment-approve'
          }
          label={model.commercial || unknown ? t.refresh : declined ? t.retry : t.approve}
          busy={model.busy}
          onPress={() =>
            model.commercial || unknown ? void model.recover() : void model.pay('approved')
          }
          fullWidth
        />
      </Footer>
    </ScreenSurface>
  );
}
export function OrderScreen({ model, context }: { model: KioskModel; context: ScreenContext }) {
  const t = copy(context.locale);
  const order = model.order;
  const canReset =
    !!order &&
    ['simulated_approved', 'paid'].includes(order.payment_state) &&
    !model.recoveryRequired;
  const [seconds, setSeconds] = useState(15);
  const modelRef = useRef(model);
  modelRef.current = model;
  useEffect(() => {
    if (!canReset) return;
    let remaining = 15;
    setSeconds(remaining);
    const interval = setInterval(() => {
      remaining -= 1;
      setSeconds(Math.max(0, remaining));
      if (remaining <= 0) {
        const current = modelRef.current;
        if (
          !!current.order &&
          ['simulated_approved', 'paid'].includes(current.order.payment_state) &&
          !current.recoveryRequired &&
          !current.busy
        ) {
          clearInterval(interval);
          void current.newGuest();
        }
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [canReset, order?.order_id]);
  const status =
    order?.state === 'ready'
      ? t.ready
      : order?.state === 'fulfilled'
        ? t.fulfilled
        : order?.state === 'failed'
          ? t.declined
          : order?.state === 'cancelled'
            ? t.cancelled
            : order?.state === 'preparing'
              ? t.preparing
              : model.commercial
                ? context.locale === 'ru'
                  ? 'Оплата подтверждена. Ожидаем ресторан.'
                  : 'Төлем расталды. Мейрамхананы күтеміз.'
                : t.waiting;
  const number = kioskOrderNumber(order?.number);

  return (
    <ScreenSurface testID="kiosk-screen-order" tone="brand">
      <ScrollArea fill>
        <Wrapper flex={1} padding={40} justify="center">
          <OrderTicket
            number={number}
            status={status}
            confirmed={canReset}
            showBoard={order?.state === 'preparing' || order?.state === 'ready'}
            locale={context.locale}
            receipt={
              model.commercial
                ? model.receiptState === 'issued'
                  ? context.locale === 'ru'
                    ? 'Чек сформирован'
                    : 'Чек дайын'
                  : context.locale === 'ru'
                    ? 'Фискальный чек пока не сформирован. Обратитесь к сотруднику.'
                    : 'Фискалдық чек әлі жасалмады. Қызметкерге хабарласыңыз.'
                : t.testPayment
            }
          />
        </Wrapper>
      </ScrollArea>
      <Footer tone="brand">
        <Button
          label={`${t.nextGuest}${canReset ? ` · ${seconds}` : ''}`}
          testID="kiosk-next-guest"
          disabled={!canReset && order?.state !== 'cancelled' && order?.state !== 'failed'}
          busy={model.busy}
          onPress={() => void model.newGuest()}
          fullWidth
        />
        <Button size="compact" label={t.help} tone="inverse" onPress={context.onHelp} />
      </Footer>
    </ScreenSurface>
  );
}
export function RecoveryScreen({ model, context }: { model: KioskModel; context: ScreenContext }) {
  const t = copy(context.locale);
  return (
    <ScreenSurface testID="kiosk-screen-recovery">
      <Header {...context} title={t.restore} />
      <ScrollArea fill>
        <Wrapper flex={1} padding={40} gap={28} align="center" justify="center">
          <Icon name="time-outline" size="hero" tone="brand" />
          <Heading align="center">{t.restore}</Heading>
          <Body tone="muted" align="center">
            {model.order?.payment_state === 'simulated_unknown' ? t.unknownBody : t.restoreBody}
          </Body>
          <Button label={t.help} tone="secondary" onPress={context.onHelp} />
        </Wrapper>
      </ScrollArea>
      <Footer>
        <Button
          testID="kiosk-payment-retry"
          label={t.refresh}
          busy={model.busy}
          onPress={() => void model.recover()}
          fullWidth
        />
      </Footer>
    </ScreenSurface>
  );
}
