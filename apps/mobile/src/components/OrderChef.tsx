import { useCallback, useEffect, useState } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Image } from 'expo-image';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useReducedMotion } from './Motion';
import { colors } from '../theme';
const cooking = require('../../assets/order-status/chef-cooking.png');
const readyArt = require('../../assets/order-status/chef-ready.png');

export function OrderChef({
  ready,
  animate,
  size,
}: {
  ready: boolean;
  animate: boolean;
  size: number;
}) {
  const reduced = useReducedMotion();
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  const [active, setActive] = useState(AppState.currentState === 'active');
  const motion = useSharedValue(0);
  const reveal = useSharedValue(ready ? 1 : 0);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setActive(state === 'active'));
    const visibility = () => setActive(!document.hidden);
    if (Platform.OS === 'web') document.addEventListener('visibilitychange', visibility);
    return () => {
      sub.remove();
      if (Platform.OS === 'web') document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  useEffect(() => {
    reveal.value = withTiming(ready ? 1 : 0, { duration: reduced ? 0 : 280 });
  }, [ready, reduced, reveal]);
  useEffect(() => {
    cancelAnimation(motion);
    motion.value = 0;
    if (active && focused && animate && !reduced) {
      motion.value = withRepeat(
        withTiming(1, { duration: ready ? 2200 : 1800, easing: Easing.inOut(Easing.sin) }),
        -1,
        true,
      );
    }
    return () => cancelAnimation(motion);
  }, [active, focused, animate, reduced, ready, motion]);
  const pose = useAnimatedStyle(() => ({
    transform: [
      { translateY: motion.value * -4 },
      { rotate: `${motion.value * (ready ? 0.5 : -0.7)}deg` },
    ],
  }));
  const cookingStyle = useAnimatedStyle(() => ({ opacity: 1 - reveal.value }));
  const readyStyle = useAnimatedStyle(() => ({ opacity: reveal.value }));
  const steam = useAnimatedStyle(() => ({
    opacity: (1 - reveal.value) * motion.value * 0.3,
    transform: [{ translateY: -motion.value * 18 }, { scaleY: 1 + motion.value * 0.25 }],
  }));
  return (
    <View
      style={{ width: size, height: size, alignSelf: 'center' }}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View style={[StyleSheet.absoluteFill, pose]}>
        <Animated.View style={[StyleSheet.absoluteFill, cookingStyle]}>
          <Image source={cooking} style={StyleSheet.absoluteFill} contentFit="contain" />
        </Animated.View>
        <Animated.View style={[StyleSheet.absoluteFill, readyStyle]}>
          <Image source={readyArt} style={StyleSheet.absoluteFill} contentFit="contain" />
        </Animated.View>
      </Animated.View>
      {!ready && animate ? <Animated.View style={[s.steam, steam]} /> : null}
    </View>
  );
}
const s = StyleSheet.create({
  steam: {
    position: 'absolute',
    left: '28%',
    bottom: '29%',
    width: 3,
    height: 22,
    borderRadius: 3,
    backgroundColor: colors.white,
  },
});
