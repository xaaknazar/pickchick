import { memo, useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';
import type { CropId } from '@pickchick/farm-game';
import { CropArt, SoilTile, CellOutline } from './visuals';
import { BED_ANCHOR, GROUND_TRANSFORM } from './geometry';

export type CropStage = 'empty' | 'seeds' | 'sprouts' | 'growing' | 'ready' | 'withered';
/** Visual stage from growth progress (0..1); shared by drawing and hit testing. */
export function cropStage(
  cropId: CropId | null,
  phase: 'empty' | 'growing' | 'ready' | 'withered',
  progress: number,
  kind: 'bed' | 'tree' = 'bed',
): CropStage {
  if (!cropId) return 'empty';
  if (phase !== 'growing' || kind === 'tree' || cropId === 'apple') return phase;
  return progress < 0.1 ? 'seeds' : progress < 0.35 ? 'sprouts' : 'growing';
}

export type GroundCropProps = {
  cropId: CropId | null;
  stage: CropStage;
  watered?: boolean;
  size?: number;
  motion: { reduced: boolean; active: boolean };
  testID?: string;
  selected?: boolean;
};

/**
 * Soil and its current planting share one anchor. Seeds fall only when a crop newly
 * appears on the bed; restored farms and timer updates never replay it.
 */
export const GroundCrop = memo(function GroundCrop({
  cropId,
  stage,
  watered = false,
  size = 92,
  motion,
  testID,
  selected = false,
}: GroundCropProps) {
  const previous = useRef({ cropId, stage, watered });
  const sow = useRef(new Animated.Value(1)).current;
  const pop = useRef(new Animated.Value(1)).current;
  const wet = useRef(new Animated.Value(watered ? 1 : 0)).current;
  const animate = motion.active && !motion.reduced;
  useEffect(() => {
    const before = previous.current;
    previous.current = { cropId, stage, watered };
    const planted = cropId !== null && before.cropId !== cropId;
    const ripened = stage === 'ready' && before.stage !== 'ready' && before.cropId === cropId;
    const soaked = watered && !before.watered;
    const running: Animated.CompositeAnimation[] = [];
    if (planted && animate) {
      sow.setValue(0);
      running.push(
        Animated.timing(sow, {
          toValue: 1,
          duration: 620,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      );
    }
    if (ripened && animate) {
      pop.setValue(1.12);
      running.push(
        Animated.spring(pop, {
          toValue: 1,
          damping: 8,
          stiffness: 220,
          mass: 0.7,
          useNativeDriver: true,
        }),
      );
    }
    if (soaked && animate)
      running.push(
        Animated.timing(wet, {
          toValue: 1,
          duration: 700,
          delay: 250,
          useNativeDriver: true,
        }),
      );
    else wet.setValue(watered ? 1 : 0);
    if (!animate) {
      sow.setValue(1);
      pop.setValue(1);
    }
    running.forEach((a) => a.start());
    return () => running.forEach((a) => a.stop());
  }, [cropId, stage, watered, animate, sow, pop, wet]);
  return (
    <View
      testID={testID}
      pointerEvents="none"
      accessible={false}
      style={{ width: size, height: size, position: 'relative' }}
    >
      <SoilTile x={size / 2} y={size * BED_ANCHOR} size={size} />
      <Animated.View
        testID={testID && watered ? `${testID}-wet` : undefined}
        style={{
          position: 'absolute',
          left: 0,
          top: size * BED_ANCHOR - size / 2,
          width: size,
          height: size,
          borderRadius: 3,
          backgroundColor: '#22140A',
          opacity: wet.interpolate({ inputRange: [0, 1], outputRange: [0, 0.46] }),
          transform: GROUND_TRANSFORM,
        }}
      />
      {selected && <CellOutline x={size / 2} y={size * BED_ANCHOR} size={size} />}
      {stage === 'sprouts' && cropId && (
        <View style={{ position: 'absolute', left: size * 0.31, top: size * 0.35 }}>
          <CropArt cropId={cropId} size={size * 0.38} phase="growing" />
        </View>
      )}
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
                left: size * (0.5 + ((index % 3) - 1 - (Math.floor(index / 3) - 0.5)) * 0.17),
                top:
                  size * (BED_ANCHOR + ((index % 3) - 1 + (Math.floor(index / 3) - 0.5)) * 0.085),
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
      {cropId && stage !== 'seeds' && stage !== 'sprouts' && stage !== 'empty' && (
        <Animated.View
          style={{
            position: 'absolute',
            left: size * 0.035,
            bottom: size * 0.1,
            opacity: sow.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0.7, 1, 1] }),
            transform: [
              {
                scale: Animated.multiply(
                  pop,
                  sow.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] }),
                ),
              },
            ],
          }}
        >
          <CropArt cropId={cropId} size={size * 0.93} phase={stage} />
        </Animated.View>
      )}
    </View>
  );
});
