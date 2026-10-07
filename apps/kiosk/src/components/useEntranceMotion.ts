import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { useMotionPreference } from './useMotionPreference';

/** Internal choreography, never a public styling prop or a gesture delay. */
export function useEntranceMotion(kind: 'product' | 'recommendation', position = 0) {
  const reduced = useMotionPreference();
  const progress = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const played = useRef(reduced);
  useEffect(() => {
    if (reduced) {
      progress.stopAnimation();
      progress.setValue(1);
      played.current = true;
    } else if (!played.current) {
      played.current = true;
      Animated.timing(progress, {
        toValue: 1,
        duration: kind === 'product' ? 260 : 320,
        delay: kind === 'recommendation' ? Math.min(position, 3) * 45 : 0,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
    return () => {
      progress.stopAnimation();
      progress.setValue(1);
    };
  }, [kind, position, progress, reduced]);
  return progress;
}
