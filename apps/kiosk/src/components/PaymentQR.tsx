import { useMemo } from 'react';
import { Animated, View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { paymentQrSvg } from '../qr';
import { colors, useMetrics } from '../theme';
import { useLoop } from './motion';
import { useMotionPreference } from './useMotionPreference';

/**
 * The bank QR, encoded locally from the exact payload. Error correction is M,
 * so nothing is ever drawn over the modules. `scanning` sweeps a thin orange
 * line up and down the code (2.4 s each way); it is hidden under reduced motion.
 */
export function PaymentQR({
  payload,
  label,
  size = 'regular',
  scanning = false,
}: {
  payload: string;
  label: string;
  size?: 'regular' | 'compact';
  scanning?: boolean;
}) {
  const { v, height } = useMetrics();
  const reduced = useMotionPreference();
  const line = 5;
  const sweep = useLoop(4800, 0, true);
  const svg = useMemo(() => paymentQrSvg(payload), [payload]);
  // Snap the box to whole points per module so every module edge lands on the
  // pixel grid: no blurred or uneven modules at any iPad scale.
  const cells = Number(/viewBox="0 0 (\d+)/.exec(svg ?? '')?.[1] ?? 0);
  // Design: about 360 pt on the 820 x 1180 iPad (~0.3 of the height), so the
  // steps and the footer still fit on screen on every portrait iPad.
  const wanted = Math.min(v(size === 'compact' ? 360 : 400), Math.round(height * 0.305));
  const box = cells ? Math.max(cells, Math.round(wanted / cells) * cells) : wanted;
  if (!svg) return null;
  return (
    <View style={{ width: box, height: box }}>
      <Image
        testID="kiosk-payment-qr"
        accessibilityLabel={label}
        accessible
        source={{ uri: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` }}
        contentFit="contain"
        style={{ width: box, height: box, backgroundColor: colors.white }}
      />
      {scanning && !reduced ? (
        <Animated.View
          pointerEvents="none"
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          style={{
            position: 'absolute',
            left: -10,
            right: -10,
            top: 0,
            height: line,
            shadowColor: colors.orange,
            shadowOpacity: 0.6,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 0 },
            transform: [
              {
                translateY: sweep.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, box - line],
                }),
              },
            ],
          }}
        >
          <LinearGradient
            colors={['rgba(255,105,0,0)', colors.orange, 'rgba(255,105,0,0)']}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={{ flex: 1, borderRadius: 3 }}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}
