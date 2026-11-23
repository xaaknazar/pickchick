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
  pressIn: 90,
  pressOut: 150,
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
 * Apple's motion (HIG «Motion», WWDC23 «Animate with springs»): every move is a spring described
 * by how long it feels and how much it bounces, it starts from the finger's speed and can be
 * interrupted at any moment. Reanimated takes these as `withSpring(value, spring.smooth)`.
 *  - smooth: no bounce. Sheets, pages, anything large (SwiftUI `.smooth`).
 *  - snappy: a hint of bounce, quicker. Controls, chips, small moves (`.snappy`).
 *  - bouncy: a visible bounce, kept for rewards and «added» moments (`.bouncy`).
 *  - exit: no bounce and no overshoot, for anything leaving the screen.
 */
export const spring = {
  smooth: { duration: 520, dampingRatio: 1 },
  snappy: { duration: 380, dampingRatio: 0.82 },
  bouncy: { duration: 560, dampingRatio: 0.68 },
  exit: { duration: 380, dampingRatio: 1, overshootClamping: true },
} as const;

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
    // Apple: the highlight follows the finger at once; the release springs back without a jolt.
    (pressed || reduced
      ? Animated.timing(value, {
          toValue: pressed ? 1 : 0,
          duration: reduced ? 0 : motion.pressIn,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
          isInteraction: false,
        })
      : Animated.spring(value, {
          toValue: 0,
          ...animatedSpring(0.3, 0.85),
          useNativeDriver: true,
          isInteraction: false,
        })
    ).start();
  };
  useEffect(() => {
    value.stopAnimation();
    value.setValue(0);
    setPressed(false);
    return () => value.stopAnimation();
  }, [disabled, reduced, value]);
  return (
    <AnimatedPressable
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
        !disabled && {
          opacity: value.interpolate({
            inputRange: [0, 1],
            outputRange: [1, feedback === 'scale' ? 0.92 : 0.75],
            extrapolate: 'clamp',
          }),
        },
        feedback === 'scale' &&
          !reduced &&
          !disabled && {
            transform: [
              { scale: value.interpolate({ inputRange: [0, 1], outputRange: [1, 0.96] }) },
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
        easing: Easing.out(Easing.cubic),
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
