import { useEffect, useRef, useState } from 'react';
import { Animated, Text, View } from 'react-native';
import { colors, fonts, useMetrics } from '../theme';
import { cssEase, easeIn, springOut } from './motion';
import { useMotionPreference } from './useMotionPreference';

/** How long the paid card holds before it leaves; the ticket choreography starts then. */
export const paidLead = 1000;

/** The check path `M20 6 9 17l-5-5` (24-unit box), drawn in path order. */
const strokes = (
  [
    [20, 6, 9, 17],
    [9, 17, 4, 12],
  ] as const
).map(([x1, y1, x2, y2]) => ({
  from: [x1, y1] as const,
  to: [x2, y2] as const,
  length: Math.hypot(x2 - x1, y2 - y1),
}));
/** Prototype `stroke-dasharray: 30`: the dash offset runs 30 -> 0. */
const dash = 30;

/**
 * Prototype `.paid` beat, the moment payment succeeds: a green card fades in
 * (220 ms), a white disc pops on the spring curve (520 ms) and the check draws
 * itself stroke by stroke (480 ms after 220 ms). It holds, then fades away as
 * the order ticket arrives. Plays once, the first time `active` is true; it
 * never takes touches and is skipped under reduced motion.
 */
export function PaidStamp({ label, active }: { label: string; active: boolean }) {
  const { v, width } = useMetrics();
  const reduced = useMotionPreference();
  const [playing, setPlaying] = useState(false);
  const played = useRef(false);
  const show = useRef(new Animated.Value(0)).current;
  const disc = useRef(new Animated.Value(0)).current;
  const draw = useRef(new Animated.Value(0)).current;
  const leave = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active || played.current) return;
    played.current = true;
    setPlaying(true);
  }, [active]);
  useEffect(() => {
    if (!playing) return;
    if (reduced) {
      setPlaying(false);
      return;
    }
    for (const value of [show, disc, draw, leave]) value.setValue(0);
    const run = (value: Animated.Value, duration: number, easing: typeof cssEase, delay = 0) =>
      Animated.timing(value, { toValue: 1, duration, delay, easing, useNativeDriver: true });
    const animation = Animated.parallel([
      run(show, 220, cssEase),
      run(disc, 520, springOut),
      run(draw, 480, cssEase, 220),
      run(leave, 280, easeIn, paidLead),
    ]);
    animation.start(({ finished }) => {
      if (finished) setPlaying(false);
    });
    return () => animation.stop();
  }, [disc, draw, leave, playing, reduced, show]);
  if (!playing || reduced) return null;
  const card = Math.min(v(460), width - v(96));
  const big = v(170);
  const box = v(96);
  const unit = box / 24;
  let start = 0;
  return (
    <View
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 5,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Animated.View
        style={{
          width: card,
          height: card,
          borderRadius: v(40),
          backgroundColor: colors.ok,
          alignItems: 'center',
          justifyContent: 'center',
          gap: v(20),
          shadowColor: '#020A28',
          shadowOpacity: 0.45,
          shadowRadius: 35,
          shadowOffset: { width: 0, height: 30 },
          elevation: 18,
          opacity: Animated.multiply(
            show,
            leave.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
          ),
          transform: [{ scale: leave.interpolate({ inputRange: [0, 1], outputRange: [1, 0.97] }) }],
        }}
      >
        <Animated.View
          style={{
            width: big,
            height: big,
            borderRadius: big / 2,
            backgroundColor: colors.white,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: disc.interpolate({
              inputRange: [0, 1],
              outputRange: [0, 1],
              extrapolate: 'clamp',
            }),
            transform: [{ scale: disc.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }) }],
          }}
        >
          <View style={{ width: box, height: box }}>
            {strokes.map(({ from, to, length: stroke }, index) => {
              // Round-capped stroke: 3 units thick, extended 1.5 units past each end.
              const length = (stroke + 3) * unit;
              const begin = start / dash;
              const end = (start + stroke) / dash;
              start += stroke;
              const grow = (a: number, b: number) =>
                draw.interpolate({
                  inputRange: [begin, end],
                  outputRange: [a, b],
                  extrapolate: 'clamp',
                });
              return (
                <Animated.View
                  key={index}
                  style={{
                    position: 'absolute',
                    left: ((from[0] + to[0]) / 2) * unit - length / 2,
                    top: ((from[1] + to[1]) / 2) * unit - 1.5 * unit,
                    width: length,
                    height: 3 * unit,
                    borderRadius: 1.5 * unit,
                    backgroundColor: colors.ok,
                    opacity: draw.interpolate({
                      inputRange: [begin, begin + 0.001],
                      outputRange: [0, 1],
                      extrapolate: 'clamp',
                    }),
                    transform: [
                      {
                        rotate: `${Math.atan2(to[1] - from[1], to[0] - from[0])}rad`,
                      },
                      // Grow from the stroke's start, like stroke-dashoffset.
                      { translateX: grow(-length / 2, 0) },
                      { scaleX: grow(0.001, 1) },
                    ],
                  }}
                />
              );
            })}
          </View>
        </Animated.View>
        <Text
          style={{
            fontFamily: fonts.black,
            fontSize: v(48),
            color: colors.white,
          }}
        >
          {label}
        </Text>
      </Animated.View>
    </View>
  );
}
