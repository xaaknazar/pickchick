import { useCallback, useEffect, useRef, useState } from 'react';
import useKioskController from '../useKioskController';
import type { KioskModel, KioskStep } from '../model';
import { copy, type Locale } from '../i18n';
import { Body, Button, Dialog, Heading, ScreenSurface, type ScreenContext } from '../components/UI';
import { WelcomeScreen, ModeScreen } from '../screens/WelcomeMode';
import { MenuScreen, type MenuMemory } from '../screens/MenuScreen';
import { ProductScreen } from '../screens/ProductScreen';
import { CartScreen, ReviewScreen, UpsellScreen, type UpsellMemory } from '../screens/CartScreens';
import { OrderScreen, PaymentScreen, RecoveryScreen } from '../screens/PaymentOrderScreens';
import { BootState } from '../components/BootState';
import { Notice } from '../components/Notice';
import { DemoBadge } from '../components/DemoBadge';
import { StaffPinField } from '../components/StaffPinField';
import { KioskHealthList } from '../components/KioskHealthList';
import { kioskHealthLines, type KioskHealthFacts } from '../kiosk-health';
import { guestErrorText } from '../guestError';
import { paymentCopy } from '../paymentCopy';
import { ScreenTransition } from '../components/ScreenTransition';
// Prototype flow order: moving to a later step slides in from the right, to an
// earlier one from the left. A finished order starting over counts as forward.
const flow: KioskStep[] = [
  'start',
  'mode',
  'menu',
  'product',
  'upsell',
  'cart',
  'loyalty',
  'payment',
  'order',
];
const directionOf = (from: KioskStep, to: KioskStep): 'forward' | 'back' =>
  from === 'order' && to === 'start'
    ? 'forward'
    : flow.indexOf(to) >= 0 && flow.indexOf(to) < flow.indexOf(from)
      ? 'back'
      : 'forward';
