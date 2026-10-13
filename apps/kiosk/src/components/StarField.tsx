import { StyleSheet, View } from 'react-native';
import { redesign, useMetrics } from '../theme';
const [yellow, white, orange] = redesign.spark;
/**
 * The mock-up's scatter (images/payment-qr.webp), as fractions of the screen so it follows any
 * iPad: four-point stars 12-34 pt (1024-wide points) in white, yellow and orange at .45-.95, and
 * small dots. Most sit at the sides, clear of the amount and the QR.
 */
const STARS: readonly { x: number; y: number; size: number; fill: string; opacity: number }[] = [
  { x: 0.768, y: 0.136, size: 14, fill: white, opacity: 0.8 },
  { x: 0.232, y: 0.159, size: 12, fill: white, opacity: 0.6 },
  { x: 0.924, y: 0.195, size: 30, fill: yellow, opacity: 0.95 },
  { x: 0.068, y: 0.228, size: 22, fill: white, opacity: 0.9 },
  { x: 0.672, y: 0.152, size: 12, fill: white, opacity: 0.45 },
  { x: 0.87, y: 0.418, size: 18, fill: white, opacity: 0.85 },
  { x: 0.135, y: 0.459, size: 14, fill: white, opacity: 0.7 },
  { x: 0.955, y: 0.548, size: 12, fill: yellow, opacity: 0.55 },
  { x: 0.036, y: 0.585, size: 16, fill: orange, opacity: 0.6 },
  { x: 0.936, y: 0.634, size: 16, fill: orange, opacity: 0.85 },
  { x: 0.083, y: 0.67, size: 34, fill: yellow, opacity: 0.9 },
  { x: 0.496, y: 0.846, size: 12, fill: white, opacity: 0.45 },
  { x: 0.968, y: 0.798, size: 20, fill: white, opacity: 0.5 },
  { x: 0.31, y: 0.252, size: 12, fill: yellow, opacity: 0.6 },
];
const DOTS: readonly { x: number; y: number; size: number; opacity: number }[] = [
  { x: 0.37, y: 0.196, size: 5, opacity: 0.6 },
  { x: 0.176, y: 0.309, size: 5, opacity: 0.55 },
  { x: 0.826, y: 0.308, size: 5, opacity: 0.6 },
  { x: 0.781, y: 0.53, size: 4, opacity: 0.5 },
  { x: 0.257, y: 0.729, size: 5, opacity: 0.5 },
  { x: 0.746, y: 0.719, size: 5, opacity: 0.55 },
  { x: 0.6, y: 0.176, size: 4, opacity: 0.45 },
  { x: 0.044, y: 0.39, size: 4, opacity: 0.5 },
  { x: 0.965, y: 0.36, size: 4, opacity: 0.55 },
  { x: 0.105, y: 0.53, size: 3, opacity: 0.6 },
  { x: 0.9, y: 0.475, size: 3, opacity: 0.5 },
  { x: 0.51, y: 0.75, size: 4, opacity: 0.4 },
  { x: 0.2, y: 0.12, size: 3, opacity: 0.55 },
  { x: 0.7, y: 0.09, size: 3, opacity: 0.5 },
];
/**
 * Four-point star of the mock-up as two crossed slim diamonds (no SVG on the kiosk), like the
 * start screen's particles.
 */
function Star({ size, fill }: { size: number; fill: string }) {
  const side = size / Math.SQRT2;
  const diamond = (axis: 'scaleX' | 'scaleY') => (
    <View
      style={{
        position: 'absolute',
        left: (size - side) / 2,
        top: (size - side) / 2,
        width: side,
        height: side,
        backgroundColor: fill,
        transform: [axis === 'scaleX' ? { scaleX: 0.316 } : { scaleY: 0.316 }, { rotate: '45deg' }],
      }}
    />
  );
  return (
    <View style={{ width: size, height: size }}>
      {diamond('scaleX')}
      {diamond('scaleY')}
    </View>
  );
}
/**
 * Kaspi QR screen sky (kiosk redesign 2026-10-13, product-and-payment.md §4): a still scatter of
 * stars and dots over the redesign gradient (`RadialBackdrop` below it). Purely decorative: it
 * takes no touches and is hidden from assistive technology.
 */
export function StarField() {
  const { px, width, height } = useMetrics();
  return (
    <View
      testID="kiosk-payment-stars"
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      style={StyleSheet.absoluteFill}
    >
      {DOTS.map((dot, index) => {
        const size = Math.max(2, px(dot.size));
        return (
          <View
            key={'dot' + index}
            style={{
              position: 'absolute',
              left: Math.round(dot.x * width - size / 2),
              top: Math.round(dot.y * height - size / 2),
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: white,
              opacity: dot.opacity,
            }}
          />
        );
      })}
      {STARS.map((star, index) => {
        const size = px(star.size);
        return (
          <View
            key={'star' + index}
            style={{
              position: 'absolute',
              left: Math.round(star.x * width - size / 2),
              top: Math.round(star.y * height - size / 2),
              opacity: star.opacity,
            }}
          >
            <Star size={size} fill={star.fill} />
          </View>
        );
      })}
    </View>
  );
}
