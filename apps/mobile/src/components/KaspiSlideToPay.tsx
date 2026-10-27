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
import { paymentHandleLabel, type PaymentMethodId } from '../payment-method';
import { GlassFill, glassRimWidth, useGlassRim } from './GlassButton';
import { methodGlyph } from './PaymentChoice';
import { Icon } from './UI';

export type SlidePhase = 'idle' | 'hint' | 'drag';
/** Press and hold before the handle follows the finger (owner: «зажать и тянуть»). */
export const SLIDE_HOLD_MS = 250;
/** Releasing at or beyond this share of the track starts the payment. */
export const SLIDE_COMPLETE_RATIO = 0.85;
const HINT_MS = 1400;
const RESET_MS = 700;
/**
 * Early release: the pill shrinks back on a critically damped spring (owner 6a): fast at first,
 * then slowing down, about 0.4 s to the base width (370-400 ms in Chromium at 393 and 320 pt),
 * never narrower than the base width. An underdamped spring with overshoot clamping would stop
 * the first time it reaches the base width (about 150 ms, a snap rather than a spring). Reduced
 * motion: no spring, the width is set at once.
 */
export const SLIDE_RETURN_SPRING = {
  duration: 420,
  dampingRatio: 1,
  overshootClamping: true,
} as const;
/** The pill's glass rim: the mark is centred on the pill's outer edge, not inside the rim. */
const RIM = glassRimWidth;

/**
 * Round mark of the active payment method under the finger (owner 27.10.2026, item 6b): the
 * Kaspi disc, the Apple Pay / Google Pay glyph or a card. The Kaspi asset keeps a white margin
 * around its disc, so it is drawn larger and clipped to the circle.
 */
function MethodMark({ method, size }: { method: PaymentMethodId; size: number }) {
  const image = Math.round(size * 1.36);
  const glyph = method === 'kaspi' ? null : methodGlyph(method);
  return (
    // No pointer target inside the handle: a web <img> would start a native image drag (and a
    // pointercancel) instead of stretching the handle.
    <View
      testID="cart-pay-mark"
      nativeID={`cart-pay-mark-${method}`}
      pointerEvents="none"
      style={[
        s.mark,
        { width: size, height: size, borderRadius: size / 2 },
        glyph && [s.glyphMark, { backgroundColor: glyph.background }],
      ]}
    >
      {glyph ? (
        <Icon name={glyph.icon} size={Math.round(size * 0.58)} color={glyph.color} />
      ) : (
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
      )}
    </View>
  );
}

/**
 * Payment handle of the cart bar (the file keeps its name; the method is the customer's active
 * one, item 6b). Hold it (~250 ms) and drag to the right: the dark pill stays anchored at the
 * bar's left edge and STRETCHES with the finger (owner 27.10.2026, item 6a, Drinkit-like), the
 * method mark rides at its right end under the finger and the pill covers «тяни для оплаты».
 * Released at the end, the pill fills the bar and the parent opens the cart with payment once.
 * An early release shrinks it back (a spring; instantly with reduced motion) and does nothing;
 * a short tap only shows the hint. Screen readers and the keyboard get a button that opens the
 * cart with payment without sending anything (the customer confirms there with «Оплатить»).
 */
