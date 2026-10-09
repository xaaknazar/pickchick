import { useEffect, useRef, useState } from 'react';
import type { KioskModel } from '../model';
import { visiblePaymentQr } from '../qr';
import { kioskOrderNumber } from '../presentation';
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
        ? t.kaspiWaiting
        : t.waiting;
  const message = unknown
    ? t.unknownBody
    : model.commercial
      ? invoice
        ? model.paymentPhase === 'awaiting_payment'
          ? t.invoiceSent
          : model.paymentPhase === 'awaiting_restaurant'
            ? t.invoiceRestaurant
            : t.invoiceChecking
        : showQr
          ? t.qrScan
          : qrExpired
            ? t.qrExpired
            : t.qrPreparing
      : t.testPayment;
  return (
    <ScreenSurface testID="kiosk-screen-payment" tone="brand" entrance={context.direction}>
      <Header {...context} title={t.payment} />
      <ScrollArea fill>
        <Wrapper flex={1} paddingX={60} paddingY={34} gap={28} align="center" justify="center">
          <PaymentStatus
            state={unknown ? 'unknown' : declined ? 'declined' : 'waiting'}
            title={title}
            total={total}
            reference={
              model.order?.number && model.order.number !== '-'
                ? `${t.orderRef} ${kioskOrderNumber(model.order.number)}`
                : model.paymentMethod !== 'card'
                  ? invoice
                    ? 'Kaspi - ' + t.invoiceMethod
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
  const waitingForNumber =
    model.commercial && order?.payment_state === 'paid' && (!order.number || order.number === '-');
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
  const status = waitingForNumber
    ? t.paymentConfirmed
    : order?.state === 'ready'
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
                ? t.awaitingRestaurant
                : t.waiting;
  const number = waitingForNumber ? null : kioskOrderNumber(order?.number);
  const stage = waitingForNumber
    ? null
    : order?.state === 'ready' || order?.state === 'fulfilled'
      ? 'ready'
      : order?.state === 'preparing'
        ? 'preparing'
        : order?.state === 'failed' || order?.state === 'cancelled'
          ? null
          : 'accepted';

  return (
    <ScreenSurface testID="kiosk-screen-order" tone="brand" entrance={context.direction}>
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
                  ? t.receiptIssued
                  : t.receiptMissing
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
              progress={canReset ? (15 - seconds) / 15 : undefined}
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
    <ScreenSurface testID="kiosk-screen-recovery" tone="brand" entrance={context.direction}>
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
