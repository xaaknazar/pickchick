import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useFocusEffect } from 'expo-router';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Modal,
  Platform,
  Pressable,
  type ModalProps,
  type PressableProps,
  type ViewProps,
} from 'react-native';

// One live preference for the whole application; no listener per card or button.
const MotionContext = createContext(true);
const MotionReadyContext = createContext(false);
export const motion = {
  // Press feedback lives in the 100-160 ms band (Emil Kowalski, animate-expo §5/§7).
  pressIn: 100,
  pressOut: 160,
  reveal: 220,
  media: 240,
  sheetEnter: 360,
  sheetExit: 240,
  sheetReturn: 200,
  dimIn: 280,
  dimOut: 220,
  dialogOut: 180,
};

/**
 * Easing curves for everything without a finger on it (Emil Kowalski's skills, emil-design-eng /
 * animate-expo): the built-in quad/cubic curves are too weak, and ease-in never goes on UI
 * because it starts slowly, at the very moment the user is watching.
 *  - out: entering or leaving the screen, press feedback, fades (strong ease-out);
 *  - inOut: something moving across the screen (a tab pill, a logo zooming through);
 *  - sheet: the iOS sheet curve, for drawers without a spring.
 * `curve` holds the cubic-bezier points; `easing` is React Native's Animated form, and
 * Reanimated takes `ReEasing.bezier(...curve.out)` (see MotionSheets).
 */
export const curve = {
  out: [0.23, 1, 0.32, 1],
  inOut: [0.77, 0, 0.175, 1],
  sheet: [0.32, 0.72, 0, 1],
} as const;
export const easing = {
  out: Easing.bezier(...curve.out),
  inOut: Easing.bezier(...curve.inOut),
  sheet: Easing.bezier(...curve.sheet),
};

/**
 * Apple's motion (HIG «Motion», WWDC18 «Designing Fluid Interfaces», WWDC23 «Animate with
 * springs»): a move is a spring described by how long it feels and how much it bounces, it starts
 * from the finger's speed and can be interrupted at any moment. Reanimated takes these as
 * `withSpring(value, spring.smooth)`.
 *  - smooth: the default settle, no bounce (Apple: damping 1, response 0.4). Sheets opened by a
 *    button, pages, anything large.
 *  - snappy: small controls and numbers; no bounce either, because nothing was thrown.
 *  - release: after a drag only. A little bounce (damping 0.8, response 0.3), because the finger
 *    gave it momentum; always pass the gesture's velocity with it.
 *  - bouncy: kept for the rare reward moment; never on something the user sees all day.
 *  - exit: no bounce, no overshoot past the edge, and faster than the entry.
 */
export const spring = {
  smooth: { duration: 400, dampingRatio: 1 },
  snappy: { duration: 300, dampingRatio: 1 },
  release: { duration: 300, dampingRatio: 0.8 },
  bouncy: { duration: 500, dampingRatio: 0.75 },
  exit: { duration: 300, dampingRatio: 1, overshootClamping: true },
} as const;

/**
 * Where a flick was going (Apple's projection, decelerationRate 0.998): a fast short swipe
 * commits, a slow long one does not. Velocity in pt/s; returns the extra distance in pt.
 */
