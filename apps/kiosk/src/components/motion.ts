import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { useMotionPreference } from './useMotionPreference';

/**
 * v3 kiosk motion vocabulary. Internal choreography only: never a styling prop,
 * never a gesture delay, and always a static resting state under reduced motion.
 */
export const motion = {
  press: 140,
  enter: 380,
  rise: 520,
  stagger: 55,
  spring: { stiffness: 260, damping: 22, mass: 1 },
} as const;

/** Mount entrance: 0 -> 1 once. Reduced motion jumps straight to 1. */
export function useEnter(delay = 0, duration: number = motion.rise) {
  const reduced = useMotionPreference();
  const value = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) {
      value.stopAnimation();
      value.setValue(1);
      return;
    }
    const animation = Animated.timing(value, {
      toValue: 1,
      duration,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => {
      animation.stop();
      value.setValue(1);
    };
  }, [delay, duration, reduced, value]);
  return value;
}

/** Staggered rise for repeated tiles; capped so long lists never wait. */
export function useStagger(index: number, step: number = motion.stagger) {
  return useEnter(Math.min(index, 8) * step, motion.rise);
}

/** Endless 0 -> 1 loop (halo, shine, bob). Static at 0 under reduced motion. */
export function useLoop(duration: number, delay = 0, bounce = false) {
  const reduced = useMotionPreference();
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    value.setValue(0);
    if (reduced) return;
    const one = Animated.timing(value, {
      toValue: 1,
      duration: bounce ? duration / 2 : duration,
      easing: bounce ? Easing.inOut(Easing.sin) : Easing.out(Easing.quad),
      useNativeDriver: true,
    });
    const loop = Animated.loop(
      bounce
        ? Animated.sequence([
            one,
            Animated.timing(value, {
              toValue: 0,
              duration: duration / 2,
              easing: Easing.inOut(Easing.sin),
              useNativeDriver: true,
            }),
          ])
        : Animated.sequence([
            one,
            Animated.timing(value, { toValue: 0, duration: 0, useNativeDriver: true }),
          ]),
    );
    const timer = setTimeout(() => loop.start(), delay);
    return () => {
      clearTimeout(timer);
      loop.stop();
      value.setValue(0);
    };
  }, [bounce, delay, duration, reduced, value]);
  return value;
}

/** Spring a value to a target (rail indicator, segmented pill). */
export function useSpringTo(target: number) {
  const reduced = useMotionPreference();
  const value = useRef(new Animated.Value(target)).current;
  useEffect(() => {
    if (reduced) {
      value.setValue(target);
      return;
    }
    const animation = Animated.spring(value, {
      toValue: target,
      ...motion.spring,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [reduced, target, value]);
  return value;
}

/** Short pop (scale 1 -> 1.12 -> 1) whenever `trigger` changes after mount. */
export function usePop(trigger: unknown) {
  const reduced = useMotionPreference();
  const value = useRef(new Animated.Value(1)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (reduced) return;
    value.setValue(0.86);
    const animation = Animated.spring(value, {
      toValue: 1,
      stiffness: 320,
      damping: 12,
      mass: 0.8,
      useNativeDriver: true,
    });
    animation.start();
    return () => {
      animation.stop();
      value.setValue(1);
    };
  }, [reduced, trigger, value]);
  return value;
}
