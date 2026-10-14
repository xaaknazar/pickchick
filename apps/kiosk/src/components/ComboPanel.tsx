import { glassSurface } from './glassSurface';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { money } from '../cart';
import { copy, type Locale } from '../i18n';
import { productCopy } from '../productCopy';
import { colors, fonts, redesign, useMetrics } from '../theme';
import { GlassPanel } from './GlassPanel';
import { Icon } from './Icon';
import { motion, usePopIn, usePress, useTimingTo, useTween } from './motion';
import { useMotionPreference } from './useMotionPreference';
import { ownerOrange } from './ownerOrange';
import { fixedText } from './Body';
/** Darkening under the panel: content scrolling beneath it stays legible, the last tiles clean. */
const SCRIM = 150;
/** Glass −/+ disc of the panel (64). */
function StepDisc({
  name,
  label,
  testID,
  disabled,
  onPress,
}: {
  name: 'remove' | 'add';
  label: string;
  testID: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const { px } = useMetrics();
  const press = usePress(0.9);
  const size = Math.max(48, px(64));
  return (
    // The design keeps both discs at full strength (the minus at 1 is still disabled).
    <Animated.View style={{ transform: [{ scale: press.scale }] }}>
      <GlassPanel shape="circle">
        <Pressable
          testID={testID}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={onPress}
          onPressIn={press.onPressIn}
          onPressOut={press.onPressOut}
          style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name={name} size="small" tone="inverse" />
        </Pressable>
      </GlassPanel>
    </Animated.View>
  );
}
/**
 * Bottom panel of the product card (kiosk redesign 2026-10-13, product-and-payment.md §1): a
 * glass bar (16 from the sides, 22 from the bottom, 112 high) under a 150-pt darkening, with
 * the glass −/+ discs (64) around the quantity, the picks («Coca-Cola 0.5 л · Фирменный соус»,
 * 16, 75% white) over the status («Всё выбрано», or «Выберите соус» while a section is empty)
 * and the orange «В корзину · 4 190 ₸ →» (88 high): the price with surcharges and quantity,
 * counting to each new total. While a choice is missing the button is pale and disabled; a tap
 * on it calls `onAttention` (the screen points at the empty section). A full cart line shows
 * why in the button instead.
 */
export function ComboPanel({
  locale,
  quantity,
  max = 20,
  limit = null,
  price,
  valid,
  available,
  busy,
  save = false,
  summary,
  status,
  onMinus,
  onPlus,
  onAdd,
  onAttention,
}: {
  locale: Locale;
  quantity: number;
  /** Most the quantity may reach (the cart's room for this exact line). */
  max?: number;
  /** The cart has no room for this line: the button shows why and stays disabled. */
  limit?: string | null;
  /** Line total in minor units, or null while a choice is missing. */
  price: string | null;
  valid: boolean;
  available: boolean;
  busy: boolean;
  /** Editing a cart line: «Сохранить» instead of «В корзину». */
  save?: boolean;
  /** The picks of every section. */
  summary: string;
  /** «Всё выбрано» or what is still missing. */
  status: string;
  onMinus: () => void;
  onPlus: () => void;
  onAdd: () => void;
  onAttention?: () => void;
}) {
  const { px } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(locale);
  const tp = productCopy(locale);
  const reduced = useMotionPreference();
  const press = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    press.stopAnimation();
    press.setValue(1);
  }, [reduced, press]);
  const pop = usePopIn(quantity, 300, 0, false);
  const disabled = !valid || !available || !!limit;
  const blocked = disabled || busy;
  const verb = save ? t.saveLine : t.toCart;
  const label =
    limit ?? (!available ? t.unavailableShort : price ? `${verb} · ${money(price)}` : verb);
  const target = price ? Number(price) : 0;
  const counted = useTween(target, motion.enter, target);
  const shown =
    limit || !available || !price || counted === target
      ? label
      : `${verb} · ${money(String(Math.round(counted / 100) * 100))}`;
  const pale = useTimingTo(disabled ? 1 : 0, 220, 'css');
  const attention = !valid && available && !limit && !busy && !!onAttention;
  const squeeze = (down: boolean) => {
    press.stopAnimation();
    Animated.timing(press, {
      toValue: down && !reduced ? 0.97 : 1,
      duration: reduced ? 0 : motion.press,
      useNativeDriver: true,
    }).start();
  };
  return (
    <View
      testID="kiosk-product-panel"
      pointerEvents="box-none"
      style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: px(SCRIM) }}
    >
      <LinearGradient
        pointerEvents="none"
        colors={[redesign.scrim[0], redesign.scrim[1]]}
        locations={[0, 0.75]}
        style={StyleSheet.absoluteFill}
      />
      <View
        style={{
          position: 'absolute',
          left: Math.max(safe.left, px(16)),
          right: Math.max(safe.right, px(16)),
          bottom: Math.max(safe.bottom, px(22)),
        }}
      >
        <GlassPanel shape="bar">
          <View
            style={{
              flex: 1,
              height: px(110),
              flexDirection: 'row',
              alignItems: 'center',
              gap: px(14),
              paddingLeft: px(22),
              paddingRight: px(11),
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(10) }}>
              <StepDisc
                name="remove"
                label={tp.fewer}
                testID="kiosk-product-decrement"
                disabled={quantity <= 1 || busy}
                onPress={onMinus}
              />
              <Animated.View
                style={{
                  minWidth: px(36),
                  alignItems: 'center',
                  opacity: pop.opacity,
                  transform: [{ scale: pop.scale }],
                }}
              >
                <Text
                  {...fixedText}
                  testID="kiosk-product-quantity"
                  accessibilityLiveRegion="polite"
                  style={{
                    fontFamily: fonts.black,
                    fontSize: px(30),
                    color: colors.white,
                    fontVariant: ['tabular-nums'],
                  }}
                >
                  {quantity}
                </Text>
              </Animated.View>
              <StepDisc
                name="add"
                label={tp.plus}
                testID="kiosk-product-increment"
                disabled={quantity >= max || busy}
                onPress={onPlus}
              />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: px(2) }}>
              {summary ? (
                <Text
                  {...fixedText}
                  testID="kiosk-product-summary"
                  numberOfLines={2}
                  style={{
                    fontFamily: fonts.medium,
                    fontSize: px(16),
                    lineHeight: px(20),
                    color: 'rgba(255,255,255,.75)',
                  }}
                >
                  {summary}
                </Text>
              ) : null}
              <Text
                {...fixedText}
                testID="kiosk-product-status"
                accessibilityLiveRegion="polite"
                numberOfLines={1}
                style={{
                  fontFamily: fonts.black,
                  fontSize: px(22),
                  lineHeight: px(28),
                  color: valid ? colors.white : colors.orangeOnBlue,
                }}
              >
                {status}
              </Text>
            </View>
            <Animated.View style={{ flexShrink: 0, transform: [{ scale: press }] }}>
              <Pressable
                testID="kiosk-product-add"
                {...ownerOrange}
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityState={{ disabled: blocked, busy }}
                disabled={blocked}
                onPress={onAdd}
                onPressIn={() => squeeze(true)}
                onPressOut={() => squeeze(false)}
                style={{
                  height: Math.max(52, px(88)),
                  paddingLeft: px(32),
                  paddingRight: px(28),
                  borderRadius: 999,
                  ...glassSurface('accent'),
                  shadowColor: redesign.cta,
                  shadowOpacity: disabled ? 0 : 0.5,
                  shadowRadius: px(13),
                  shadowOffset: { width: 0, height: px(10) },
                  opacity: busy ? 0.75 : 1,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: px(14),
                }}
              >
                <Animated.View
                  pointerEvents="none"
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: 0,
                    bottom: 0,
                    borderRadius: 999,
                    backgroundColor: '#FFA466',
                    opacity: pale,
                  }}
                />
                {busy ? (
                  <ActivityIndicator accessibilityLabel={label} color={colors.white} />
                ) : null}
                <Text
                  {...fixedText}
                  numberOfLines={1}
                  style={{
                    fontFamily: fonts.black,
                    fontSize: px(27),
                    color: colors.white,
                    fontVariant: ['tabular-nums'],
                  }}
                >
                  {shown}
                </Text>
                {limit || !available ? null : (
                  <Icon name="arrow-forward" size="small" tone="inverse" />
                )}
              </Pressable>
              {attention ? (
                // Silent layer over the pale button: a tap points at the missing choice.
                <Pressable
                  accessible={false}
                  importantForAccessibility="no"
                  tabIndex={-1}
                  onPress={onAttention}
                  onPressIn={() => squeeze(true)}
                  onPressOut={() => squeeze(false)}
                  style={StyleSheet.absoluteFill}
                />
              ) : null}
            </Animated.View>
          </View>
        </GlassPanel>
      </View>
    </View>
  );
}
