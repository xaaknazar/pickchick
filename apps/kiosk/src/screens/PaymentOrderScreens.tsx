import { useEffect, useRef, useState } from 'react';
import type { KioskModel } from '../model';
import { visiblePaymentQr } from '../qr';
import { kioskOrderNumber, kioskTicketNumber } from '../presentation';
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
  // A live Kaspi QR: the footer keeps the way to staff and a secondary "I paid - check"
  // (the not-yet card option no longer takes the main spot under the guest's hand).
  const kaspiQr =
    !!model.commercial && showQr && !unknown && !declined && model.paymentMethod !== 'card';

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
      {/* The footer owns the way out of a payment; the header has no cancel. */}
      <Header {...context} title={t.payment} cancellable={false} />
      <ScrollArea fill>
        <Wrapper
          flex={1}
          paddingX={60}
          paddingY={kaspiQr ? 8 : 34}
          gap={kaspiQr ? 12 : 28}
          align="center"
          justify="center"
        >
          <PaymentStatus
            dense={kaspiQr}
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
          ) : null}
        </Wrapper>
      </ScrollArea>
      <Footer tone="brand">
        {/* Outlined way out beside the main action. A commercial order cannot be cancelled
            at the kiosk, so there it calls staff instead of opening a cancel dialog. */}
        <Wrapper dir="row" gap={14} align="center">
          <Button
            label={model.commercial ? t.callStaff : t.cancel}
            tone="outline"
            testID="kiosk-payment-cancel"
            onPress={model.commercial ? context.onHelp : context.onCancel}
          />
          <Wrapper flex={1}>
            {kaspiQr ? (
              <Button
                testID="kiosk-payment-retry"
                label={t.paidCheck}
                tone="inverse"
                busy={model.busy}
                onPress={() => void model.recover()}
                fullWidth
              />
            ) : (
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
            )}
          </Wrapper>
        </Wrapper>
      </Footer>
    </ScreenSurface>
  );
}
/** Seconds a paid order keeps its number on screen; any touch starts them again. */
const PAID_HOLD = 40;
/** Seconds a failed payment stays before the kiosk returns to the start screen. */
const FAILED_HOLD = 30;
export function OrderScreen({ model, context }: { model: KioskModel; context: ScreenContext }) {
  const t = copy(context.locale);
  const order = model.order;
  const paid = !!order && ['simulated_approved', 'paid'].includes(order.payment_state);
  const failed = order?.state === 'failed' || order?.state === 'cancelled';
  const waitingForNumber = model.commercial && paid && (!order.number || order.number === '-');
  // A manager-accepted payment incident reaches the device as `failed` while the QR payment is
  // still being checked: the result is unknown, not a decline.
  const incident =
    !!model.commercial &&
    order?.state === 'failed' &&
    !!model.qrPayment &&
    model.qrPayment.state !== 'failed';
  const canReset = !!order && (paid || failed) && !model.recoveryRequired;
  const hold = paid ? PAID_HOLD : FAILED_HOLD;
  const [seconds, setSeconds] = useState(hold);
  const [touches, setTouches] = useState(0);
  const modelRef = useRef(model);
  modelRef.current = model;
  useEffect(() => {
    if (!canReset) return;
    let remaining = hold;
    setSeconds(remaining);
    const interval = setInterval(() => {
      remaining -= 1;
      setSeconds(Math.max(0, remaining));
      if (remaining <= 0) {
        const current = modelRef.current;
        if (!!current.order && !current.recoveryRequired && !current.busy) {
          clearInterval(interval);
          void current.newGuest();
        }
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [canReset, hold, order?.order_id, touches]);
  const status = incident
    ? t.incidentTitle
    : waitingForNumber
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
  // A failed or cancelled order has no number to collect.
  const number = waitingForNumber || failed ? null : kioskTicketNumber(order?.number);
  const stage =
    waitingForNumber || failed
      ? null
      : order?.state === 'ready' || order?.state === 'fulfilled'
        ? 'ready'
        : order?.state === 'preparing'
          ? 'preparing'
          : 'accepted';

  return (
    <ScreenSurface
      testID="kiosk-screen-order"
      tone="brand"
      entrance={context.direction}
      // Any touch keeps the number on screen a while longer.
      onTouchStart={() => setTouches((n) => n + 1)}
    >
      <ScrollArea fill>
        <Wrapper flex={1} paddingX={60} paddingY={40} gap={20} justify="center">
          <OrderTicket
            number={number}
            status={status}
            confirmed={paid && !model.recoveryRequired}
            stage={stage}
            showBoard={order?.state === 'preparing' || order?.state === 'ready'}
            locale={context.locale}
            receipt={
              incident
                ? t.incidentBody
                : waitingForNumber
                  ? t.numberPending
                  : failed
                    ? model.commercial
                      ? t.helpCommercial
                      : t.testPayment
                    : model.commercial
                      ? model.receiptState === 'issued'
                        ? t.receiptIssued
                        : t.receiptMissing
                      : t.testPayment
            }
          />
          {number ? (
            <Body tone="onBlue" align="center">
              {t.photoNumber}
            </Body>
          ) : null}
        </Wrapper>
      </ScrollArea>
      <Footer tone="clear">
        <Wrapper dir="row" gap={18} align="center">
          <Wrapper flex={1}>
            {/* Secondary: the guest's number stays the main thing on screen. */}
            <Button
              label={`${t.nextGuest}${canReset ? ` · ${seconds}` : ''}`}
              testID="kiosk-next-guest"
              tone="outline"
              disabled={!canReset}
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
