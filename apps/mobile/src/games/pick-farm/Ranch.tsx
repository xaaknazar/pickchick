import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Image, Text, View } from 'react-native';
import {
  ANIMALS,
  PENS,
  PLANTING_BOUNDS,
  getProgression,
  landBounds,
  levelForXp,
  nextLandExpansion,
  type AnimalKind,
  type CropId,
  type FarmState,
  type PenId,
} from '@pickchick/farm-game';
import { GROUND_TRANSFORM, TILE_WIDTH, isoPoint } from './geometry';
import { Badge } from './FieldObjects';
import {
  ART_SCALE,
  PEN_ART,
  PEN_CORNER,
  SCENERY_SIZE,
  STROLL,
  animalPlace,
  at,
  landSigns,
  revealTiles,
  yardAnimals,
  type AnimalMode,
  type SceneryKind,
} from './ranch-layout';
import { CropArt } from './visuals';

export {
  animalAt,
  animalPlace,
  penAt,
  penCenter,
  landSignAt,
  sceneryBack,
  sceneryFront,
  yardAnimals,
  ANIMAL_BODY,
} from './ranch-layout';

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
  drop = null,
}: {
  cell: Point;
  title: string;
  detail: string;
  testID?: string;
  /** Delay before the sign falls into place (a new land edge); null - already standing. */
  drop?: number | null;
}) {
  const p = isoPoint(cell.x, cell.y);
  const width = 92;
  const height = (126 / 122) * width;
  const fall = useRef(new Animated.Value(drop === null ? 1 : 0)).current;
  useEffect(() => {
    if (drop === null) return;
    const animation = Animated.sequence([
      Animated.delay(drop),
      Animated.spring(fall, { toValue: 1, damping: 9, stiffness: 180, useNativeDriver: true }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [drop, fall]);
  return (
    <Animated.View
      testID={testID}
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: p.x - (61 / 122) * width,
        top: p.y - (116 / 126) * height,
        opacity: fall.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 1, 1] }),
        transform: [
          { translateY: fall.interpolate({ inputRange: [0, 1], outputRange: [-90, 0] }) },
        ],
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
    </Animated.View>
  );
}

/** Locked land is darker wild grass; the open square has a light edge and sale signs. */
export const LandOverlay = memo(function LandOverlay({
  state,
  showSigns,
  reduced = false,
}: {
  state: FarmState;
  showSigns: boolean;
  reduced?: boolean;
}) {
  const b = landBounds(state);
  // A purchase plays once: the old dark ring fades in a wave, new signs fall into place.
  const shown = useRef(b.land);
  const [reveal, setReveal] = useState<{ from: number; to: number } | null>(null);
  useEffect(() => {
    if (b.land > shown.current) {
      setReveal({ from: shown.current, to: b.land });
      shown.current = b.land;
      const timer = setTimeout(() => setReveal(null), 2200);
      return () => clearTimeout(timer);
    }
    // A rejected purchase rolls the land back: drop any wave still on screen.
    shown.current = b.land;
    setReveal(null);
  }, [b.land]);
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
      {reveal && <LandReveal from={reveal.from} to={reveal.to} reduced={reduced} key={reveal.to} />}
      {showSigns &&
        next &&
        landSigns(state).map((cell, i) => (
          <Sign
            key={`${b.land}-${i}`}
            drop={reveal && !reduced ? 1100 + i * 140 : null}
            cell={cell}
            testID={i === 0 ? 'pick-farm-land-sign' : undefined}
            title="Новая земля"
            detail={level < next.unlockLevel ? `уровень ${next.unlockLevel}` : `${next.cost} монет`}
          />
        ))}
    </>
  );
});

