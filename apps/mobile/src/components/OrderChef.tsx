import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useReducedMotion } from './Motion';
import type { OrderScene } from '../order-status';
const scenes = {
  cooking: require('../../assets/order-status/chef-cooking.png'),
  assembly: require('../../assets/order-status/chef-assembly.png'),
  ready: require('../../assets/order-status/chef-ready.png'),
  'ready-takeaway': require('../../assets/order-status/chef-ready-takeaway.png'),
};

function Scene({ name, selected }: { name: OrderScene; selected: OrderScene }) {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(name === selected ? 1 : 0);
  useEffect(() => {
    opacity.value = withTiming(name === selected ? 1 : 0, { duration: reduced ? 0 : 240 });
  }, [name, selected, reduced, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View style={[StyleSheet.absoluteFill, style]}>
      <Image source={scenes[name]} style={StyleSheet.absoluteFill} contentFit="contain" />
    </Animated.View>
  );
}

/** Stationary scenes. Only a server stage change crossfades; no idle movement or loop. */
export function OrderChef({ stage, size }: { stage: OrderScene; size: number }) {
  return (
    <View
      testID={`order-chef-${stage}`}
      style={{ width: size, height: size, alignSelf: 'center' }}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {(['cooking', 'assembly', 'ready', 'ready-takeaway'] as const).map((name) => (
        <Scene key={name} name={name} selected={stage} />
      ))}
    </View>
  );
}
