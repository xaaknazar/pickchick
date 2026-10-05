import { useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';
import type { CropId } from '@pickchick/farm-game';
import { CropArt, Sprite } from './visuals';

export type GroundCropProps = {
  cropId: CropId | null;
  plantedAt: number | null;
  growSeconds: number;
  phase: 'empty' | 'growing' | 'ready' | 'withered';
  /** Same clock unit as plantedAt (the engine uses Unix milliseconds). */
  now: number;
  size?: number;
  motion: { reduced: boolean; active: boolean };
  testID?: string;
};

/** Soil and its current planting share one anchor; initial restored crops never animate. */
export function GroundCrop({
  cropId,
  plantedAt,
  growSeconds,
  phase,
  now,
  size = 92,
  motion,
  testID,
}: GroundCropProps) {
  const previous = useRef({ cropId, plantedAt });
  const sow = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const changed = cropId !== previous.current.cropId || plantedAt !== previous.current.plantedAt;
    previous.current = { cropId, plantedAt };
    sow.stopAnimation();
    sow.setValue(1);
    if (!changed || !cropId || plantedAt === null || motion.reduced || !motion.active) return;
    sow.setValue(0);
    const animation = Animated.timing(sow, {
      toValue: 1,
      duration: 620,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [cropId, plantedAt, motion.reduced, motion.active, sow]);
  const fraction =
    plantedAt === null
      ? 0
      : Math.max(0, Math.min(1, (now - plantedAt) / (Math.max(1, growSeconds) * 1000)));
  const stage = !cropId
    ? 'empty'
    : phase !== 'growing' || cropId === 'apple'
      ? phase
      : fraction < 0.1
        ? 'seeds'
        : fraction < 0.35
          ? 'sprouts'
          : 'growing';
  return (
    <View
      testID={testID}
      pointerEvents="none"
      accessible={false}
      style={{ width: size, height: size, position: 'relative' }}
    >
      <Sprite kind={stage === 'sprouts' ? 'sprouts' : 'soil'} x={size / 2} y={size} width={size} />
      {stage === 'seeds' && (
        <View
          testID={testID ? `${testID}-seeds` : undefined}
          style={{ position: 'absolute', inset: 0 }}
        >
          {Array.from({ length: 6 }, (_, index) => (
            <Animated.View
              key={index}
              style={{
                position: 'absolute',
                left: size * (0.27 + (index % 3) * 0.18),
                top: size * (0.72 + Math.floor(index / 3) * 0.12),
                width: Math.max(2, size * 0.038),
                height: Math.max(2, size * 0.023),
                borderRadius: 3,
                backgroundColor: '#E6CF88',
                transform: [
                  {
                    translateY: sow.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-size * (0.16 + index * 0.025), 0],
                    }),
                  },
                  { rotate: `${index * 29 - 40}deg` },
                ],
                opacity: sow.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 1, 1] }),
              }}
            />
          ))}
        </View>
      )}
      {cropId && stage !== 'seeds' && stage !== 'sprouts' && (
        <Animated.View
          style={{
            position: 'absolute',
            left: size * 0.035,
            bottom: size * 0.1,
            opacity: sow.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0.7, 1, 1] }),
            transform: [{ scale: sow.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] }) }],
          }}
        >
          <CropArt
            cropId={cropId}
            size={size * 0.93}
            phase={phase === 'empty' ? 'growing' : phase}
          />
        </Animated.View>
      )}
    </View>
  );
}