/** The newly bought ring, still dark, fading tile by tile around the square. */
function LandReveal({ from, to, reduced }: { from: number; to: number; reduced: boolean }) {
  const { minX, minY, maxX, maxY } = PLANTING_BOUNDS;
  const cells = maxX - minX + 1;
  const side = cells * TILE_WIDTH;
  const center = isoPoint((minX + maxX) / 2, (minY + maxY) / 2);
  const tiles = useMemo(() => revealTiles(from, to), [from, to]);
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const animation = Animated.timing(t, {
      toValue: 1,
      duration: reduced ? 1 : 1600,
      easing: Easing.linear,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [t, reduced]);
  return (
    <View
      pointerEvents="none"
      testID="pick-farm-land-reveal"
      style={{
        position: 'absolute',
        left: center.x - side / 2,
        top: center.y - side / 2,
        width: side,
        height: side,
        transform: GROUND_TRANSFORM,
      }}
    >
      {tiles.map((tile) => {
        // Each tile holds, flashes light for a moment, then is gone: a wave along the ring.
        const start = (300 + tile.delay) / 1600;
        const end = Math.min(1, start + 0.22);
        const mid = (start + end) / 2;
        const box = {
          position: 'absolute' as const,
          left: (tile.x - minX) * TILE_WIDTH,
          top: (tile.y - minY) * TILE_WIDTH,
          width: 2 * TILE_WIDTH,
          height: 2 * TILE_WIDTH,
        };
        return (
          <View key={`${tile.x},${tile.y}`}>
            <Animated.View
              style={{
                ...box,
                backgroundColor: '#2E4A1A',
                opacity: t.interpolate({
                  inputRange: [0, start, mid, 1],
                  outputRange: [0.34, 0.34, 0, 0],
                }),
              }}
            />
            <Animated.View
              style={{
                ...box,
                backgroundColor: '#FFF4C8',
                opacity: t.interpolate({
                  inputRange: [0, start, mid, end, 1],
                  outputRange: [0, 0, 0.55, 0, 0],
                }),
              }}
            />
          </View>
        );
      })}
    </View>
  );
}

/** animalPlace's ease (quadratic in-out) sampled for interpolations driven by walk time. */
const EASE_IN = Array.from({ length: 17 }, (_, i) => i / 16);
const EASE_OUT = EASE_IN.map((t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2));

/** One animal. Busy ones stroll around the yard, hungry ones sit with a feed bubble, ready
 * ones wait with an egg or milk at their feet. Idle pecks are short and rare. */
const Animal = memo(function Animal({
  pen,
  kind,
  id,
  index,
  mode,
  condition,
  moving,
  feed,
}: {
  pen: PenId;
  kind: AnimalKind;
  id: number;
  index: number;
  mode: AnimalMode;
  condition: 'ready' | 'hungry' | 'busy';
  moving: boolean;
  feed: CropId;
}) {
  const a = ANIMAL_ART[kind];
  const height = a.width * a.ratio;
  const [seg, setSeg] = useState(() => animalPlace(pen, id, index, mode, Date.now()));
  const progress = useRef(new Animated.Value(1)).current;
  const peck = useRef(new Animated.Value(0)).current;
  const walking = useRef(false);
  // Stroll: follow the shared schedule (the same one taps use) one walk at a time.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;
    const step = () => {
      if (!alive) return;
      const now = Date.now();
      const place = animalPlace(pen, id, index, mode, now);
      setSeg(place);
      if (mode === 'stroll')
        timer = setTimeout(step, Math.max(50, place.start + STROLL.period - now + 5));
    };
    step();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [pen, id, index, mode]);
  // Start the walk in the same commit as the new segment, so the animal never jumps back.
  // `progress` is walk time (linear); the easing is sampled in the interpolation below, exactly
  // as animalPlace eases it, so the drawn animal and the tap target stay together.
  useLayoutEffect(() => {
    progress.stopAnimation();
    if (mode !== 'stroll' || !seg.walking) {
      walking.current = false;
      progress.setValue(1);
      return;
    }
    const elapsed = Math.max(0, Date.now() - seg.start);
    walking.current = true;
    progress.setValue(Math.min(1, elapsed / STROLL.walk));
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: Math.max(60, STROLL.walk - elapsed),
      easing: Easing.linear,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) walking.current = false;
    });
    return () => animation.stop();
  }, [seg, mode, progress]);
  // Idle pecks while standing (not when hungry: a hungry animal sits and waits).
  useEffect(() => {
    if (!moving || condition === 'hungry') {
      peck.setValue(0);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let animation: Animated.CompositeAnimation | null = null;
    const next = (n: number) => {
      timer = setTimeout(
        () => {
          if (!alive) return;
          if (walking.current) return next(n + 1);
          animation = Animated.sequence([
            Animated.timing(peck, {
              toValue: 1,
              duration: 160,
              easing: Easing.out(Easing.quad),
              useNativeDriver: true,
            }),
            Animated.timing(peck, {
              toValue: 0,
              duration: 220,
              easing: Easing.inOut(Easing.quad),
              useNativeDriver: true,
            }),
          ]);
          animation.start(() => next(n + 1));
        },
        2200 + (((id + 1) * 1373 + n * 811) % 4200),
      );
    };
    next(0);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      animation?.stop();
    };
  }, [moving, condition, id, peck]);
  const from = at(pen, seg.from.x, seg.from.y);
  const to = at(pen, seg.to.x, seg.to.y);
  const flip = seg.facing < 0;
  const sitting = condition === 'hungry';
  const tilt = kind === 'chicken' ? 18 : 5;
  // Little hops along the way.
  const hops = 6;
  const hopInput = Array.from({ length: hops * 2 + 1 }, (_, i) => i / (hops * 2));
  const hopOutput = hopInput.map((_, i) => (i % 2 ? -3 : 0));
  return (
    <Animated.View
      pointerEvents="none"
      testID={`pick-farm-animal-${id}`}
      style={{
        position: 'absolute',
        left: from.x - a.width / 2,
        top: from.y - height,
        transform: [
          {
            translateX: progress.interpolate({
              inputRange: EASE_IN,
              outputRange: EASE_OUT.map((k) => k * (to.x - from.x)),
            }),
          },
          {
            translateY: progress.interpolate({
              inputRange: EASE_IN,
              outputRange: EASE_OUT.map((k) => k * (to.y - from.y)),
            }),
          },
          { translateY: progress.interpolate({ inputRange: hopInput, outputRange: hopOutput }) },
        ],
      }}
    >
      {condition === 'ready' && (
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
            // Pivot near the feet: shift, rotate or squash, shift back.
            { translateY: height * 0.4 },
            {
              rotate: peck.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${tilt}deg`] }),
            },
            { scaleY: sitting ? 0.8 : 1 },
            { translateY: -height * 0.4 },
          ],
        }}
      />
      {sitting && (
        <View
          testID={`pick-farm-hungry-${id}`}
          style={{
            position: 'absolute',
            left: a.width / 2 - 13 + (flip ? -8 : 8),
            top: -18 + height * 0.18,
            width: 26,
            height: 26,
            borderRadius: 13,
            backgroundColor: '#FFFDF6',
            borderWidth: 1.5,
            borderColor: '#E3D6B8',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <CropArt cropId={feed} size={20} />
          <View
            style={{
              position: 'absolute',
              bottom: -6,
              left: flip ? 15 : 5,
              width: 7,
              height: 7,
              borderRadius: 4,
              backgroundColor: '#FFFDF6',
              borderWidth: 1,
              borderColor: '#E3D6B8',
            }}
          />
        </View>
      )}
    </Animated.View>
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
        const feed = Object.keys(ANIMALS.find((v) => v.id === kind)!.feed)[0] as CropId;
        const animals = yardAnimals(state, kind, now, moving);
        const ready = animals.some((v) => v.condition === 'ready');
        const hungry = animals.some((v) => v.condition === 'hungry');
        const busy = animals.some((v) => v.condition === 'busy');
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
            {animals.map((v) => (
              <Animal
                key={v.id}
                pen={pen.id}
                kind={kind}
                id={v.id}
                index={v.index}
                mode={v.mode}
                condition={v.condition}
                moving={moving}
                feed={feed}
              />
            ))}
            {(ready || (hungry && !busy)) && (
              <View
                style={{
                  position: 'absolute',
                  left: roof.x,
                  top: roof.y - (pen.id === 'coop' ? 100 : 128),
                }}
              >
                <Badge
                  kind={ready ? 'ready' : 'feed'}
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
