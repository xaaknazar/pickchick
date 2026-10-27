import { localize, t, useLocale } from '../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  Animated as NativeAnimated,
  AppState,
  Easing,
  Platform,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ViewStyle,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { MotionPressable as Pressable, useReducedMotion } from './Motion';
import { ProductPhoto, productPhoto, type ProductPhotoSource } from './ProductPhoto';
import { KaspiSlideToPay, type SlidePhase } from './KaspiSlideToPay';
import { GlassFill, glassRim } from './GlassButton';
import { cartTotal } from '../domain';
import {
  cartBarLayout,
  cartCheckoutBlocked,
  payableTotalMinor,
  recentCartLines,
  slideToPayAvailable,
} from '../cart-bar';
import { kaspiCheckoutEnabled } from '../commerce-checkout';
import { orderSimulatorEnabled } from '../order-simulator';
import { useAccount } from '../useAccount';
import { SLIDE_PAY_PARAM, slidePayIntents } from '../useSlidePayIntent';
import { usePaymentMethod } from '../usePaymentMethod';
import type { CartLine, MobileModel } from '../model';
import { brandColors, colors, font } from '../theme';
import { BottomActions, Icon, MinorMoney } from './UI';

const PAD = 5;
const ROW = 54;
const OVERLAP = 16;
/** Large text: the hint grows up to x1.4, then shrinks to fit (KK at 320 pt). */
const HINT_MAX_SCALE = 1.4;
const HINT_MIN_FIT = 0.7;
const glass = 'rgba(10, 32, 80, 0.94)';
// Same backdrop as the floating tab bar on the web build; native keeps the navy glass.
const webGlass =
  Platform.OS === 'web'
    ? ({
        backdropFilter: 'saturate(180%) blur(20px)',
        WebkitBackdropFilter: 'saturate(180%) blur(20px)',
      } as ViewStyle)
    : null;

/** A product without its own photo (or a restored unavailable line) gets a neutral circle. */
function hasPhoto(photo: ProductPhotoSource) {
  return photo.kind === 'remote' || (photo.kind !== 'logo' && !!photo.source);
}

function RecentPhoto({ line, size, index }: { line: CartLine; size: number; index: number }) {
  const photo = productPhoto(line.product, 'thumb', 'menu');
  return (
    <View
      testID={`cart-recent-photo-${index}`}
      nativeID={`cart-recent-${line.product.id}`}
      style={[s.photo, { width: size, height: size, borderRadius: size / 2 }]}
    >
      {hasPhoto(photo) ? (
        <ProductPhoto photo={photo} style={StyleSheet.absoluteFill} contentFit="contain" />
      ) : (
        <View style={[StyleSheet.absoluteFill, s.placeholder]}>
          <Icon name="fast-food-outline" size={Math.round(size * 0.45)} color={colors.muted} />
        </View>
      )}
    </View>
  );
}

