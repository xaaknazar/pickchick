import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, AppState } from 'react-native';
import type { CropId } from '@pickchick/farm-game';

/** Motion is reserved for acknowledged actions and phase transitions. */
export function useFarmMotion() {
  const [reduced, setReduced] = useState(true);
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (alive) setReduced(value);
    });
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    const visible = () =>
      setActive(
        AppState.currentState === 'active' && (typeof document === 'undefined' || !document.hidden),
      );
    const app = AppState.addEventListener('change', visible);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visible);
    visible();
    return () => {
      alive = false;
      motion.remove();
      app.remove();
      if (typeof document !== 'undefined')
        document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  return { reduced, active };
}

export function CropMotion({
  cropId,
  ready,
  reduced,
  active,
  children,
}: {
  cropId: CropId | null;
  ready: boolean;
  reduced: boolean;
  active: boolean;
  children: ReactNode;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const previous = useRef({ cropId, ready });
  useEffect(() => {
    const changed = cropId !== previous.current.cropId || (ready && !previous.current.ready);
    previous.current = { cropId, ready };
    scale.stopAnimation();
    if (!changed || !cropId || reduced || !active) {
      scale.setValue(1);
      return;
    }
    scale.setValue(ready ? 1.09 : 0.72);
    const growth = Animated.spring(scale, {
      toValue: 1,
      damping: 13,
      stiffness: 170,
      mass: 0.65,
      useNativeDriver: true,
    });
    growth.start();
    return () => growth.stop();
  }, [cropId, ready, reduced, active, scale]);
  return (
    <Animated.View
      pointerEvents="none"
      style={{ alignItems: 'center', justifyContent: 'center', transform: [{ scale }] }}
    >
      {children}
    </Animated.View>
  );
}
