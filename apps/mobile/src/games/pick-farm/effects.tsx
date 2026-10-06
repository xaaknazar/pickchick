import { memo, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, Text, View } from 'react-native';
import type { CropId } from '@pickchick/farm-game';
import { Icon, type IconName } from '../../components/UI';
import { font } from '../../theme';
import { CropArt } from './visuals';
import { farmPalette as p } from './styles';

type Point = { x: number; y: number };
export type FarmFx =
  | {
      id: number;
      kind: 'fly';
      from: Point;
      to: Point;
      cropId?: CropId;
      coin?: boolean;
      delay: number;
    }
  | { id: number; kind: 'water'; at: Point; size: number }
  | { id: number; kind: 'pop'; at: Point; text: string; tone: 'coin' | 'xp' | 'info' }
  | { id: number; kind: 'puff'; at: Point; size: number }
  | { id: number; kind: 'pluck'; base: Point; size: number; cropId: CropId };
/** An effect before it receives its id (distributes over the union). */
export type FarmFxInput = FarmFx extends infer T
  ? T extends unknown
    ? Omit<T, 'id'>
    : never
  : never;

/** Gold game coin drawn with views; fictional currency, no real-money symbol. */
export const Coin = memo(function Coin({ size = 18 }: { size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: '#F2B53A',
        borderWidth: Math.max(1.5, size * 0.1),
        borderColor: '#C7841D',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <View
        style={{
          width: size * 0.42,
          height: size * 0.42,
          borderRadius: size,
          borderWidth: Math.max(1, size * 0.07),
          borderColor: '#FFE6A3',
        }}
      />
    </View>
  );
});

/** Produce or a coin flying in an arc from the field to a HUD counter. */
function Fly({ fx, onDone }: { fx: Extract<FarmFx, { kind: 'fly' }>; onDone(id: number): void }) {
  const t = useRef(new Animated.Value(0)).current;
  const finish = useLatest(() => onDone(fx.id));
  useEffect(() => {
    const animation = Animated.timing(t, {
      toValue: 1,
      duration: 640,
      delay: fx.delay,
      easing: Easing.inOut(Easing.quad),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => finished && finish.current());
    return () => animation.stop();
  }, [t, fx.delay, finish]);
  const dx = fx.to.x - fx.from.x,
    dy = fx.to.y - fx.from.y;
  const lift = Math.min(120, 40 + Math.abs(dx) * 0.2);
  const size = fx.coin ? 20 : 30;
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: fx.from.x - size / 2,
        top: fx.from.y - size / 2,
        opacity: t.interpolate({ inputRange: [0, 0.05, 0.85, 1], outputRange: [0, 1, 1, 0] }),
        transform: [
          { translateX: t.interpolate({ inputRange: [0, 1], outputRange: [0, dx] }) },
          {
            // Arc: up first, then into the counter.
            translateY: t.interpolate({
              inputRange: [0, 0.35, 1],
              outputRange: [0, Math.min(dy, 0) * 0.15 - lift, dy],
            }),
          },
          {
            scale: t.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0.6, 1.15, 0.55] }),
          },
        ],
      }}
    >
      {fx.coin ? (
        <Coin size={size} />
      ) : fx.cropId ? (
        <CropArt cropId={fx.cropId} size={size} />
      ) : null}
    </Animated.View>
  );
}

const can = require('../../../assets/games/pick-farm/watering-can.png');
/** The watering can tips over the bed and a short shower falls on the soil. */
function Water({
  fx,
  onDone,
}: {
  fx: Extract<FarmFx, { kind: 'water' }>;
  onDone(id: number): void;
}) {
  const t = useRef(new Animated.Value(0)).current;
  const finish = useLatest(() => onDone(fx.id));
  useEffect(() => {
    const animation = Animated.timing(t, {
      toValue: 1,
      duration: 900,
      easing: Easing.linear,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => finished && finish.current());
    return () => animation.stop();
  }, [t, finish]);
  const s = Math.max(34, Math.min(84, fx.size));
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: fx.at.x, top: fx.at.y }}>
      <Animated.Image
        source={can}
        accessible={false}
        style={{
          position: 'absolute',
          width: s,
          height: s * 0.97,
          left: -s * 1.05,
          top: -s * 1.12,
          opacity: t.interpolate({ inputRange: [0, 0.1, 0.8, 1], outputRange: [0, 1, 1, 0] }),
          transform: [
            { translateY: t.interpolate({ inputRange: [0, 0.15, 1], outputRange: [-10, 0, 0] }) },
            {
              rotate: t.interpolate({
                inputRange: [0, 0.2, 0.75, 1],
                outputRange: ['0deg', '28deg', '28deg', '8deg'],
              }),
            },
          ],
        }}
      />
      {Array.from({ length: 7 }, (_, i) => {
        const x = -s * 0.16 + (i % 4) * s * 0.09 - s * 0.04 * Math.floor(i / 4);
        const start = 0.18 + (i % 3) * 0.07;
        return (
          <Animated.View
            key={i}
            style={{
              position: 'absolute',
              left: x,
              top: -s * 0.66,
              width: 3,
              height: 9,
              borderRadius: 2,
              backgroundColor: '#8FD3F2',
              opacity: t.interpolate({
                inputRange: [0, start, start + 0.08, 0.86, 1],
                outputRange: [0, 0, 0.95, 0.9, 0],
              }),
              transform: [
                {
                  translateY: t.interpolate({
                    inputRange: [0, start, 1],
                    outputRange: [0, 0, s * 0.66],
                  }),
                },
              ],
            }}
          />
        );
      })}
    </View>
  );
}

