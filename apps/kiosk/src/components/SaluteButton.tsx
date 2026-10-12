import { useEffect, useMemo, useRef, useState } from 'react';
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
import { cssEase, easeOut, motion } from './motion';
import { ownerOrange } from './ownerOrange';
import { useMotionPreference } from './useMotionPreference';

/** One «Салют» cycle (kiosk redesign 2026-10-13). */
const cycle = 2800;
/** Fourteen sparks: even `kind` is a 22 pt four-point star, odd a 16 pt dot. */
const sparkCount = 14;
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
/** Point on the pill outline at fraction `u` (clockwise from the top-left) and its outward angle. */
function outline(u: number, width: number, height: number) {
  const r = height / 2;
  const straight = Math.max(0, width - height);
  const total = 2 * straight + Math.PI * height;
  let d = (((u % 1) + 1) % 1) * total;
  if (d < straight) return { x: r + d, y: 0, angle: -Math.PI / 2 };
  d -= straight;
  if (d < Math.PI * r) {
    const a = -Math.PI / 2 + d / r;
    return { x: r + straight + Math.cos(a) * r, y: r + Math.sin(a) * r, angle: a };
  }
  d -= Math.PI * r;
  if (d < straight) return { x: r + straight - d, y: height, angle: Math.PI / 2 };
  d -= straight;
  const a = Math.PI / 2 + d / r;
  return { x: r + Math.cos(a) * r, y: r + Math.sin(a) * r, angle: a };
}
/** Four-point star from two crossed slim diamonds (no SVG on the kiosk). */
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
        transform: [axis === 'scaleX' ? { scaleX: 0.36 } : { scaleY: 0.36 }, { rotate: '45deg' }],
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
 * Kiosk redesign 2026-10-13 «Салют» CTA: the orange pill springs (scale 1 → .965 → 1.045 → 1
 * over the first 16 % of a 2.8 s loop, ease-out), a light band (18 % of the width,
 * skewed -20°) sweeps across it during 6-50 %, and fourteen sparks (dots and four-point
 * stars) leave its edges at 4-8 %, fly 60-120 pt outward by 70 % and fade. No arrow. All of it
 * runs on the native driver (opacity and transforms only). Under reduced motion, while busy or
 * when `still`, the button rests at scale 1 with no band and no sparks.
 */
export function SaluteButton({
  label,
  onPress,
  busy = false,
  still = false,
  delay = 0,
  testID,
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  /** Rest without the salute, as under the system reduced-motion setting. */
  still?: boolean;
  /** Milliseconds before the first cycle (e.g. after an entrance). */
  delay?: number;
  testID?: string;
}) {
  const { v, scale } = useMetrics();
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
      Animated.timing(time, { toValue, duration, easing: Easing.linear, useNativeDriver: true });
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
          cssEase,
          12,
        ),
      ),
    [box.width, time],
  );
  const sparks = useMemo(() => {
    if (!box.width) return [];
    // 1024-wide mock-up points (like `px`); keyed on `scale` so a re-render keeps the nodes.
    const px = (n: number) => Math.round(n * scale);
    return Array.from({ length: sparkCount }, (_, index) => {
      const star = index % 2 === 0;
      const size = px(star ? 22 : 16);
      const spot = outline((index + 0.35) / sparkCount, box.width, box.height);
      const angle = spot.angle + (((index * 7) % 5) - 2) * 0.16;
      const reach = px(60 + ((index * 3) % 7) * 10);
      const travel = (axis: number) =>
        time.interpolate(
          frames(
            [
              [0, 0],
              [0.04, 0],
              [0.7, axis * reach],
              [1, axis * reach * 1.12],
            ],
            easeOut,
          ),
        );
      return {
        key: index,
        star,
        size,
        fill: redesign.spark[index % redesign.spark.length] ?? colors.white,
        left: spot.x - size / 2,
        top: spot.y - size / 2,
        opacity: time.interpolate({
          inputRange: [0, 0.04, 0.08, 0.7, 0.92, 1],
          outputRange: [0, 0, 1, 1, 0, 0],
          extrapolate: 'clamp',
        }),
        transform: [
          { translateX: travel(Math.cos(angle)) },
          { translateY: travel(Math.sin(angle)) },
          {
            scale: time.interpolate({
              inputRange: [0, 0.04, 0.08, 0.7, 0.92, 1],
              outputRange: [0.4, 0.4, 1, 1, 0.6, 0.6],
              extrapolate: 'clamp',
            }),
          },
          // Stars turn a quarter as they fly; a dot has nothing to turn.
          ...(star
            ? [
                {
                  rotate: time.interpolate({
                    inputRange: [0, 0.04, 1],
                    outputRange: ['0deg', '0deg', `${index % 4 === 0 ? -90 : 90}deg`],
                    extrapolate: 'clamp',
                  }),
                },
              ]
            : []),
        ],
      };
    });
  }, [box.height, box.width, scale, time]);
  const layout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width !== box.width || height !== box.height) setBox({ width, height });
  };
  const height = Math.max(64, v(112));
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
          {sparks.map(({ key, star, size, fill, left, top, opacity, transform }) => (
            <Animated.View
              key={key}
              style={{
                position: 'absolute',
                left,
                top,
                width: size,
                height: size,
                opacity,
                transform,
              }}
            >
              {star ? (
                <Star size={size} fill={fill} />
              ) : (
                <View
                  style={{
                    width: size,
                    height: size,
                    borderRadius: size / 2,
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
              shadowColor: colors.orange,
              shadowOpacity: 0.45,
              shadowRadius: v(20),
              shadowOffset: { width: 0, height: v(18) },
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
                gap: v(16),
                paddingHorizontal: v(32),
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
              <Text
                {...fixedText}
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
      </Animated.View>
    </View>
  );
}
