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
  Logo,
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
  const declined = ['simulated_declined', 'declined'].includes(model.order?.payment_state ?? '');
  const total = model.order?.snapshot.total_minor ?? model.cartTotalMinor;
  const qr = model.qrPayment;
  const qrExpired = !!qr?.expiresAt && Date.parse(qr.expiresAt) <= Date.now();
  const qrPayload = visiblePaymentQr(qr, unknown, Date.now());
  const showQr = !!qrPayload;
  const invoice = model.paymentMethod === 'kaspi_invoice';

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
      ? invoice
        ? context.locale === 'ru'
          ? model.paymentPhase === 'awaiting_payment'
            ? 'Счёт отправлен. Откройте Kaspi.kz на своём телефоне и подтвердите оплату. Этот экран обновится автоматически.'
            : model.paymentPhase === 'awaiting_restaurant'
              ? 'Ресторан подтверждает заказ. После подтверждения отправим счёт в Kaspi.kz.'
              : 'Отправляем счёт или проверяем результат оплаты в Kaspi.kz. Не оплачивайте повторно.'
          : model.paymentPhase === 'awaiting_payment'
            ? 'Шот жіберілді. Телефоныңызда Kaspi.kz ашып, төлемді растаңыз. Бұл экран автоматты түрде жаңарады.'
            : model.paymentPhase === 'awaiting_restaurant'
              ? 'Мейрамхана тапсырысты растауда. Расталғаннан кейін Kaspi.kz шотын жібереміз.'
              : 'Шот жіберілуде немесе Kaspi.kz төлемі тексерілуде. Қайта төлемеңіз.'
        : showQr
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
    <ScreenSurface testID="kiosk-screen-payment" tone="brand" entrance>
      <Header {...context} title={t.payment} />
      <ScrollArea fill>
        <Wrapper flex={1} paddingX={60} paddingY={34} gap={28} align="center" justify="center">
          <PaymentStatus
            state={unknown ? 'unknown' : declined ? 'declined' : 'waiting'}
            title={title}
            total={total}
            reference={
              model.order?.number && model.order.number !== '-'
                ? `${context.locale === 'ru' ? 'Заказ' : 'Тапсырыс'} ${kioskOrderNumber(model.order.number)}`
                : model.paymentMethod !== 'card'
                  ? invoice
                    ? 'Kaspi - ' + (context.locale === 'ru' ? 'счёт на телефон' : 'телефонға шот')
                    : 'Kaspi QR'
                  : t.card
            }
            message={message}
            qrPayload={qrPayload}
            expiresAt={qr?.expiresAt ?? null}
            method={model.paymentMethod === 'card' ? 'card' : invoice ? 'invoice' : 'qr'}
            locale={context.locale}
          />
          {!unknown && !model.commercial ? (
            <Wrapper dir="row" gap={16} wrap justify="center">
              <Button
                label={t.decline}
                tone="inverse"
                testID="kiosk-payment-decline"
                size="compact"
                busy={model.busy}
                onPress={() => void model.pay('declined')}
              />
              <Button
                label={t.unknown}
                tone="inverse"
                testID="kiosk-payment-unknown"
                size="compact"
                busy={model.busy}
                onPress={() => void model.pay('unknown')}
              />
            </Wrapper>
          ) : (
            <Button label={t.help} tone="outline" size="compact" onPress={context.onHelp} />
          )}
        </Wrapper>
      </ScrollArea>
      <Footer tone="brand">
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
  const stage =
    order?.state === 'ready' || order?.state === 'fulfilled'
      ? 'ready'
      : order?.state === 'preparing'
        ? 'preparing'
        : order?.state === 'failed' || order?.state === 'cancelled'
          ? null
          : 'accepted';

  return (
    <ScreenSurface testID="kiosk-screen-order" tone="brand" entrance>
      <ScrollArea fill>
        <Wrapper flex={1} paddingX={60} paddingY={40} justify="center">
          <OrderTicket
            number={number}
            status={status}
            confirmed={canReset}
            stage={stage}
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
      <Footer tone="clear">
        <Wrapper dir="row" gap={18} align="center">
          <Wrapper flex={1}>
            <Button
              label={`${t.nextGuest}${canReset ? ` · ${seconds}` : ''}`}
              testID="kiosk-next-guest"
              tone="secondary"
              disabled={!canReset && order?.state !== 'cancelled' && order?.state !== 'failed'}
              busy={model.busy}
              onPress={() => void model.newGuest()}
              fullWidth
            />
          </Wrapper>
          <Button label={t.help} tone="inverse" onPress={context.onHelp} />
        </Wrapper>
      </Footer>
    </ScreenSurface>
  );
}
export function RecoveryScreen({ model, context }: { model: KioskModel; context: ScreenContext }) {
  const t = copy(context.locale);
  return (
    <ScreenSurface testID="kiosk-screen-recovery" tone="brand" entrance>
      <Header {...context} title={t.restore} />
      <ScrollArea fill>
        <Wrapper flex={1} paddingX={60} paddingY={40} gap={28} align="center" justify="center">
          <Logo size="large" />
          <Icon name="time-outline" size="hero" tone="inverse" />
          <Heading align="center" tone="inverse">
            {t.restore}
          </Heading>
          <Wrapper maxWidth={760}>
            <Body tone="onBlue" align="center">
              {model.order?.payment_state === 'simulated_unknown' ? t.unknownBody : t.restoreBody}
            </Body>
          </Wrapper>
          <Button label={t.help} tone="outline" size="compact" onPress={context.onHelp} />
        </Wrapper>
      </ScrollArea>
      <Footer tone="brand">
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
