import { memo } from 'react';
import { useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { View } from 'react-native';
import { assets } from '../../assets';
import { GamePosterCard } from '../GamePosterCard';
import type { PieceKind } from './engine';

export const blockColors: Record<PieceKind, string> = {
  I: '#EAF1FF',
  O: '#FF8A45',
  T: '#5D91FF',
  S: '#86B5FF',
  Z: '#E86629',
  J: '#1D64DE',
  L: '#FFBC8D',
};
export const Tile = memo(function Tile({
  x,
  y,
  size,
  kind,
  ghost = false,
}: {
  x: number;
  y: number;
  size: number;
  kind: PieceKind;
  ghost?: boolean;
}) {
  const color = blockColors[kind];
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: x * size + 1,
        top: y * size + 1,
        width: size - 2,
        height: size - 2,
        borderRadius: Math.max(2, size * 0.16),
        backgroundColor: ghost ? `${color}10` : color,
        borderWidth: ghost ? 1.5 : 1,
        borderColor: ghost ? `${color}88` : '#FFFFFF55',
        borderBottomColor: ghost ? `${color}88` : '#00000035',
      }}
    >
      {!ghost && size >= 17 ? (
        <Image
          source={assets.logo}
          contentFit="cover"
          style={{
            position: 'absolute',
            width: size * 0.72,
            height: size * 0.72,
            left: size * 0.09,
            top: size * 0.09,
            opacity: 0.3,
          }}
        />
      ) : null}
      {!ghost && size >= 14 ? (
        <View
          style={{
            position: 'absolute',
            top: 1,
            left: 1,
            right: 1,
            height: Math.max(2, size * 0.28),
            borderRadius: 2,
            backgroundColor: '#FFFFFF25',
          }}
        />
      ) : null}
    </View>
  );
});

const illustration: [number, number, PieceKind][] = [
  [0, 5, 'T'],
  [1, 5, 'T'],
  [2, 5, 'T'],
  [1, 4, 'T'],
  [3, 5, 'I'],
  [4, 5, 'I'],
  [5, 5, 'I'],
  [6, 5, 'I'],
  [4, 4, 'O'],
  [5, 4, 'O'],
  [4, 3, 'O'],
  [5, 3, 'O'],
  [2, 4, 'L'],
  [3, 4, 'L'],
  [3, 3, 'L'],
  [3, 2, 'L'],
  [5, 0, 'S'],
  [6, 0, 'S'],
  [4, 1, 'S'],
  [5, 1, 'S'],
];
export function BlockArt({ size = 27 }: { size?: number }) {
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size * 7, height: size * 6 }}
    >
      {illustration.map(([x, y, kind], i) => (
        <Tile key={i} x={x} y={y} size={size} kind={kind} />
      ))}
    </View>
  );
}

export function PickBlocksCard() {
  const router = useRouter();
  return (
    <GamePosterCard
      name="PICK BLOCKS"
      subtitle="СОБИРАЙ СВОЙ ПИК"
      description={'Заполняй ряды.\nВсё сложится.'}
      testID="pick-blocks-open"
      onPress={() => router.push('/games/pick-blocks')}
      cover={assets.pickBlocksCover}
    />
  );
}
