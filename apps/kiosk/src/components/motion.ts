import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, type EasingFunction } from 'react-native';
import { useMotionPreference } from './useMotionPreference';

/**
 * v3 kiosk motion vocabulary. Internal choreography only: never a styling prop,
 * never a gesture delay, and always a static resting state under reduced motion.
 */
export const motion = {
  press: 140,
  enter: 380,
  exit: 260,
  rise: 520,
  stagger: 55,
  spring: { stiffness: 260, damping: 22, mass: 1 },
} as const;

/** Prototype `--ease`: cubic-bezier(.2,.8,.2,1). */
export const ease = Easing.bezier(0.2, 0.8, 0.2, 1);
/** Prototype `--spring`: cubic-bezier(.34,1.56,.64,1); overshoots ~10 % then settles. */
export const springOut = Easing.bezier(0.34, 1.56, 0.64, 1);
/** CSS `ease-in`, `ease-out` and plain `ease`. */
export const easeIn = Easing.bezier(0.42, 0, 1, 1);
export const easeOut = Easing.bezier(0, 0, 0.58, 1);
export const cssEase = Easing.bezier(0.25, 0.1, 0.25, 1);
/** Product hero landing: cubic-bezier(.2,.9,.25,1.15), a slight overshoot. */
export const settle = Easing.bezier(0.2, 0.9, 0.25, 1.15);

export type Curve = 'ease' | 'spring' | 'linear' | 'in' | 'out' | 'css' | 'settle';
const curves: Record<Curve, EasingFunction> = {
  ease,
  spring: springOut,
  linear: Easing.linear,
  in: easeIn,
  out: easeOut,
  css: cssEase,
  settle,
};
/** Named prototype curve for an `Animated.timing` easing. */
export const curve = (name: Curve) => curves[name];

/** Mount entrance: 0 -> 1 once. Reduced motion jumps straight to 1. */
export function useEnter(delay = 0, duration: number = motion.rise, shape: Curve = 'ease') {
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
      easing: curves[shape],
      useNativeDriver: true,
    });
    animation.start();
    return () => {
      animation.stop();
      value.setValue(1);
    };
  }, [delay, duration, reduced, shape, value]);
  return value;
}

/** Staggered rise for repeated tiles; capped so long lists never wait. */
export function useStagger(index: number, step: number = motion.stagger) {
  return useEnter(Math.min(index, 8) * step, motion.rise);
}

/** Remainder of `easing` after the fraction `from` of its time has passed. */
const tail = (easing: EasingFunction, from: number): EasingFunction => {
  const start = easing(from);
  const span = 1 - start;
  return (t) => (span ? (easing(from + t * (1 - from)) - start) / span : t);
};

/**
 * Endless 0 -> 1 loop (halo, shine, bob). Static at 0 under reduced motion.
 * `phase` (ms) starts the cycle that far in, like a negative CSS
 * `animation-delay`, so two loops can alternate. `shape` replaces the rising
 * curve (e.g. 'linear' when keyframes are mapped by interpolation).
 */
export function useLoop(duration: number, delay = 0, bounce = false, phase = 0, shape?: Curve) {
  const reduced = useMotionPreference();
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    value.setValue(0);
    if (reduced) return;
    const half = duration / 2;
    const swing = Easing.inOut(Easing.sin);
    const rise = shape ? curves[shape] : bounce ? swing : Easing.out(Easing.quad);
    const time = (toValue: number, ms: number, easing: EasingFunction) =>
      Animated.timing(value, { toValue, duration: ms, easing, useNativeDriver: true });
    const one = time(1, bounce ? half : duration, rise);
    const back = bounce ? time(0, half, swing) : time(0, 0, Easing.linear);
    const loop = Animated.loop(Animated.sequence([one, back]));
    // Play the rest of the cycle `phase` ms in, then loop from the top.
    const at = ((phase % duration) + duration) % duration;
    const steps: Animated.CompositeAnimation[] = [];
    if (at) {
      const up = bounce ? half : duration;
      if (at < up) {
        value.setValue(rise(at / up));
        steps.push(time(1, up - at, tail(rise, at / up)), back);
      } else {
        const k = (at - up) / half;
        value.setValue(1 - swing(k));
        steps.push(time(0, half - (at - up), tail(swing, k)));
      }
    }
    const animation = steps.length ? Animated.sequence([...steps, loop]) : loop;
    const timer = setTimeout(() => animation.start(), delay);
    return () => {
      clearTimeout(timer);
      animation.stop();
      value.setValue(0);
    };
  }, [bounce, delay, duration, phase, reduced, shape, value]);
  return value;
}

