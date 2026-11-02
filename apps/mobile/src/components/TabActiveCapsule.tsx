import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, type LayoutRectangle } from 'react-native';
import { tabBarPalette } from '../tab-bar-metrics';
import { useReducedMotion } from './Motion';

/** One persistent highlight: changing tabs redirects its current spring, not a new pill. */
export function TabActiveCapsule({ frame, testID }: { frame: LayoutRectangle; testID: string }) {
  const reduced = useReducedMotion();
  const x = useRef(new Animated.Value(frame.x)).current;
  const previousWidth = useRef(frame.width);
  useEffect(() => {
    const resized = previousWidth.current !== frame.width;
    previousWidth.current = frame.width;
    if (reduced || resized) {
      x.stopAnimation();
      x.setValue(frame.x);
      return;
    }
    const animation = Animated.spring(x, {
      toValue: frame.x,
      stiffness: 340,
      damping: 29,
      mass: 0.85,
      restDisplacementThreshold: 0.15,
      restSpeedThreshold: 0.15,
      useNativeDriver: true,
      isInteraction: false,
    });
    animation.start();
    return () => animation.stop();
  }, [frame.x, frame.width, reduced, x]);
  return (
    <Animated.View
      testID={testID}
      pointerEvents="none"
      accessible={false}
      style={[
        styles.pill,
        { top: frame.y, width: frame.width, height: frame.height, transform: [{ translateX: x }] },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  pill: {
    position: 'absolute',
    left: 0,
    borderRadius: 999,
    backgroundColor: tabBarPalette.pill,
  },
});
