import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copy, type Locale } from '../i18n';
import { money } from '../cart';
import { colors, fonts, useMetrics } from '../theme';
import { Icon } from './Icon';
import { motion, usePop } from './motion';
import { useMotionPreference } from './useMotionPreference';
const positions = (n: number, locale: Locale) => {
  if (locale !== 'ru') return n + ' позиция';
  const tens = n % 100;
  const ones = n % 10;
  return (
    n +
    (tens >= 11 && tens <= 14
      ? ' позиций'
      : ones === 1
        ? ' позиция'
        : ones >= 2 && ones <= 4
          ? ' позиции'
          : ' позиций')
  );
};
/**
 * v3 floating cart pill: blue bag with an orange count badge, item count and
 * total, and the orange checkout pill. The bag bumps when something is added.
 */
export function CartBar({
  quantity,
  previousQuantity,
  total,
  valid,
  empty,
  busy,
  locale,
  onCheckout,
}: {
  quantity: number;
  previousQuantity?: number;
  total: string;
  valid: boolean;
  empty: boolean;
  busy: boolean;
  locale: Locale;
  onCheckout: () => void;
}) {
  const { v } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(locale);
  const previous = useRef(previousQuantity ?? quantity);
  const [added, setAdded] = useState(false);
  const scale = useRef(new Animated.Value(1)).current;
  const press = useRef(new Animated.Value(1)).current;
  const reduced = useMotionPreference();
  // A reduced-motion switch must also release a press that is already held.
  useEffect(() => {
    press.stopAnimation();
    press.setValue(1);
  }, [reduced, press]);
  const [pulse, setPulse] = useState(0);
  const badge = usePop(quantity);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (quantity > previous.current) {
      setAdded(true);
      setPulse((value) => value + 1);
      timer = setTimeout(() => setAdded(false), 1800);
    } else setAdded(false);
    previous.current = quantity;
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [quantity]);
  useEffect(() => {
    scale.stopAnimation();
    scale.setValue(1);
    if (pulse && !reduced)
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.2, duration: 150, useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, damping: 9, stiffness: 260, useNativeDriver: true }),
      ]).start();
    return () => {
      scale.stopAnimation();
      scale.setValue(1);
    };
  }, [pulse, reduced, scale]);
  const blocked = empty || busy;
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
      testID="kiosk-cart-bar"
      style={{
        paddingTop: v(14),
        paddingBottom: Math.max(safe.bottom, v(22)),
        paddingLeft: Math.max(safe.left, v(20)),
        paddingRight: Math.max(safe.right, v(20)),
      }}
    >
      <View
        style={{
          minHeight: v(100),
          borderRadius: v(50),
          backgroundColor: colors.white,
          shadowColor: '#020A28',
          shadowOpacity: 0.35,
          shadowRadius: 34,
          shadowOffset: { width: 0, height: 14 },
          elevation: 10,
          flexDirection: 'row',
          alignItems: 'center',
          gap: v(16),
          paddingLeft: v(14),
          paddingRight: v(10),
          paddingVertical: v(10),
        }}
      >
        <Animated.View
          style={{
            transform: [
              { scale },
              {
                rotate: scale.interpolate({
                  inputRange: [0.9, 1, 1.2],
                  outputRange: ['3deg', '0deg', '-8deg'],
                }),
              },
            ],
          }}
        >
          <View
            style={{
              width: v(76),
              height: v(76),
              borderRadius: v(38),
              backgroundColor: colors.blue,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="bag-handle-outline" tone="inverse" />
          </View>
          <Animated.View
            style={{
              position: 'absolute',
              top: -v(4),
              right: -v(4),
              minWidth: v(30),
              height: v(30),
              paddingHorizontal: v(4),
              borderRadius: v(15),
              backgroundColor: colors.orange,
              borderWidth: 3,
              borderColor: colors.white,
              alignItems: 'center',
              justifyContent: 'center',
              transform: [{ scale: badge }],
            }}
          >
            <Text style={{ fontFamily: fonts.black, fontSize: v(15), color: colors.white }}>
              {quantity}
            </Text>
          </Animated.View>
        </Animated.View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            testID="kiosk-cart-feedback"
            accessibilityLiveRegion="polite"
            numberOfLines={1}
            style={{
              fontFamily: fonts.body,
              fontSize: Math.max(15, v(15)),
              color: added ? colors.orangeDeep : colors.muted,
            }}
          >
            {added ? t.selected : quantity ? positions(quantity, locale) : t.cart}
          </Text>
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            style={{
              fontFamily: fonts.black,
              fontSize: valid ? v(32) : v(22),
              color: valid ? colors.navy : colors.error,
              fontVariant: ['tabular-nums'],
            }}
          >
            {valid ? money(total) : locale === 'ru' ? 'Проверьте корзину' : 'Себетті тексеріңіз'}
          </Text>
        </View>
        <Animated.View style={{ transform: [{ scale: press }] }}>
          <Pressable
            testID="kiosk-menu-checkout"
            accessibilityRole="button"
            accessibilityLabel={t.checkout}
            accessibilityState={{ disabled: blocked, busy }}
            disabled={blocked}
            onPress={onCheckout}
            onPressIn={() => squeeze(true)}
            onPressOut={() => squeeze(false)}
            style={{
              minHeight: Math.max(52, v(80)),
              paddingHorizontal: v(32),
              borderRadius: 999,
              backgroundColor: empty ? '#C9D2E3' : colors.orange,
              shadowColor: colors.orange,
              shadowOpacity: empty ? 0 : 0.4,
              shadowRadius: 18,
              shadowOffset: { width: 0, height: 8 },
              opacity: busy ? 0.7 : 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: v(10),
            }}
          >
            {busy ? (
              <ActivityIndicator accessibilityLabel={t.checkout} color={colors.white} />
            ) : null}
            <Text style={{ fontFamily: fonts.black, fontSize: v(21), color: colors.white }}>
              {t.checkout}
            </Text>
          </Pressable>
        </Animated.View>
      </View>
    </View>
  );
}
