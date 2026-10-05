import { memo } from 'react';
import { useRouter } from 'expo-router';
import { Image as NativeImage, Pressable, Text } from 'react-native';
import { Icon } from '../../components/UI';
import { font } from '../../theme';
import { useGameCardHeight } from '../ArcadeCard';
import { Image } from 'expo-image';
import { View } from 'react-native';
import { PLANTING_BOUNDS, HOUSE_DISPLAY_CELL, type CropId } from '@pickchick/farm-game';
import { isoPoint } from './geometry';
export { isoPoint, cellAtPoint } from './geometry';

// Generated atlases remain intact. Each view clips its own source rectangle.
const propsAtlas = require('../../../assets/games/pick-farm/props-painted-v2.png');
const plantsAtlas = require('../../../assets/games/pick-farm/plants-painted-v2.png');
const propBounds = {
  house: [10, 16, 677, 668],
  soil: [741, 235, 1429, 623],
  sprouts: [1473, 235, 2157, 622],
} as const;
export const Sprite = memo(function Sprite({
  kind,
  x,
  y,
  width = 92,
}: {
  kind: keyof typeof propBounds;
  x: number;
  y: number;
  width?: number;
}) {
  const [left, top, right, bottom] = propBounds[kind];
  const scale = width / (right - left);
  const height = (bottom - top) * scale;
  return (
    <View
      pointerEvents="none"
      accessible={false}
      style={{
        position: 'absolute',
        left: x - width / 2,
        top: y - height,
        width,
        height,
        overflow: 'hidden',
      }}
    >
      <NativeImage
        source={propsAtlas}
        resizeMode="stretch"
        accessible={false}
        style={{
          position: 'absolute',
          left: -left * scale,
          top: -top * scale,
          width: 2172 * scale,
          height: 724 * scale,
        }}
      />
    </View>
  );
});
const cropColumn: Record<CropId, number> = {
  carrot: 0,
  tomato: 1,
  strawberry: 2,
  sunflower: 3,
  tulip: 4,
  apple: 5,
};
export const CropArt = memo(function CropArt({
  cropId,
  size = 64,
  phase = 'ready',
}: {
  cropId: CropId;
  size?: number;
  phase?: 'growing' | 'ready' | 'withered';
}) {
  const row = phase === 'growing' ? 0 : phase === 'withered' ? 2 : 1;
  const left = cropColumn[cropId] * 256 + 4;
  const top = row * (1024 / 3) + 3;
  const spriteWidth = 248,
    spriteHeight = 1024 / 3 - 6;
  const scale = size / spriteHeight;
  return (
    <View
      pointerEvents="none"
      accessible={false}
      style={{ width: size, height: size, flexShrink: 0, position: 'relative' }}
    >
      <View
        style={{
          position: 'absolute',
          left: (size - spriteWidth * scale) / 2,
          top: 0,
          width: spriteWidth * scale,
          height: size,
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        <NativeImage
          source={plantsAtlas}
          resizeMode="stretch"
          accessible={false}
          style={{
            position: 'absolute',
            left: -left * scale,
            top: -top * scale,
            width: 1536 * scale,
            height: 1024 * scale,
          }}
        />
      </View>
    </View>
  );
});

export function CellOutline({ x, y, color = '#FFF9EA' }: { x: number; y: number; color?: string }) {
  const corners = [
    [-48, 0],
    [0, -24],
    [48, 0],
    [0, 24],
  ] as const;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: x, top: y }}>
      {corners.map((a, i) => {
        const b = corners[(i + 1) % 4]!;
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        return (
          <View
            key={i}
            style={{
              position: 'absolute',
              left: (a[0] + b[0]) / 2 - length / 2,
              top: (a[1] + b[1]) / 2 - 1.5,
              width: length,
              height: 3,
              backgroundColor: color,
              transform: [{ rotate: `${Math.atan2(b[1] - a[1], b[0] - a[0])}rad` }],
            }}
          />
        );
      })}
    </View>
  );
}

export const Landscape = memo(function Landscape({ grid = false }: { grid?: boolean }) {
  const { minX, minY, maxX, maxY } = PLANTING_BOUNDS;
  const house = isoPoint(HOUSE_DISPLAY_CELL.x, HOUSE_DISPLAY_CELL.y);
  const lines: { x: number; y: number; length: number; angle: string; edge: boolean }[] = [];
  const add = (a: { x: number; y: number }, b: { x: number; y: number }, edge: boolean) => {
    lines.push({
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      length: Math.hypot(b.x - a.x, b.y - a.y),
      angle: `${Math.atan2(b.y - a.y, b.x - a.x)}rad`,
      edge,
    });
  };
  for (let x = minX; x <= maxX + 1; x++) {
    const edge = x === minX || x === maxX + 1;
    if (grid || edge) add(isoPoint(x - 0.5, minY - 0.5), isoPoint(x - 0.5, maxY + 0.5), edge);
  }
  for (let y = minY; y <= maxY + 1; y++) {
    const edge = y === minY || y === maxY + 1;
    if (grid || edge) add(isoPoint(minX - 0.5, y - 0.5), isoPoint(maxX + 0.5, y - 0.5), edge);
  }
  return (
    <View pointerEvents="none" style={{ position: 'absolute', width: 900, height: 600 }}>
      {lines.map((line, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: line.x - line.length / 2,
            top: line.y,
            width: line.length,
            height: line.edge ? 12 : 2,
            backgroundColor: line.edge ? '#EAD6A0' : '#F7FFDC55',
            transform: [{ rotate: line.angle }],
          }}
        />
      ))}
      <View testID="pick-farm-house" style={{ position: 'absolute', left: house.x, top: house.y }}>
        <Sprite kind="house" x={0} y={0} width={240} />
      </View>
    </View>
  );
});

export function PickFarmCard() {
  const router = useRouter();
  const height = useGameCardHeight();
  return (
    <Pressable
      testID="pick-farm-open"
      accessibilityRole="button"
      accessibilityLabel="Играть в PICK FARM. Вырастите свою маленькую ферму."
      onPress={() => router.push('/games/pick-farm')}
      style={({ pressed }) => ({
        height,
        marginTop: 12,
        borderRadius: 26,
        overflow: 'hidden',
        backgroundColor: '#B6D49B',
        opacity: pressed ? 0.88 : 1,
      })}
    >
      <Image
        source={require('../../../assets/games/pick-farm/cover-alex.png')}
        contentFit="cover"
        contentPosition={{ left: '75%', top: '35%' }}
        accessible={false}
        pointerEvents="none"
        style={{ position: 'absolute', width: '100%', height: '100%' }}
      />
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          padding: 18,
          backgroundColor: '#18332CEB',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: font.display, fontSize: 26, color: '#FFFFFF' }}>
            PICK FARM
          </Text>
          <Text style={{ fontFamily: font.medium, fontSize: 12, lineHeight: 18, color: '#EDF4D9' }}>
            Семена, урожай и ваша маленькая ферма.
          </Text>
        </View>
        <View
          style={{
            width: 52,
            height: 52,
            borderRadius: 26,
            backgroundColor: '#FF6900',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="play" size={25} color="#FFFFFF" />
        </View>
      </View>
    </Pressable>
  );
}
