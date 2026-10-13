import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
  type EasingFunction,
  type LayoutChangeEvent,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, fonts, redesign, useMetrics } from '../theme';
import { fixedText } from './Body';
import { burst, easeInOut, easeOut, motion } from './motion';
import { ownerOrange } from './ownerOrange';
import { useMotionPreference } from './useMotionPreference';

/** One «Салют» cycle (kiosk redesign 2026-10-13). */
const cycle = 2800;
/** The approved mock-up button (1024-wide points): 904 × 140, its particles placed on it. */
const mock = { width: 904, height: 140 };
/**
 * The approved mock-up's fourteen particles (`Main.dc.html`, variant «burst»): centre on the
 * 904 × 140 button, flight (dx, dy) and colour (`redesign.spark`: gold, white, orange).
 * Even entries are 16 pt dots, odd ones 22 pt four-point stars. They sit behind the button.
 */
const particles = [
  [90, 10, -50, -80, 0],
  [230, 0, -14, -110, 1],
  [380, 0, 6, -96, 2],
  [530, 0, 18, -120, 0],
  [690, 0, 40, -96, 1],
  [830, 14, 80, -70, 2],
  [902, 70, 96, 0, 0],
  [830, 126, 72, 66, 1],
  [640, 140, 24, 90, 2],
  [450, 140, 0, 104, 0],
  [250, 140, -30, 90, 1],
  [74, 126, -76, 66, 2],
  [2, 70, -96, 0, 0],
  [310, 0, -36, -86, 1],
] as const;
type Frame = readonly [at: number, value: number];
/**
 * CSS-like keyframes for the native driver: it drops `easing` inside `interpolate`
 * (release builds), so every eased segment is sampled into straight pieces.
 */
function frames(points: readonly Frame[], easing: EasingFunction, steps = 8) {
  const inputRange: number[] = [];
  const outputRange: number[] = [];
  points.forEach(([at, value], index) => {
    const previous = points[index - 1];
    if (!previous) {
      inputRange.push(at);
      outputRange.push(value);
      return;
    }
    const [from, start] = previous;
    const count = start === value ? 1 : steps;
    for (let k = 1; k <= count; k++) {
      const u = k / count;
      inputRange.push(from + (at - from) * u);
      outputRange.push(start + (value - start) * easing(u));
    }
  });
  return { inputRange, outputRange, extrapolate: 'clamp' as const };
}
/**
 * Four-point star of the mock-up, `clip-path: polygon(50% 0, 62% 38%, 100% 50%, …)`, drawn as
 * two crossed slim diamonds (no SVG on the kiosk): a half-width of 15.8 % puts their crossings
 * exactly on the polygon's inner corners.
 */
