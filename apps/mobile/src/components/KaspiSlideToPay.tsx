import { localize, t, useLocale } from '../i18n';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { assets } from '../assets';
import { colors } from '../theme';

export type SlidePhase = 'idle' | 'hint' | 'drag';
/** Press and hold before the handle follows the finger (owner: «зажать и тянуть»). */
export const SLIDE_HOLD_MS = 250;
/** Releasing at or beyond this share of the track starts the payment. */
export const SLIDE_COMPLETE_RATIO = 0.85;
const HINT_MS = 1400;
const RESET_MS = 700;

/** The Kaspi disc fills the round mark; the asset keeps a white margin around it. */
function KaspiMark({ size }: { size: number }) {
  const image = Math.round(size * 1.36);
  return (
    // No pointer target inside the handle: a web <img> would start a native image drag (and a
    // pointercancel) instead of moving the handle.
    <View
      pointerEvents="none"
      style={[s.mark, { width: size, height: size, borderRadius: size / 2 }]}
    >
      <Image
        source={assets.kaspi}
        contentFit="contain"
        accessible={false}
        style={{
          width: image,
          height: image,
          marginLeft: (size - image) / 2,
          marginTop: (size - image) / 2,
        }}
      />
    </View>
  );
}

/**
 * Kaspi handle of the cart bar. Hold it (~250 ms), drag it to the right end and release: the
 * parent opens the guarded checkout once. An early release springs back and does nothing; a short
 * tap only shows the hint. Screen readers get a button that opens checkout without sending
 * anything (the customer confirms there with the regular button).
 */
export function KaspiSlideToPay({
  travel,
  width,
  height,
  reduced,
  style,
  offset,
  onPhaseChange,
  onComplete,
  onOpenCheckout,
}: {
  /** Distance the handle can move to the right, in points. */
  travel: number;
  width: number;
  height: number;
  reduced: boolean;
  style?: StyleProp<ViewStyle>;
  /** Handle position in points, shared with the bar (the hint fades as the handle passes). */
  offset?: SharedValue<number>;
  onPhaseChange: (phase: SlidePhase) => void;
  onComplete: () => void;
  onOpenCheckout: () => void;
}) {
  useLocale();
  const own = useSharedValue(0);
  const x = offset ?? own;
  const limit = useSharedValue(travel);
  const done = useSharedValue(false);
  const timers = useRef<{
    hint?: ReturnType<typeof setTimeout>;
    reset?: ReturnType<typeof setTimeout>;
  }>({});
  useEffect(() => {
    limit.value = travel;
    if (x.value > travel) x.value = Math.max(0, travel);
  }, [travel, limit, x]);
  useEffect(
    () => () => {
      clearTimeout(timers.current.hint);
      clearTimeout(timers.current.reset);
    },
    [],
  );
  const flashHint = useCallback(() => {
    clearTimeout(timers.current.hint);
    onPhaseChange('hint');
    timers.current.hint = setTimeout(() => onPhaseChange('idle'), HINT_MS);
  }, [onPhaseChange]);
  const startDrag = useCallback(() => {
    clearTimeout(timers.current.hint);
    onPhaseChange('drag');
  }, [onPhaseChange]);
  const cancelDrag = useCallback(() => onPhaseChange('idle'), [onPhaseChange]);
  // Latest callbacks without rebuilding the gesture while a finger is down.
  const actions = useRef({ onComplete, onOpenCheckout });
  actions.current = { onComplete, onOpenCheckout };
  const complete = useCallback(() => {
    actions.current.onComplete();
    clearTimeout(timers.current.reset);
    // The checkout sheet opens over the bar; the handle returns home underneath it.
    timers.current.reset = setTimeout(() => {
      x.value = 0;
      done.value = false;
      onPhaseChange('idle');
    }, RESET_MS);
  }, [onPhaseChange, x, done]);

  const enabled = travel > 0;
  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .enabled(enabled)
      .activateAfterLongPress(SLIDE_HOLD_MS)
      .onStart(() => {
        if (done.value) return;
        cancelAnimation(x);
        runOnJS(startDrag)();
      })
      .onUpdate((event) => {
        if (done.value) return;
        // Horizontal only, clamped to the bar.
        x.value = Math.min(limit.value, Math.max(0, event.translationX));
      })
      .onEnd((_event, success) => {
        if (done.value) return;
        if (success && limit.value > 0 && x.value >= limit.value * SLIDE_COMPLETE_RATIO) {
          done.value = true;
          x.value = reduced ? limit.value : withTiming(limit.value, { duration: 120 });
          runOnJS(complete)();
        } else {
          x.value = reduced
            ? 0
            : withSpring(0, { duration: 380, dampingRatio: 0.9, overshootClamping: true });
          runOnJS(cancelDrag)();
        }
      });
    const tap = Gesture.Tap()
      .enabled(enabled)
      .maxDuration(SLIDE_HOLD_MS)
      .onEnd((_event, success) => {
        if (success && !done.value) runOnJS(flashHint)();
      });
    return Gesture.Race(pan, tap);
  }, [enabled, reduced, x, limit, done, startDrag, cancelDrag, complete, flashHint]);
  const position = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  // Keyboard on the web build: Enter/Space opens checkout like VoiceOver's double tap.
  const keyboard =
    Platform.OS === 'web'
      ? ({
          tabIndex: 0,
          onKeyDown: (event: { key: string; preventDefault(): void }) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            actions.current.onOpenCheckout();
          },
        } as object)
      : {};
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        testID="cart-pay-handle"
        accessible
        accessibilityRole="button"
        accessibilityLabel={t('Оплатить через Kaspi')}
        accessibilityHint={localize(
          t('Удерживайте и потяните вправо. Двойное касание откроет оформление заказа.'),
        )}
        accessibilityActions={[{ name: 'activate', label: t('Оформить заказ') }]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'activate') actions.current.onOpenCheckout();
        }}
        {...keyboard}
        style={[
          s.handle,
          { width, height, borderRadius: height / 2 },
          Platform.OS === 'web' && s.webHandle,
          style,
          position,
        ]}
      >
        <KaspiMark size={Math.min(34, height - 18)} />
      </Animated.View>
    </GestureDetector>
  );
}

const s = StyleSheet.create({
  handle: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.14)',
    shadowColor: '#000000',
    shadowOpacity: 0.3,
    shadowOffset: { width: 0, height: 3 },
    shadowRadius: 8,
    elevation: 4,
  },
  // No text selection or native scrolling while the handle is dragged with a mouse or pen.
  webHandle: { cursor: 'pointer', userSelect: 'none', touchAction: 'none' } as unknown as ViewStyle,
  mark: { overflow: 'hidden', backgroundColor: '#F14635' },
});
