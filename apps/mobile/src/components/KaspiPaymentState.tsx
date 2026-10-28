import { localize, t, useLocale } from '../i18n';
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
import { PaymentMark } from './PaymentChoice';
import { useReducedMotion } from './Motion';
import { colors, font } from '../theme';
import { checkoutStyle } from './CheckoutPresentation';
import { useTabBarInset } from './tab-bar-inset';
import { SupportContact } from './SupportContact';

const BANK_PHASES: readonly string[] = ['sending', 'awaiting_payment', 'checking'];

export function KaspiPaymentState({
  order,
  paid = false,
  onContinue,
  onRetry,
  onCart,
  notice,
  extraAction,
  canReturnToCheckout = true,
  returnLabel = 'Вернуться к оформлению',
  onClose,
  closeLabel = 'Закрыть',
  closeDelayMs = null,
  support = false,
}: {
  order?: CustomerCommerceOrder;
  paid?: boolean;
  onContinue(): void;
  onRetry(): void;
  onCart(): void;
  notice?: React.ReactNode;
  extraAction?: React.ReactNode;
  canReturnToCheckout?: boolean;
  /** The Kaspi cart is the checkout (27.10.2026): «Вернуться в корзину». */
  returnLabel?: string;
  /** Leaves this screen without touching the order or the bank (audit 0.2 / 2.0 / 2.4). */
  onClose?: () => void;
  closeLabel?: string;
  /** 0: offer close at once; >0: after this wait (the bank may still answer); null: never. */
  closeDelayMs?: number | null;
  /** Show the support contact at once (a bank wait the app can no longer settle). */
  support?: boolean;
}) {
  useLocale();
  const closable = Boolean(onClose);
  const [closeReady, setCloseReady] = useState(closeDelayMs === 0);
  useEffect(() => {
    if (!closable || closeDelayMs === null) {
      setCloseReady(false);
      return;
    }
    setCloseReady(closeDelayMs === 0);
    if (closeDelayMs === 0) return;
    const timer = setTimeout(() => setCloseReady(true), closeDelayMs);
    return () => clearTimeout(timer);
  }, [closable, closeDelayMs, order?.orderId, order?.phase]);
  const reduced = useReducedMotion();
  const tabBarInset = useTabBarInset();
  const { height, fontScale } = useWindowDimensions();
  const compact = height < 700;
  // 320 x 568 class screens (QA 27.10, items 11/16): a smaller title, scene and gaps, so the
  // amount line, the spinner and the countdown fit above the pinned buttons. Taller screens
  // (393 x 852) keep their look.
  const tight = height < 620;
  // Large text on a small screen: the words come first and the scene follows them, so the
  // amount is never pushed below the fold; the content scrolls above the buttons.
  const textFirst = compact && (fontScale || 1) > 1.2;
  const button = [s.button, tight && s.tightButton];
  const [foreground, setForeground] = useState(AppState.currentState !== 'background');
  const [openError, setOpenError] = useState(false);
  const [cancelHelp, setCancelHelp] = useState(false);
  const openKaspi = () => {
    setOpenError(false);
    void Linking.openURL('https://kaspi.kz').catch(() => setOpenError(true));
  };
  const pulse = useRef(new Animated.Value(0)).current;
  const phase = order?.phase ?? 'awaiting_restaurant';
  const failed = phase === 'failed';
  const waiting = phase === 'awaiting_payment';
  const [now, setNow] = useState(Date.now);
  const remaining = invoiceSecondsRemaining(order?.expiresAt ?? null, now);
  const deadlineReached = (waiting || phase === 'checking') && remaining === 0;
  const showCancelHelp = cancelHelp && waiting && !paid && !deadlineReached;
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
  const scene =
    height >= 500 && !showCancelHelp ? (
      <View
        style={[
          s.visual,
          (paid || failed) && s.resultVisual,
          compact && s.compactVisual,
          tight && s.tightVisual,
        ]}
        accessible={false}
      >
        <View style={[s.scene, compact && s.compactScene, tight && s.tightScene]}>
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
                <PaymentMark method="kaspi" size={56} />
              </View>
            </>
          )}
        </View>
      </View>
    ) : null;
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
      <ScrollView
        testID="kaspi-state-scroll"
        contentContainerStyle={[s.content, tight && s.tightContent]}
        showsVerticalScrollIndicator={false}
      >
        {notice}
        {!paid && !failed ? (
          <Heading style={[s.title, tight && s.tightTitle]}>
            {localize(
              showCancelHelp
                ? 'Отмена в Kaspi.kz'
                : deadlineReached
                  ? 'Проверяем отмену счёта'
                  : waiting
                    ? 'Отличный выбор!\nЖдём оплату в Kaspi'
                    : paymentCopy[phase].title,
            )}
          </Heading>
        ) : null}
        {textFirst ? null : scene}
        {paid || failed ? (
          <Heading style={[s.title, tight && s.tightTitle]}>
            {localize(paid ? 'Оплачено' : 'Счёт не оплачен')}
          </Heading>
        ) : null}
        {!paid && !failed && !showCancelHelp && phase !== 'attention' ? (
          <ActivityIndicator
            testID="kaspi-state-spinner"
            color={colors.accent}
            style={tight ? s.tightSpinner : s.spinner}
          />
        ) : null}
        {showCancelHelp ? (
          <View testID="kaspi-cancel-help" style={s.cancelHelp} accessibilityLiveRegion="polite">
            <Caption style={s.detail}>
              {t(
                'В Kaspi.kz найдите счёт PickChick в сообщениях об удалённой оплате и выберите «Отклонить счёт». Вернитесь сюда. Когда банк подтвердит отмену, можно будет изменить заказ.',
              )}
            </Caption>
            <Caption style={s.small}>
              {t('Если вы уже оплатили, дождитесь статуса заказа.')}
            </Caption>
          </View>
        ) : (
          <Caption
            testID="kaspi-state-detail"
            style={[s.detail, tight && s.tightDetail]}
            accessibilityLiveRegion="polite"
          >
            {localize(
              paid
                ? `${money(order?.totalMinor ?? '0')} · Kaspi`
                : deadlineReached
                  ? 'Время оплаты истекло. Ждём подтверждение Kaspi. Если вы успели оплатить, заказ продолжится.'
                  : waiting
                    ? t('Подтвердите счёт на {p0} в приложении Kaspi.kz. Обычно это быстро.', {
                        p0: money(order?.totalMinor ?? '0'),
                      })
                    : paymentCopy[phase].detail,
            )}
          </Caption>
        )}
        {waiting && remaining !== null && remaining > 0 ? (
          <View
            style={[s.deadline, tight && s.tightDeadline]}
            testID="kaspi-invoice-countdown"
            accessibilityLabel={localize(
              t('Осталось оплатить за {p0} минут {p1} секунд', {
                p0: Math.floor(remaining / 60),
                p1: remaining % 60,
              }),
            )}
          >
            <Caption style={s.small}>{t('На оплату осталось')}</Caption>
            <Body style={[s.deadlineTime, tight && s.tightDeadlineTime]}>
              {localize(Math.floor(remaining / 60))}:
              {localize(String(remaining % 60).padStart(2, '0'))}
            </Body>
          </View>
        ) : null}
        {textFirst ? scene : null}
        {paid ? (
          <View style={s.orderCard}>
            <View style={s.orderColumn}>
              <Caption style={s.small}>{t('Номер заказа')}</Caption>
              <Body testID="kaspi-paid-number" style={s.number}>
                {localize(order?.displayNumber ? `№ ${order?.displayNumber}` : 'Присваивается')}
              </Body>
            </View>
            <View style={s.divider} />
            <View style={s.orderColumn}>
              <Caption style={s.small}>{t('Как заберёте')}</Caption>
              <Body style={s.mode}>
                {localize(order?.serviceMode === 'dine_in' ? 'В зале' : 'С собой')}
              </Body>
            </View>
          </View>
        ) : null}
        {openError ? (
          <Caption style={s.detail}>
            {t(
              'Не удалось открыть Kaspi.kz. Откройте приложение самостоятельно и найдите счёт от PickChick.',
            )}
          </Caption>
        ) : null}
      </ScrollView>
      <BottomActions
        safeArea={tabBarInset === 0}
        style={[checkoutStyle.cartFooter, { marginBottom: tabBarInset }]}
      >
        {paid ? (
          <>
            <Caption style={s.detail}>
              {localize(phase === 'paid' ? 'Передаём заказ на кухню…' : 'Открываем статус заказа…')}
            </Caption>
            <Button
              title={t('Следить за заказом')}
              testID="kaspi-track-order"
              onPress={onContinue}
              style={button}
            />
          </>
        ) : failed ? (
          <>
            <Button
              title={t('Оплатить ещё раз')}
              testID="kaspi-retry-payment"
              onPress={onRetry}
              style={button}
            />
            <Button title={t('Вернуться в корзину')} secondary onPress={onCart} style={button} />
          </>
        ) : (
          <>
            {extraAction}
            {!order && canReturnToCheckout ? (
              <Button title={localize(returnLabel)} secondary onPress={onCart} style={button} />
            ) : null}
            {!deadlineReached && (waiting || phase === 'checking') ? (
              <Button
                title={t('Открыть Kaspi.kz')}
                testID="kaspi-open-app"
                style={button}
                onPress={openKaspi}
              />
            ) : null}
            {!deadlineReached && waiting ? (
              <Button
                title={localize(showCancelHelp ? 'Вернуться к оплате' : 'Отменить в Kaspi')}
                testID="kaspi-cancel-instructions"
                secondary
                style={button}
                onPress={() => setCancelHelp((value) => !value)}
              />
            ) : null}
            {support || phase === 'attention' || (closeReady && closeDelayMs !== 0) ? (
              <SupportContact buttonStyle={button} textStyle={s.small} />
            ) : null}
            {closeReady ? (
              <Button
                title={closeLabel}
                testID="kaspi-close-order"
                secondary
                style={button}
                onPress={onClose}
              />
            ) : null}
            {order && BANK_PHASES.includes(phase) ? (
              <Caption style={s.small}>{t('Статус обновится после ответа банка')}</Caption>
            ) : null}
          </>
        )}
      </BottomActions>
    </View>
  );
}
const s = StyleSheet.create({
  cancelHelp: { gap: 12, alignItems: 'center', marginTop: 24, maxWidth: 350 },
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
  spinner: { marginBottom: 14 },
  // 320 x 568 class screens (height < 620).
  tightContent: { paddingVertical: 12 },
  tightTitle: { fontSize: 24, lineHeight: 30, letterSpacing: -0.3 },
  tightVisual: { height: 104, marginVertical: 6 },
  tightScene: { transform: [{ scale: 0.36 }] },
  tightSpinner: { marginBottom: 4 },
  tightDetail: { marginTop: 4, fontSize: 14, lineHeight: 20 },
  tightDeadline: { marginTop: 8, gap: 0 },
  tightDeadlineTime: { fontSize: 20, lineHeight: 26 },
  tightButton: { minHeight: 48 },
});
