import { useCallback, useRef, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useReducedMotion } from './Motion';
import { Icon } from './UI';
import { colors, font } from '../theme';
import { SHEET_SPRING, slideConfirmed, slideProgress } from '../luma-patterns';

const KNOB = 56;
const PAD = 4;

/**
 * Irreversible action confirmed by dragging the knob to the end of the track (Luma pattern).
 * Screen readers get an ordinary button: activating it confirms. Reduced motion keeps the
 * drag but drops the spring. Haptic feedback needs expo-haptics (a native module that the
 * current build does not include), so completion is confirmed visually only.
 */
export function SlideToConfirm({
  label,
  accessibilityLabel,
  onConfirm,
  disabled = false,
  testID = 'slide-confirm',
}: {
  label: string;
  accessibilityLabel: string;
  onConfirm(): void;
  disabled?: boolean;
  testID?: string;
}) {
  const reduced = useReducedMotion();
  const [width, setWidth] = useState(0);
  const travel = Math.max(0, width - KNOB - PAD * 2);
  const x = useSharedValue(0);
  const start = useSharedValue(0);
  const done = useSharedValue(false);
  const fired = useRef(false);
  const confirm = useCallback(() => {
    if (fired.current || disabled) return;
    fired.current = true;
    onConfirm();
  }, [disabled, onConfirm]);
  const settle = (to: number) => {
    'worklet';
    return reduced
      ? withTiming(to, { duration: 0 })
      : to === 0
        ? withSpring(0, SHEET_SPRING)
        : withTiming(to, { duration: 120, easing: Easing.out(Easing.cubic) });
  };
  const pan = Gesture.Pan()
    .enabled(!disabled && travel > 0)
    .activeOffsetX([-4, 4])
    .onStart(() => {
      start.value = x.value;
    })
    .onUpdate((event) => {
      if (done.value) return;
      x.value = slideProgress(start.value + event.translationX, travel) * travel;
    })
    .onEnd(() => {
      if (done.value) return;
      if (slideConfirmed(slideProgress(x.value, travel))) {
        done.value = true;
        x.value = settle(travel);
        runOnJS(confirm)();
      } else x.value = settle(0);
    });
  const knob = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const fill = useAnimatedStyle(() => ({ width: x.value + KNOB + PAD }));
  const hint = useAnimatedStyle(() => ({
    opacity: travel > 0 ? interpolate(x.value, [0, travel * 0.6], [1, 0], 'clamp') : 1,
  }));
  return (
    <View
      testID={testID}
      role="button"
      accessible
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Дважды коснитесь, чтобы подтвердить"
      accessibilityState={{ disabled }}
      accessibilityActions={[{ name: 'activate', label: accessibilityLabel }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'activate') confirm();
      }}
      onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
      style={[s.track, disabled && s.disabled]}
    >
      <Animated.View pointerEvents="none" style={[s.fill, fill]} />
      <Animated.View pointerEvents="none" style={[s.labelBox, hint]}>
        <Text style={s.label} numberOfLines={1} maxFontSizeMultiplier={1.4}>
          {label}
        </Text>
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View testID={`${testID}-knob`} style={[s.knob, knob]}>
          <Icon name="chevron-forward" size={26} color={colors.orangeInk} />
        </Animated.View>
      </GestureDetector>
    </View>
  );
}
const s = StyleSheet.create({
  track: {
    height: KNOB + PAD * 2,
    borderRadius: (KNOB + PAD * 2) / 2,
    backgroundColor: colors.raised,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  disabled: { opacity: 0.5 },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: (KNOB + PAD * 2) / 2,
    backgroundColor: 'rgba(255, 105, 0, 0.28)',
  },
  labelBox: {
    position: 'absolute',
    left: KNOB + PAD * 2,
    right: 16,
    alignItems: 'center',
  },
  label: { color: colors.text, fontFamily: font.bold, fontSize: 15, lineHeight: 20 },
  knob: {
    position: 'absolute',
    left: PAD,
    width: KNOB,
    height: KNOB,
    borderRadius: KNOB / 2,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
