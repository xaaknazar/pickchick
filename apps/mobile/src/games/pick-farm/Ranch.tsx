import { memo, useEffect, useRef } from 'react';
import { Animated, Easing, Image, Text, View } from 'react-native';
import {
  PENS,
  PLANTING_BOUNDS,
  animalStatus,
  getProgression,
  landBounds,
  levelForXp,
  nextLandExpansion,
  type AnimalKind,
  type FarmState,
} from '@pickchick/farm-game';
import { GROUND_TRANSFORM, TILE_WIDTH, isoPoint } from './geometry';
import { Badge } from './FieldObjects';
import {
  ART_SCALE,
  PEN_ART,
  PEN_CORNER,
  SCENERY_SIZE,
  SPOTS,
  at,
  landSigns,
  type SceneryKind,
} from './ranch-layout';

export { penAt, penCenter, landSignAt, sceneryBack, sceneryFront } from './ranch-layout';

export const ANIMAL_ART = {
  chicken: {
    source: require('../../../assets/games/pick-farm/chicken.png'),
    width: 40,
    ratio: 112 / 96,
  },
  cow: { source: require('../../../assets/games/pick-farm/cow.png'), width: 86, ratio: 142 / 182 },
} as const;
export const GOOD_ART = {
  egg: require('../../../assets/games/pick-farm/egg.png'),
  milk: require('../../../assets/games/pick-farm/milk.png'),
} as const;
const SIGN = require('../../../assets/games/pick-farm/sale-sign.png');
const PEN_SOURCE = {
  coop: require('../../../assets/games/pick-farm/coop.png'),
  barn: require('../../../assets/games/pick-farm/barn.png'),
} as const;
const SCENERY_SOURCE: Record<SceneryKind, number> = {
  tree: require('../../../assets/games/pick-farm/tree-round.png'),
  treeDark: require('../../../assets/games/pick-farm/tree-dark.png'),
  bush: require('../../../assets/games/pick-farm/bush-a.png'),
  berries: require('../../../assets/games/pick-farm/bush-b.png'),
  rock: require('../../../assets/games/pick-farm/rock.png'),
  flowers: require('../../../assets/games/pick-farm/flowers-a.png'),
  flowersPink: require('../../../assets/games/pick-farm/flowers-b.png'),
  pond: require('../../../assets/games/pick-farm/pond.png'),
};
type Point = { x: number; y: number };

function Sign({
  cell,
  title,
  detail,
  testID,
}: {
  cell: Point;
  title: string;
  detail: string;
  testID?: string;
}) {
  const p = isoPoint(cell.x, cell.y);
  const width = 92;
  const height = (126 / 122) * width;
  return (
    <View
      testID={testID}
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: p.x - (61 / 122) * width,
        top: p.y - (116 / 126) * height,
      }}
    >
      <Image source={SIGN} style={{ width, height }} accessible={false} />
      <View
        style={{
          position: 'absolute',
          left: 8,
          right: 8,
          top: 14,
          height: 46,
          justifyContent: 'center',
        }}
      >
        <Text
          numberOfLines={1}
          style={{ textAlign: 'center', fontSize: 11, fontWeight: '800', color: '#4A2C14' }}
        >
          {title}
        </Text>
        <Text
          numberOfLines={1}
          style={{ textAlign: 'center', fontSize: 12, fontWeight: '800', color: '#7A3C10' }}
        >
          {detail}
        </Text>
      </View>
    </View>
  );
}