export function KaspiSlideToPay({
  travel,
  width,
  height,
  reduced,
  method,
  style,
  offset,
  onPhaseChange,
  onComplete,
  onOpenCheckout,
}: {
  /** How far the pill can stretch to the right, in points. */
  travel: number;
  /** Width of the pill at rest. */
  width: number;
  /** Height of the visible pill; the touch and VoiceOver frame is as tall as `style` makes it. */
  height: number;
  reduced: boolean;
  /** The customer's active payment method: its mark and its name in the label. */
  method: PaymentMethodId;
  style?: StyleProp<ViewStyle>;
  /** How far the pill is stretched, in points, shared with the bar (content fades out). */
  offset?: SharedValue<number>;
  onPhaseChange: (phase: SlidePhase) => void;
  onComplete: () => void;
  onOpenCheckout: () => void;
}) {
  useLocale();
  const own = useSharedValue(0);
  const x = offset ?? own;
  const limit = useSharedValue(travel);
  const base = useSharedValue(width);
  const done = useSharedValue(false);
  const timers = useRef<{
    hint?: ReturnType<typeof setTimeout>;
    reset?: ReturnType<typeof setTimeout>;
  }>({});
  useEffect(() => {
    limit.value = travel;
    if (x.value > travel) x.value = Math.max(0, travel);
  }, [travel, limit, x]);
  useEffect(() => {
    base.value = width;
  }, [width, base]);
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
    // The cart sheet opens over the bar; the pill returns to its width underneath it.
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
        // The pill's right end follows the finger horizontally, clamped to the bar.
        x.value = Math.min(limit.value, Math.max(0, event.translationX));
      })
      .onEnd((_event, success) => {
        if (done.value) return;
        if (success && limit.value > 0 && x.value >= limit.value * SLIDE_COMPLETE_RATIO) {
          done.value = true;
          // The pill fills the bar, then the payment starts (once).
          x.value = reduced ? limit.value : withTiming(limit.value, { duration: 120 });
          runOnJS(complete)();
        } else {
          x.value = reduced ? 0 : withSpring(0, SLIDE_RETURN_SPRING);
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
  // Anchored at the left edge: only the width changes, never the position.
  const stretch = useAnimatedStyle(() => ({ width: base.value + Math.max(0, x.value) }));
  // Keyboard on the web build: Enter/Space opens the cart like VoiceOver's double tap.
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
  const mark = Math.min(34, height - 18);
  const rim = useGlassRim();
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        testID="cart-pay-handle"
        accessible
        accessibilityRole="button"
        accessibilityLabel={t(paymentHandleLabel(method))}
        accessibilityHint={localize(
          t('Удерживайте и потяните вправо. Двойное касание откроет корзину с оплатой.'),
        )}
        accessibilityActions={[{ name: 'activate', label: t('Открыть корзину с оплатой') }]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'activate') actions.current.onOpenCheckout();
        }}
        {...keyboard}
        style={[
          s.frame,
          { width, minHeight: height, borderRadius: height / 2 },
          Platform.OS === 'web' && s.webHandle,
          style,
          stretch,
        ]}
      >
        {/* The same glass as every round button (27.10.2026) on a dark base, so the stretched
            pill covers the hint instead of showing it through. */}
        <View
          testID="cart-pay-pill"
          pointerEvents="none"
          style={[s.handle, rim, { height, borderRadius: height / 2 }]}
        >
          <GlassFill radius={height / 2} />
          <View style={[s.markSlot, { width, height, right: -RIM, top: -RIM }]}>
            <MethodMark method={method} size={mark} />
          </View>
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

const s = StyleSheet.create({
  // Transparent touch and VoiceOver frame; the visible pill fills its width, centred vertically.
  frame: { alignItems: 'stretch', justifyContent: 'center' },
  handle: {
    width: '100%',
    backgroundColor: '#071A44',
    shadowColor: '#000000',
    shadowOpacity: 0.3,
    shadowOffset: { width: 0, height: 3 },
    shadowRadius: 8,
    elevation: 4,
  },
  // No text selection or native scrolling while the handle is dragged with a mouse or pen.
  webHandle: { cursor: 'pointer', userSelect: 'none', touchAction: 'none' } as unknown as ViewStyle,
  // The mark stays in the pill's right end: under the finger while it stretches. The slot is
  // laid over the rim (right/top -RIM), so the mark is centred on the pill and the finger.
  markSlot: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyphMark: { alignItems: 'center', justifyContent: 'center' },
  mark: { overflow: 'hidden', backgroundColor: '#F14635' },
});
