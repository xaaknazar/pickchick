import { useMemo } from 'react';
import { ActivityIndicator, Animated, Text, View } from 'react-native';
import { paymentQrModules, plateQuietZone } from '../qr';
import { colors, fonts, redesign, useMetrics } from '../theme';
import { fixedText } from './Body';
import { Icon } from './Icon';
import { PaymentQR } from './PaymentQR';
import { useEnter, useLoop } from './motion';
/** Plate geometry of the mock-up (1024-wide points). */
const PAD = 30;
const RADIUS = 40;
/** Orange scanner corners: 7 thick with round ends, arms 62 long, 14 outside the plate. */
const CORNER = { width: 7, arm: 62, gap: 14, bend: 24 };
/**
 * Kaspi QR on its white plate (kiosk redesign 2026-10-13, product-and-payment.md §4): padding 30,
 * radius 40, a deep shadow, and four orange scanner corners (7 pt) around it that breathe gently
 * while the kiosk waits (still under reduced motion). The code is about 400 pt on the 13-inch
 * iPad, bounded by the screen height; `compact` leaves room for the staff demo controls. The
 * plate's padding completes the code's quiet zone to the standard 4 modules. Without a code
 * (being prepared, or past its local expiry) the plate keeps its size and shows `message`.
 */
export function QrPlate({
  payload,
  label,
  message,
  expired = false,
  demoWarning = null,
  compact = false,
}: {
  /** The bank QR text, or null while it is prepared or after it lapsed on the local clock. */
  payload: string | null;
  /** Accessible name of the code. */
  label: string;
  /** Shown on the plate in place of the code. */
  message: string;
  /** The code lapsed: a clock instead of the spinner. */
  expired?: boolean;
  /** Staff demo mode: «ДЕМО - не оплачивать» above a code that cannot be paid. */
  demoWarning?: string | null;
  compact?: boolean;
}) {
  const { px, height } = useMetrics();
  const appear = useEnter(80, 300);
  const breathe = useLoop(2400, 0, true);
  const full = Math.min(px(400), Math.round(height * 0.293));
  const side = compact ? Math.round(full * 0.72) : full;
  const padding = px(PAD);
  const modules = useMemo(() => (payload ? paymentQrModules(payload) : 0), [payload]);
  const quiet = plateQuietZone(modules, side, padding);
  const radius = px(RADIUS);
  const gap = px(CORNER.gap);
  const stroke = Math.max(4, px(CORNER.width));
  const arm = px(CORNER.arm);
  const round = px(CORNER.bend);
  // Round line caps: a dot of the stroke's width at the end of each arm.
  const cap = (x: number, y: number) => (
    <View
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: stroke,
        height: stroke,
        borderRadius: stroke / 2,
        backgroundColor: redesign.cta,
      }}
    />
  );
  const corner = (top: boolean, left: boolean) => (
    <View
      key={`${top}-${left}`}
      style={{
        position: 'absolute',
        width: arm,
        height: arm,
        top: top ? 0 : undefined,
        bottom: top ? undefined : 0,
        left: left ? 0 : undefined,
        right: left ? undefined : 0,
      }}
    >
      <View
        style={{
          position: 'absolute',
          width: arm - stroke / 2,
          height: arm - stroke / 2,
          top: top ? 0 : undefined,
          bottom: top ? undefined : 0,
          left: left ? 0 : undefined,
          right: left ? undefined : 0,
          borderColor: redesign.cta,
          borderTopWidth: top ? stroke : 0,
          borderBottomWidth: top ? 0 : stroke,
          borderLeftWidth: left ? stroke : 0,
          borderRightWidth: left ? 0 : stroke,
          borderTopLeftRadius: top && left ? round : 0,
          borderTopRightRadius: top && !left ? round : 0,
          borderBottomLeftRadius: !top && left ? round : 0,
          borderBottomRightRadius: !top && !left ? round : 0,
        }}
      />
      {cap(left ? arm - stroke : 0, top ? 0 : arm - stroke)}
      {cap(left ? 0 : arm - stroke, top ? arm - stroke : 0)}
    </View>
  );
  return (
    <Animated.View style={{ padding: gap, opacity: appear }}>
      <View
        testID="kiosk-payment-qr-plate"
        style={{
          backgroundColor: colors.white,
          borderRadius: radius,
          padding,
          alignItems: 'center',
          gap: px(14),
          boxShadow: `0 ${px(30)}px ${px(70)}px rgba(2,10,31,.5), 0 ${px(8)}px ${px(20)}px rgba(2,10,31,.25)`,
        }}
      >
        {demoWarning ? (
          <View
            testID="kiosk-demo-qr-warning"
            style={{
              maxWidth: side,
              paddingVertical: px(8),
              paddingHorizontal: px(18),
              borderRadius: 999,
              backgroundColor: colors.orangeInk,
            }}
          >
            <Text
              {...fixedText}
              style={{
                fontFamily: fonts.bold,
                fontSize: Math.max(13, px(17)),
                lineHeight: Math.max(17, px(22)),
                color: colors.white,
                textAlign: 'center',
              }}
            >
              {demoWarning}
            </Text>
          </View>
        ) : null}
        {payload ? (
          <PaymentQR payload={payload} label={label} fit={side} quiet={quiet} />
        ) : (
          <View
            testID="kiosk-payment-qr-pending"
            style={{
              width: side,
              height: side,
              alignItems: 'center',
              justifyContent: 'center',
              gap: px(20),
              paddingHorizontal: px(24),
            }}
          >
            {expired ? (
              <Icon name="time-outline" size="hero" tone="brand" />
            ) : (
              <ActivityIndicator size="large" color={colors.blue} />
            )}
            <Text
              {...fixedText}
              accessibilityLiveRegion="polite"
              style={{
                fontFamily: fonts.medium,
                fontSize: Math.max(15, px(20)),
                lineHeight: Math.max(20, px(28)),
                color: redesign.cardInk,
                textAlign: 'center',
              }}
            >
              {message}
            </Text>
          </View>
        )}
      </View>
      <Animated.View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          opacity: breathe.interpolate({ inputRange: [0, 1], outputRange: [1, 0.55] }),
        }}
      >
        {corner(true, true)}
        {corner(true, false)}
        {corner(false, true)}
        {corner(false, false)}
      </Animated.View>
    </Animated.View>
  );
}
