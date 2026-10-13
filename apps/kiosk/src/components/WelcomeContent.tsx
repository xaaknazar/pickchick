import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { curve, useEnter } from './motion';
import { useMotionPreference } from './useMotionPreference';
import {
  CTA_FLIP,
  CTA_ORDER,
  CTA_STEP_MS,
  ctaCaptionMove,
  ctaRestPoses,
  ctaRotates,
  ctaShownLocale,
  nextCtaStep,
  type CtaPose,
} from './ctaLanguage';
import { SaluteButton } from './SaluteButton';
import { fixedText } from './Body';
/** Kaspi brand mark for the "Pay with Kaspi QR" chip (same file as the checkout package). */
const kaspiLogo = require('../../assets/v3/kaspi.webp');
/** The start CTA rises in (260 ms delay, 650 ms); its salute loop starts once it has landed. */
function useCtaStep(rotating: boolean) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!rotating) return;
    const timer = setInterval(() => setStep(nextCtaStep), CTA_STEP_MS);
    return () => clearInterval(timer);
  }, [rotating]);
  return step;
}
/** One caption's own animated opacity and vertical offset (points). */
interface CaptionTrack {
  opacity: Animated.Value;
  y: Animated.Value;
}
/**
 * The rotating caption: a vertical flip without blur on the native driver (transform and
 * opacity). The old caption leaves up and fades out in 120 ms; the new one rises from below and
 * fades in between 100 and 280 ms. Hidden from VoiceOver: the button carries its own label.
 *
 * Each caption owns its Animated values for its whole life and its style always reads them,
 * never a plain number. On iOS Fabric a view whose opacity or transform the native driver has
 * moved ignores later plain values from React, and nothing restores it when the animated value
 * is detached: a caption a flip had left opaque stayed on the button after its style switched
 * to a static `opacity: 0`, so build 16 stacked languages once a guest chose one. Every change
 * now goes through these values, and any stop (a chosen language, Reduce Motion) stops their
 * animations and sets every caption's rest pose at once, never a frozen half-flip.
 */
function CtaCaption({ shown, animate }: { shown: Locale; animate: boolean }) {
  const { px } = useMetrics();
  const lineHeight = Math.round(px(58) * 1.22);
  const shift = lineHeight * CTA_FLIP.shift;
  const [tracks] = useState(() => {
    const rest = ctaRestPoses(shown);
    return Object.fromEntries(
      CTA_ORDER.map((locale) => [
        locale,
        {
          opacity: new Animated.Value(rest[locale].opacity),
          y: new Animated.Value(rest[locale].lift * shift),
        },
      ]),
    ) as Record<Locale, CaptionTrack>;
  });
  const current = useRef(shown);
  // Pin before paint, including Reduce Motion: the visible caption must change in the
  // same frame as the selected language, without a stale caption between commits.
  useLayoutEffect(() => {
    const from = current.current;
    current.current = shown;
    const pose = (poses: Record<Locale, CtaPose>) => {
      for (const locale of CTA_ORDER) {
        const track = tracks[locale];
        track.opacity.stopAnimation();
        track.y.stopAnimation();
        track.opacity.setValue(poses[locale].opacity);
        track.y.setValue(poses[locale].lift * shift);
      }
    };
    const { start, legs } = ctaCaptionMove(from, shown, animate);
    pose(start);
    if (legs.length === 0) return;
    let live = true;
    const flip = Animated.parallel(
      legs.map((leg) =>
        Animated.timing(
          leg.prop === 'opacity' ? tracks[leg.locale].opacity : tracks[leg.locale].y,
          {
            toValue: leg.prop === 'opacity' ? leg.to : leg.to * shift,
            delay: leg.delay,
            duration: leg.duration,
            easing: curve(leg.curve),
            useNativeDriver: true,
          },
        ),
      ),
    );
    flip.start(({ finished }) => {
      if (finished && live) pose(ctaRestPoses(shown));
    });
    return () => {
      live = false;
      flip.stop();
    };
  }, [shown, animate, shift, tracks]);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      pointerEvents="none"
      style={{ flex: 1, height: lineHeight, overflow: 'hidden', marginBottom: px(12) }}
    >
      {CTA_ORDER.map((locale) => (
        <Animated.Text
          {...fixedText}
          key={locale}
          testID={locale === shown ? 'kiosk-start-caption' : undefined}
          numberOfLines={1}
          adjustsFontSizeToFit
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            fontFamily: fonts.black,
            fontSize: px(58),
            lineHeight,
            letterSpacing: px(58) * 0.04,
            color: colors.white,
            textAlign: 'center',
            opacity: tracks[locale].opacity,
            transform: [{ translateY: tracks[locale].y }],
          }}
        >
          {copy(locale).orderNow}
        </Animated.Text>
      ))}
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
  const rotating = ctaRotates({ pinned, reduced, active: true });
  const step = useCtaStep(rotating);
  const shown = ctaShownLocale(step, { pinned, reduced }, locale);
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
      <SaluteButton testID="kiosk-start" label={label} busy={busy} onPress={onPress} delay={910}>
        <CtaCaption shown={shown} animate={rotating} />
        <CtaDots shown={shown} />
      </SaluteButton>
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
              surface="start"
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