/** Locked land is darker wild grass; the open square has a light edge and sale signs. */
export const LandOverlay = memo(function LandOverlay({
  state,
  showSigns,
}: {
  state: FarmState;
  showSigns: boolean;
}) {
  const b = landBounds(state);
  if (b.land >= 5 && !showSigns) return null;
  const { minX, minY, maxX, maxY } = PLANTING_BOUNDS;
  const cells = maxX - minX + 1;
  const side = cells * TILE_WIDTH;
  const center = isoPoint((minX + maxX) / 2, (minY + maxY) / 2);
  const u = TILE_WIDTH;
  const ox = b.minX - minX,
    oy = b.minY - minY,
    w = b.maxX - b.minX + 1,
    h = b.maxY - b.minY + 1;
  const strips = [
    { left: 0, top: 0, width: cells, height: oy },
    { left: 0, top: oy + h, width: cells, height: cells - oy - h },
    { left: 0, top: oy, width: ox, height: h },
    { left: ox + w, top: oy, width: cells - ox - w, height: h },
  ].filter((r) => r.width > 0 && r.height > 0);
  const next = nextLandExpansion(state);
  const level = levelForXp(state.xp);
  return (
    <>
      {strips.length > 0 && (
        <View
          pointerEvents="none"
          testID="pick-farm-locked-land"
          style={{
            position: 'absolute',
            left: center.x - side / 2,
            top: center.y - side / 2,
            width: side,
            height: side,
            transform: GROUND_TRANSFORM,
          }}
        >
          {strips.map((r, i) => (
            <View
              key={i}
              style={{
                position: 'absolute',
                left: r.left * u,
                top: r.top * u,
                width: r.width * u,
                height: r.height * u,
                backgroundColor: '#2E4A1A',
                opacity: 0.34,
              }}
            />
          ))}
          <View
            style={{
              position: 'absolute',
              left: ox * u - 6,
              top: oy * u - 6,
              width: w * u + 12,
              height: h * u + 12,
              borderWidth: 12,
              borderColor: '#F4E3AE',
              borderRadius: 10,
              opacity: 0.9,
            }}
          />
        </View>
      )}
      {showSigns &&
        next &&
        landSigns(state).map((cell, i) => (
          <Sign
            key={i}
            cell={cell}
            testID={i === 0 ? 'pick-farm-land-sign' : undefined}
            title="Новая земля"
            detail={level < next.unlockLevel ? `уровень ${next.unlockLevel}` : `${next.cost} монет`}
          />
        ))}
    </>
  );
});

