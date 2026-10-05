import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  Easing,
  Linking,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import type { CustomerCommerceOrder } from '@pickchick/contracts';
import { assets } from '../assets';
import { invoiceSecondsRemaining, paymentCopy } from '../commerce-presentation';
import { money } from '../domain';
import { Body, Button, Caption, Heading, Icon, BottomActions } from './UI';
import { paymentName, PaymentMark } from './PaymentChoice';
import { useReducedMotion } from './Motion';
import { colors, font } from '../theme';
import { checkoutStyle } from './CheckoutPresentation';

export function KaspiPaymentState({
  order,
  paid = false,
  onContinue,
  onRetry,
  onCart,
  notice,
  extraAction,
}: {
  order?: CustomerCommerceOrder;
  paid?: boolean;
  onContinue(): void;
  onRetry(): void;
  onCart(): void;
  notice?: React.ReactNode;
  extraAction?: React.ReactNode;
}) {
  const reduced = useReducedMotion();
  const { height } = useWindowDimensions();
  const compact = height < 700;
  const [foreground, setForeground] = useState(AppState.currentState !== 'background');
  const [openError, setOpenError] = useState(false);
  const pulse = useRef(new Animated.Value(0)).current;
  const method = order?.paymentMethod ?? 'kaspi';
  const kaspi = method === 'kaspi';
  const phase = order?.phase ?? 'awaiting_restaurant';
  const failed = phase === 'failed';
  const waiting = phase === 'awaiting_payment';
  const [now, setNow] = useState(Date.now);
  const remaining = invoiceSecondsRemaining(order?.expiresAt ?? null, now);
  const deadlineReached = (waiting || phase === 'checking') && remaining === 0;
  useEffect(() => {
    if ((!waiting && phase !== 'checking') || !foreground || !order?.expiresAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting, foreground, order?.expiresAt, phase]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) =>
      setForeground(state === 'active'),
    );
    return () => listener.remove();
  }, []);
  useEffect(() => {
    if (reduced || !foreground || paid || failed) {
      pulse.setValue(0);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 2000,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
          isInteraction: false,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 2000,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
          isInteraction: false,
        }),
      ]),
    );
    animation.start();
    return () => {
      animation.stop();
      pulse.setValue(0);
    };
  }, [reduced, foreground, paid, failed, pulse]);
  return (
    <View
      style={s.root}
      testID={
        !order
          ? 'kaspi-connecting'
          : paid
            ? 'kaspi-paid'
            : failed
              ? 'kaspi-failed'
              : 'kaspi-waiting'
      }
    >
      <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        {notice}
        {!paid && !failed ? (
          <Heading style={s.title}>
            {deadlineReached
              ? 'Проверяем отмену счёта'
              : waiting
                ? kaspi
                  ? 'Отличный выбор!\nЖдём оплату в Kaspi'
                  : `Ждём оплату · ${paymentName(method)}`
                : paymentCopy[phase].title}
          </Heading>
        ) : null}
        {height >= 500 ? (
          <View
            style={[s.visual, (paid || failed) && s.resultVisual, compact && s.compactVisual]}
            accessible={false}
          >
            <View style={[s.scene, compact && s.compactScene]}>
              {paid || failed ? (
                <View style={[s.resultMark, paid ? s.success : s.failure]}>
                  <Icon
                    name={paid ? 'checkmark' : 'alert'}
                    size={64}
                    color={paid ? '#FFFFFF' : colors.accent}
                  />
                </View>
              ) : (
                <>
                  <Animated.View
                    style={[
                      s.glow,
                      {
                        opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.4, 0.8] }),
                        transform: [
                          {
                            scale: pulse.interpolate({
                              inputRange: [0, 1],
                              outputRange: [0.9, 1.05],
                            }),
                          },
                        ],
                      },
                    ]}
                  />
                  <Animated.View
                    style={[
                      s.ring,
                      {
                        opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0] }),
                        transform: [
                          {
                            scale: pulse.interpolate({
                              inputRange: [0, 1],
                              outputRange: [0.85, 1.18],
                            }),
                          },
                        ],
                      },
                    ]}
                  />
                  <Animated.View
                    style={{
                      transform: [
                        {
                          translateY: pulse.interpolate({
                            inputRange: [0, 1],
                            outputRange: [0, -7],
                          }),
                        },
                      ],
                    }}
                  >
                    <Image source={assets.pickManChick} contentFit="contain" style={s.hero} />
                  </Animated.View>
                  <View style={s.kaspiBadge}>
                    <PaymentMark method={method} size={56} />
                  </View>
                </>
              )}
            </View>
          </View>
        ) : null}
        {paid || failed ? (
          <Heading style={s.title}>{paid ? 'Оплачено' : 'Счёт не оплачен'}</Heading>
        ) : null}
        {!paid && !failed && phase !== 'attention' ? (
          <ActivityIndicator color={colors.accent} style={{ marginBottom: 14 }} />
        ) : null}
        <Caption style={s.detail} accessibilityLiveRegion="polite">
          {paid
            ? `${money(order?.totalMinor ?? '0')} · ${paymentName(method)}`
            : deadlineReached
              ? 'Время оплаты истекло. Ждём подтверждение банка. Если вы успели оплатить, заказ продолжится.'
              : waiting
                ? kaspi
                  ? `Подтвердите счёт на ${money(order?.totalMinor ?? '0')} в приложении Kaspi.kz. Обычно это быстро.`
                  : `Завершите оплату на защищённой странице и вернитесь в PickChick. Закрытие страницы не отменяет платёж.`
                : paymentCopy[phase].detail}
        </Caption>
        {waiting && remaining !== null && remaining > 0 ? (
          <View
            style={s.deadline}
            testID="kaspi-invoice-countdown"
            accessibilityLabel={`Осталось оплатить за ${Math.floor(remaining / 60)} минут ${remaining % 60} секунд`}
          >
            <Caption style={s.small}>На оплату осталось</Caption>
            <Body style={s.deadlineTime}>
              {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}
            </Body>
          </View>
        ) : null}
        {paid ? (
          <View style={s.orderCard}>
            <View style={s.orderColumn}>
              <Caption style={s.small}>Номер заказа</Caption>
              <Body testID="kaspi-paid-number" style={s.number}>
                {order?.displayNumber ? `№ ${order?.displayNumber}` : 'Присваивается'}
              </Body>
            </View>
            <View style={s.divider} />
            <View style={s.orderColumn}>
              <Caption style={s.small}>Как заберёте</Caption>
              <Body style={s.mode}>{order?.serviceMode === 'dine_in' ? 'В зале' : 'С собой'}</Body>
            </View>
          </View>
        ) : null}
        {openError ? (
          <Caption style={s.detail}>
            Не удалось открыть Kaspi.kz. Откройте приложение самостоятельно и найдите счёт от
            PickChick.
          </Caption>
        ) : null}
      </ScrollView>
      <BottomActions style={checkoutStyle.cartFooter}>
        {paid ? (
          <>
            <Caption style={s.detail}>
              {phase === 'paid' ? 'Передаём заказ на кухню…' : 'Открываем статус заказа…'}
            </Caption>
            <Button
              title="Следить за заказом"
              testID="kaspi-track-order"
              onPress={onContinue}
              style={s.button}
            />
          </>
        ) : failed ? (
          <>
            <Button
              title="Оплатить ещё раз"
              testID="kaspi-retry-payment"
              onPress={onRetry}
              style={s.button}
            />
            <Button title="Вернуться в корзину" secondary onPress={onCart} style={s.button} />
          </>
        ) : (
          <>
            {extraAction}
            {!order ? (
              <Button title="Вернуться к оформлению" secondary onPress={onCart} style={s.button} />
            ) : null}
            {kaspi && !deadlineReached && (waiting || phase === 'checking') ? (
              <Button
                title="Открыть Kaspi.kz"
                testID="kaspi-open-app"
                secondary
                style={s.button}
                onPress={() => {
                  setOpenError(false);
                  void Linking.openURL('https://kaspi.kz').catch(() => setOpenError(true));
                }}
              />
            ) : null}
            {order ? <Caption style={s.small}>Статус обновится после ответа банка</Caption> : null}
          </>
        )}
      </BottomActions>
    </View>
  );
}
const s = StyleSheet.create({
  deadline: { alignItems: 'center', gap: 4, marginTop: 16 },
  deadlineTime: {
    fontSize: 24,
    lineHeight: 32,
    fontFamily: font.medium,
    fontVariant: ['tabular-nums'],
  },
  root: { flex: 1, backgroundColor: colors.background },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 28,
  },
  title: {
    fontFamily: font.display,
    fontSize: 30,
    lineHeight: 36,
    letterSpacing: -0.5,
    textAlign: 'center',
    maxWidth: 380,
  },
  visual: {
    width: 280,
    height: 290,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 28,
  },
  scene: { width: 280, height: 290, alignItems: 'center', justifyContent: 'center' },
  compactScene: { transform: [{ scale: 0.58 }] },
  compactVisual: { height: 170, marginVertical: 12 },
  resultVisual: { height: 170, marginVertical: 20 },
  resultMark: {
    width: 132,
    height: 132,
    borderRadius: 66,
    alignItems: 'center',
    justifyContent: 'center',
  },
  success: { backgroundColor: '#1FAF5A' },
  failure: { backgroundColor: '#0B2255', borderWidth: 1.5, borderColor: '#FF690073' },
  glow: {
    position: 'absolute',
    width: 270,
    height: 270,
    borderRadius: 135,
    backgroundColor: '#123887',
  },
  ring: {
    position: 'absolute',
    width: 250,
    height: 250,
    borderRadius: 125,
    borderWidth: 2,
    borderColor: colors.accent,
  },
  hero: { width: 260, height: 260, borderRadius: 130 },
  kaspiBadge: {
    position: 'absolute',
    right: 10,
    bottom: 4,
    padding: 4,
    borderRadius: 20,
    backgroundColor: '#FFFFFF',
    transform: [{ rotate: '8deg' }],
  },
  detail: {
    fontSize: 15,
    lineHeight: 22,
    color: '#A3B4D6',
    textAlign: 'center',
    maxWidth: 350,
    marginTop: 10,
  },
  small: { fontSize: 12, lineHeight: 18, color: '#A3B4D6', textAlign: 'center' },
  orderCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 18,
    marginTop: 24,
    borderRadius: 22,
    backgroundColor: '#0B2255',
    width: '100%',
    maxWidth: 360,
  },
  orderColumn: { flex: 1, alignItems: 'center', gap: 4 },
  divider: { width: 1, height: 42, backgroundColor: '#FFFFFF14', marginHorizontal: 14 },
  number: { color: colors.accent, fontFamily: font.heading, fontSize: 26, lineHeight: 34 },
  mode: { fontFamily: font.heading, fontSize: 18, lineHeight: 26 },
  button: { borderRadius: 28, minHeight: 56 },
});
