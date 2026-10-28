import { localize, t, useLocale } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  AppState,
  Easing,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CustomerCommerceOrder } from '@pickchick/contracts';
import { assets } from '../assets';
import { STUCK_NOTICE_MS, paymentStuck, paymentWaitPhase, waitSince } from '../checkout-resume';
import { bannerAnnouncement } from '../payment-availability';
import { invoiceSecondsRemaining, paymentCopy, stuckCopy } from '../commerce-presentation';
import { money } from '../domain';
import { Body, Button, Caption, Heading, Icon, BottomActions } from './UI';
import { PaymentMark } from './PaymentChoice';
import { useReducedMotion } from './Motion';
import { colors, font } from '../theme';
import { checkoutStyle } from './CheckoutPresentation';
import { useTabBarInset } from './tab-bar-inset';
import { SupportContact } from './SupportContact';
import { GlassButton } from './GlassButton';
import { PaymentCloseConfirm } from './PaymentCloseConfirm';

const BANK_PHASES: readonly string[] = ['sending', 'awaiting_payment', 'checking'];
/** The smallest share of its size the scene may shrink to so the words fit (owner 28.10.2026). */
const SCENE_MIN_FIT = 0.5;

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
  onDismiss,
  dismissLabel = 'Закрыть оплату',
  dismissNeedsConfirm,
  onRecheck,
  rechecking = false,
  stuckReturnLabel = null,
  safeTop = false,
  paymentCommand = false,
  intentKey,
  bottomInset = 0,
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
  /**
   * Owner 28.10.2026 (TestFlight 25): the glass X at the top right, there at once on every
   * payment state: back to the cart (or the Orders list). Safe close semantics are the parent's.
   */
  onDismiss?: () => void;
  dismissLabel?: string;
  /** Asked at the press: the bank may still act, so «Закрыть оплату?» comes first. */
  dismissNeedsConfirm?: () => boolean;
  /** «Проверить ещё раз» of a stuck «sending» or restaurant wait: a read-only check. */
  onRecheck?: () => void;
  rechecking?: boolean;
  /** The way back offered by a stuck screen («Вернуться в корзину»); null: none of its own. */
  stuckReturnLabel?: string | null;
  /** Not inside a sheet («Заказы»): the X keeps clear of the status bar. */
  safeTop?: boolean;
  /**
   * This screen's payment command (POST /payment) for the order still runs: «ready_to_pay» is
   * shown and waits as «Отправляем счёт» (paymentWaitPhase).
   */
  paymentCommand?: boolean;
  /**
   * The saved intent behind this screen: on the connecting scene, a create command still waiting
   * for its order (the restaurant's wait); on an order, the intent that created it (its wait
   * goes on, waitSince).
   */
  intentKey?: string;
  /**
   * Space a tab screen keeps free at the bottom (ScreenHost cartBottomInset): the tab bar plus
   * the cart bar docked on it while the cart has lines. On «Заказы» the buttons sit above both,
   * never under the cart bar (integration 28.10.2026). Outside the tabs it is 0.
   */
  bottomInset?: number;
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
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const footerInset = tabBarInset > 0 ? Math.max(tabBarInset, bottomInset) : 0;
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
  // Review 28.10.2026: a running payment command reads «Отправляем счёт», a create command that
  // waits for its order counts as the restaurant's wait.
  const shown = paymentWaitPhase(order?.phase, {
    commandRunning: paymentCommand,
    creating: !order && !!intentKey,
  });
  const phase = shown ?? 'awaiting_restaurant';
  const failed = phase === 'failed';
  const waiting = phase === 'awaiting_payment';
  const [now, setNow] = useState(Date.now);
  const remaining = invoiceSecondsRemaining(order?.expiresAt ?? null, now);
  const deadlineReached = (waiting || phase === 'checking') && remaining === 0;
  const showCancelHelp = cancelHelp && waiting && !paid && !deadlineReached;
  // Owner 28.10.2026: «Отправляем счёт» or «Связываемся с рестораном» that has not moved for 20 s
  // says so honestly and offers its actions. Measured from the first time this app run saw the
  // wait in this phase (waitSince): a reopened order does not start from 0 again.
  const waitId = order ? order.orderId : intentKey ? `intent:${intentKey}` : undefined;
  const waitFrom = order && intentKey ? `intent:${intentKey}` : undefined;
  const stuckPhase = waitId && !paid ? shown : undefined;
  const stuckKey = `${waitId ?? ''}:${stuckPhase ?? ''}`;
  const waitStart = (at: number) =>
    waitId && stuckPhase ? waitSince(waitId, stuckPhase, at, waitFrom) : at;
  const [stuckClock, setStuckClock] = useState(() => {
    const at = Date.now();
    return { key: stuckKey, since: waitStart(at), now: at };
  });
  useEffect(() => {
    const at = Date.now();
    const since = waitStart(at);
    setStuckClock({ key: stuckKey, since, now: at });
    if (stuckPhase !== 'sending' && stuckPhase !== 'awaiting_restaurant') return;
    const left = since + STUCK_NOTICE_MS - at;
    if (left <= 0) return;
    const timer = setTimeout(
      () => setStuckClock({ key: stuckKey, since, now: Date.now() }),
      left + 50,
    );
    return () => clearTimeout(timer);
  }, [stuckKey]);
  const stuck =
    stuckClock.key === stuckKey ? paymentStuck(stuckPhase, stuckClock.since, stuckClock.now) : null;
  // VoiceOver has no live region (review 28.10.2026): the new title and text are announced on iOS
  // when the screen turns stuck; Android reads the detail through its live region.
  const stuckSaid = stuck
    ? `${localize(stuckCopy[stuck].title)}. ${localize(stuckCopy[stuck].detail)}`
    : null;
  const stuckShown = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const announce = bannerAnnouncement(stuckShown.current, stuckSaid);
    stuckShown.current = stuckSaid;
    if (announce && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(announce);
  }, [stuckSaid]);
  const [confirming, setConfirming] = useState(false);
  const dismissible = Boolean(onDismiss);
  useEffect(() => {
    if (!dismissible) setConfirming(false);
  }, [dismissible]);
  const requestDismiss = () => {
    if (!onDismiss) return;
    if (dismissNeedsConfirm?.()) setConfirming(true);
    else onDismiss();
  };
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
  // The X row takes the top of the screen (owner 28.10.2026). When the words, the amount, the
  // countdown and the pinned buttons do not fit with the full scene, the decorative scene shrinks
  // to fit (never the words or the buttons), down to SCENE_MIN_FIT of its size; beyond that the
  // content scrolls as before. It only shrinks within one state, so it never oscillates.
  const fitKey = [order?.orderId, phase, paid, showCancelHelp, stuck, height, fontScale].join(':');
  const [fit, setFit] = useState({ key: fitKey, factor: 1 });
  const factor = fit.key === fitKey ? fit.factor : 1;
  const measured = useRef({ view: 0, content: 0 });
  const visualHeight = tight ? 104 : compact || paid || failed ? 170 : 290;
  const visualMargin = tight ? 6 : compact ? 12 : paid || failed ? 20 : 28;
  const sceneScale = tight ? 0.36 : compact ? 0.58 : 1;
  const refit = () => {
    const { view, content } = measured.current;
    const overflow = content - view;
    if (!view || overflow <= 1 || textFirst || height < 500 || showCancelHelp) return;
    const block = visualHeight + 2 * visualMargin;
    const next = Math.max(SCENE_MIN_FIT, (block * factor - overflow - 2) / block);
    if (next < factor - 0.005) setFit({ key: fitKey, factor: next });
  };
  const fitted =
    factor < 1
      ? {
          visual: {
            height: Math.round(visualHeight * factor),
            marginVertical: Math.round(visualMargin * factor),
          },
          scene: { transform: [{ scale: sceneScale * factor }] },
        }
      : null;
  const scene =
    height >= 500 && !showCancelHelp ? (
      <View
        style={[
          s.visual,
          (paid || failed) && s.resultVisual,
          compact && s.compactVisual,
          tight && s.tightVisual,
          fitted?.visual,
        ]}
        accessible={false}
      >
        <View style={[s.scene, compact && s.compactScene, tight && s.tightScene, fitted?.scene]}>
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
      {onDismiss ? (
        <View style={[s.topBar, tight && s.tightTopBar, safeTop && { paddingTop: insets.top + 8 }]}>
          <GlassButton
            name="close"
            label={dismissLabel}
            onPress={requestDismiss}
            testID="kaspi-state-close"
          />
        </View>
      ) : null}
      <ScrollView
        testID="kaspi-state-scroll"
        contentContainerStyle={[
          s.content,
          tight && s.tightContent,
          onDismiss && (tight ? s.tightContentUnderBar : s.contentUnderBar),
        ]}
        showsVerticalScrollIndicator={false}
        onLayout={(event) => {
          measured.current.view = event.nativeEvent.layout.height;
          refit();
        }}
        onContentSizeChange={(_, contentHeight) => {
          measured.current.content = contentHeight;
          refit();
        }}
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
                    : stuck
                      ? stuckCopy[stuck].title
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
                    : stuck
                      ? stuckCopy[stuck].detail
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
        safeArea={footerInset === 0}
        style={[checkoutStyle.cartFooter, { marginBottom: footerInset }]}
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
            {stuck ? (
              <>
                {/* A create command still running retries by itself: no check of its own. */}
                {onRecheck ? (
                  <Button
                    title={t('Проверить ещё раз')}
                    testID="kaspi-stuck-recheck"
                    disabled={rechecking}
                    onPress={onRecheck}
                    style={button}
                  />
                ) : null}
                {stuckReturnLabel && onDismiss ? (
                  <Button
                    title={localize(stuckReturnLabel)}
                    testID="kaspi-stuck-cart"
                    secondary
                    onPress={requestDismiss}
                    style={button}
                  />
                ) : null}
              </>
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
            {/* A stuck screen's own way back replaces it (the X stays). */}
            {closeReady && !(stuck && stuckReturnLabel && onDismiss) ? (
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
      <PaymentCloseConfirm
        visible={confirming && dismissible}
        phase={shown}
        onStay={() => setConfirming(false)}
        onClose={() => {
          setConfirming(false);
          onDismiss?.();
        }}
      />
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
  // The X sits where the cart's own X is (CartTopBar): right, 16 pt from the edge.
  topBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingTop: 12,
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
  },
  tightTopBar: { paddingTop: 6 },
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
  // The X row above already keeps the content off the top edge.
  contentUnderBar: { paddingTop: 8 },
  tightContentUnderBar: { paddingTop: 0 },
  tightTitle: { fontSize: 24, lineHeight: 30, letterSpacing: -0.3 },
  tightVisual: { height: 104, marginVertical: 6 },
  tightScene: { transform: [{ scale: 0.36 }] },
  tightSpinner: { marginBottom: 4 },
  tightDetail: { marginTop: 4, fontSize: 14, lineHeight: 20 },
  tightDeadline: { marginTop: 8, gap: 0 },
  tightDeadlineTime: { fontSize: 20, lineHeight: 26 },
  tightButton: { minHeight: 48 },
});
