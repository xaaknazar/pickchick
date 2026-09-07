import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import useKioskController from './useKioskController';
import type { KioskModel } from './model';
import { copy, type Locale } from './i18n';
import { colors, useMetrics } from './theme';
import { Body, Button, Dialog, Heading, layout, type ScreenContext } from './components/UI';
import { WelcomeScreen, ModeScreen } from './screens/WelcomeMode';
import { MenuScreen } from './screens/MenuScreen';
import { ProductScreen } from './screens/ProductScreen';
import { CartScreen, ReviewScreen, UpsellScreen } from './screens/CartScreens';
import { OrderScreen, PaymentScreen, RecoveryScreen } from './screens/PaymentOrderScreens';
export function KioskApp() {
  const liveModel = useKioskController();
  const { px } = useMetrics();
  const [locale, setLocale] = useState<Locale>('ru');
  const [help, setHelp] = useState(false);
  const [cancel, setCancel] = useState(false);
  const t = copy(locale);
  const upsellSeen = useRef(false);
  const previousStep = useRef(liveModel.step);
  useEffect(() => {
    if (liveModel.step === 'start' && previousStep.current !== 'start') {
      upsellSeen.current = false;
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
    if (model.recoveryRequired || model.order?.payment_state === 'simulated_unknown') {
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
      <View
        style={[
          layout.screen,
          { alignItems: 'center', justifyContent: 'center', gap: px(28), padding: px(40) },
        ]}
      >
        <ActivityIndicator size="large" color={colors.blue} />
        <Heading size={34}>{t.loading}</Heading>
        {model.error ? (
          <>
            <Body>{model.error}</Body>
            <Button label={t.tryAgain} onPress={() => void model.recover()} busy={model.busy} />
          </>
        ) : null}
      </View>
    );
  else if (model.step === 'recovery') screen = <RecoveryScreen model={model} context={context} />;
  else if (!model.catalog && !model.order)
    screen = (
      <View style={[layout.screen, { justifyContent: 'center', padding: px(50), gap: px(28) }]}>
        <Heading size={42}>{t.unavailable}</Heading>
        <Button label={t.tryAgain} busy={model.busy} onPress={() => void model.refresh()} />
      </View>
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
        screen = <MenuScreen model={model} context={context} />;
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
          <MenuScreen model={model} context={context} />
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
    <View style={layout.screen} onTouchStart={model.touch}>
      {screen}
      {model.ready && model.error ? (
        <View
          accessibilityRole="alert"
          testID="kiosk-error"
          style={{
            backgroundColor: '#FFF0E9',
            borderTopWidth: 1,
            borderColor: '#F4C7AE',
            paddingHorizontal: px(24),
            paddingVertical: px(14),
          }}
        >
          <Body style={{ color: '#913A12', fontSize: Math.max(16, px(18)) }}>{model.error}</Body>
        </View>
      ) : null}
      <Dialog visible={help} onClose={() => setHelp(false)} testID="kiosk-help">
        <Heading size={44}>{t.helpTitle}</Heading>
        <Body>{t.helpBody}</Body>
        <Button label={t.close} onPress={() => setHelp(false)} />
      </Dialog>
      <Dialog visible={cancel} onClose={closeCancel} testID="kiosk-cancel-dialog">
        <Heading size={44}>{t.cancelQuestion}</Heading>
        <Body>
          {model.recoveryRequired || model.order?.payment_state === 'simulated_unknown'
            ? t.unknownBody
            : model.order
              ? t.testPayment
              : t.cancelBody}
        </Body>
        <Button label={t.keep} testID="kiosk-cancel-dismiss" onPress={closeCancel} />
        <Button
          label={
            model.recoveryRequired || model.order?.payment_state === 'simulated_unknown'
              ? t.help
              : t.yesCancel
          }
          tone="outline"
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
        <Heading size={44}>{t.stillHere}</Heading>
        <Heading size={76} color={colors.orange}>
          {model.idleWarningSeconds}
        </Heading>
        <Button label={t.continueOrder} testID="kiosk-idle-continue" onPress={model.stay} />
        <Button
          label={t.restart}
          tone="outline"
          testID="kiosk-idle-reset"
          busy={model.busy}
          onPress={() => void model.newGuest()}
        />
      </Dialog>
    </View>
  );
}
export default KioskApp;
