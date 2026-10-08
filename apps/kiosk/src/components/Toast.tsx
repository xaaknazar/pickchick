import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Text, View } from 'react-native';
import { colors, fonts, useMetrics } from '../theme';
import { Icon } from './Icon';
import { ease } from './motion';
import { useMotionPreference } from './useMotionPreference';
/** Prototype toast lifetime (`toastIn` 2400 ms, removed after 2500 ms). */
const life = 2400;
/**
 * v3 toast: a navy pill with a green check disc, centred near the top of the
 * screen. Each new `trigger` (any truthy value) replaces the previous toast and
 * plays the prototype `toastIn`: drops in from -30 pt at .9 scale, holds, then
 * lifts 20 pt while fading out. Under reduced motion it shows statically and
 * disappears after the same time. It never takes touches.
 */
export function Toast({
  message,
  trigger,
  tone = 'success',
  testID,
}: {
  message: string;
  trigger: number | string | null;
  tone?: 'success';
  testID?: string;
}) {
  const { v } = useMetrics();
  const reduced = useMotionPreference();
  const still = useRef(reduced);
  still.current = reduced;
  const [shown, setShown] = useState(!!trigger);
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!trigger) {
      setShown(false);
      return;
    }
    setShown(true);
    progress.stopAnimation();
    let animation: Animated.CompositeAnimation | null = null;
    if (still.current) progress.setValue(0.5);
    else {
      progress.setValue(0);
      const step = (toValue: number, duration: number, easing = ease) =>
        Animated.timing(progress, { toValue, duration, easing, useNativeDriver: true });
      // CSS applies the curve per keyframe: 0-12 % in, 12-85 % hold, 85-100 % out.
      animation = Animated.sequence([
        step(0.12, life * 0.12),
        step(0.85, life * 0.73, Easing.linear),
        step(1, life * 0.15),
      ]);
      animation.start();
    }
    const timer = setTimeout(() => setShown(false), life + 100);
    return () => {
      clearTimeout(timer);
      animation?.stop();
    };
  }, [progress, trigger]);
  // A reduced-motion switch mid-toast freezes it fully visible until it expires.
  useEffect(() => {
    if (!reduced) return;
    progress.stopAnimation();
    progress.setValue(0.5);
  }, [progress, reduced]);
  if (!shown || !message) return null;
  const at = (values: number[]) =>
    progress.interpolate({ inputRange: [0, 0.12, 0.85, 1], outputRange: values });
  const disc = v(48);
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', left: 0, right: 0, top: v(126), alignItems: 'center' }}
    >
      <Animated.View
        testID={testID}
        accessibilityLiveRegion="polite"
        style={{
          minHeight: v(72),
          maxWidth: '92%',
          paddingLeft: v(12),
          paddingRight: v(28),
          paddingVertical: v(12),
          borderRadius: v(36),
          backgroundColor: colors.navy,
          flexDirection: 'row',
          alignItems: 'center',
          gap: v(14),
          shadowColor: colors.navy,
          shadowOpacity: 0.6,
          shadowRadius: 28,
          shadowOffset: { width: 0, height: 20 },
          elevation: 12,
          opacity: at([0, 1, 1, 0]),
          transform: [{ translateY: at([-30, 0, 0, -20]) }, { scale: at([0.9, 1, 1, 1]) }],
        }}
      >
        <View
          style={{
            width: disc,
            height: disc,
            borderRadius: disc / 2,
            backgroundColor: tone === 'success' ? colors.ok : colors.blue,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="checkmark" tone="inverse" />
        </View>
        <Text
          numberOfLines={1}
          style={{
            flexShrink: 1,
            fontFamily: fonts.medium,
            fontSize: Math.max(18, v(20)),
            color: colors.white,
          }}
        >
          {message}
        </Text>
      </Animated.View>
    </View>
  );
}
