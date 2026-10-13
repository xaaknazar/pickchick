import { Platform, Text, View, type ViewStyle } from 'react-native';
import type { Locale } from '../i18n';
import { paymentCopy } from '../paymentCopy';
import { colors, fonts, redesign, useMetrics } from '../theme';
import { fixedText } from './Body';
import { clock, useQrCountdown } from './countdown';
/**
 * A pie: the orange share is the time left, the light share the time gone, growing clockwise
 * from 12 o'clock. Drawn with two clipped half discs (no SVG on the kiosk); `left` is 0..1.
 */
function TimePie({ left, size }: { left: number; size: number }) {
  const share = Math.min(1, Math.max(0, left));
  // The orange sector runs clockwise from 12 o'clock over `share`, then the whole pie is
  // mirrored so that the gone time starts at 12 o'clock.
  const turn = share * 360;
  const half = (rotate: number) => (
    <View
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: size,
        height: size,
        transform: [{ rotate: `${rotate}deg` }],
      }}
    >
      <View
        style={{
          position: 'absolute',
          top: 0,
          left: size / 2,
          width: size / 2,
          height: size,
          borderTopRightRadius: size / 2,
          borderBottomRightRadius: size / 2,
          backgroundColor: redesign.cta,
        }}
      />
    </View>
  );
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: 'rgba(255,255,255,.32)',
        overflow: 'hidden',
        transform: [{ scaleX: -1 }],
      }}
    >
      {/* Right half: 0-180°. */}
      <View
        style={{
          position: 'absolute',
          top: 0,
          left: size / 2,
          width: size / 2,
          height: size,
          overflow: 'hidden',
        }}
      >
        <View style={{ position: 'absolute', top: 0, left: -size / 2, width: size, height: size }}>
          {half(-180 + Math.min(turn, 180))}
        </View>
      </View>
      {/* Left half: 180-360°. */}
      <View
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: size / 2,
          height: size,
          overflow: 'hidden',
        }}
      >
        {half(Math.max(0, turn - 180))}
      </View>
    </View>
  );
}
/**
 * «QR действует 02:58» (kiosk redesign 2026-10-13, product-and-payment.md §4): a glass pill 53
 * high with a pie that empties as the QR's lifetime runs out on the local clock (the bank's
 * expiry from the order, as before). Nothing is shown without an expiry.
 */
export function QrTimer({
  expiresAt,
  locale,
}: {
  expiresAt: string | null | undefined;
  locale: Locale;
}) {
  const { px } = useMetrics();
  const t = paymentCopy(locale);
  const { left, total } = useQrCountdown(expiresAt);
  if (left === null) return null;
  const pie = Math.max(22, px(30));
  const web =
    Platform.OS === 'web'
      ? ({
          backdropFilter: 'blur(18px) saturate(150%)',
          WebkitBackdropFilter: 'blur(18px) saturate(150%)',
        } as unknown as ViewStyle)
      : null;
  return (
    <View
      testID="kiosk-payment-qr-timer"
      accessible
      accessibilityLabel={`${t.qrValid} ${clock(left)}`}
      style={[
        {
          minHeight: Math.max(44, px(53)),
          paddingLeft: px(14),
          paddingRight: px(22),
          borderRadius: 999,
          backgroundColor: redesign.glass,
          borderWidth: 1,
          borderColor: redesign.glassLine,
          flexDirection: 'row',
          alignItems: 'center',
          gap: px(12),
        },
        web,
      ]}
    >
      <TimePie left={left / total} size={pie} />
      <Text
        {...fixedText}
        numberOfLines={1}
        style={{
          fontFamily: fonts.heavy,
          fontSize: Math.max(15, px(20)),
          color: colors.white,
          fontVariant: ['tabular-nums'],
        }}
      >
        {`${t.qrValid} ${clock(left)}`}
      </Text>
    </View>
  );
}