/** One animal with a short idle move now and then (pecking, a nod); still when reduced. */
const Animal = memo(function Animal({
  kind,
  left,
  top,
  flip,
  moving,
  seed,
  good,
}: {
  kind: AnimalKind;
  left: number;
  top: number;
  flip: boolean;
  moving: boolean;
  seed: number;
  good: boolean;
}) {
  const a = ANIMAL_ART[kind];
  const height = a.width * a.ratio;
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!moving) {
      t.setValue(0);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let animation: Animated.CompositeAnimation | null = null;
    const next = (n: number) => {
      // A different rhythm per animal, so the yard never moves in unison.
      timer = setTimeout(
        () => {
          if (!alive) return;
          animation = Animated.sequence([
            Animated.timing(t, {
              toValue: 1,
              duration: 160,
              easing: Easing.out(Easing.quad),
              useNativeDriver: true,
            }),
            Animated.timing(t, {
              toValue: 0,
              duration: 220,
              easing: Easing.inOut(Easing.quad),
              useNativeDriver: true,
            }),
          ]);
          animation.start(() => next(n + 1));
        },
        2200 + ((seed * 1373 + n * 811) % 4200),
      );
    };
    next(0);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      animation?.stop();
    };
  }, [moving, seed, t]);
  const tilt = kind === 'chicken' ? 18 : 5;
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', left: left - a.width / 2, top: top - height }}
    >
      {good && (
        <Image
          source={GOOD_ART[kind === 'chicken' ? 'egg' : 'milk']}
          accessible={false}
          style={{
            position: 'absolute',
            left: flip ? -6 : a.width - (kind === 'chicken' ? 10 : 22),
            top: height - (kind === 'chicken' ? 16 : 30),
            width: kind === 'chicken' ? 14 : 20,
            height: kind === 'chicken' ? 19 : 33,
          }}
        />
      )}
      <Animated.Image
        source={a.source}
        accessible={false}
        style={{
          width: a.width,
          height,
          transform: [
            { scaleX: flip ? -1 : 1 },
            // Pivot near the feet: shift, rotate, shift back.
            { translateY: height * 0.4 },
            { rotate: t.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${tilt}deg`] }) },
            { translateY: -height * 0.4 },
          ],
        }}
      />
    </View>
  );
});

/** Coop and barn: a sale sign before purchase, then the building, yard and animals. */
export const Pens = memo(function Pens({
  state,
  now,
  badgeScale,
  moving,
}: {
  state: FarmState;
  now: number;
  badgeScale: Animated.AnimatedInterpolation<number>;
  moving: boolean;
}) {
  const progression = getProgression(state);
  const owned = progression.pens ?? [];
  const level = levelForXp(state.xp);
  return (
    <>
      {PENS.map((pen) => {
        const a = PEN_ART[pen.id];
        const corner = at(pen.id, 0, 0);
        if (!owned.includes(pen.id))
          return (
            <Sign
              key={pen.id}
              testID={`pick-farm-pen-sign-${pen.id}`}
              cell={{
                x: PEN_CORNER[pen.id].x + a.yard.x / 2,
                y: PEN_CORNER[pen.id].y + a.yard.y / 2,
              }}
              title={pen.name}
              detail={level < pen.unlockLevel ? `уровень ${pen.unlockLevel}` : `${pen.cost} монет`}
            />
          );
        const kind = pen.animal;
        const status = animalStatus(state, kind, now);
        const readyIds = new Set(status.ready.map((v) => v.id));
        const roof = at(pen.id, pen.id === 'coop' ? 0.9 : 1.2, pen.id === 'coop' ? 0.65 : 0.85);
        return (
          <View key={pen.id} pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0 }}>
            <Image
              source={PEN_SOURCE[pen.id]}
              testID={`pick-farm-pen-${pen.id}`}
              accessible={false}
              style={{
                position: 'absolute',
                left: corner.x - a.anchor.x * ART_SCALE,
                top: corner.y - a.anchor.y * ART_SCALE,
                width: a.width * ART_SCALE,
                height: a.height * ART_SCALE,
              }}
            />
            {status.list.map((animal, i) => {
              const spot = SPOTS[pen.id][i % SPOTS[pen.id].length]!;
              const p = at(pen.id, spot.x, spot.y);
              return (
                <Animal
                  key={animal.id}
                  kind={kind}
                  left={p.x}
                  top={p.y}
                  flip={i % 2 === 1}
                  moving={moving}
                  seed={animal.id + 1}
                  good={readyIds.has(animal.id)}
                />
              );
            })}
            {(status.ready.length > 0 || (status.hungry.length > 0 && !status.busy.length)) && (
              <View
                style={{
                  position: 'absolute',
                  left: roof.x,
                  top: roof.y - (pen.id === 'coop' ? 100 : 128),
                }}
              >
                <Badge
                  kind={status.ready.length ? 'ready' : 'feed'}
                  scale={badgeScale}
                  bob={moving}
                  testID={`pick-farm-pen-badge-${pen.id}`}
                />
              </View>
            )}
          </View>
        );
      })}
    </>
  );
});

export const Scenery = memo(function Scenery({
  items,
  visible,
}: {
  items: readonly { kind: SceneryKind; x: number; y: number }[];
  visible(point: Point): boolean;
}) {
  return (
    <>
      {[...items]
        .sort((a, b) => a.x + a.y - b.x - b.y)
        .map((item, i) => {
          const a = SCENERY_SIZE[item.kind];
          const p = isoPoint(item.x, item.y);
          if (!visible(p)) return null;
          const height = (a.h / a.w) * a.width;
          const pond = item.kind === 'pond';
          return (
            <Image
              key={`${item.kind}-${i}`}
              source={SCENERY_SOURCE[item.kind]}
              accessible={false}
              style={{
                position: 'absolute',
                left: p.x - (pond ? (94 / 165) * a.width : a.width / 2),
                top: p.y - (pond ? (73.2 / 113) * height : height * 0.92),
                width: a.width,
                height,
              }}
            />
          );
        })}
    </>
  );
});
