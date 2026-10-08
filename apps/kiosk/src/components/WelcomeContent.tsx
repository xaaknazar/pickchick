import { useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copy, type Locale } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
import { Icon, Language, Logo } from './UI';
import { motion, useEnter, useLoop } from './motion';
import { useMotionPreference } from './useMotionPreference';
/** v3 attract CTA: one orange pill with an expanding halo and a passing shine. */
function StartCta({ label, busy, onPress }: { label: string; busy: boolean; onPress: () => void }) {
  const { v } = useMetrics();
  const reduced = useMotionPreference();
  const rise = useEnter(260, 650);
  const halo = useLoop(1800);
  const shine = useLoop(3200);
  const scale = useRef(new Animated.Value(1)).current;
  // A reduced-motion switch must also release a press that is already held.
  useEffect(() => {
    scale.stopAnimation();
    scale.setValue(1);
  }, [reduced, scale]);
  const press = (pressed: boolean) => {
    scale.stopAnimation();
    Animated.timing(scale, {
      toValue: pressed && !reduced ? 0.98 : 1,
      duration: reduced ? 0 : motion.press,
      useNativeDriver: true,
    }).start();
  };
  const height = Math.max(64, v(112));
  const ring = v(4);
  const shineWidth = v(140);
  return (
    <Animated.View
      style={{
        marginTop: v(10),
        marginBottom: v(72),
        opacity: rise,
        transform: [
          { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [v(22), 0] }) },
          { scale },
        ],
      }}
    >
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: -ring,
          left: -ring,
          right: -ring,
          bottom: -ring,
          borderRadius: (height + ring * 2) / 2,
          borderWidth: ring,
          borderColor: colors.orange,
          opacity: reduced ? 0 : halo.interpolate({ inputRange: [0, 1], outputRange: [0.7, 0] }),
          transform: [
            { scaleX: halo.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] }) },
            { scaleY: halo.interpolate({ inputRange: [0, 1], outputRange: [1, 1.32] }) },
          ],
        }}
      />
      <View
        style={{
          borderRadius: height / 2,
          shadowColor: colors.orange,
          shadowOpacity: 0.45,
          shadowRadius: v(20),
          shadowOffset: { width: 0, height: v(18) },
        }}
      >
        <Pressable
          testID="kiosk-start"
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ disabled: busy, busy }}
          disabled={busy}
          onPress={onPress}
          onPressIn={() => press(true)}
          onPressOut={() => press(false)}
          style={{
            height,
            borderRadius: height / 2,
            backgroundColor: colors.orangeCta,
            overflow: 'hidden',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: v(16),
            paddingHorizontal: v(32),
            opacity: busy ? 0.7 : 1,
          }}
        >
          {reduced ? null : (
            <Animated.View
              pointerEvents="none"
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: 0,
                width: shineWidth,
                transform: [
                  {
                    translateX: shine.interpolate({
                      inputRange: [0, 0.55, 1],
                      outputRange: [-1.4 * shineWidth, 6.2 * shineWidth, 6.2 * shineWidth],
                      easing: Easing.inOut(Easing.quad),
                    }),
                  },
                  { skewX: '-20deg' },
                ],
              }}
            >
              <LinearGradient
                colors={['rgba(255,255,255,0)', 'rgba(255,255,255,.35)', 'rgba(255,255,255,0)']}
                start={{ x: 0, y: 0.5 }}
                end={{ x: 1, y: 0.5 }}
                style={StyleSheet.absoluteFill}
              />
            </Animated.View>
          )}
          {busy ? <ActivityIndicator accessibilityLabel={label} color={colors.white} /> : null}
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            style={{
              fontFamily: fonts.black,
              fontSize: v(38),
              lineHeight: v(42),
              letterSpacing: v(38) * 0.04,
              color: colors.white,
              textAlign: 'center',
              flexShrink: 1,
            }}
          >
            {label}
          </Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}
/** v3 01 attract screen content over the film: logo, language, CTA and a QR hint. */
export function WelcomeContent({
  locale,
  onLocale,
  onStart,
  busy,
}: {
  locale: Locale;
  onLocale: (v: Locale) => void;
  onStart: () => void;
  busy: boolean;
}) {
  const { v } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(locale);
  // Prototype logo `drop` (700 ms, spring curve): -28 pt and .92, overshoot, settle.
  const drop = useEnter(0, 700, 'spring');
  const language = useEnter(200, 500);
  const foot = useEnter(480, 600);
  const visible = drop.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  return (
    <>
      <Pressable
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        onPress={onStart}
        disabled={busy}
        style={StyleSheet.absoluteFill}
      />
      <View
        pointerEvents="box-none"
        style={{
          flex: 1,
          justifyContent: 'space-between',
          paddingTop: Math.max(safe.top, v(40)),
          paddingBottom: Math.max(safe.bottom, v(48)),
        }}
      >
        <View
          pointerEvents="box-none"
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            paddingHorizontal: Math.max(safe.left, v(44)),
          }}
        >
          <Animated.View
            style={{
              opacity: visible,
              transform: [
                { translateY: drop.interpolate({ inputRange: [0, 1], outputRange: [-v(28), 0] }) },
                { scale: drop.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) },
              ],
              ...(Platform.OS === 'ios'
                ? {
                    shadowColor: '#000000',
                    shadowOpacity: 0.35,
                    shadowRadius: v(20),
                    shadowOffset: { width: 0, height: v(8) },
                  }
                : null),
            }}
          >
            <Logo size="hero" />
          </Animated.View>
          <Animated.View style={{ opacity: language }}>
            <Language locale={locale} onChange={onLocale} tone="inverse" />
          </Animated.View>
        </View>
        <View pointerEvents="box-none" style={{ paddingHorizontal: v(48), gap: v(22) }}>
          <StartCta label={t.orderNow} busy={busy} onPress={onStart} />
          <Animated.View
            pointerEvents="none"
            style={{
              marginTop: v(4),
              opacity: foot,
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: v(16),
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: v(12),
                height: v(60),
                paddingLeft: v(10),
                paddingRight: v(22),
                borderRadius: 999,
                backgroundColor: 'rgba(255,255,255,.12)',
              }}
            >
              <View
                style={{
                  width: v(42),
                  height: v(42),
                  borderRadius: v(21),
                  backgroundColor: colors.orange,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon name="qr-code-outline" size="small" tone="inverse" />
              </View>
              <Text
                numberOfLines={1}
                style={{ fontFamily: fonts.medium, fontSize: v(20), color: colors.white }}
              >
                {t.payQR}
              </Text>
            </View>
            <Text
              numberOfLines={2}
              style={{
                flexShrink: 1,
                textAlign: 'right',
                fontFamily: fonts.body,
                fontSize: v(20),
                color: 'rgba(255,255,255,.75)',
              }}
            >
              {t.tapAnywhere}
            </Text>
          </Animated.View>
        </View>
      </View>
    </>
  );
}
