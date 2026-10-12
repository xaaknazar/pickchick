import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copy, type Locale } from '../i18n';
import { colors, fonts, redesign, useMetrics } from '../theme';
import { Language, Logo } from './UI';
import { useEnter } from './motion';
import { SaluteButton } from './SaluteButton';
import { fixedText } from './Body';
/** Kaspi brand mark for the "Pay with Kaspi QR" chip (same file as the checkout package). */
const kaspiLogo = require('../../assets/v3/kaspi.webp');
/** The start CTA rises in (260 ms delay, 650 ms); its salute loop starts once it has landed. */
function StartCta({ label, busy, onPress }: { label: string; busy: boolean; onPress: () => void }) {
  const { v } = useMetrics();
  const rise = useEnter(260, 650);
  return (
    <Animated.View
      style={{
        marginTop: v(10),
        marginBottom: v(72),
        opacity: rise,
        transform: [
          { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [v(22), 0] }) },
        ],
      }}
    >
      <SaluteButton testID="kiosk-start" label={label} busy={busy} onPress={onPress} delay={910} />
    </Animated.View>
  );
}
/**
 * Redesign 2026-10-13 «Оплата через Kaspi QR» chip over the film: 75 pt tall smoked glass
 * (rgba(2,10,31,.28), 1 px light line, 14 px backdrop blur on the web), a round 50 pt Kaspi
 * mark on a white disc and Montserrat 700 24. Sizes are 1024-wide mock-up points (`px`).
 */
function KaspiChip({ label }: { label: string }) {
  const { px } = useMetrics();
  const web =
    Platform.OS === 'web'
      ? ({
          backdropFilter: 'blur(14px)',
          WebkitBackdropFilter: 'blur(14px)',
        } as unknown as ViewStyle)
      : null;
  const disc = px(50);
  return (
    <View
      testID="kiosk-start-kaspi"
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: px(14),
          height: px(75),
          paddingLeft: px(12),
          paddingRight: px(26),
          borderRadius: px(38),
          borderWidth: 1,
          borderColor: redesign.startChipLine,
          backgroundColor: redesign.startChip,
        },
        web,
      ]}
    >
      <View
        style={{
          width: disc,
          height: disc,
          borderRadius: disc / 2,
          backgroundColor: colors.white,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        <Image
          source={kaspiLogo}
          contentFit="contain"
          accessible={false}
          accessibilityLabel=""
          style={{ width: px(42), height: px(42) }}
        />
      </View>
      <Text
        {...fixedText}
        numberOfLines={1}
        style={{
          fontFamily: fonts.heading,
          fontSize: px(24),
          lineHeight: px(30),
          color: colors.white,
        }}
      >
        {label}
      </Text>
    </View>
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
            <Language locale={locale} onChange={onLocale} tone="inverse" surface="start" />
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
            <KaspiChip label={t.payKaspiQR} />
            <Text
              {...fixedText}
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
