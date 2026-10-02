import { createContext, useCallback, useEffect, useRef, type ReactNode } from 'react';
import {
  BackHandler,
  Platform,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { motion, useReducedMotion } from './Motion';
import { colors } from '../theme';

// Keyboard events use window coordinates; children are laid out inside this sheet.
export const SheetKeyboardOffsetContext = createContext(0);

/** One bounded surface; only the handle drags so scrolling a long cart never dismisses it. */
export function OrderSheet({
  children,
  name,
  onClose,
  raised = false,
  productHeight = false,
  auth = false,
  checkout = false,
}: {
  children(close: () => void): ReactNode;
  name: string;
  onClose(): void;
  raised?: boolean;
  productHeight?: boolean;
  auth?: boolean;
  checkout?: boolean;
}) {
  const { height, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const top = auth
    ? Math.max(insets.top + 10, Math.min(62, height * 0.08))
    : checkout
      ? Math.max(insets.top + 8, Math.min(62, height * 0.08))
      : productHeight
        ? Math.max(20, insets.top + 8)
        : Math.max(
            insets.top + (raised ? 12 : 16),
            Math.min(raised ? 76 : 116, height * (width > height ? 0.08 : raised ? 0.085 : 0.13)),
          );
  const travel = height - top;
  const y = useSharedValue(reduced ? 0 : travel);
  const gestureStart = useSharedValue(0);
  const closing = useSharedValue(false);
  const exiting = useRef(false);
  const dialog = useRef<View>(null);
  const close = useCallback(() => {
    if (exiting.current) return;
    exiting.current = true;
    closing.value = true;
    y.value = withTiming(
      travel,
      { duration: reduced ? 0 : motion.sheetExit, easing: Easing.in(Easing.cubic) },
      (done) => {
        if (done) runOnJS(onClose)();
      },
    );
  }, [closing, onClose, reduced, travel, y]);
  useEffect(() => {
    y.value = withTiming(0, {
      duration: reduced ? 0 : motion.sheetEnter,
      easing: Easing.bezier(0.22, 1, 0.36, 1),
    });
  }, [reduced, y]);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [close]);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const node = dialog.current as unknown as HTMLElement;
    const previous = document.activeElement as HTMLElement | null;
    const controls = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>('button, input, [tabindex="0"], [role="button"]'),
      ).filter((el) => el.getAttribute('aria-disabled') !== 'true' && el.getClientRects().length);
    controls()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
      if (event.key !== 'Tab') return;
      const items = controls();
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    node.addEventListener('keydown', key);
    return () => {
      node.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, [close]);
  const pan = Gesture.Pan()
    .activeOffsetY([-10, 10])
    .onStart(() => {
      if (closing.value) return;
      cancelAnimation(y);
      gestureStart.value = y.value;
    })
    .onUpdate((e) => {
      if (!closing.value)
        y.value = Math.min(travel, Math.max(0, gestureStart.value + e.translationY));
    })
    .onEnd((e) => {
      if (closing.value) return;
      if (y.value > 90 || e.velocityY > 850) {
        closing.value = true;
        runOnJS(close)();
      }
    })
    .onFinalize(() => {
      if (!closing.value)
        y.value = withTiming(0, {
          duration: reduced ? 0 : motion.sheetReturn,
          easing: Easing.out(Easing.cubic),
        });
    });
  const position = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const scrim = useAnimatedStyle(() => ({ opacity: Math.max(0, 1 - y.value / travel) }));
  return (
    <GestureHandlerRootView style={s.root}>
      <Animated.View style={[StyleSheet.absoluteFill, s.scrim, scrim]} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Закрыть: ${name}`}
        onPress={close}
        style={StyleSheet.absoluteFill}
      />
      <Animated.View
        ref={dialog}
        testID={auth ? 'auth-sheet' : 'order-sheet'}
        accessibilityViewIsModal
        accessibilityLabel={name}
        role="dialog"
        aria-modal
        style={[
          s.sheet,
          { height: travel },
          checkout && { borderTopLeftRadius: 36, borderTopRightRadius: 36 },
          auth && { maxWidth: 520, borderTopLeftRadius: 36, borderTopRightRadius: 36 },
          position,
        ]}
      >
        {!auth ? (
          <GestureDetector gesture={pan}>
            <View testID="sheet-handle" style={s.handleArea} accessible={false}>
              <View style={s.handle} />
            </View>
          </GestureDetector>
        ) : null}
        <SheetKeyboardOffsetContext.Provider value={top}>
          {children(close)}
        </SheetKeyboardOffsetContext.Provider>
      </Animated.View>
    </GestureHandlerRootView>
  );
}
const s = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
  scrim: { backgroundColor: '#00000066' },
  sheet: {
    width: '100%',
    maxWidth: 720,
    overflow: 'hidden',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: colors.background,
  },
  handleArea: { height: 28, alignItems: 'center', justifyContent: 'center' },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.muted },
});
