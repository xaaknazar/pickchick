import { memo } from 'react';
import { useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { View } from 'react-native';
import { ArcadeCard } from '../ArcadeCard';
import type { Direction, Food } from './engine';

// Original vector miniatures stay legible at maze-cell size on both native and web.
const svg = (body: string) => ({
  uri: `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' + body + '</svg>')}`,
});
const foods = {
  burger: svg(
    '<path d="M5 21C5 3 43 3 43 21Z" fill="#FFB56F"/><path d="M7 28h34v7H7z" fill="#72351D"/><path d="M5 24l7-3 6 3 7-3 7 3 8-3 4 4-4 5H9Z" fill="#B6DE90"/><path d="M6 36h36c0 9-36 9-36 0" fill="#FF9746"/><path d="m15 14 2-2m8-1 2 2m7 2 2-1" stroke="#FFF4D8" stroke-width="3" stroke-linecap="round"/>',
  ),
  fingers: svg(
    '<g fill="#FFB15B" stroke="#E47B2F" stroke-width="2"><rect x="6" y="5" width="11" height="32" rx="5" transform="rotate(-12 12 20)"/><rect x="18" y="3" width="11" height="32" rx="5"/><rect x="30" y="7" width="11" height="32" rx="5" transform="rotate(12 35 20)"/></g><path d="m7 27 4 17h26l4-17Z" fill="#FF7A3D"/><path d="m19 35 4 4 7-8" fill="none" stroke="#FFF" stroke-width="3" stroke-linecap="round"/>',
  ),
  cola: svg(
    '<path d="m29 16 4-12h10" fill="none" stroke="#FFF1D8" stroke-width="4" stroke-linecap="round"/><path d="m9 15 4 29h23l4-29Z" fill="#FF7A3D"/><path d="M10 21h29l-2 15H12Z" fill="#FFFFFF"/><path d="M21 24h8l-5 9h-7Z" fill="#0047BB"/><rect x="6" y="12" width="36" height="6" rx="3" fill="#B5D3FF"/>',
  ),
  power: svg(
    '<circle cx="24" cy="24" r="21" fill="#FFF0CF"/><path d="M25 5 12 26h10l-1 17 16-24H26Z" fill="#FF7A3D"/>',
  ),
};
export const FoodIcon = memo(function FoodIcon({ kind, size }: { kind: Food; size: number }) {
  return (
    <Image
      source={foods[kind]}
      style={{ width: size, height: size }}
      contentFit="contain"
      pointerEvents="none"
      accessibilityLabel={
        { burger: 'Бургер', fingers: 'Фингерсы', cola: 'Кола', power: 'Острый соус - защита' }[kind]
      }
    />
  );
});
const chicken = svg(
  '<path d="m19 12-2-7 8 5 5-6 1 11" fill="#FF7A3D"/><path d="M38 25c0 13-10 20-20 17C4 38 4 16 17 12c12-4 22 4 21 13" fill="#FFAB6F"/><path d="m34 23 12 5-12 6Z" fill="#FF7A3D"/><ellipse cx="29" cy="21" rx="6" ry="7" fill="#FFF"/><ellipse cx="31" cy="22" rx="2.6" ry="3.2" fill="#04143A"/><path d="M13 27c8-3 10 7 3 8" fill="none" stroke="#F57B3F" stroke-width="3" stroke-linecap="round"/>',
);
const rival = svg(
  '<path d="M7 39V21C7 2 41 2 41 21v18l-7-4-6 5-7-5-7 5Z" fill="#B6D2FF"/><path d="M8 23h32v9H8Z" fill="#0047BB"/><ellipse cx="18" cy="22" rx="5" ry="6" fill="#FFF"/><ellipse cx="31" cy="22" rx="5" ry="6" fill="#FFF"/><circle cx="19" cy="23" r="2.3" fill="#04143A"/><circle cx="32" cy="23" r="2.3" fill="#04143A"/>',
);
export function Chick({ size, direction = 'right' }: { size: number; direction?: Direction }) {
  return (
    <Image
      source={chicken}
      contentFit="contain"
      style={{
        width: size,
        height: size,
        transform: [
          { rotate: { right: '0deg', down: '90deg', left: '0deg', up: '-90deg' }[direction] },
          { scaleX: direction === 'left' ? -1 : 1 },
        ],
      }}
    />
  );
}
export function Rival({ size, scared = false }: { size: number; scared?: boolean }) {
  return (
    <Image
      source={rival}
      contentFit="contain"
      style={{ width: size, height: size, opacity: scared ? 0.45 : 1 }}
    />
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
    <ArcadeCard
      name="PICK MAN"
      subtitle="ПОЙМАЙ СВОЙ ВКУС"
      description={'Бургеры, фингерсы, кола.\nСобери всё в лабиринте.'}
      testID="pick-man-open"
      onPress={() => router.push('/games/pick-man')}
      art={<MazeArt size={120} />}
    />
  );
}