export function project(velocity: number, decelerationRate = 0.998) {
  'worklet';
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** The same springs for React Native's Animated (stiffness/damping from response and ratio). */
export function animatedSpring(response: number, dampingRatio: number) {
  const omega = (2 * Math.PI) / response;
  return { stiffness: omega * omega, damping: 2 * dampingRatio * omega, mass: 1 };
}
export function MotionProvider({ children }: { children: ReactNode }) {
  const [reduced, setReduced] = useState(true);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web') {
      const query = window.matchMedia('(prefers-reduced-motion: reduce)');
      const update = () => setReduced(query.matches);
      update();
      setReady(true);
      query.addEventListener('change', update);
      return () => query.removeEventListener('change', update);
    }
    let mounted = true;
    // Unknown preference stays conservative, but cannot block launch indefinitely.
    const timeout = setTimeout(() => {
      if (mounted) setReady(true);
    }, 1000);
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (mounted) setReduced(value);
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setReady(true);
      });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      mounted = false;
      clearTimeout(timeout);
      subscription.remove();
    };
  }, []);
  return (
    <MotionReadyContext.Provider value={ready}>
      <MotionContext.Provider value={reduced}>{children}</MotionContext.Provider>
    </MotionReadyContext.Provider>
  );
}
export const useMotionReady = () => useContext(MotionReadyContext);
export const useReducedMotion = () => useContext(MotionContext);
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
export function MotionPressable({
  style,
  onPressIn,
  onPressOut,
  disabled,
  feedback = 'opacity',
  ...props
}: PressableProps & { feedback?: 'opacity' | 'scale' }) {
  const reduced = useReducedMotion();
  const value = useRef(new Animated.Value(0)).current;
  const [pressed, setPressed] = useState(false);
  const animate = (pressed: boolean) => {
    value.stopAnimation();
    // Feedback on press-in, at once; the release is a short ease-out, not a spring: a press is a
    // discrete state change and nothing was thrown (Emil Kowalski, animate-expo §5).
    Animated.timing(value, {
      toValue: pressed ? 1 : 0,
      duration: reduced ? 0 : pressed ? motion.pressIn : motion.pressOut,
      easing: easing.out,
      useNativeDriver: true,
      isInteraction: false,
    }).start();
  };
  useEffect(() => {
    value.stopAnimation();
    value.setValue(0);
    setPressed(false);
    return () => value.stopAnimation();
  }, [disabled, reduced, value]);
  return (
    <AnimatedPressable
      // A finger drifting a little while pressing must not cancel the press.
      pressRetentionOffset={16}
      {...props}
      disabled={disabled}
      onPressIn={(event) => {
        if (!disabled) {
          setPressed(true);
          animate(true);
        }
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        setPressed(false);
        animate(false);
        onPressOut?.(event);
      }}
      style={[
        typeof style === 'function' ? style({ pressed: pressed && !disabled }) : style,
        // A scaled control does not also dim: scale alone reads as physical, and dimming turns the
        // orange buttons muddy. Plain rows and links keep the iOS highlight.
        !disabled &&
          (feedback !== 'scale' || reduced) && {
            opacity: value.interpolate({
              inputRange: [0, 1],
              outputRange: [1, 0.7],
              extrapolate: 'clamp',
            }),
          },
        feedback === 'scale' &&
          !reduced &&
          !disabled && {
            transform: [
              { scale: value.interpolate({ inputRange: [0, 1], outputRange: [1, 0.97] }) },
            ],
          },
        Platform.OS === 'web' && { cursor: disabled ? 'auto' : 'pointer' },
      ]}
    />
  );
}

export function MotionModal(props: ModalProps) {
  const reduced = useReducedMotion();
  return (
    <Modal
      {...props}
      animationType={reduced ? 'none' : props.animationType === 'slide' ? 'slide' : 'fade'}
    />
  );
}

// Native routes already animate on the UI thread. The web fallback only fades
// the incoming screen, without remounting forms or resetting their state.
export function ScreenTransition({ children, style, ...props }: ViewProps) {
  const reduced = useReducedMotion();
  const opacity = useRef(new Animated.Value(1)).current;
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'web' || reduced) {
        opacity.setValue(1);
        return;
      }
      opacity.setValue(0);
      const animation = Animated.timing(opacity, {
        toValue: 1,
        duration: motion.reveal,
        easing: easing.out,
        useNativeDriver: true,
        isInteraction: false,
      });
      animation.start();
      return () => {
        animation.stop();
        opacity.setValue(1);
      };
    }, [opacity, reduced]),
  );
  return (
    <Animated.View {...props} style={[style, { opacity }]}>
      {children}
    </Animated.View>
  );
}

export function MediaPoster({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  const reduced = useReducedMotion();
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const animation = Animated.timing(opacity, {
      toValue: hidden ? 0 : 1,
      duration: hidden && !reduced ? motion.media : 0,
      easing: easing.out,
      useNativeDriver: true,
      isInteraction: false,
    });
    animation.start();
    return () => animation.stop();
  }, [hidden, reduced, opacity]);
  return (
    <Animated.View pointerEvents="none" style={{ position: 'absolute', inset: 0, opacity }}>
      {children}
    </Animated.View>
  );
}
