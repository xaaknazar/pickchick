import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { motion, spring, useReducedMotion } from './Motion';
import { colors, themed, tc } from '../theme';

/** Apple's rubber band: past the edge the content follows the finger less and less. */
export function rubberBand(offset: number, dimension: number) {
  'worklet';
  const c = 0.55;
  return (1 - 1 / ((Math.abs(offset) * c) / dimension + 1)) * dimension * Math.sign(offset);
}

/**
 * Keeps a modal on screen until its exit animation has finished: `visible` turning false starts
 * the exit, the native modal is hidden only after it (so `onDismiss` still comes last).
 */
function usePresence(visible: boolean) {
  const [mounted, setMounted] = useState(visible);
  useEffect(() => {
    if (visible) setMounted(true);
  }, [visible]);
  const unmount = useCallback(() => setMounted(false), []);
  return { mounted, unmount };
}

/**
 * A bottom sheet in Apple's manner (UISheetPresentationController): the dimming fades on its own
 * while the sheet rises on a spring without bounce; the grabber drags it, with rubber band at the
 * top and the finger's speed carried into the close. Replaces `Modal transparent
 * animationType="slide"`, where the whole dark layer slid in with the sheet.
 */
export function SheetModal({
  visible,
  onClose,
  onDismiss,
  closeLabel,
  dim = tc('#00000088'),
  style,
  children,
}: {
  visible: boolean;
  onClose(): void;
  onDismiss?: () => void;
  closeLabel: string;
  dim?: string;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const { mounted, unmount } = usePresence(visible);
  const [height, setHeight] = useState(0);
  const y = useSharedValue(2000);
  const shade = useSharedValue(0);
  const start = useSharedValue(0);
  const shown = useRef(false);
  useEffect(() => {
    if (!mounted || !height) return;
    if (visible) {
      shown.current = true;
      if (reduced) {
        y.value = 0;
        shade.value = withTiming(1, { duration: motion.dimIn });
        return;
      }
      if (y.value > height) y.value = height;
      y.value = withSpring(0, spring.smooth);
      shade.value = withTiming(1, { duration: motion.dimIn, easing: Easing.out(Easing.quad) });
    } else {
      shade.value = withTiming(0, { duration: motion.dimOut, easing: Easing.out(Easing.quad) });
      const done = (finished?: boolean) => {
        'worklet';
        if (finished) runOnJS(unmount)();
      };
      y.value = reduced
        ? withTiming(0, { duration: motion.dimOut }, done)
        : withSpring(height, spring.exit, done);
    }
  }, [visible, mounted, height, reduced, y, shade, unmount]);
  const pan = Gesture.Pan()
    .activeOffsetY([-8, 8])
    .onStart(() => {
      cancelAnimation(y);
      start.value = y.value;
    })
    .onUpdate((e) => {
      const next = start.value + e.translationY;
      y.value = next < 0 ? rubberBand(next, height) : next;
      shade.value = Math.max(0, 1 - Math.max(0, next) / Math.max(1, height));
    })
    .onEnd((e) => {
      if (y.value > height * 0.3 || e.velocityY > 900) {
        y.value = withSpring(height, { ...spring.exit, velocity: e.velocityY });
        runOnJS(onClose)();
      } else {
        y.value = withSpring(0, { ...spring.smooth, velocity: e.velocityY });
        shade.value = withTiming(1, { duration: motion.dimIn });
      }
    });
  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const shadeStyle = useAnimatedStyle(() => ({ opacity: shade.value }));
  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      onRequestClose={onClose}
      onDismiss={onDismiss}
      statusBarTranslucent
    >
      {/* Leaving: taps already go to the screen underneath. */}
      <GestureHandlerRootView style={s.root} pointerEvents={visible ? 'auto' : 'none'}>
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: dim }, shadeStyle]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={closeLabel}
          style={StyleSheet.absoluteFill}
          onPress={onClose}
        />
        <Animated.View
          style={[s.sheet, style, sheetStyle]}
          onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
        >
          {children}
          <GestureDetector gesture={pan}>
            <View testID="sheet-grabber" style={s.grabberArea} accessible={false}>
              <View style={s.grabber} />
            </View>
          </GestureDetector>
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}

/**
 * A centred dialog as on iOS: the dimming fades in and the card settles from slightly larger on a
 * quick spring; it leaves with a short fade only. Replaces `Modal animationType="none"`.
 * The child draws its own dimming backdrop and card, so the whole layer fades together.
 */
export function DialogModal({
  visible,
  onRequestClose,
  children,
}: {
  visible: boolean;
  onRequestClose(): void;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const { mounted, unmount } = usePresence(visible);
  const opacity = useSharedValue(0);
  const scale = useSharedValue(1.08);
  useEffect(() => {
    if (!mounted) return;
    if (visible) {
      opacity.value = withTiming(1, {
        duration: reduced ? 120 : 200,
        easing: Easing.out(Easing.quad),
      });
      scale.value = reduced ? 1 : withSpring(1, spring.snappy);
    } else {
      opacity.value = withTiming(
        0,
        { duration: motion.dialogOut, easing: Easing.out(Easing.quad) },
        (finished) => {
          if (finished) runOnJS(unmount)();
        },
      );
    }
  }, [visible, mounted, reduced, opacity, scale, unmount]);
  useEffect(() => {
    if (!mounted) scale.value = 1.08;
  }, [mounted, scale]);
  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));
  return (
    <Modal visible={mounted} transparent animationType="none" onRequestClose={onRequestClose}>
      <Animated.View style={[{ flex: 1 }, style]} pointerEvents={visible ? 'auto' : 'none'}>
        {children}
      </Animated.View>
    </Modal>
  );
}

/**
 * A number that changes like SwiftUI's `.contentTransition(.numericText())`: the old value slides
 * out and the new one in, up when it grows and down when it shrinks.
 */
export function RollingText({
  value,
  numeric,
  children,
  style,
}: {
  value: string | number;
  numeric: number;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const reduced = useReducedMotion();
  const previous = useRef(numeric);
  const progress = useSharedValue(1);
  const direction = useSharedValue(1);
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (value === shown) return;
    direction.value = numeric >= previous.current ? 1 : -1;
    previous.current = numeric;
    setShown(value);
    if (reduced) return;
    progress.value = 0;
    progress.value = withSpring(1, spring.snappy);
  }, [value, numeric, shown, reduced, direction, progress]);
  const animated = useAnimatedStyle(() => ({
    opacity: Math.min(1, 0.2 + progress.value),
    transform: [{ translateY: (1 - progress.value) * 10 * direction.value }],
  }));
  return <Animated.View style={[style, animated]}>{children}</Animated.View>;
}

const s = themed(() =>
  StyleSheet.create({
    root: { flex: 1, justifyContent: 'flex-end' },
    sheet: {
      width: '100%',
      alignSelf: 'center',
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      overflow: 'hidden',
    },
    grabberArea: {
      position: 'absolute',
      top: 0,
      left: 72,
      right: 72,
      height: 22,
      alignItems: 'center',
      justifyContent: 'center',
    },
    grabber: { width: 36, height: 5, borderRadius: 3, backgroundColor: colors.muted, opacity: 0.6 },
  }),
);
