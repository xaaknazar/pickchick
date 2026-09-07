import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { KioskModel } from '../model';
import { money } from '../cart';
import { assets } from '../assets';
import { copy } from '../i18n';
import { colors, useMetrics } from '../theme';
import {
  Body,
  Button,
  Footer,
  Header,
  Heading,
  Icon,
  Logo,
  layout,
  type ScreenContext,
} from '../components/UI';
export function PaymentScreen({ model, context }: { model: KioskModel; context: ScreenContext }) {
  const { px } = useMetrics();
  const t = copy(context.locale);
  const unknown = model.order?.payment_state === 'simulated_unknown' || model.recoveryRequired;
  const declined = model.order?.payment_state === 'simulated_declined';
  const total = model.order?.snapshot.total_minor ?? model.cartTotalMinor;
  return (
    <View testID="kiosk-screen-payment" style={layout.screen}>
      <Header {...context} title={t.payment} />
      <ScrollView
        style={layout.grow}
        contentContainerStyle={{
          flexGrow: 1,
          padding: px(48),
          gap: px(28),
          justifyContent: 'center',
        }}
      >
        <View style={{ alignItems: 'center', gap: px(24) }}>
          <View
            style={{
              width: px(120),
              height: px(120),
              borderRadius: px(36),
              backgroundColor: unknown ? '#FFF0E5' : '#E8EFFC',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon
              name={unknown ? 'time-outline' : declined ? 'close-circle-outline' : 'card-outline'}
              size={px(68)}
              color={unknown ? colors.orange : colors.blue}
            />
          </View>
          <Heading size={48} style={{ textAlign: 'center' }}>
            {unknown ? t.unknownTitle : declined ? t.declined : t.waiting}
          </Heading>
          <Heading size={62} color={colors.blue}>
            {money(total)}
          </Heading>
          <Body style={{ textAlign: 'center', color: colors.muted }}>
            {model.paymentMethod === 'kaspi' ? 'Kaspi' : t.card} · {model.order?.number}
          </Body>
          <Body style={{ textAlign: 'center', color: colors.muted, maxWidth: 700 }}>
            {unknown ? t.unknownBody : t.testPayment}
          </Body>
        </View>
        {!unknown ? (
          <View style={{ gap: px(16), marginTop: px(24) }}>
            <Button
              label={t.decline}
              tone="outline"
              testID="kiosk-payment-decline"
              compact
              busy={model.busy}
              onPress={() => void model.pay('declined')}
            />
            <Button
              label={t.unknown}
              tone="outline"
              testID="kiosk-payment-unknown"
              compact
              busy={model.busy}
              onPress={() => void model.pay('unknown')}
            />
          </View>
        ) : (
          <Button label={t.help} tone="outline" onPress={context.onHelp} />
        )}
      </ScrollView>
      <Footer>
        <Button
          testID={
            unknown
              ? 'kiosk-payment-retry'
              : declined
                ? 'kiosk-payment-retry'
                : 'kiosk-payment-approve'
          }
          label={unknown ? t.refresh : declined ? t.retry : t.approve}
          busy={model.busy}
          onPress={() => (unknown ? void model.recover() : void model.pay('approved'))}
          style={{ minHeight: px(126) }}
        />
      </Footer>
    </View>
  );
}
export function OrderScreen({ model, context }: { model: KioskModel; context: ScreenContext }) {
  const { px, width, landscape } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(context.locale);
  const order = model.order;
  const canReset =
    !!order && order.payment_state === 'simulated_approved' && !model.recoveryRequired;
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
          current.order?.payment_state === 'simulated_approved' &&
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
        : order?.state === 'cancelled'
          ? t.cancelled
          : order?.state === 'preparing'
            ? t.preparing
            : t.waiting;
  const number = order?.number ?? '—';
  const numberSize = Math.min(
    px(340),
    Math.floor((width - px(96)) / Math.max(1, number.length) / 0.72),
  );
  return (
    <View testID="kiosk-screen-order" style={[layout.screen, { backgroundColor: colors.blue }]}>
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={StyleSheet.absoluteFill}
      >
        <Image source={assets.blue} contentFit="cover" style={StyleSheet.absoluteFill} />
        <LinearGradient
          colors={['rgba(0,40,110,.74)', 'rgba(0,26,80,.92)']}
          style={StyleSheet.absoluteFill}
        />
      </View>
      <ScrollView
        style={layout.grow}
        contentContainerStyle={{
          flexGrow: 1,
          alignItems: 'center',
          justifyContent: 'center',
          paddingTop: Math.max(safe.top, px(60)),
          paddingHorizontal: px(44),
          paddingBottom: px(40),
          gap: px(landscape ? 25 : 46),
        }}
      >
        <Logo size={110} />
        <Heading size={40} color={colors.white} style={{ textAlign: 'center' }}>
          {t.yourNumber}
        </Heading>
        <Heading
          testID="kiosk-order-number"
          size={numberSize / (px(100) / 100)}
          color={colors.orange}
          style={{ fontSize: numberSize, lineHeight: numberSize * 1.12, textAlign: 'center' }}
        >
          {number}
        </Heading>
        <Heading
          testID="kiosk-order-state"
          size={46}
          color={colors.white}
          style={{ textAlign: 'center' }}
        >
          {status}
        </Heading>
        {order?.state === 'preparing' || order?.state === 'ready' ? (
          <Body style={{ color: colors.white, fontSize: px(26), textAlign: 'center' }}>
            {t.board}
          </Body>
        ) : null}
        <Body style={{ color: 'rgba(255,255,255,.7)', textAlign: 'center' }}>{t.testPayment}</Body>
      </ScrollView>
      <Footer blue>
        <Button
          label={`${t.nextGuest}${canReset ? ` · ${seconds}` : ''}`}
          testID="kiosk-next-guest"
          disabled={!canReset && order?.state !== 'cancelled'}
          busy={model.busy}
          onPress={() => void model.newGuest()}
        />
        <Button compact label={t.help} tone="glass" onPress={context.onHelp} />
      </Footer>
    </View>
  );
}
export function RecoveryScreen({ model, context }: { model: KioskModel; context: ScreenContext }) {
  const { px } = useMetrics();
  const t = copy(context.locale);
  return (
    <View testID="kiosk-screen-recovery" style={layout.screen}>
      <Header {...context} title={t.restore} />
      <ScrollView
        style={layout.grow}
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          alignItems: 'center',
          padding: px(50),
          gap: px(32),
        }}
      >
        <Icon name="time-outline" size={px(110)} color={colors.blue} />
        <Heading size={48} style={{ textAlign: 'center' }}>
          {t.restore}
        </Heading>
        <Body style={{ color: colors.muted, textAlign: 'center' }}>
          {model.order?.payment_state === 'simulated_unknown' ? t.unknownBody : t.restoreBody}
        </Body>
        <Button label={t.help} tone="outline" onPress={context.onHelp} />
      </ScrollView>
      <Footer>
        <Button
          testID="kiosk-payment-retry"
          label={t.refresh}
          busy={model.busy}
          onPress={() => void model.recover()}
        />
      </Footer>
    </View>
  );
}
