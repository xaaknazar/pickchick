import { useEffect, useRef, useState } from 'react';
import type { KioskModel } from '../model';
import { visiblePaymentQr } from '../qr';
import { kioskOrderNumber, kioskTicketNumber } from '../presentation';
import { copy } from '../i18n';
import { checkoutCopy } from '../checkoutCopy';
import { orderScreenState } from '../orderScreen';
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
import { RadialBackdrop } from '../components/RadialBackdrop';
import { StarField } from '../components/StarField';
import { PaymentHeader } from '../components/PaymentHeader';
import { StepPills } from '../components/StepPills';
import { KaspiAmount } from '../components/KaspiAmount';
import { QrPlate } from '../components/QrPlate';
import { QrTimer } from '../components/QrTimer';
import { QrStepTiles } from '../components/QrStepTiles';
import { PaymentPanel } from '../components/PaymentPanel';
import { paymentCopy } from '../paymentCopy';
export function PaymentScreen({
  model,
  context,
  onStartOver,
}: {
  model: KioskModel;
  context: ScreenContext;
  /** Opens the «Начать заново?» confirmation (owner decision 2026-10-13). */
  onStartOver?: () => void;
}) {
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
  const canCancelDemo =
    !!model.demo && !!model.cancelPayment && model.order?.payment_state === 'pending' && !unknown;
  // A live Kaspi QR: the footer keeps the way to staff and a secondary "I paid - check"
  // (the not-yet card option no longer takes the main spot under the guest's hand).
  const kaspiQr =
    !!model.commercial && showQr && !unknown && !declined && model.paymentMethod !== 'card';

  // Staff demo mode (owner decision 2026-10-11): the outcome is chosen locally, the in-memory
  // demo transport never reaches a bank.
  const demoOutcomes =
    model.demo && model.order && !declined ? (
      <Wrapper dir="row" gap={12} width="100%" align="center">
        <Wrapper flex={1}>
          <Button
            label={t.demoPaid}
            tone="inverse"
            testID="kiosk-demo-paid"
            size="compact"
            busy={model.busy}
            onPress={() => void model.pay('approved')}
            fullWidth
          />
        </Wrapper>
        <Wrapper flex={1}>
          <Button
            label={t.demoDeclined}
            tone="inverse"
            testID="kiosk-demo-declined"
            size="compact"
            busy={model.busy}
            onPress={() => void model.pay('declined')}
            fullWidth
          />
        </Wrapper>
        {unknown ? null : (
          <Wrapper flex={1}>
            <Button
              label={t.demoUnknown}
              tone="inverse"
              testID="kiosk-demo-unknown"
              size="compact"
              busy={model.busy}
              onPress={() => void model.pay('unknown')}
              fullWidth
            />
          </Wrapper>
        )}
      </Wrapper>
    ) : null;
  // Kiosk redesign 2026-10-13 (product-and-payment.md §4): the commercial Kaspi QR while it is
  // prepared or waits for the scan. Checking, an unknown result, a failure, the invoice and the
  // simulator keep the screen below unchanged; the payment logic and polling are the same.
  if (
    model.commercial &&
    !unknown &&
    !declined &&
    !invoice &&
    (qr?.state === 'preparing' || qr?.state === 'pending')
  ) {
    const pc = paymentCopy(context.locale);
    const number =
      model.order?.number && model.order.number !== '-'
        ? pc.orderNo.replace('{n}', kioskTicketNumber(model.order.number))
        : null;
    const mode = model.mode ? (model.mode === 'dine_in' ? pc.dineIn : pc.takeaway) : null;
    return (
      <ScreenSurface testID="kiosk-screen-payment" tone="brand" entrance={context.direction}>
        <RadialBackdrop />
        <StarField />
        <PaymentHeader
          locale={context.locale}
          setLocale={context.setLocale}
          title={pc.title}
          subtitle={[number, mode].filter(Boolean).join(' · ') || undefined}
          onHelp={context.onHelp}
        />
        <StepPills current="payment" locale={context.locale} />
        <ScrollArea testID="kiosk-payment-scroll" fill>
          <Wrapper
            flex={1}
            paddingX={16}
            paddingY={model.demo ? 14 : 24}
            gap={model.demo ? 18 : 30}
            align="center"
            justify="center"
          >
            <KaspiAmount total={total} locale={context.locale} />
            <Wrapper align="center" gap={model.demo ? 10 : 22}>
              <QrPlate
                payload={qrPayload}
                label={model.demo ? t.demoQr : t.payKaspiQR}
                message={qrExpired ? pc.qrExpired : pc.qrPreparing}
                expired={qrExpired}
                demoWarning={model.demo ? t.demoQr : null}
                compact={!!model.demo}
              />
              <QrTimer expiresAt={qrPayload ? qr?.expiresAt : null} locale={context.locale} />
            </Wrapper>
            {demoOutcomes}
            {model.demo ? (
              <Body tone="onBlue">{t.demoQrHint}</Body>
            ) : (
              <QrStepTiles locale={context.locale} />
            )}
          </Wrapper>
        </ScrollArea>
        <PaymentPanel
          lines={model.cart}
          checking={model.busy}
          busy={model.busy}
          locale={context.locale}
          restart={!!model.canStartOver && !!onStartOver}
          onRestart={() => onStartOver?.()}
          // The live QR bridge has no cancellation: staff is the way out besides starting over.
          // Only the isolated demo previews a cancellation of its unpaid QR.
          actionLabel={canCancelDemo ? t.cancelPayment : undefined}
          onAction={canCancelDemo ? context.onCancel : context.onHelp}
        />
      </ScreenSurface>
    );
  }
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
          ? model.demo
            ? t.demoQrHint
            : t.qrScan
          : qrExpired
            ? t.qrExpired
            : t.qrPreparing
      : t.testPayment;
  return (
    <ScreenSurface testID="kiosk-screen-payment" tone="brand" entrance={context.direction}>
      {/* Design 07: "Оплата" centred, "Помощь" on the right; the footer owns the way out. */}
      <Header {...context} title={checkoutCopy(context.locale).payment} centered helpPill />
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
                    : t.payKaspiQR
                  : t.card
            }
            message={message}
            qrPayload={qrPayload}
            expiresAt={qr?.expiresAt ?? null}
            method={model.paymentMethod === 'card' ? 'card' : invoice ? 'invoice' : 'qr'}
            locale={context.locale}
            demoWarning={model.demo ? t.demoQr : null}
            checking={model.busy}
          />
          {demoOutcomes}
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
        {/* A true cancellation preview exists only in the isolated demo transport.
            The live QR bridge has no cancellation endpoint; staff remains its way out. */}
        <Wrapper dir="row" gap={14} align="center">
          {canCancelDemo || !model.commercial ? (
            <Button
              label={canCancelDemo ? t.cancelPayment : t.cancel}
              tone="outline"
              testID="kiosk-payment-cancel"
              disabled={model.busy}
              onPress={context.onCancel}
            />
          ) : null}
          <Wrapper flex={1}>
            {kaspiQr ? (
              <Button
                testID="kiosk-payment-retry"
                label={model.busy ? t.checkingPayment : t.paidCheck}
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
export function OrderScreen({ model, context }: { model: KioskModel; context: ScreenContext }) {
  const t = copy(context.locale);
  const order = model.order;
  const { paid, failed, waitingForNumber, incident, canReset, hold, cancel } =
    orderScreenState(model);
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
      ? t.paidNumberPending
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
        <Wrapper flex={1} paddingX={60} paddingY={24} gap={12} justify="center">
          <OrderTicket
            number={number}
            status={status}
            confirmed={paid && !model.recoveryRequired}
            stage={stage}
            showBoard={order?.state === 'preparing' || order?.state === 'ready'}
            locale={context.locale}
            receipt={
              model.demo
                ? t.demoReceipt
                : incident
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
            {/* Design 08: the white "Новый заказ · 15" pill beside a glass help. */}
            {cancel ? (
              // Payment result unknown: leave now, by the same path as the auto-reset.
              <Button
                label={`${t.cancel} · ${seconds}`}
                testID="kiosk-payment-unknown-cancel"
                tone="light"
                busy={model.busy}
                onPress={() => void model.newGuest()}
                fullWidth
              />
            ) : (
              <Button
                label={`${t.nextGuest}${canReset ? ` · ${seconds}` : ''}`}
                testID="kiosk-next-guest"
                tone="light"
                disabled={!canReset}
                busy={model.busy}
                onPress={() => void model.newGuest()}
                fullWidth
              />
            )}
          </Wrapper>
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
        </Wrapper>
      </ScrollArea>
      <Footer tone="brand">
        <Wrapper dir="row" gap={14} align="center">
          {/* Audit 19.10, finding 3.0: a money-safe service reset for staff (code required). */}
          {model.staffResetAvailable && context.onStaffHold ? (
            <Button
              testID="kiosk-staff-service"
              label={t.staffService}
              tone="outline"
              disabled={model.busy}
              onPress={context.onStaffHold}
            />
          ) : null}
          <Wrapper flex={1}>
            <Button
              testID="kiosk-payment-retry"
              label={t.refresh}
              busy={model.busy}
              onPress={() => void model.recover()}
              fullWidth
            />
          </Wrapper>
        </Wrapper>
      </Footer>
    </ScreenSurface>
  );
}
