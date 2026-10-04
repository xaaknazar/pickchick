import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, AppState, Easing, Text, View } from 'react-native';
import type { CropId } from '@pickchick/farm-game';
import { font } from '../../theme';
import { farmPalette } from './styles';

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
    const app = AppState.addEventListener('change', (value) => setActive(value === 'active'));
    return () => {
      alive = false;
      motion.remove();
      app.remove();
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

export type FarmFeedback = { id: number; text: string };
/** Mount only after an acknowledged command; failed saves never create a reward. */
export function HarvestFeedback({
  feedback,
  reduced,
  active,
  onDone,
}: {
  feedback: FarmFeedback;
  reduced: boolean;
  active: boolean;
  onDone(): void;
}) {
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) {
      onDone();
      return;
    }
    if (reduced) {
      const timer = setTimeout(onDone, 1800);
      return () => clearTimeout(timer);
    }
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 1500,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) onDone();
    });
    return () => animation.stop();
  }, [active, reduced, progress, onDone]);
  const opacity = reduced
    ? 1
    : progress.interpolate({ inputRange: [0, 0.08, 0.76, 1], outputRange: [0, 1, 1, 0] });
  return (
    <View
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      style={{ alignItems: 'center', width: 200, height: 100 }}
    >
      {!reduced &&
        Array.from({ length: 6 }, (_, i) => {
          const angle = Math.PI * (0.15 + i * 0.14);
          return (
            <Animated.View
              key={i}
              style={{
                position: 'absolute',
                top: 38,
                left: 96,
                width: i % 2 ? 6 : 8,
                height: i % 2 ? 6 : 8,
                borderRadius: 4,
                backgroundColor: i % 2 ? farmPalette.orange : farmPalette.blue,
                opacity,
                transform: [
                  {
                    translateX: progress.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, Math.cos(angle) * 78],
                    }),
                  },
                  {
                    translateY: progress.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, -Math.sin(angle) * 66],
                    }),
                  },
                ],
              }}
            />
          );
        })}
      <Animated.View
        style={{
          marginTop: 30,
          borderRadius: 14,
          paddingHorizontal: 18,
          paddingVertical: 10,
          backgroundColor: farmPalette.paper,
          opacity,
          transform: reduced
            ? []
            : [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [0, -26] }) }],
        }}
      >
        <Text style={{ fontFamily: font.bold, fontSize: 17, color: farmPalette.ink }}>
          {feedback.text}
        </Text>
      </Animated.View>
    </View>
  );
}
