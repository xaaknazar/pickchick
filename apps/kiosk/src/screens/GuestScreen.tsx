import { useCallback, useEffect, useRef, useState } from 'react';
import useKioskController from '../useKioskController';
import type { KioskModel } from '../model';
import { copy, type Locale } from '../i18n';
import { Body, Button, Dialog, Heading, ScreenSurface, type ScreenContext } from '../components/UI';
import { WelcomeScreen, ModeScreen } from '../screens/WelcomeMode';
import { MenuScreen, type MenuMemory } from '../screens/MenuScreen';
import { ProductScreen } from '../screens/ProductScreen';
import { CartScreen, ReviewScreen, UpsellScreen } from '../screens/CartScreens';
import { OrderScreen, PaymentScreen, RecoveryScreen } from '../screens/PaymentOrderScreens';
import { BootState } from '../components/BootState';
import { Notice } from '../components/Notice';
export function GuestScreen() {
  const liveModel = useKioskController();
  const [locale, setLocale] = useState<Locale>('ru');
  const [help, setHelp] = useState(false);
  const [cancel, setCancel] = useState(false);
  const t = copy(locale);
  const upsellSeen = useRef(false);
  const menuMemory = useRef<MenuMemory>({ category: 'combo', offsets: {} });
  const previousStep = useRef(liveModel.step);
  useEffect(() => {
    if (liveModel.step === 'start' && previousStep.current !== 'start') {
      upsellSeen.current = false;
      menuMemory.current = { category: 'combo', offsets: {} };
      setLocale('ru');
      setCancel(false);
      setHelp(false);
    }
    previousStep.current = liveModel.step;
  }, [liveModel.step]);
  const openUpsell = useCallback(() => {
    if (upsellSeen.current || BigInt(liveModel.cartTotalMinor) > 1000000n) liveModel.openCart();
    else {
      upsellSeen.current = true;
      liveModel.openUpsell();
    }
  }, [liveModel.cartTotalMinor, liveModel.openCart, liveModel.openUpsell]);
  const model: KioskModel = { ...liveModel, openUpsell };
  const context: ScreenContext = {
    locale,
    setLocale: (value) => {
      model.touch();
      setLocale(value);
    },
    onHelp: () => setHelp(true),
    onCancel: () => setCancel(true),
  };
  const closeCancel = () => setCancel(false);
  const confirmCancel = async () => {
    if (
      model.recoveryRequired ||
      ['simulated_unknown', 'unknown', 'pending'].includes(model.order?.payment_state ?? '')
    ) {
      setCancel(false);
      setHelp(true);
      return;
    }
    const success = model.order ? await model.cancelOrder() : await model.newGuest();
    if (success) setCancel(false);
  };
  let screen;
  if (!model.ready)
    screen = (
      <BootState
        title={t.loading}
        message={model.error}
        busy={model.busy}
        onRetry={model.error ? () => void model.recover() : undefined}
        retryLabel={t.tryAgain}
      />
    );
  else if (model.step === 'recovery') screen = <RecoveryScreen model={model} context={context} />;
  else if (!model.catalog && !model.order)
    screen = (
      <BootState
        title={t.unavailable}
        loading={false}
        busy={model.busy}
        onRetry={() => void model.refresh()}
        retryLabel={t.tryAgain}
      />
    );
  else
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
        screen = model.selectedProduct ? (
          <ProductScreen
            key={model.selectedProduct.id}
            product={model.selectedProduct}
            model={model}
            context={context}
          />
        ) : (
          <MenuScreen model={model} context={context} memory={menuMemory.current} />
        );
        break;
      case 'upsell':
        screen = <UpsellScreen model={model} context={context} />;
        break;
      case 'cart':
        screen = <CartScreen model={model} context={context} />;
        break;
      case 'loyalty':
        screen = <ReviewScreen model={model} context={context} />;
        break;
      case 'payment':
        screen = <PaymentScreen model={model} context={context} />;
        break;
      case 'order':
        screen = <OrderScreen model={model} context={context} />;
        break;
    }
  return (
    <ScreenSurface onTouchStart={model.touch}>
      {screen}
      {model.ready && model.error && (model.catalog || model.order || model.recoveryRequired) ? (
        <Notice testID="kiosk-error" body={model.error} tone="error" />
      ) : null}
      <Dialog visible={help} onClose={() => setHelp(false)} testID="kiosk-help">
        <Heading size="title">{t.helpTitle}</Heading>
        <Body>
          {model.commercial
            ? locale === 'ru'
              ? 'Пригласите сотрудника ресторана. Если результат оплаты неизвестен, не оплачивайте повторно.'
              : 'Мейрамхана қызметкерін шақырыңыз. Төлем нәтижесі белгісіз болса, қайта төлемеңіз.'
            : t.helpBody}
        </Body>
        <Button label={t.close} onPress={() => setHelp(false)} />
      </Dialog>
      <Dialog visible={cancel} onClose={closeCancel} testID="kiosk-cancel-dialog">
        <Heading size="title">{t.cancelQuestion}</Heading>
        <Body>
          {model.recoveryRequired ||
          ['simulated_unknown', 'unknown', 'pending'].includes(model.order?.payment_state ?? '')
            ? t.unknownBody
            : model.order
              ? model.commercial
                ? t.unknownBody
                : t.testPayment
              : t.cancelBody}
        </Body>
        <Button label={t.keep} testID="kiosk-cancel-dismiss" onPress={closeCancel} />
        <Button
          label={
            model.recoveryRequired ||
            ['simulated_unknown', 'unknown', 'pending'].includes(model.order?.payment_state ?? '')
              ? t.help
              : t.yesCancel
          }
          tone="secondary"
          testID="kiosk-cancel-confirm"
          busy={model.busy}
          onPress={() => void confirmCancel()}
        />
      </Dialog>
      <Dialog
        visible={model.idleWarningSeconds !== null && !model.order && !model.recoveryRequired}
        onClose={model.stay}
        testID="kiosk-idle-dialog"
      >
        <Heading size="title">{t.stillHere}</Heading>
        <Heading size="display" tone="brand">
          {model.idleWarningSeconds}
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
