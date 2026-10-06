import { memo, useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';
import type { CropId } from '@pickchick/farm-game';
import { Icon } from '../../components/UI';
import { CropArt, CellOutline } from './visuals';
import { GroundCrop, type CropStage } from './PlantingVisual';
import { CropMotion } from './motion';
import { BADGE_OFFSET } from './hit-zones';
import { TREE_ART, TREE_IN_BOX } from './geometry';

/** `feed` marks hungry animals in a pen; plots use the other three. */
export type PlotBadge = 'ready' | 'water' | 'withered' | 'feed' | null;
/** World size of a status badge before its zoom-dependent counter scale. */
export const BADGE_WORLD = 28;

const badgeLook: Record<Exclude<PlotBadge, null>, { bg: string; icon: string; color: string }> = {
  ready: { bg: '#2F6B3E', icon: 'basket', color: '#FFF6DD' },
  water: { bg: '#E9F6FB', icon: 'water', color: '#2A86BA' },
  withered: { bg: '#8A6236', icon: 'leaf', color: '#F6E7C2' },
  feed: { bg: '#D9822B', icon: 'nutrition', color: '#FFF6DD' },
};

/** Status marker that keeps a readable screen size at every zoom. */
export const Badge = memo(function Badge({
  kind,
  scale,
  bob,
  testID,
  small = false,
}: {
  kind: Exclude<PlotBadge, null>;
  scale: Animated.AnimatedInterpolation<number>;
  bob: boolean;
  testID?: string;
  small?: boolean;
}) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    t.setValue(0);
    if (!bob) return;
    // One gentle hop when the badge appears; no perpetual motion on the field.
    const animation = Animated.sequence([
      Animated.timing(t, {
        toValue: 1,
        duration: 180,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(t, {
        toValue: 0,
        duration: 260,
        easing: Easing.bounce,
        useNativeDriver: true,
      }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [kind, bob, t]);
  const look = badgeLook[kind];
  const s = small ? BADGE_WORLD * 0.72 : BADGE_WORLD;
  return (
    <Animated.View
      testID={testID}
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: -s / 2,
        top: -s / 2,
        width: s,
        height: s,
        borderRadius: s / 2,
        backgroundColor: look.bg,
        borderWidth: 2.5,
        borderColor: kind === 'water' ? '#7CC3E6' : '#FFF6DD',
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: '#132015',
        shadowOpacity: 0.3,
        shadowRadius: 3,
        shadowOffset: { width: 0, height: 2 },
        transform: [
          { scale },
          { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, -8] }) },
        ],
      }}
    >
      <Icon name={look.icon as never} size={s * 0.56} color={look.color} />
    </Animated.View>
  );
});

export type PlotViewProps = {
  id: number;
  left: number;
  top: number;
  kind: 'bed' | 'tree';
  cropId: CropId | null;
  stage: CropStage;
  watered: boolean;
  badge: PlotBadge;
  selected: boolean;
  lifted: boolean;
  reduced: boolean;
  active: boolean;
  badgeScale: Animated.AnimatedInterpolation<number>;
  /** Water markers fade out at the overview, where the soil colour already tells the story. */
  waterOpacity: Animated.AnimatedInterpolation<number>;
};

/** One field object. Memoized: it re-renders only when its own visible state changes. */
export const PlotView = memo(function PlotView({
  id,
  left,
  top,
  kind,
  cropId,
  stage,
  watered,
  badge,
  selected,
  lifted,
  reduced,
  active,
  badgeScale,
  waterOpacity,
}: PlotViewProps) {
  const motion = { reduced, active };
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', left, top, opacity: lifted ? 0.28 : 1 }}
    >
      {kind === 'tree' && selected && <CellOutline x={0} y={0} />}
      <View
        testID={`pick-farm-plot-${id}`}
        style={{ position: 'absolute', left: -48, top: -69, width: 96, height: 96 }}
      >
        {kind === 'bed' ? (
          <GroundCrop
            selected={selected}
            cropId={cropId}
            stage={stage}
            watered={watered}
            size={96}
            motion={motion}
            testID={`pick-farm-growth-${id}`}
          />
        ) : (
          cropId && (
            <View style={{ position: 'absolute', left: TREE_IN_BOX.left, top: TREE_IN_BOX.top }}>
              <CropMotion cropId={cropId} ready={stage === 'ready'} {...motion}>
                <CropArt
                  cropId={cropId}
                  size={TREE_ART}
                  phase={
                    stage === 'withered' ? 'withered' : stage === 'ready' ? 'ready' : 'growing'
                  }
                />
              </CropMotion>
            </View>
          )
        )}
      </View>
      {badge === 'water' && (
        <Animated.View
          style={{
            position: 'absolute',
            left: kind === 'tree' ? 22 : 30,
            top: kind === 'tree' ? -6 : 2,
            opacity: waterOpacity,
          }}
        >
          <Badge
            kind="water"
            scale={badgeScale}
            bob={false}
            testID={`pick-farm-badge-water-${id}`}
            small
          />
        </Animated.View>
      )}
      {badge && badge !== 'water' && (
        <View style={{ position: 'absolute', left: 0, top: BADGE_OFFSET[kind] }}>
          <Badge
            kind={badge}
            scale={badgeScale}
            bob={active && !reduced}
            testID={`pick-farm-badge-${badge}-${id}`}
          />
        </View>
      )}
    </View>
  );
});