/** Short rising label beside a counter or object. */
function Pop({ fx, onDone }: { fx: Extract<FarmFx, { kind: 'pop' }>; onDone(id: number): void }) {
  const t = useRef(new Animated.Value(0)).current;
  const finish = useLatest(() => onDone(fx.id));
  useEffect(() => {
    const animation = Animated.timing(t, {
      toValue: 1,
      duration: 1100,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => finished && finish.current());
    return () => animation.stop();
  }, [t, finish]);
  const color = fx.tone === 'coin' ? '#7A4A06' : fx.tone === 'xp' ? '#1F5B3A' : p.ink;
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: fx.at.x - 60,
        top: fx.at.y,
        width: 120,
        alignItems: 'center',
        opacity: t.interpolate({ inputRange: [0, 0.1, 0.7, 1], outputRange: [0, 1, 1, 0] }),
        transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, -22] }) }],
      }}
    >
      <Text
        style={{
          fontFamily: font.bold,
          fontSize: 15,
          color,
          backgroundColor: '#FFF8E6EE',
          paddingHorizontal: 9,
          paddingVertical: 3,
          borderRadius: 10,
          overflow: 'hidden',
        }}
      >
        {fx.text}
      </Text>
    </Animated.View>
  );
}

/** A harvested plant lifts out of the soil with a quick squash-and-stretch, then fades. */
function Pluck({
  fx,
  onDone,
}: {
  fx: Extract<FarmFx, { kind: 'pluck' }>;
  onDone(id: number): void;
}) {
  const t = useRef(new Animated.Value(0)).current;
  const finish = useLatest(() => onDone(fx.id));
  useEffect(() => {
    const animation = Animated.timing(t, {
      toValue: 1,
      duration: 380,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => finished && finish.current());
    return () => animation.stop();
  }, [t, finish]);
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: fx.base.x - fx.size / 2,
        top: fx.base.y - fx.size,
        opacity: t.interpolate({ inputRange: [0, 0.55, 1], outputRange: [1, 0.9, 0] }),
        transform: [
          { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, -fx.size * 0.35] }) },
          // Stretch up as it leaves the soil, then settle smaller while it fades.
          { scaleX: t.interpolate({ inputRange: [0, 0.25, 1], outputRange: [1, 0.86, 0.7] }) },
          { scaleY: t.interpolate({ inputRange: [0, 0.25, 1], outputRange: [1, 1.18, 0.8] }) },
        ],
      }}
    >
      <CropArt cropId={fx.cropId} size={fx.size} />
    </Animated.View>
  );
}

/** Soft leaf puff when a withered bed is cleared or a plant is removed. */
function Puff({ fx, onDone }: { fx: Extract<FarmFx, { kind: 'puff' }>; onDone(id: number): void }) {
  const t = useRef(new Animated.Value(0)).current;
  const finish = useLatest(() => onDone(fx.id));
  useEffect(() => {
    const animation = Animated.timing(t, {
      toValue: 1,
      duration: 560,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => finished && finish.current());
    return () => animation.stop();
  }, [t, finish]);
  const r = Math.max(18, Math.min(60, fx.size * 0.5));
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: fx.at.x, top: fx.at.y }}>
      {Array.from({ length: 6 }, (_, i) => {
        const a = (i / 6) * Math.PI * 2;
        return (
          <Animated.View
            key={i}
            style={{
              position: 'absolute',
              width: 7,
              height: 7,
              borderRadius: 4,
              backgroundColor: i % 2 ? '#B5893F' : '#E6D7A2',
              opacity: t.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 1, 0] }),
              transform: [
                {
                  translateX: t.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, Math.cos(a) * r],
                  }),
                },
                {
                  translateY: t.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, Math.sin(a) * r * 0.55 - 8],
                  }),
                },
              ],
            }}
          />
        );
      })}
    </View>
  );
}

function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export const FxLayer = memo(function FxLayer({
  items,
  reduced,
  onDone,
}: {
  items: FarmFx[];
  reduced: boolean;
  onDone(id: number): void;
}) {
  return (
    <View pointerEvents="none" style={{ position: 'absolute', inset: 0, zIndex: 15 }}>
      {items.map((fx) => {
        if (reduced && fx.kind !== 'pop') return <Done key={fx.id} id={fx.id} onDone={onDone} />;
        if (fx.kind === 'fly') return <Fly key={fx.id} fx={fx} onDone={onDone} />;
        if (fx.kind === 'water') return <Water key={fx.id} fx={fx} onDone={onDone} />;
        if (fx.kind === 'puff') return <Puff key={fx.id} fx={fx} onDone={onDone} />;
        if (fx.kind === 'pluck') return <Pluck key={fx.id} fx={fx} onDone={onDone} />;
        return <Pop key={fx.id} fx={fx} onDone={onDone} />;
      })}
    </View>
  );
});
function Done({ id, onDone }: { id: number; onDone(id: number): void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDone(id), 0);
    return () => clearTimeout(timer);
  }, [id, onDone]);
  return null;
}

