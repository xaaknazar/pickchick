import { useEffect, useMemo, useState } from 'react';
import { Animated, Easing, View } from 'react-native';
import { Image } from 'expo-image';
import { optionPhoto } from '../assets';
import { useMetrics } from '../theme';
import { useMotionPreference } from './useMotionPreference';

/** Prototype burst cut-outs, in order (r13, r35, r23, r36, r27, r13, r28, r25, r35, r29). */
const pieces = [
  'fingers',
  'sauce',
  'cola-bottle',
  'sauce-hot',
  'fanta',
  'fingers',
  'sprite',
  'fuse-peach',
  'sauce',
  'cola-zero',
];
const flight = Easing.bezier(0.15, 0.7, 0.3, 1);

/**
 * Prototype done-screen burst: ten food and drink cut-outs (110 pt) fly out of
 * one point and fade, each 1600 ms on cubic-bezier(.15,.7,.3,1), 30 ms apart
 * after `after` + 520 ms. A zero-size anchor: place it where the burst starts.
 * It never takes touches, is hidden from assistive tech, unmounts when done
 * and is not drawn at all under reduced motion.
 */
export function OrderBurst({ after = 0 }: { after?: number }) {
  const { v } = useMetrics();
  const reduced = useMotionPreference();
  const [done, setDone] = useState(false);
  const values = useMemo(() => pieces.map(() => new Animated.Value(0)), []);
  useEffect(() => {
    if (reduced || done) return;
    for (const value of values) value.setValue(0);
    const animation = Animated.parallel(
      values.map((value, index) =>
        Animated.timing(value, {
          toValue: 1,
          duration: 1600,
          delay: after + 520 + index * 30,
          easing: flight,
          useNativeDriver: true,
        }),
      ),
    );
    animation.start(({ finished }) => {
      if (finished) setDone(true);
    });
    return () => animation.stop();
  }, [after, done, reduced, values]);
  if (reduced || done) return null;
  const size = v(110);
  return (
    <View
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ position: 'absolute', width: 0, height: 0 }}
    >
      {pieces.map((id, index) => {
        const photo = optionPhoto(id);
        const value = values[index];
        if (!photo || !value) return null;
        const angle = (index / pieces.length) * Math.PI * 2 + 0.35;
        const distance = v(300 + (index % 3) * 60);
        const to = (end: number) =>
          value.interpolate({ inputRange: [0, 1], outputRange: [0, end] });
        return (
          <Animated.View
            key={index}
            style={{
              position: 'absolute',
              left: -size / 2,
              top: -size / 2,
              width: size,
              height: size,
              opacity: value.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 1, 0] }),
              transform: [
                { translateX: to(Math.cos(angle) * distance) },
                { translateY: to(Math.sin(angle) * distance * 0.75) },
                {
                  scale: value.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.2, 0.7 + (index % 3) * 0.15],
                  }),
                },
                {
                  rotate: value.interpolate({
                    inputRange: [0, 1],
                    outputRange: ['0deg', `${index % 2 ? 50 : -50}deg`],
                  }),
                },
              ],
            }}
          >
            <Image
              source={photo.source}
              contentFit="contain"
              accessible={false}
              accessibilityLabel=""
              style={{ width: size, height: size }}
            />
          </Animated.View>
        );
      })}
    </View>
  );
}
