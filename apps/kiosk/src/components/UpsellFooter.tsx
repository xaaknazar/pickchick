import { glassSurface } from './glassSurface';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { money } from '../cart';
import { copy, type Locale } from '../i18n';
import { colors, fonts, redesign, useMetrics } from '../theme';
import { fixedText } from './Body';
import { GlassPanel } from './GlassPanel';
import { Icon } from './Icon';
import { useEnter, usePress } from './motion';
import { ownerOrange } from './ownerOrange';
/**
 * Smart upsell bottom panel (kiosk redesign 2026-10-13, 1024-pt layout): the glass bar 112 high,
 * 16 from the sides and 22 from the bottom, under the 220-pt darkening. On the left «В заказе: …»
 * (17, 75% white, two lines at most) over the total (Montserrat 900 36): the block is a button
 * that opens the order page to change it (no extra mark, as in the approved design). On the
 * right the glass «Без допов» and the orange «К оплате →», both 88 high; both lead to payment.
 * Disabled actions turn grey; while busy the orange action shows a spinner. The panel slides up
 * as the screen opens (static under reduced motion).
 */
export function UpsellFooter({
  items,
  total,
  valid,
  disabled,
  busy,
  locale,
  onCart,
  onSkip,
  onPay,
}: {
  /** The order's lines, e.g. «Burger Combo + Соус фирменный». */
  items: string;
  total: string;
  /** False while a line of the order is unavailable: the total gives way to «Проверьте корзину». */
  valid: boolean;
  disabled: boolean;
  busy: boolean;
  locale: Locale;
  onCart: () => void;
  onSkip: () => void;
  onPay: () => void;
}) {
  const { px } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(locale);
  const rise = useEnter(0, 520);
  const cart = usePress(0.98);
  const skip = usePress(0.96);
  const pay = usePress(0.96);
  const blocked = disabled || busy;
  const height = Math.max(64, px(88));
  const summary = t.smartInOrder.replace('{items}', items);
  const amount = valid ? money(total) : t.checkCart;
  return (
    <Animated.View
      style={{
        paddingTop: px(14),
        paddingBottom: Math.max(safe.bottom, px(22)),
        paddingLeft: Math.max(safe.left, px(16)),
        paddingRight: Math.max(safe.right, px(16)),
        transform: [
          { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [px(160), 0] }) },
        ],
      }}
    >
      <LinearGradient
        pointerEvents="none"
        colors={redesign.scrim}
        locations={[0, 0.75]}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: px(220) }}
      />
      <GlassPanel shape="bar" testID="kiosk-upsell-footer">
        <View
          style={{
            flex: 1,
            minWidth: 0,
            flexDirection: 'row',
            alignItems: 'center',
            padding: px(12),
            gap: px(14),
          }}
        >
          <Animated.View style={{ flex: 1, minWidth: 0, transform: [{ scale: cart.scale }] }}>
            <Pressable
              testID="kiosk-upsell-cart"
              accessibilityRole="button"
              onPress={onCart}
              onPressIn={cart.onPressIn}
              onPressOut={cart.onPressOut}
              style={{ minHeight: height, paddingLeft: px(20), justifyContent: 'center' }}
            >
              <Text
                {...fixedText}
                // A longer order takes a second line (the panel keeps its height); only a very
                // long one is cut, and the order page lists everything.
                numberOfLines={2}
                style={{
                  fontFamily: fonts.medium,
                  fontSize: Math.max(13, px(17)),
                  lineHeight: Math.max(18, px(22)),
                  color: 'rgba(255,255,255,.75)',
                }}
              >
                {summary}
              </Text>
              <Text
                {...fixedText}
                testID="kiosk-upsell-total"
                numberOfLines={1}
                style={{
                  fontFamily: fonts.black,
                  fontSize: valid ? px(36) : px(24),
                  lineHeight: valid ? px(44) : px(30),
                  letterSpacing: -0.4,
                  color: colors.white,
                  fontVariant: ['tabular-nums'],
                }}
              >
                {amount}
              </Text>
            </Pressable>
          </Animated.View>
          <Animated.View style={{ transform: [{ scale: skip.scale }] }}>
            <Pressable
              testID="kiosk-upsell-skip"
              accessibilityRole="button"
              accessibilityLabel={t.smartSkip}
              accessibilityState={{ disabled: blocked, busy }}
              disabled={blocked}
              onPress={onSkip}
              onPressIn={skip.onPressIn}
              onPressOut={skip.onPressOut}
              style={{
                minHeight: height,
                paddingHorizontal: px(34),
                borderRadius: 999,
                borderWidth: 1,
                borderColor: 'rgba(255,255,255,.24)',
                ...glassSurface(),
                alignItems: 'center',
                justifyContent: 'center',
                opacity: disabled ? 0.45 : 1,
              }}
            >
              <Text
                {...fixedText}
                numberOfLines={1}
                style={{ fontFamily: fonts.heavy, fontSize: px(21), color: colors.white }}
              >
                {t.smartSkip}
              </Text>
            </Pressable>
          </Animated.View>
          <Animated.View style={{ transform: [{ scale: pay.scale }] }}>
            <Pressable
              testID="kiosk-upsell-continue"
              {...(disabled ? {} : ownerOrange)}
              accessibilityRole="button"
              accessibilityLabel={t.smartPay}
              accessibilityState={{ disabled: blocked, busy }}
              disabled={blocked}
              onPress={onPay}
              onPressIn={pay.onPressIn}
              onPressOut={pay.onPressOut}
              style={{
                minHeight: height,
                paddingLeft: px(36),
                paddingRight: px(32),
                borderRadius: 999,
                ...glassSurface('accent'),
                ...(disabled ? { backgroundColor: 'rgba(201,210,227,.9)' } : {}),
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: px(12),
                boxShadow: disabled ? undefined : `0 ${px(10)}px ${px(26)}px ${redesign.ctaShadow}`,
              }}
            >
              <Text
                {...fixedText}
                numberOfLines={1}
                style={{
                  fontFamily: fonts.black,
                  fontSize: px(27),
                  color: colors.white,
                  opacity: busy ? 0 : 1,
                }}
              >
                {t.smartPay}
              </Text>
              <View style={{ opacity: busy ? 0 : 1 }}>
                <Icon name="arrow-forward" size="small" tone="inverse" />
              </View>
              {busy ? (
                <View
                  style={[
                    StyleSheet.absoluteFill,
                    { alignItems: 'center', justifyContent: 'center' },
                  ]}
                >
                  <ActivityIndicator accessibilityLabel={t.smartPay} color={colors.white} />
                </View>
              ) : null}
            </Pressable>
          </Animated.View>
        </View>
      </GlassPanel>
    </Animated.View>
  );
}