/** Integer counter that rolls to its new value; the value itself is always the confirmed one. */
export function CountUp({ value, style }: { value: number; style: object }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = performance.now();
    const origin = from.current;
    if (origin === value) return;
    let frame = 0;
    const step = () => {
      const k = Math.min(1, (performance.now() - start) / 520);
      const v = Math.round(origin + (value - origin) * (1 - (1 - k) ** 3));
      from.current = v;
      setShown(v);
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <Text style={style}>{shown}</Text>;
}

/** Pulse a HUD element when something arrives in it. */
export function usePulse(trigger: unknown, reduced: boolean) {
  const scale = useRef(new Animated.Value(1)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (reduced) return;
    scale.setValue(1.14);
    const animation = Animated.spring(scale, {
      toValue: 1,
      damping: 9,
      stiffness: 260,
      mass: 0.6,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [trigger, reduced, scale]);
  return scale;
}

/** Fills while the player holds an object, before it lifts for moving. */
export function HoldRing({ at, duration }: { at: Point | null; duration: number }) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    t.setValue(0);
    if (!at) return;
    const animation = Animated.timing(t, {
      toValue: 1,
      duration,
      easing: Easing.linear,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [at, duration, t]);
  if (!at) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        zIndex: 16,
        left: at.x - 30,
        top: at.y - 30,
        width: 60,
        height: 60,
        borderRadius: 30,
        borderWidth: 4,
        borderColor: '#FFF6DD',
        backgroundColor: '#FFF6DD33',
        opacity: t.interpolate({ inputRange: [0, 0.25, 1], outputRange: [0, 0.9, 1] }),
        transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [1.5, 0.75] }) }],
      }}
    />
  );
}

export type LevelUpInfo = { level: number; unlocks: string[] };
/** Celebration after a confirmed level increase, with what the level opened. */
export function LevelUp({
  info,
  reduced,
  onClose,
}: {
  info: LevelUpInfo;
  reduced: boolean;
  onClose(): void;
}) {
  const t = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) return;
    const animation = Animated.spring(t, {
      toValue: 1,
      damping: 12,
      stiffness: 170,
      mass: 0.8,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [t, reduced]);
  const confetti: { color: string; x: number; y: number; r: number }[] = Array.from(
    { length: 18 },
    (_, i) => ({
      color: ['#F4AE57', '#7CC57A', '#F06B5B', '#8FD3F2', '#F2D45C'][i % 5]!,
      x: Math.cos((i / 18) * Math.PI * 2) * (120 + (i % 3) * 30),
      y: Math.sin((i / 18) * Math.PI * 2) * (70 + (i % 4) * 14),
      r: i * 37,
    }),
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Новый уровень ${info.level}. Закрыть`}
      onPress={onClose}
      testID="pick-farm-level-up"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 40,
        backgroundColor: '#14261D66',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {!reduced &&
        confetti.map((c, i) => (
          <Animated.View
            key={i}
            style={{
              position: 'absolute',
              width: 10,
              height: 6,
              borderRadius: 2,
              backgroundColor: c.color,
              opacity: t.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 1, 0.9] }),
              transform: [
                { translateX: t.interpolate({ inputRange: [0, 1], outputRange: [0, c.x] }) },
                { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, c.y] }) },
                { rotate: `${c.r}deg` },
              ],
            }}
          />
        ))}
      <Animated.View
        style={{
          backgroundColor: p.paper,
          borderRadius: 24,
          paddingHorizontal: 28,
          paddingVertical: 20,
          alignItems: 'center',
          gap: 8,
          minWidth: 260,
          maxWidth: 380,
          transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }],
          opacity: t,
        }}
      >
        <View
          style={{
            width: 64,
            height: 64,
            borderRadius: 32,
            backgroundColor: p.blue,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 4,
            borderColor: p.orange,
          }}
        >
          <Text style={{ fontFamily: font.display, fontSize: 28, color: '#FFFFFF' }}>
            {info.level}
          </Text>
        </View>
        <Text style={{ fontFamily: font.display, fontSize: 24, color: p.ink }}>Новый уровень!</Text>
        {info.unlocks.length ? (
          info.unlocks.map((line) => (
            <View key={line} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Icon name={'sparkles' as IconName} size={16} color={p.green} />
              <Text style={{ fontFamily: font.medium, fontSize: 14, color: p.ink }}>{line}</Text>
            </View>
          ))
        ) : (
          <Text style={{ fontFamily: font.medium, fontSize: 14, color: p.muted }}>
            Сад растёт вместе с вами
          </Text>
        )}
        <Text style={{ fontFamily: font.medium, fontSize: 12, color: p.muted, marginTop: 6 }}>
          Коснитесь, чтобы продолжить
        </Text>
      </Animated.View>
    </Pressable>
  );
}