// Drinkit-style dock shared by the tabs and the standalone menu (owner request 27.10.2026):
// the payment handle on the left (the customer's last used method, Kaspi today), the total only
// in the middle, the last added items on the right.
export function CartShortcut({
  model,
  onPress,
  safeArea = false,
  floating = false,
  bottomOffset = 0,
  onHeightChange,
}: {
  model: MobileModel;
  onPress: () => void;
  safeArea?: boolean;
  floating?: boolean;
  /** Lifts the floating dock above the floating tab bar. */
  bottomOffset?: number;
  onHeightChange?: (height: number) => void;
}) {
  useLocale();
  const router = useRouter();
  const account = useAccount();
  // The handle shows the customer's last used payment method (owner 6b; Kaspi today).
  const payment = usePaymentMethod();
  const count = model.cart.reduce((sum, line) => sum + line.quantity, 0);
  // The amount of «Оформить заказ» and of the invoice: a selected combo gift is taken off.
  const total = MinorMoney(
    payableTotalMinor(cartTotal(model.cart), model.comboRewards?.discountMinor),
  );
  const reduced = useReducedMotion();
  const { width, fontScale } = useWindowDimensions();
  const layout = cartBarLayout({ width, fontScale, totalLength: total.length });
  const recent = recentCartLines(model.cart, model.recentCartProductIds, layout.photos);
  const payable = slideToPayAvailable({
    kaspiCheckout: kaspiCheckoutEnabled,
    orderSimulator: orderSimulatorEnabled,
    catalogMode: model.catalogMode,
    accountMode: account.mode,
  });
  const [barWidth, setBarWidth] = useState(0);
  const [phase, setPhase] = useState<SlidePhase>('idle');
  const content = useSharedValue(1);
  useEffect(() => {
    const target = phase === 'idle' ? 1 : 0;
    content.value = reduced ? target : withTiming(target, { duration: 140 });
  }, [phase, reduced, content]);
  const offset = useSharedValue(0);
  // The handle is drawn below the cart button (it comes first for VoiceOver), so the total and the
  // photos stay hidden until it is back home.
  const contentStyle = useAnimatedStyle(() => ({
    opacity: content.value * interpolate(offset.value, [0, 12], [1, 0], Extrapolation.CLAMP),
  }));
  // Subtle added feedback: the newest photo settles in when the customer returns with more items.
  const feedback = useRef(new NativeAnimated.Value(0)).current;
  const previousCount = useRef(0);
  useFocusEffect(
    useCallback(() => {
      const added = count > previousCount.current;
      previousCount.current = count;
      const reset = () => {
        feedback.stopAnimation();
        feedback.setValue(0);
      };
      reset();
      if (added && !reduced && AppState.currentState === 'active') {
        NativeAnimated.sequence([
          NativeAnimated.timing(feedback, {
            toValue: 1,
            duration: 160,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: Platform.OS !== 'web',
            isInteraction: false,
          }),
          NativeAnimated.timing(feedback, {
            toValue: 0,
            duration: 240,
            easing: Easing.inOut(Easing.cubic),
            useNativeDriver: Platform.OS !== 'web',
            isInteraction: false,
          }),
        ]).start();
      }
      const subscription = AppState.addEventListener('change', (state) => {
        if (state !== 'active') reset();
      });
      return () => {
        subscription.remove();
        reset();
      };
    }, [count, reduced, feedback]),
  );
  // The Kaspi cart is the checkout (27.10.2026): the slide opens the cart with payment, which
  // takes the one-shot intent and presses its own «Оплатить» once. Guests sign in first and land
  // on the cart without anything sent; a blocked basket opens the cart, where the reason is shown.
  const openPayment = (slide: boolean) => {
    if (cartCheckoutBlocked(model)) {
      onPress();
      return;
    }
    if (!account.account) {
      router.push({ pathname: '/auth', params: { returnTo: 'M09' } });
      return;
    }
    router.push({
      pathname: '/cart',
      params: slide ? { [SLIDE_PAY_PARAM]: slidePayIntents.issue() } : {},
    });
  };
  const photoStep = layout.photoSize - OVERLAP;
  // How far the handle pill can stretch: fully stretched it fills the capsule (owner 6a).
  const travel = Math.max(0, Math.floor(barWidth - PAD * 2 - layout.handleWidth - 2));
  if (!count) return null;
  return (
    <BottomActions
      safeArea={safeArea}
      pointerEvents="box-none"
      onLayout={(event) => onHeightChange?.(Math.ceil(event.nativeEvent.layout.height))}
      style={[
        s.dock,
        floating && s.floating,
        floating && bottomOffset > 0 && { bottom: bottomOffset, paddingBottom: 10 },
      ]}
    >
      <GestureHandlerRootView style={s.root}>
        <View
          testID="cart-shortcut"
          onLayout={(event) => setBarWidth(event.nativeEvent.layout.width)}
          style={[s.capsule, webGlass]}
        >
          {/* Reading and focus order follow the picture: the hint, the payment handle, then the
              cart button. Nothing gets a zIndex, which would move the handle last on iOS. The
              handle is drawn after the hint, so its stretching pill covers the hint. */}
          {phase !== 'idle' ? (
            <View
              pointerEvents="none"
              style={[s.hintBox, { left: PAD + layout.handleWidth + 8, right: PAD + 8 }]}
            >
              <Text
                testID="cart-pay-hint"
                accessibilityLiveRegion="polite"
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={HINT_MIN_FIT}
                maxFontSizeMultiplier={HINT_MAX_SCALE}
                style={s.hint}
              >
                {t('тяни для оплаты')}
              </Text>
            </View>
          ) : null}
          {payable ? (
            <KaspiSlideToPay
              travel={travel}
              width={layout.handleWidth}
              height={ROW}
              reduced={reduced}
              method={payment.method}
              offset={offset}
              style={s.handle}
              onPhaseChange={setPhase}
              onComplete={() => openPayment(true)}
              onOpenCheckout={() => openPayment(false)}
            />
          ) : null}
          <Pressable
            testID="open-cart"
            accessibilityRole="button"
            accessibilityLabel={localize(
              t('Корзина, {p0} позиций, {p1}', { p0: count, p1: total }),
            )}
            accessibilityHint={t('Открыть состав заказа')}
            disabled={phase === 'drag'}
            onPress={onPress}
            style={[s.open, payable ? { marginLeft: layout.handleWidth } : s.openWhole]}
          >
            {!payable ? (
              <View
                pointerEvents="none"
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[s.bag, { width: layout.handleWidth }]}
              >
                <GlassFill radius={ROW / 2} />
                <Icon name="bag-handle-outline" size={24} color={brandColors.brandOrange} />
              </View>
            ) : null}
            <Animated.View
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={[s.middle, contentStyle]}
            >
              <View testID="cart-total" style={s.totalBox}>
                <Text
                  testID="cart-shortcut-total"
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.7}
                  maxFontSizeMultiplier={1.5}
                  style={[
                    s.total,
                    { fontSize: layout.totalSize, lineHeight: Math.round(layout.totalSize * 1.3) },
                  ]}
                >
                  {localize(total)}
                </Text>
              </View>
            </Animated.View>
            {recent.length ? (
              <Animated.View
                pointerEvents="none"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[
                  s.photos,
                  { width: layout.photoSize + (recent.length - 1) * photoStep },
                  contentStyle,
                ]}
              >
                {/* Older items first so the newest (index 0) is drawn on top at the right end. */}
                {recent
                  .map((line, index) => ({ line, index }))
                  .reverse()
                  .map(({ line, index }) => (
                    <NativeAnimated.View
                      key={line.product.id}
                      testID={index === 0 ? 'cart-recent-feedback' : undefined}
                      style={[
                        s.photoSlot,
                        { left: (recent.length - 1 - index) * photoStep },
                        index === 0 && {
                          transform: [
                            {
                              scale: feedback.interpolate({
                                inputRange: [0, 1],
                                outputRange: [1, 1.14],
                              }),
                            },
                          ],
                        },
                      ]}
                    >
                      <RecentPhoto line={line} size={layout.photoSize} index={index} />
                    </NativeAnimated.View>
                  ))}
              </Animated.View>
            ) : null}
          </Pressable>
        </View>
      </GestureHandlerRootView>
    </BottomActions>
  );
}
const s = StyleSheet.create({
  dock: {
    paddingTop: 10,
    paddingHorizontal: 16,
    borderTopWidth: 0,
    backgroundColor: 'transparent',
  },
  floating: { position: 'absolute', bottom: 0, left: 0, right: 0 },
  root: { width: '100%', maxWidth: 440, alignSelf: 'center' },
  // The cart button fills the capsule's full height (a larger target, and the dock keeps its
  // distance to the tab bar); the handle and the photos sit inside with the same inset.
  capsule: {
    minHeight: ROW + PAD * 2,
    borderRadius: 999,
    paddingHorizontal: PAD,
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: glass,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.14)',
    shadowColor: '#000000',
    shadowOpacity: 0.35,
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 18,
    elevation: 12,
  },
  open: {
    flex: 1,
    minWidth: 0,
    minHeight: ROW + PAD * 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 999,
  },
  openWhole: { gap: 10 },
  // Non-payment builds: the same glass pill as the Kaspi handle, with the bag icon.
  bag: {
    height: ROW,
    borderRadius: ROW / 2,
    alignItems: 'center',
    justifyContent: 'center',
    ...glassRim,
    flexShrink: 0,
  },
  middle: { flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center' },
  totalBox: { maxWidth: '100%' },
  total: {
    fontFamily: font.display,
    color: colors.white,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    includeFontPadding: false,
  },
  photos: { height: ROW, flexShrink: 0, justifyContent: 'center' },
  photoSlot: { position: 'absolute', top: 0, bottom: 0, justifyContent: 'center' },
  photo: {
    overflow: 'hidden',
    backgroundColor: '#FFF8EE',
    borderWidth: 2,
    borderColor: '#0A2050',
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.raised,
  },
  hintBox: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hint: {
    fontFamily: font.heading,
    fontSize: 18,
    lineHeight: 24,
    color: colors.white,
    textAlign: 'center',
    includeFontPadding: false,
  },
  // The touch and VoiceOver frame spans the capsule height, level with the cart button.
  handle: { position: 'absolute', left: PAD, top: 0, bottom: 0 },
});