/** Spring a value to a target (rail indicator, segmented pill). */
export function useSpringTo(target: number) {
  const reduced = useMotionPreference();
  const value = useRef(new Animated.Value(target)).current;
  useEffect(() => {
    if (reduced) {
      value.stopAnimation();
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

/** Timed glide to a target (a CSS `transition`). Jumps under reduced motion. */
export function useTimingTo(target: number, duration: number, shape: Curve = 'ease') {
  const reduced = useMotionPreference();
  const value = useRef(new Animated.Value(target)).current;
  useEffect(() => {
    value.stopAnimation();
    if (reduced) {
      value.setValue(target);
      return;
    }
    const animation = Animated.timing(value, {
      toValue: target,
      duration,
      easing: curves[shape],
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [duration, reduced, shape, target, value]);
  return value;
}

/**
 * A CSS `transition` between two discrete looks (a fill colour): whenever
 * `trigger` changes after mount, `value` jumps to 1 and fades to 0 over
 * `duration`, and `active` is true meanwhile so the caller can render the
 * outgoing look only while it fades. Never active under reduced motion.
 */
export function useFlash(trigger: unknown, duration = 260, shape: Curve = 'css') {
  const reduced = useMotionPreference();
  const value = useRef(new Animated.Value(0)).current;
  const [active, setActive] = useState(false);
  const last = useRef(trigger);
  useEffect(() => {
    // Only a change of `trigger` flashes; a reduced-motion switch never does.
    if (Object.is(last.current, trigger)) return;
    last.current = trigger;
    value.stopAnimation();
    value.setValue(0);
    if (reduced) {
      setActive(false);
      return;
    }
    value.setValue(1);
    setActive(true);
    const animation = Animated.timing(value, {
      toValue: 0,
      duration,
      easing: curves[shape],
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) setActive(false);
    });
    return () => {
      animation.stop();
      value.setValue(0);
      setActive(false);
    };
  }, [duration, reduced, shape, trigger, value]);
  useEffect(() => {
    if (!reduced) return;
    value.stopAnimation();
    value.setValue(0);
    setActive(false);
  }, [reduced, value]);
  return { value, active: active && !reduced };
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
    if (reduced) {
      value.stopAnimation();
      value.setValue(1);
      return;
    }
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

/**
 * Prototype `pop` keyframes: scale .3 -> 1 and opacity 0 -> 1 on the spring
 * curve. Plays on mount (unless `onMount` is false) and again whenever
 * `trigger` changes.
 */
export function usePopIn(trigger: unknown, duration = 420, delay = 0, onMount = true) {
  const reduced = useMotionPreference();
  const value = useRef(new Animated.Value(reduced || !onMount ? 1 : 0)).current;
  const first = useRef(!onMount);
  useEffect(() => {
    value.stopAnimation();
    if (reduced || first.current) {
      first.current = false;
      value.setValue(1);
      return;
    }
    value.setValue(0);
    const animation = Animated.timing(value, {
      toValue: 1,
      duration,
      delay,
      easing: springOut,
      useNativeDriver: true,
    });
    animation.start();
    return () => {
      animation.stop();
      value.setValue(1);
    };
  }, [delay, duration, reduced, trigger, value]);
  return useMemo(
    () => ({
      progress: value,
      opacity: value.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' }),
      scale: value.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }),
    }),
    [value],
  );
}

/**
 * Prototype `.press`: scale to `to` over 140 ms on `--ease` while held. Wrap the
 * Pressable in an Animated.View bound to `scale`; the Pressable stays live.
 */
export function usePress(to = 0.96) {
  const reduced = useMotionPreference();
  const scale = useRef(new Animated.Value(1)).current;
  // A reduced-motion switch must also release a press that is already held.
  useEffect(() => {
    scale.stopAnimation();
    scale.setValue(1);
    return () => scale.stopAnimation();
  }, [reduced, scale]);
  const animate = useCallback(
    (down: boolean) => {
      scale.stopAnimation();
      if (reduced) {
        scale.setValue(1);
        return;
      }
      Animated.timing(scale, {
        toValue: down ? to : 1,
        duration: motion.press,
        easing: ease,
        useNativeDriver: true,
      }).start();
    },
    [reduced, scale, to],
  );
  return useMemo(
    () => ({ scale, onPressIn: () => animate(true), onPressOut: () => animate(false) }),
    [animate, scale],
  );
}

/**
 * Prototype one-shot `el.animate([{scale: a}, {scale: b}, {scale: 1}])`: the
 * whole run follows `shape` over `duration` and the keyframes sit at 0, .5 and
 * 1. `play()` restarts it (tap pulses); at rest and under reduced motion the
 * scale is 1. Never delays the tap that triggers it.
 */
export function usePulse(from: number, peak: number, duration: number, shape: Curve = 'out') {
  const reduced = useMotionPreference();
  const value = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    value.stopAnimation();
    value.setValue(1);
    return () => value.stopAnimation();
  }, [reduced, value]);
  const play = useCallback(() => {
    value.stopAnimation();
    if (reduced) {
      value.setValue(1);
      return;
    }
    value.setValue(0);
    Animated.timing(value, {
      toValue: 1,
      duration,
      easing: curves[shape],
      useNativeDriver: true,
    }).start();
  }, [duration, reduced, shape, value]);
  const scale = useMemo(
    () => value.interpolate({ inputRange: [0, 0.5, 1], outputRange: [from, peak, 1] }),
    [from, peak, value],
  );
  return useMemo(() => ({ scale, play }), [play, scale]);
}

/**
 * Prototype `shake` (420 ms, CSS ease per keyframe): translateX 0, -10, 10, -10,
 * 10, 0. Plays whenever `trigger` changes after mount; bind it to translateX.
 */
export function useShake(trigger: unknown, distance = 10) {
  const reduced = useMotionPreference();
  const value = useRef(new Animated.Value(0)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    value.stopAnimation();
    value.setValue(0);
    if (reduced) return;
    const step = (toValue: number) =>
      Animated.timing(value, { toValue, duration: 84, easing: cssEase, useNativeDriver: true });
    const animation = Animated.sequence([
      step(-distance),
      step(distance),
      step(-distance),
      step(distance),
      step(0),
    ]);
    animation.start();
    return () => {
      animation.stop();
      value.setValue(0);
    };
  }, [distance, reduced, trigger, value]);
  return value;
}

/**
 * Prototype `bump` (520 ms, spring curve per keyframe): scale 1 -> 1.2 with
 * -8deg -> .94 -> 1. Plays whenever `trigger` changes after mount.
 */
export function useBump(trigger: unknown) {
  const reduced = useMotionPreference();
  const scale = useRef(new Animated.Value(1)).current;
  const turn = useRef(new Animated.Value(0)).current;
  const first = useRef(true);
  useEffect(() => {
    const rest = () => {
      scale.stopAnimation();
      turn.stopAnimation();
      scale.setValue(1);
      turn.setValue(0);
    };
    if (first.current) {
      first.current = false;
      return;
    }
    rest();
    if (reduced) return;
    const to = (value: Animated.Value, toValue: number, duration: number) =>
      Animated.timing(value, { toValue, duration, easing: springOut, useNativeDriver: true });
    const animation = Animated.parallel([
      Animated.sequence([to(scale, 1.2, 156), to(scale, 0.94, 156), to(scale, 1, 208)]),
      Animated.sequence([to(turn, -8, 156), to(turn, 0, 156)]),
    ]);
    animation.start();
    return () => {
      animation.stop();
      rest();
    };
  }, [reduced, scale, trigger, turn]);
  return useMemo(
    () => ({
      scale,
      rotate: turn.interpolate({ inputRange: [-8, 0], outputRange: ['-8deg', '0deg'] }),
    }),
    [scale, turn],
  );
}

/**
 * Prototype `tween()`: count a number to its new value over 380 ms with a cubic
 * ease-out on the JS thread (text cannot use the native driver). Shows the final
 * number at once on first mount (or counts from `from`, the value a previous
 * mount last showed) and always under reduced motion.
 */
export function useTween(target: number, duration: number = motion.enter, from: number = target) {
  const reduced = useMotionPreference();
  const [shown, setShown] = useState(from);
  const current = useRef(from);
  useEffect(() => {
    if (reduced || current.current === target) {
      current.current = target;
      setShown(target);
      return;
    }
    const start = current.current;
    const started = Date.now();
    let frame = 0;
    const step = () => {
      const k = Math.min(1, (Date.now() - started) / duration);
      const next =
        k >= 1 ? target : Math.round(start + (target - start) * (1 - Math.pow(1 - k, 3)));
      current.current = next;
      setShown(next);
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [duration, reduced, target]);
  return reduced ? target : shown;
}

/** Window rectangle of a view, for `useFly`. */
export interface FlyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Measurable {
  measureInWindow: (
    callback: (x: number, y: number, width: number, height: number) => void,
  ) => void;
}
/** Resolve a view's window rectangle (null when it is not mounted). */
export function measureRect(view: Measurable | null | undefined) {
  return new Promise<FlyRect | null>((resolve) => {
    if (!view) resolve(null);
    else view.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }));
  });
}

/**
 * Prototype `fly()`: a photo arcs from `from` to the centre of `to` in 780 ms
 * (cubic-bezier(.5,.05,.55,1)), lifting 200 pt and growing mid-way, turning
 * -12deg -> 10deg and fading to .25 as it lands at `landing` pt. `launch`
 * resolves when it lands, at once under reduced motion. Render `flight.style`
 * on an absolutely positioned, pointer-transparent layer that shares the
 * rectangles' coordinate space.
 */
export function useFly(landing = 60) {
  const reduced = useMotionPreference();
  const progress = useRef(new Animated.Value(0)).current;
  const [trip, setTrip] = useState<{ id: number; from: FlyRect; to: FlyRect } | null>(null);
  const done = useRef<(() => void) | null>(null);
  const finish = useCallback(() => {
    const resolve = done.current;
    done.current = null;
    setTrip(null);
    resolve?.();
  }, []);
  useEffect(() => {
    if (!reduced) return;
    progress.stopAnimation();
    finish();
  }, [finish, progress, reduced]);
  useEffect(() => () => progress.stopAnimation(), [progress]);
  const launch = useCallback(
    (from: FlyRect, to: FlyRect) =>
      new Promise<void>((resolve) => {
        done.current?.();
        done.current = null;
        if (reduced || !from.width) {
          setTrip(null);
          resolve();
          return;
        }
        done.current = resolve;
        progress.stopAnimation();
        progress.setValue(0);
        setTrip((previous) => ({ id: (previous?.id ?? 0) + 1, from, to }));
        Animated.timing(progress, {
          toValue: 1,
          duration: 780,
          easing: Easing.bezier(0.5, 0.05, 0.55, 1),
          useNativeDriver: true,
        }).start(({ finished }) => {
          if (finished && done.current === resolve) finish();
        });
      }),
    [finish, progress, reduced],
  );
  const flight = useMemo(() => {
    if (!trip) return null;
    const { from, to } = trip;
    const dx = to.x + to.width / 2 - (from.x + from.width / 2);
    const dy = to.y + to.height / 2 - (from.y + from.height / 2);
    const s = landing / from.width;
    const range = (a: number, b: number, c: number) =>
      progress.interpolate({ inputRange: [0, 0.5, 1], outputRange: [a, b, c] });
    return {
      id: trip.id,
      style: {
        position: 'absolute' as const,
        left: from.x,
        top: from.y,
        width: from.width,
        height: from.height,
        opacity: range(1, 1, 0.25),
        transform: [
          { translateX: range(0, dx * 0.4, dx) },
          { translateY: range(0, dy * 0.4 - 200, dy) },
          { scale: range(1, Math.max(s * 2.4, 0.4), s) },
          {
            rotate: progress.interpolate({
              inputRange: [0, 0.5, 1],
              outputRange: ['0deg', '-12deg', '10deg'],
            }),
          },
        ],
      },
    };
  }, [landing, progress, trip]);
  return { flight, launch };
}
