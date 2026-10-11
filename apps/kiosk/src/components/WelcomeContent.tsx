import { useEffect, useRef, useState } from 'react';
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
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copy, type Locale } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
import { Language, Logo } from './UI';
import { ease, motion, useEnter, useLoop } from './motion';
import { useMotionPreference } from './useMotionPreference';
import { ownerOrange } from './ownerOrange';
import { fixedText } from './Body';
import {
  CTA_FLIP,
  CTA_ORDER,
  CTA_STEP_MS,
  ctaRotates,
  ctaShownLocale,
  nextCtaStep,
} from './ctaLanguage';
/** Nine samples of the CTA shine sweep and its ease-in-out (quad) curve. */
const sweep = Array.from({ length: 9 }, (_, k) => k / 8);
const inOutQuad = (u: number) => (u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u));
/** Kaspi brand mark for the "Pay with Kaspi QR" chip (same file as the checkout package). */
const kaspiLogo = require('../../assets/v3/kaspi.webp');
/**
 * Rotation step of the CTA caption (ctaLanguage.ts). The interval runs only while the caption
 * rotates: it stops under Reduce Motion, in the background (useMotionPreference follows AppState
 * and the page visibility), once the guest picks a language, and when the attract screen unmounts.
 */
function useCtaStep(rotating: boolean) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!rotating) return;
    const timer = setInterval(() => setStep(nextCtaStep), CTA_STEP_MS);
    return () => clearInterval(timer);
  }, [rotating]);
  return step;
}
/**
 * The rotating caption: a vertical flip without blur on the native driver (transform and
 * opacity). The old caption leaves up and fades out in 120 ms; the new one rises from below and
 * fades in between 100 and 280 ms. Hidden from VoiceOver: the button carries its own label.
 */
function CtaCaption({ shown, animate }: { shown: Locale; animate: boolean }) {
  const { v } = useMetrics();
  const lineHeight = v(42);
  const [pair, setPair] = useState<{ cur: Locale; prev: Locale | null }>({
    cur: shown,
    prev: null,
  });
  const current = useRef(shown);
  const move = useRef(new Animated.Value(1)).current;
  const fade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const from = current.current;
    if (shown === from) return;
    current.current = shown;
    move.stopAnimation();
    fade.stopAnimation();
    if (!animate) {
      move.setValue(1);
      fade.setValue(1);
      setPair({ cur: shown, prev: null });
      return;
    }
    move.setValue(0);
    fade.setValue(0);
    setPair({ cur: shown, prev: from });
    const flip = Animated.parallel([
      Animated.timing(move, {
        toValue: 1,
        duration: CTA_FLIP.duration,
        easing: ease,
        useNativeDriver: true,
      }),
      Animated.timing(fade, {
        toValue: 1,
        duration: CTA_FLIP.duration,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    ]);
    flip.start(({ finished }) => {
      if (finished) setPair((p) => (p.cur === shown ? { cur: shown, prev: null } : p));
    });
    return () => flip.stop();
  }, [shown, animate, move, fade]);
  const shift = lineHeight * CTA_FLIP.shift;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      pointerEvents="none"
      style={{ flex: 1, height: lineHeight, overflow: 'hidden', marginBottom: v(10) }}
    >
      {CTA_ORDER.map((locale) => {
        const role = locale === pair.cur ? 'cur' : locale === pair.prev ? 'prev' : 'off';
        return (
          <Animated.Text
            {...fixedText}
            key={locale}
            testID={role === 'cur' ? 'kiosk-start-caption' : undefined}
            numberOfLines={1}
            adjustsFontSizeToFit
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              fontFamily: fonts.black,
              fontSize: v(38),
              lineHeight,
              letterSpacing: v(38) * 0.04,
              color: colors.white,
              textAlign: 'center',
              opacity:
                role === 'cur'
                  ? fade.interpolate({
                      inputRange: [0, CTA_FLIP.inDelay / CTA_FLIP.duration, 1],
                      outputRange: [0, 0, 1],
                    })
                  : role === 'prev'
                    ? fade.interpolate({
                        inputRange: [0, CTA_FLIP.outFade / CTA_FLIP.duration, 1],
                        outputRange: [1, 0, 0],
                      })
                    : 0,
              transform: [
                {
                  translateY:
                    role === 'cur'
                      ? move.interpolate({ inputRange: [0, 1], outputRange: [shift, 0] })
                      : role === 'prev'
                        ? move.interpolate({ inputRange: [0, 1], outputRange: [0, -shift] })
                        : shift,
                },
              ],
            }}
          >
            {copy(locale).orderNow}
          </Animated.Text>
        );
      })}
    </View>
  );
}
/** Three decorative dots KZ, RU, EN under the caption; the shown language is stretched. */
function CtaDots({ shown }: { shown: Locale }) {
  const { v } = useMetrics();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      pointerEvents="none"
      style={{
        position: 'absolute',
        bottom: v(14),
        left: 0,
        right: 0,
        flexDirection: 'row',
        justifyContent: 'center',
        gap: v(8),
      }}
    >
      {CTA_ORDER.map((locale) => (
        <View
          key={locale}
          testID={locale === shown ? 'kiosk-start-dot-active' : undefined}
          style={{
            width: locale === shown ? v(22) : v(8),
            height: v(8),
            borderRadius: 999,
            backgroundColor: locale === shown ? colors.white : 'rgba(255,255,255,.45)',
          }}
        />
      ))}
    </View>
  );
}
/**
 * v3 attract CTA: one orange pill with an expanding halo and a passing shine. Its caption takes
 * turns KZ -> RU -> EN (owner decision 2026-10-11); the accessible name and the order language
 * always follow the language switch (`locale`).
 */
