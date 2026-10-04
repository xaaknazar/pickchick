import { memo } from 'react';
import { useRouter } from 'expo-router';
import { Image as NativeImage, Pressable, Text } from 'react-native';
import { Icon } from '../../components/UI';
import { font } from '../../theme';
import { useGameCardHeight } from '../ArcadeCard';
import { Image } from 'expo-image';
import { View } from 'react-native';
import type { CropId } from '@pickchick/farm-game';

// Static require calls let Metro bundle every asset for offline rendering.
const sprites = {
  grass: require('../../../assets/games/pick-farm/grass.png'),
  path: require('../../../assets/games/pick-farm/path.png'),
  soil: require('../../../assets/games/pick-farm/soil.png'),
  sprouts: require('../../../assets/games/pick-farm/sprouts.png'),
  roof: require('../../../assets/games/pick-farm/roof.png'),
  wall: require('../../../assets/games/pick-farm/wall.png'),
  door: require('../../../assets/games/pick-farm/door.png'),
  fence: require('../../../assets/games/pick-farm/fence.png'),
  fenceSide: require('../../../assets/games/pick-farm/fence-side.png'),
  hay: require('../../../assets/games/pick-farm/hay.png'),
};
const bounds = {
  grass: [38, 389, 218, 493],
  path: [38, 395, 218, 493],
  soil: [0, 373, 256, 512],
  sprouts: [26, 377, 219, 490],
  roof: [0, 242, 256, 512],
  wall: [115, 278, 256, 512],
  door: [0, 277, 141, 512],
  fence: [0, 377, 134, 512],
  fenceSide: [115, 377, 256, 512],
  hay: [15, 350, 211, 489],
} as const;
export const Sprite = memo(function Sprite({
  kind,
  x,
  y,
  width = 92,
}: {
  kind: keyof typeof sprites;
  x: number;
  y: number;
  width?: number;
}) {
  const [left, top, right, bottom] = bounds[kind];
  const scale = width / (right - left);
  return (
    <Image
      source={sprites[kind]}
      pointerEvents="none"
      accessible={false}
      style={{
        position: 'absolute',
        left: x - width / 2 - left * scale,
        top: y - (bottom - top) * scale - top * scale,
        width: 256 * scale,
        height: 512 * scale,
      }}
    />
  );
});
// Original generated atlas stays intact; each native view clips one sprite region.
const cropAtlas = require('../../../assets/games/pick-farm/crops-generated.png');
const cropBounds: Record<CropId, readonly [number, number, number, number]> = {
  carrot: [0, 65, 432, 578],
  tomato: [432, 65, 828, 580],
  strawberry: [829, 197, 1254, 579],
  sunflower: [0, 600, 434, 1160],
  tulip: [432, 628, 815, 1160],
  apple: [816, 618, 1254, 1165],
};
export const CropArt = memo(function CropArt({
  cropId,
  size = 44,
  phase = 'ready',
}: {
  cropId: CropId;
  size?: number;
  phase?: 'growing' | 'ready' | 'withered';
}) {
  const [left, top, right, bottom] = cropBounds[cropId];
  const scale = size / Math.max(right - left, bottom - top);
  return (
    <View
      pointerEvents="none"
      accessible={false}
      style={{
        width: size,
        height: size,
        opacity: phase === 'withered' ? 0.5 : 1,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <View
        style={{
          width: (right - left) * scale,
          height: (bottom - top) * scale,
          overflow: 'hidden',
        }}
      >
        <NativeImage
          source={cropAtlas}
          resizeMode="stretch"
          accessible={false}
          style={{
            position: 'absolute',
            width: 1254 * scale,
            height: 1254 * scale,
            left: -left * scale,
            top: -top * scale,
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
      <Sprite kind="door" x={house.x - 26} y={house.y} width={58} />
      <Sprite kind="wall" x={house.x + 29} y={house.y} width={58} />
      <Sprite kind="roof" x={house.x} y={house.y - 25} width={112} />
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
        source={require('../../../assets/games/pick-farm/cover-generated.png')}
        contentFit="cover"
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
