import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AccessibilityInfo, Platform, StyleSheet, Text } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useReducedMotion } from './Motion';
import { Icon, type IconName } from './UI';
import { font } from '../theme';
import {
  SHEET_SPRING,
  TOAST_DURATION_MS,
  toastShouldDismiss,
  toastStyle,
  type ToastMessage,
} from '../luma-patterns';

type Show = (message: Omit<ToastMessage, 'id'>) => void;
const ToastContext = createContext<Show>(() => {});
/** Shows a short confirmation pill from the top; outside the provider it is a no-op. */
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const counter = useRef(0);
  const show = useCallback<Show>((message) => {
    counter.current += 1;
    setToast({ ...message, id: counter.current });
  }, []);
  const dismiss = useCallback(
    (id: number) => setToast((current) => (current?.id === id ? null : current)),
    [],
  );
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast ? <ToastView key={toast.id} toast={toast} onDone={dismiss} /> : null}
    </ToastContext.Provider>
  );
}

function ToastView({ toast, onDone }: { toast: ToastMessage; onDone(id: number): void }) {
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const offset = -(insets.top + 96);
  const y = useSharedValue(reduced ? 0 : offset);
  const opacity = useSharedValue(reduced ? 1 : 0);
  const leaving = useSharedValue(false);
  const palette = toastStyle(toast.tone);
  const finish = useCallback(() => onDone(toast.id), [onDone, toast.id]);
  const leave = useCallback(() => {
    if (leaving.value) return;
    leaving.value = true;
    if (reduced) {
      finish();
      return;
    }
    opacity.value = withTiming(0, { duration: 180 });
    y.value = withTiming(offset, { duration: 220, easing: Easing.in(Easing.cubic) }, (done) => {
      if (done) runOnJS(finish)();
    });
  }, [finish, leaving, offset, opacity, reduced, y]);
  useEffect(() => {
    if (!reduced) {
      y.value = withSpring(0, SHEET_SPRING);
      opacity.value = withTiming(1, { duration: 160 });
    }
    if (Platform.OS !== 'web') AccessibilityInfo.announceForAccessibility(toast.text);
    const timer = setTimeout(leave, TOAST_DURATION_MS);
    return () => clearTimeout(timer);
    // One toast instance per message (keyed by id); show once on mount.
  }, []);
  const pan = Gesture.Pan()
    .activeOffsetY([-6, 6])
    .onUpdate((event) => {
      if (!leaving.value) y.value = Math.min(0, event.translationY);
    })
    .onEnd((event) => {
      if (toastShouldDismiss(event.translationY, event.velocityY)) runOnJS(leave)();
      else if (!leaving.value) y.value = withSpring(0, SHEET_SPRING);
    });
  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: y.value }],
  }));
  return (
    <GestureHandlerRootView pointerEvents="box-none" style={[s.host, { top: insets.top + 8 }]}>
      <GestureDetector gesture={pan}>
        <Animated.View
          testID="app-toast"
          role="status"
          aria-live="polite"
          accessibilityLiveRegion="polite"
          accessible
          accessibilityLabel={toast.text}
          style={[s.toast, { backgroundColor: palette.background }, style]}
        >
          <Icon name={toast.icon as IconName} size={22} color={palette.icon} />
          <Text
            numberOfLines={2}
            maxFontSizeMultiplier={1.6}
            style={[s.text, { color: palette.ink }]}
          >
            {toast.text}
          </Text>
        </Animated.View>
      </GestureDetector>
    </GestureHandlerRootView>
  );
}
const s = StyleSheet.create({
  host: {
    position: 'absolute',
    left: 12,
    right: 12,
    alignItems: 'center',
    zIndex: 1000,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 48,
    maxWidth: 520,
    paddingVertical: 12,
    paddingLeft: 14,
    paddingRight: 18,
    borderRadius: 999,
    shadowColor: '#000000',
    shadowOpacity: 0.28,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  text: { flexShrink: 1, fontFamily: font.bold, fontSize: 15, lineHeight: 20 },
});