function StartCta({
  locale,
  pinned,
  busy,
  onPress,
}: {
  locale: Locale;
  pinned: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  const { v } = useMetrics();
  const reduced = useMotionPreference();
  const label = copy(locale).orderNow;
  // useMotionPreference is also true in the background: the rotation stops there too.
  const rotating = ctaRotates({ pinned, reduced, active: true });
  const step = useCtaStep(rotating);
  const shown = ctaShownLocale(step, { pinned, reduced }, locale);
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
          {...ownerOrange}
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
                    // Ease-in-out (quad) sweep, sampled: the native driver takes no
                    // `easing` inside interpolate (it would be dropped in release builds).
                    translateX: shine.interpolate({
                      inputRange: [...sweep.map((u) => u * 0.55), 1],
                      outputRange: [
                        ...sweep.map((u) => (-1.4 + 7.6 * inOutQuad(u)) * shineWidth),
                        6.2 * shineWidth,
                      ],
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
          <CtaCaption shown={shown} animate={rotating} />
          <CtaDots shown={shown} />
        </Pressable>
      </View>
    </Animated.View>
  );
}
/**
 * Staff gesture on the attract logo (owner decision 2026-10-11): holding it this long opens the
 * demo mode dialog. Equal to DEMO_HOLD_MS in demo.ts (checked by tests/kiosk/design-demo.test.mjs).
 */
export const STAFF_HOLD_MS = 5000;
/** v3 01 attract screen content over the film: logo, language, CTA and a QR hint. */
export function WelcomeContent({
  locale,
  onLocale,
  onStart,
  busy,
  onLogoHold,
}: {
  locale: Locale;
  onLocale: (v: Locale) => void;
  onStart: () => void;
  busy: boolean;
  /** Staff only: a long hold (STAFF_HOLD_MS) on the logo; no visible hint for guests. */
  onLogoHold?: () => void;
}) {
  const { v } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(locale);
  // The guest touched the language switch: the CTA caption stops on that language until the
  // attract screen is shown again (this component remounts with it).
  const [pinned, setPinned] = useState(false);
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
            {onLogoHold ? (
              <Pressable
                testID="kiosk-logo-hold"
                accessible={false}
                delayLongPress={STAFF_HOLD_MS}
                onLongPress={onLogoHold}
              >
                <Logo size="hero" />
              </Pressable>
            ) : (
              <Logo size="hero" />
            )}
          </Animated.View>
          <Animated.View style={{ opacity: language }}>
            <Language
              locale={locale}
              onChange={(value) => {
                setPinned(true);
                onLocale(value);
              }}
              tone="inverse"
            />
          </Animated.View>
        </View>
        <View pointerEvents="box-none" style={{ paddingHorizontal: v(48), gap: v(22) }}>
          {/* A tap always starts the order in the switch language (GuestScreen), whatever
              language the caption shows (owner decision 2026-10-11). */}
          <StartCta locale={locale} pinned={pinned} busy={busy} onPress={onStart} />
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
              <Image
                source={kaspiLogo}
                contentFit="contain"
                accessible={false}
                accessibilityLabel=""
                style={{ width: v(42), height: v(42) }}
              />
              <Text
                {...fixedText}
                numberOfLines={1}
                style={{ fontFamily: fonts.medium, fontSize: v(20), color: colors.white }}
              >
                {t.payKaspiQR}
              </Text>
            </View>
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
