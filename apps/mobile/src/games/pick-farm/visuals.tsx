import { memo } from 'react';
import { useRouter } from 'expo-router';
import { Image as NativeImage, Pressable, Text } from 'react-native';
import { Icon } from '../../components/UI';
import { font } from '../../theme';
import { useGameCardHeight } from '../ArcadeCard';
import { Image } from 'expo-image';
import { View } from 'react-native';
import type { CropId } from '@pickchick/farm-game';

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

export function isoPoint(col: number, row: number) {
  return { x: 450 + (col - 32 - (row - 28)) * 48, y: 230 + (col - 32 + (row - 28)) * 24 };
}
export function cellAtPoint(px: number, py: number) {
  return {
    x: Math.round(32 + (px - 450) / 96 + (py - 230) / 48),
    y: Math.round(28 - (px - 450) / 96 + (py - 230) / 48),
  };
}
export const Landscape = memo(function Landscape({
  grid = false,
  cell = { x: 32, y: 30 },
}: {
  grid?: boolean;
  cell?: { x: number; y: number };
}) {
  const house = isoPoint(32, 28);
  const lines: { x: number; y: number; length: number; angle: string }[] = [];
  if (grid) {
    const minX = Math.max(0, cell.x - 8),
      maxX = Math.min(64, cell.x + 9);
    const minY = Math.max(0, cell.y - 8),
      maxY = Math.min(64, cell.y + 9);
    for (let x = minX; x <= maxX; x++) {
      const a = isoPoint(x - 0.5, minY - 0.5),
        b = isoPoint(x - 0.5, maxY - 0.5);
      lines.push({
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
        length: Math.hypot(b.x - a.x, b.y - a.y),
        angle: `${Math.atan2(b.y - a.y, b.x - a.x)}rad`,
      });
    }
    for (let y = minY; y <= maxY; y++) {
      const a = isoPoint(minX - 0.5, y - 0.5),
        b = isoPoint(maxX - 0.5, y - 0.5);
      lines.push({
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
        length: Math.hypot(b.x - a.x, b.y - a.y),
        angle: `${Math.atan2(b.y - a.y, b.x - a.x)}rad`,
      });
    }
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
            height: 1,
            backgroundColor: '#F7FFDC80',
            transform: [{ rotate: line.angle }],
          }}
        />
      ))}
      <Sprite kind="house" x={house.x} y={house.y + 6} width={160} />
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
