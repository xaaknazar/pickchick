import { memo } from 'react';
import { useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { View } from 'react-native';
import { assets } from '../../assets';
import { GamePosterCard } from '../GamePosterCard';
import { MAZE, COLS, ROWS, type Direction, type Food } from './engine';

// Rival artwork remains vector-based for crisp rendering at maze-cell size.
const svg = (body: string) => ({
  uri: `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' + body + '</svg>')}`,
});
// Transparent vector silhouettes with shaded surfaces stay crisp even at
// maze-cell size. The shapes and packaging follow the owner's menu photos.
const foods = {
  burger: require('../../../assets/games/food-burger.svg'),
  fingers: require('../../../assets/games/food-fingers.svg'),
  cola: require('../../../assets/games/food-cola.svg'),
  power: require('../../../assets/games/food-sauce.svg'),
};
export const FoodIcon = memo(function FoodIcon({ kind, size }: { kind: Food; size: number }) {
  return (
    <Image
      testID={`pick-man-food-${kind}`}
      source={foods[kind]}
      contentFit="contain"
      style={{ width: size, height: size }}
      pointerEvents="none"
      accessibilityLabel={
        { burger: 'Бургер', fingers: 'Фингерсы', cola: 'Кола', power: 'Фирменный соус - защита' }[
          kind
        ]
      }
    />
  );
});

const rivalArt = (color: string, scared = false) =>
  svg(
    `<path d="M6 40V22C6 1 42 1 42 22v18l-9-5-9 6-9-6Z" fill="${color}" stroke="#E4EFFF" stroke-width="1.5"/><path d="M8 29h32v4H8Z" fill="#04143A" opacity=".16"/><ellipse cx="18" cy="21" rx="5.5" ry="6.5" fill="#FFF"/><ellipse cx="32" cy="21" rx="5.5" ry="6.5" fill="#FFF"/><circle cx="19" cy="22" r="2.7" fill="#04143A"/><circle cx="33" cy="22" r="2.7" fill="#04143A"/>${scared ? '<path d="m16 33 4-3 4 3 4-3 4 3" fill="none" stroke="#04143A" stroke-width="2"/>' : ''}`,
  );
const rivals = ['#91BFFF', '#C5A3F5', '#6FDDC6'].map((color) => rivalArt(color));
const scaredRival = rivalArt('#CBDDFA', true);
export const Chick = memo(function Chick({
  size,
  direction = 'right',
}: {
  size: number;
  direction?: Direction;
}) {
  return (
    <Image
      source={assets.pickManChick}
      contentFit="contain"
      testID="pick-man-chick"
      style={{
        borderRadius: size / 2,
        width: size,
        height: size,
        transform: [
          { rotate: { right: '0deg', down: '90deg', left: '0deg', up: '-90deg' }[direction] },
          { scaleX: direction === 'left' ? -1 : 1 },
        ],
      }}
    />
  );
});
export const Rival = memo(function Rival({
  size,
  scared = false,
  variant = 0,
}: {
  size: number;
  scared?: boolean;
  variant?: number;
}) {
  return (
    <Image
      source={scared ? scaredRival : rivals[variant % rivals.length]}
      contentFit="contain"
      style={{ width: size, height: size }}
    />
  );
});

// Trace only exposed wall edges, so adjoining cells form a single rounded shape.
// The source is built once; food and actors can move without rebuilding the maze.
type Corner = { x: number; y: number };
function wallContours() {
  const edges = new Map<string, Corner[]>();
  const key = (p: Corner) => `${p.x},${p.y}`;
  const edge = (from: Corner, to: Corner) =>
    edges.set(key(from), [...(edges.get(key(from)) ?? []), to]);
  const wall = (x: number, y: number) => MAZE[y]?.[x] === '#';
  MAZE.forEach((row, y) =>
    [...row].forEach((tile, x) => {
      if (tile !== '#') return;
      if (!wall(x, y - 1)) edge({ x, y }, { x: x + 1, y });
      if (!wall(x + 1, y)) edge({ x: x + 1, y }, { x: x + 1, y: y + 1 });
      if (!wall(x, y + 1)) edge({ x: x + 1, y: y + 1 }, { x, y: y + 1 });
      if (!wall(x - 1, y)) edge({ x, y: y + 1 }, { x, y });
    }),
  );
  const paths: string[] = [];
  while (edges.size) {
    const start = edges.keys().next().value!;
    const [x, y] = start.split(',').map(Number);
    const points: Corner[] = [];
    let point: Corner = { x: x!, y: y! };
    do {
      points.push(point);
      const options = edges.get(key(point))!;
      const next = options.shift()!;
      if (!options.length) edges.delete(key(point));
      point = next;
    } while (key(point) !== start);
    // Remove collinear vertices before rounding; long walls stay perfectly straight.
    const corners = points.filter((p, i) => {
      const a = points[(i + points.length - 1) % points.length]!;
      const b = points[(i + 1) % points.length]!;
      return (p.x - a.x) * (b.y - p.y) !== (p.y - a.y) * (b.x - p.x);
    });
    paths.push(
      corners
        .map((p, i) => {
          const a = corners[(i + corners.length - 1) % corners.length]!;
          const b = corners[(i + 1) % corners.length]!;
          const from = {
            x: p.x + Math.sign(a.x - p.x) * 0.22,
            y: p.y + Math.sign(a.y - p.y) * 0.22,
          };
          const to = { x: p.x + Math.sign(b.x - p.x) * 0.22, y: p.y + Math.sign(b.y - p.y) * 0.22 };
          return `${i ? 'L' : 'M'}${from.x} ${from.y}Q${p.x} ${p.y} ${to.x} ${to.y}`;
        })
        .join('') + 'Z',
    );
  }
  return paths.join('');
}
const wallsSource = {
  uri: `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${COLS} ${ROWS}"><defs><linearGradient id="walls" x2="0" y2="1"><stop stop-color="#16477E"/><stop offset="1" stop-color="#102C56"/></linearGradient></defs><path d="${wallContours()}" fill="url(#walls)" fill-rule="evenodd" stroke="#4583CC" stroke-width=".065" stroke-linejoin="round"/></svg>`,
  )}`,
};
export const MazeWalls = memo(function MazeWalls({ cell }: { cell: number }) {
  return (
    <Image
      source={wallsSource}
      style={{ width: COLS * cell, height: ROWS * cell }}
      contentFit="contain"
      pointerEvents="none"
    />
  );
});
export function PickManHero({ size }: { size: number }) {
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ position: 'absolute', opacity: 0.7, transform: [{ rotate: '-6deg' }] }}>
        <MazeWalls cell={size / ROWS} />
      </View>
      <View
        style={{
          width: size * 0.43,
          height: size * 0.43,
          borderRadius: size,
          backgroundColor: '#FFAF60',
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 6,
          borderColor: '#FFD59B',
        }}
      >
        <Chick size={size * 0.35} />
      </View>
      <View style={{ position: 'absolute', left: '2%', top: '15%' }}>
        <FoodIcon kind="burger" size={size * 0.2} />
      </View>
      <View style={{ position: 'absolute', right: '2%', top: '13%' }}>
        <Rival size={size * 0.22} variant={2} />
      </View>
      <View style={{ position: 'absolute', left: '9%', bottom: '9%' }}>
        <FoodIcon kind="cola" size={size * 0.18} />
      </View>
      <View style={{ position: 'absolute', right: '7%', bottom: '5%' }}>
        <FoodIcon kind="fingers" size={size * 0.21} />
      </View>
    </View>
  );
}
export function MazeArt({ size = 140 }: { size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 22,
        backgroundColor: '#04143A',
        borderWidth: 2,
        borderColor: '#8BB6FF',
        transform: [{ rotate: '7deg' }],
      }}
    >
      {[
        { left: '18%', top: '14%', width: '43%', height: 8 },
        { left: '72%', top: '14%', width: 8, height: '37%' },
        { left: '18%', top: '41%', width: 8, height: '41%' },
        { left: '39%', top: '65%', width: '44%', height: 8 },
      ].map((style, i) => (
        <View
          key={i}
          style={[
            { position: 'absolute', borderRadius: 4, backgroundColor: '#2C73EA' },
            style as object,
          ]}
        />
      ))}
      <View style={{ position: 'absolute', left: '34%', top: '24%' }}>
        <Chick size={size * 0.39} />
      </View>
      <View style={{ position: 'absolute', left: '67%', top: '40%' }}>
        <FoodIcon kind="burger" size={size * 0.23} />
      </View>
      <View style={{ position: 'absolute', left: '37%', top: '73%' }}>
        <FoodIcon kind="cola" size={size * 0.2} />
      </View>
      <View style={{ position: 'absolute', left: '6%', top: '10%' }}>
        <FoodIcon kind="fingers" size={size * 0.23} />
      </View>
    </View>
  );
}
export function PickManCard() {
  const router = useRouter();
  return (
    <GamePosterCard
      name="PICK MAN"
      subtitle="ПОЙМАЙ СВОЙ ВКУС"
      description={'Бургеры, фингерсы, кола.\nСобери всё в лабиринте.'}
      testID="pick-man-open"
      onPress={() => router.push('/games/pick-man')}
      cover={assets.pickManCover}
    />
  );
}
