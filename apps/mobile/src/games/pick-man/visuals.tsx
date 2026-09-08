import { memo } from 'react';
import { useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { View } from 'react-native';
import { assets } from '../../assets';
import { GamePosterCard } from '../GamePosterCard';
import type { Direction, Food } from './engine';

// Rival artwork remains vector-based for crisp rendering at maze-cell size.
const svg = (body: string) => ({
  uri: `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' + body + '</svg>')}`,
});
// Frame the original menu photos in small collectible badges. These are the
// same bundled images used by the menu, with no network load during a game.
const foods = {
  burger: { source: assets.burger, width: 1.285, height: 1.375, left: -0.169, top: -0.325 },
  fingers: { source: assets.fingers, width: 2.245, height: 1.331, left: -0.602, top: -0.184 },
  cola: { source: assets.drink, width: 1.667, height: 1.667, left: -0.333, top: -0.4 },
  power: { source: assets.sauce, width: 1.786, height: 1.786, left: -0.393, top: -0.5 },
};
export const FoodIcon = memo(function FoodIcon({ kind, size }: { kind: Food; size: number }) {
  const photo = foods[kind];
  return (
    <View
      testID={`pick-man-food-${kind}`}
      pointerEvents="none"
      accessible
      accessibilityLabel={
        {
          burger: 'Бургер',
          fingers: 'Фингерсы',
          cola: 'Coca-Cola',
          power: 'Фирменный соус - защита',
        }[kind]
      }
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        overflow: 'hidden',
        backgroundColor: '#F4F4F4',
        borderWidth: kind === 'power' ? Math.max(1, size * 0.07) : 0,
        borderColor: '#FF9A45',
      }}
    >
      <Image
        source={photo.source}
        contentFit="fill"
        accessible={false}
        style={{
          position: 'absolute',
          width: size * photo.width,
          height: size * photo.height,
          left: size * photo.left,
          top: size * photo.top,
        }}
      />
    </View>
  );
});
const rival = svg(
  '<path d="M7 39V21C7 2 41 2 41 21v18l-7-4-6 5-7-5-7 5Z" fill="#B6D2FF"/><path d="M8 23h32v9H8Z" fill="#0047BB"/><ellipse cx="18" cy="22" rx="5" ry="6" fill="#FFF"/><ellipse cx="31" cy="22" rx="5" ry="6" fill="#FFF"/><circle cx="19" cy="23" r="2.3" fill="#04143A"/><circle cx="32" cy="23" r="2.3" fill="#04143A"/>',
);
export function Chick({ size, direction = 'right' }: { size: number; direction?: Direction }) {
  return (
    <Image
      source={assets.pickManChick}
      contentFit="contain"
      testID="pick-man-chick"
      style={{
        borderRadius: size * 0.3,
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