function Star({ size, fill }: { size: number; fill: string }) {
  const side = size / Math.SQRT2;
  const slim = 0.316;
  const diamond = (axis: 'scaleX' | 'scaleY') => (
    <View
      style={{
        position: 'absolute',
        left: (size - side) / 2,
        top: (size - side) / 2,
        width: side,
        height: side,
        backgroundColor: fill,
        transform: [axis === 'scaleX' ? { scaleX: slim } : { scaleY: slim }, { rotate: '45deg' }],
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
 * Kiosk redesign 2026-10-13 «Салют» CTA, as in the owner's approved mock-up (variant «burst»):
 * an orange pill 140 tall with «СДЕЛАТЬ ЗАКАЗ» in Montserrat 900 58, letter-spacing .04em,
 * no arrow, glow 0 16 48 rgba(255,105,0,.45). On a 2.8 s loop it springs (scale 1 → .965 →
 * 1.045 → 1 over the first 16 %, ease-out), a light band (18 % of the width, skewed -20°)
 * sweeps across it during 6-50 % (ease-in-out), and fourteen particles behind it pop in at
 * 4-8 % (scale .3 → 1), fly to their own offsets by 70 % (scale .4) and fade during 55-70 %,
 * cubic-bezier(.15,.7,.3,1). Sizes are 1024-wide mock-up points (`px`). All of it runs on the
 * native driver (opacity and transforms only). Under reduced motion, while busy or when
 * `still`, the button rests at scale 1 with no band and no particles.
 */
export function SaluteButton({
  label,
  onPress,
  busy = false,
  still = false,
  delay = 0,
  testID,
  children,
}: {
  label: string;
  /** Optional animated caption; the accessible label remains stable. */
  children?: ReactNode;
  onPress: () => void;
  busy?: boolean;
  /** Rest without the salute, as under the system reduced-motion setting. */
  still?: boolean;
  /** Milliseconds before the first cycle (e.g. after an entrance). */
  delay?: number;
  testID?: string;
}) {
  const { px, scale } = useMetrics();
  const reduced = useMotionPreference();
  const calm = reduced || still || busy;
  const [box, setBox] = useState({ width: 0, height: 0 });
  const time = useRef(new Animated.Value(0)).current;
  const press = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    time.stopAnimation();
    time.setValue(0);
    if (calm) return;
    const to = (toValue: number, duration: number) =>
      Animated.timing(time, {
        toValue,
        duration,
        easing: Easing.linear,
        useNativeDriver: true,
        isInteraction: false,
      });
    // A sequence (0 → 1, then back to 0 at once), as in `useLoop`: a bare native-driver
    // timing in Animated.loop plays only once where the JS fallback runs (web export).
    const loop = Animated.loop(Animated.sequence([to(1, cycle), to(0, 0)]));
    const timer = setTimeout(() => loop.start(), delay);
    return () => {
      clearTimeout(timer);
      loop.stop();
      time.setValue(0);
    };
  }, [calm, delay, time]);
  // A reduced-motion switch must also release a press that is already held.
  useEffect(() => {
    press.stopAnimation();
    press.setValue(1);
  }, [reduced, press]);
  const pressTo = (down: boolean) => {
    press.stopAnimation();
    Animated.timing(press, {
      toValue: down && !reduced ? 0.98 : 1,
      duration: reduced ? 0 : motion.press,
      useNativeDriver: true,
    }).start();
  };
  const spring = useMemo(
    () =>
      time.interpolate(
        frames(
          [
            [0, 1],
            [0.03, 0.965],
            [0.09, 1.045],
            [0.16, 1],
            [1, 1],
          ],
          easeOut,
        ),
      ),
    [time],
  );
  const band = box.width * 0.18;
  const sweep = useMemo(
    () =>
      time.interpolate(
        frames(
          [
            [0, -0.35 * box.width],
            [0.06, -0.35 * box.width],
            [0.5, 1.25 * box.width],
            [1, 1.25 * box.width],
          ],
          easeInOut,
          12,
        ),
      ),
    [box.width, time],
  );
  const sparks = useMemo(() => {
    if (!box.width) return [];
    // Shared by every particle: appear at 4-8 %, hold, fade during 55-70 %.
    const opacity = time.interpolate(
      frames(
        [
          [0, 0],
          [0.04, 0],
          [0.08, 1],
          [0.55, 1],
          [0.7, 0],
          [1, 0],
        ],
        burst,
      ),
    );
    const grow = time.interpolate(
      frames(
        [
          [0, 0.3],
          [0.04, 0.3],
          [0.08, 1],
          [0.7, 0.4],
          [1, 0.4],
        ],
        burst,
        16,
      ),
    );
    const fly = (distance: number) =>
      time.interpolate(
        frames(
          [
            [0, 0],
            [0.08, 0],
            [0.7, distance],
            [1, distance],
          ],
          burst,
          16,
        ),
      );
    // Keyed on `scale` so a re-render keeps the nodes.
    return particles.map(([x, y, dx, dy, tint], index) => {
      const star = index % 2 === 1;
      const size = Math.round((star ? 22 : 16) * scale);
      return {
        key: index,
        star,
        size,
        fill: redesign.spark[tint],
        left: (x / mock.width) * box.width - size / 2,
        top: (y / mock.height) * box.height - size / 2,
        opacity,
        transform: [
          { translateX: fly(Math.round(dx * scale)) },
          { translateY: fly(Math.round(dy * scale)) },
          { scale: grow },
        ],
      };
    });
  }, [box.height, box.width, scale, time]);
  const layout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width !== box.width || height !== box.height) setBox({ width, height });
  };
  const height = Math.max(64, px(140));
  const size = px(58);
  return (
    <View onLayout={layout}>
      {calm ? null : (
        <View
          testID={testID && testID + '-sparks'}
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          aria-hidden
          style={StyleSheet.absoluteFill}
        >
          {sparks.map(({ key, star, size: side, fill, left, top, opacity, transform }) => (
            <Animated.View
              key={key}
              style={{
                position: 'absolute',
                left,
                top,
                width: side,
                height: side,
                opacity,
                transform,
              }}
            >
              {star ? (
                <Star size={side} fill={fill} />
              ) : (
                <View
                  style={{
                    width: side,
                    height: side,
                    borderRadius: side / 2,
                    backgroundColor: fill,
                  }}
                />
              )}
            </Animated.View>
          ))}
        </View>
      )}
      <Animated.View style={{ transform: [{ scale: press }] }}>
        <Animated.View
          testID={testID && testID + '-spring'}
          style={{ transform: [{ scale: calm ? 1 : spring }] }}
        >
          <View
            style={{
              borderRadius: height / 2,
              boxShadow: `0 ${px(16)}px ${px(48)}px ${redesign.saluteShadow}`,
            }}
          >
            <Pressable
              testID={testID}
              {...ownerOrange}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ disabled: busy, busy }}
              disabled={busy}
              onPress={onPress}
              onPressIn={() => pressTo(true)}
              onPressOut={() => pressTo(false)}
              style={{
                height,
                borderRadius: height / 2,
                backgroundColor: colors.orangeCta,
                overflow: 'hidden',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: px(22),
                paddingHorizontal: px(40),
                opacity: busy ? 0.7 : 1,
              }}
            >
              {calm || !band ? null : (
                <Animated.View
                  testID={testID && testID + '-sweep'}
                  pointerEvents="none"
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: 0,
                    width: band,
                    transform: [{ translateX: sweep }, { skewX: '-20deg' }],
                  }}
                >
                  {/* CSS linear-gradient(100deg, transparent, rgba(255,255,255,.65), transparent). */}
                  <LinearGradient
                    colors={['rgba(255,255,255,0)', 'rgba(255,255,255,.65)', 'rgba(255,255,255,0)']}
                    start={{ x: 0, y: 0.41 }}
                    end={{ x: 1, y: 0.59 }}
                    style={StyleSheet.absoluteFill}
                  />
                </Animated.View>
              )}
              {busy ? <ActivityIndicator accessibilityLabel={label} color={colors.white} /> : null}
              {children ?? (
                <Text
                  {...fixedText}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  style={{
                    fontFamily: fonts.black,
                    fontSize: size,
                    // Montserrat's normal line height (1.22 em), as in the mock-up.
                    lineHeight: Math.round(size * 1.22),
                    letterSpacing: size * 0.04,
                    color: colors.white,
                    textAlign: 'center',
                    flexShrink: 1,
                  }}
                >
                  {label}
                </Text>
              )}
            </Pressable>
          </View>
        </Animated.View>
      </Animated.View>
    </View>
  );
}