export function GuestScreen() {
  const liveModel = useKioskController();
  const [locale, setLocale] = useState<Locale>('ru');
  const [help, setHelp] = useState(false);
  const [cancel, setCancel] = useState(false);
  // «Начать заново?» on the Kaspi QR (owner decision 2026-10-13).
  const [restartAsk, setRestartAsk] = useState(false);
  // Staff dialog (long hold on the start screen logo, «Сотруднику» on the recovery screen): demo
  // mode and the service reset, both behind the staff code (audit 19.10, findings 3.0/3.1/3.4).
  const [demoAsk, setDemoAsk] = useState(false);
  // Staff code typed in the staff or restart dialog; cleared whenever a dialog closes.
  const [pin, setPin] = useState('');
  // Stage 2: the kiosk health line shown in the staff dialog after the staff code.
  const [health, setHealth] = useState<KioskHealthFacts | null>(null);
  useEffect(() => {
    if (!demoAsk) setHealth(null);
  }, [demoAsk]);
  const t = copy(locale);
  const upsellMemory = useRef<UpsellMemory>({ base: null });
  const menuMemory = useRef<MenuMemory>({ category: 'combo', offsets: {} });
  const previousStep = useRef(liveModel.step);
  // Where the visible step came from, settled once per step change.
  const arrival = useRef<{
    step: KioskStep;
    from: KioskStep | 'boot';
    direction: 'forward' | 'back';
  }>({ step: liveModel.step, from: 'boot', direction: 'forward' });
  // Every opening of a product page is a new screen: a page still closing its circle
  // (460 ms) is never reused half-open when the same product is tapped again.
  const productVisit = useRef(0);
  if (arrival.current.step !== liveModel.step) {
    if (liveModel.step === 'product') productVisit.current += 1;
    arrival.current = {
      step: liveModel.step,
      from: arrival.current.step,
      direction: directionOf(arrival.current.step, liveModel.step),
    };
  }
  useEffect(() => {
    if (previousStep.current === 'payment' && liveModel.step !== 'payment') {
      setCancel(false);
      setRestartAsk(false);
      setPin('');
    }
    if (liveModel.step === 'start' && previousStep.current !== 'start') {
      upsellMemory.current = { base: null };
      menuMemory.current = { category: 'combo', offsets: {} };
      setLocale('ru');
      setCancel(false);
      setRestartAsk(false);
      setHelp(false);
      setPin('');
    }
    previousStep.current = liveModel.step;
  }, [liveModel.step]);
  const setCatalogLocale = liveModel.setCatalogLocale;
  useEffect(() => setCatalogLocale?.(locale), [locale, setCatalogLocale]);
  // Redesign 2026-10-13: «Оформить заказ» always opens the smart upsell, which starts over from
  // the order as it is now (a visit to a product page from it keeps what it remembered).
  const openUpsell = useCallback(() => {
    upsellMemory.current = { base: null };
    liveModel.openUpsell();
  }, [liveModel.openUpsell]);
  const model: KioskModel = { ...liveModel, openUpsell };
  // Errors come with a code in the guest's language; the simulator keeps its own text.
  // NOT_ACCEPTING is never shown (owner decision 2026-10-11, guestError.ts).
  const errorText = guestErrorText(model, t);
  // iOS presents one modal at a time: the idle countdown first closes help or cancel (and the
  // product page its drinks sheet), then appears once they are gone.
  const warning = model.idleWarningSeconds !== null && !model.order && !model.recoveryRequired;
  const [idleShown, setIdleShown] = useState(false);
  useEffect(() => {
    if (!warning) {
      setIdleShown(false);
      return;
    }
    setHelp(false);
    setCancel(false);
    setRestartAsk(false);
    setDemoAsk(false);
    const timer = setTimeout(() => setIdleShown(true), 300);
    return () => clearTimeout(timer);
  }, [warning]);
  const context: ScreenContext = {
    locale,
    setLocale: (value) => {
      model.touch();
      setLocale(value);
    },
    onHelp: () => setHelp(true),
    onCancel: () => setCancel(true),
    onStaffHold: model.setDemo || model.staffReset ? () => setDemoAsk(true) : undefined,
    direction: arrival.current.direction,
    from: arrival.current.from,
  };
  const closeCancel = () => setCancel(false);
  const clearStaffError = model.clearStaffError;
  const closeStaff = () => {
    setDemoAsk(false);
    setPin('');
    setHealth(null);
    clearStaffError?.();
  };
  const closeRestart = () => {
    setRestartAsk(false);
    setPin('');
    clearStaffError?.();
  };
  // The demo is entered only from the idle start screen; the service reset only when offered.
  const canDemo =
    !!model.setDemo && model.step === 'start' && !model.order && !model.recoveryRequired;
  const canReset = !!model.staffReset && !!model.staffResetAvailable;
  const pinReady = !model.staffPinRequired || pin.length >= 4;
  const paying = model.step === 'payment';
  const demoCancelPayment =
    paying &&
    !!model.demo &&
    !!model.cancelPayment &&
    model.order?.payment_state === 'pending' &&
    !model.recoveryRequired;
  // A live Kaspi QR (or any commercial order) cannot be cancelled from the kiosk.
  const noCancel = !!model.commercial && !!model.order && paying && !demoCancelPayment;
  const unresolved =
    model.recoveryRequired ||
    ['simulated_unknown', 'unknown', 'pending'].includes(model.order?.payment_state ?? '');
  const confirmCancel = async () => {
    if (demoCancelPayment) {
      if (await model.cancelPayment?.()) setCancel(false);
      return;
    }
    if (unresolved || noCancel) {
      setCancel(false);
      setHelp(true);
      return;
    }
    const success = model.order ? await model.cancelOrder() : await model.newGuest();
    if (success) setCancel(false);
  };
  let screen;
  let screenKey: string = model.step;
  if (!model.ready) {
    screenKey = 'boot';
    screen = (
      <BootState
        title={t.loading}
        message={model.error}
        busy={model.busy}
        onRetry={model.error ? () => void model.recover() : undefined}
        retryLabel={t.tryAgain}
      />
    );
  } else if (model.step === 'recovery') screen = <RecoveryScreen model={model} context={context} />;
  else if (!model.catalog && !model.order) {
    screenKey = 'unavailable';
    screen = (
      <BootState
        title={t.unavailable}
        loading={false}
        busy={model.busy}
        onRetry={() => void model.refresh()}
        retryLabel={t.tryAgain}
      />
    );
  } else
    switch (model.step) {
      case 'start':
        screen = <WelcomeScreen model={model} context={context} />;
        break;
      case 'mode':
        screen = <ModeScreen model={model} context={context} />;
        break;
      case 'menu':
        screen = <MenuScreen model={model} context={context} memory={menuMemory.current} />;
        break;
      case 'product':
        screenKey = model.selectedProduct
          ? `product-${model.selectedProduct.id}-${productVisit.current}`
          : 'menu';
        screen = model.selectedProduct ? (
          <ProductScreen
            key={screenKey}
            product={model.selectedProduct}
            model={model}
            context={context}
          />
        ) : (
          <MenuScreen model={model} context={context} memory={menuMemory.current} />
        );
        break;
      case 'upsell':
        screen = <UpsellScreen model={model} context={context} memory={upsellMemory.current} />;
        break;
      case 'cart':
        screen = <CartScreen model={model} context={context} />;
        break;
      case 'loyalty':
        screen = <ReviewScreen model={model} context={context} />;
        break;
      case 'payment':
        screen = (
          <PaymentScreen
            model={model}
            context={context}
            onStartOver={() => {
              model.touch();
              setRestartAsk(true);
            }}
          />
        );
        break;
      case 'order':
        screen = <OrderScreen model={model} context={context} />;
        break;
    }
  return (
    <ScreenSurface onTouchStart={model.touch}>
      {/* The product page opens and closes as a circle over the menu. */}
      <ScreenTransition
        screenKey={screenKey}
        reveal={screenKey.startsWith('product-')}
        diningMode={model.mode}
      >
        {screen}
      </ScreenTransition>
      {model.ready && errorText && (model.catalog || model.order || model.recoveryRequired) ? (
        <Notice
          testID="kiosk-error"
          body={errorText}
          tone={
            model.errorCode === 'CONNECTION' || model.errorCode === 'OFFLINE' ? 'info' : 'error'
          }
        />
      ) : null}
      {model.demo ? <DemoBadge locale={locale} onExit={() => model.setDemo?.(false)} /> : null}
      <Dialog visible={demoAsk && !warning} onClose={closeStaff} testID="kiosk-demo-dialog">
        {model.demo ? (
          <>
            <Heading size="title">{t.demoExitTitle}</Heading>
            <Body>{t.demoExitBody}</Body>
            <Button
              label={t.demoTurnOff}
              testID="kiosk-demo-confirm"
              onPress={() => {
                closeStaff();
                void model.setDemo?.(false);
              }}
            />
          </>
        ) : health ? (
          <>
            <Heading size="title">{t.healthTitle}</Heading>
            <Body tone="muted">{t.healthBody}</Body>
            <KioskHealthList lines={kioskHealthLines(health, locale)} locale={locale} />
          </>
        ) : (
          <>
            <Heading size="title">
              {model.staffPinRequired ? t.staffTitle : t.demoEnterTitle}
            </Heading>
            <Body>{model.staffPinRequired ? t.staffBody : t.demoEnterBody}</Body>
            {canReset ? <Body tone="muted">{t.staffResetBody}</Body> : null}
            {model.staffPinRequired ? (
              <StaffPinField
                value={pin}
                onChange={setPin}
                locale={locale}
                error={model.staffPinError}
                busy={model.busy}
              />
            ) : null}
            {canDemo ? (
              <Button
                label={model.staffPinRequired ? t.staffDemo : t.demoTurnOn}
                testID="kiosk-demo-confirm"
                busy={model.busy}
                disabled={!pinReady}
                onPress={() =>
                  void model.setDemo?.(true, pin).then((on) => {
                    if (on) closeStaff();
                    else setPin('');
                  })
                }
              />
            ) : null}
            {canReset ? (
              <Button
                label={t.staffReset}
                tone="secondary"
                testID="kiosk-staff-reset"
                busy={model.busy}
                disabled={!pinReady}
                onPress={() =>
                  void model.staffReset?.(pin).then((done) => {
                    if (done) closeStaff();
                    else setPin('');
                  })
                }
              />
            ) : null}
            {model.staffHealth ? (
              <Button
                label={t.staffHealth}
                tone="secondary"
                testID="kiosk-staff-health"
                busy={model.busy}
                disabled={!pinReady}
                onPress={() =>
                  void model.staffHealth?.(pin).then((facts) => {
                    // The code is never kept, whatever the answer.
                    setPin('');
                    if (facts) setHealth(facts);
                  })
                }
              />
            ) : null}
          </>
        )}
        <Button
          label={health && !model.demo ? t.close : t.demoCancel}
          tone="secondary"
          testID="kiosk-demo-dismiss"
          onPress={closeStaff}
        />
      </Dialog>
      <Dialog visible={help && !warning} onClose={() => setHelp(false)} testID="kiosk-help">
        <Heading size="title">{t.helpTitle}</Heading>
        <Body>{model.commercial ? t.helpCommercial : t.helpBody}</Body>
        <Button label={t.close} onPress={() => setHelp(false)} />
      </Dialog>
      <Dialog visible={cancel && !warning} onClose={closeCancel} testID="kiosk-cancel-dialog">
        <Heading size="title">
          {demoCancelPayment
            ? t.cancelPaymentQuestion
            : noCancel
              ? t.qrNoCancelTitle
              : t.cancelQuestion}
        </Heading>
        <Body>
          {demoCancelPayment
            ? t.cancelPaymentBody
            : noCancel
              ? t.qrNoCancel
              : unresolved
                ? t.unknownBody
                : model.order
                  ? model.commercial
                    ? t.unknownBody
                    : t.testPayment
                  : t.cancelBody}
        </Body>
        <Button
          label={paying ? t.backToPayment : t.keep}
          testID="kiosk-cancel-dismiss"
          onPress={closeCancel}
        />
        {demoCancelPayment || (!noCancel && !unresolved) ? (
          <Button
            label={demoCancelPayment ? t.cancelPayment : t.yesCancel}
            tone="secondary"
            testID="kiosk-cancel-confirm"
            busy={model.busy}
            onPress={() => void confirmCancel()}
          />
        ) : null}
      </Dialog>
      {/* Owner decision 2026-10-13: the guest gives up at the QR and the kiosk starts over. The
          QR is not revoked; a late payment is still captured by the server (staff, as before).
          Shown only while the controller allows it. */}
      <Dialog
        visible={restartAsk && !!model.canStartOver && !warning}
        onClose={closeRestart}
        testID="kiosk-restart-dialog"
      >
        <Heading size="title">{paymentCopy(locale).startOverTitle}</Heading>
        <Body>
          {model.startOverNeedsStaff
            ? paymentCopy(locale).startOverStaffBody
            : paymentCopy(locale).startOverBody}
        </Body>
        {/* Audit 19.10, finding 3.3: a QR shown for a while may be scanned; staff decides. */}
        {model.startOverNeedsStaff ? (
          <StaffPinField
            value={pin}
            onChange={setPin}
            locale={locale}
            error={model.staffPinError}
            busy={model.busy}
          />
        ) : null}
        <Button
          label={paymentCopy(locale).backToPayment}
          testID="kiosk-restart-dismiss"
          onPress={closeRestart}
        />
        <Button
          label={paymentCopy(locale).startOver}
          tone="secondary"
          testID="kiosk-restart-confirm"
          busy={model.busy}
          disabled={!!model.startOverNeedsStaff && pin.length < 4}
          onPress={() =>
            void model.startOver?.(model.startOverNeedsStaff ? pin : undefined).then((done) => {
              if (done) setPin('');
            })
          }
        />
      </Dialog>
      <Dialog visible={idleShown} onClose={model.stay} testID="kiosk-idle-dialog">
        <Heading size="title">{t.stillHere}</Heading>
        <Body tone="muted">{t.willCancel}</Body>
        <Heading size="display" tone="brand">
          {`${model.idleWarningSeconds ?? 0} ${t.secondsShort}`}
        </Heading>
        <Button label={t.continueOrder} testID="kiosk-idle-continue" onPress={model.stay} />
        <Button
          label={t.restart}
          tone="secondary"
          testID="kiosk-idle-reset"
          busy={model.busy}
          onPress={() => void model.newGuest()}
        />
      </Dialog>
    </ScreenSurface>
  );
}
