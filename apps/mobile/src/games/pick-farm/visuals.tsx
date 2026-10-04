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
}: {
  cropId: CropId;
  size?: number;
}) {
  const [left, top, right, bottom] = cropBounds[cropId];
  const scale = size / Math.max(right - left, bottom - top);
  return (
    <View
      pointerEvents="none"
      accessible={false}
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
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
  return { x: 450 + (col - row) * 46, y: 90 + (col + row) * 23 };
}
export const Landscape = memo(function Landscape() {
  const tiles = Array.from({ length: 81 }, (_, i) => ({ col: i % 9, row: Math.floor(i / 9) }));
  return (
    <View pointerEvents="none" style={{ position: 'absolute', width: 900, height: 600 }}>
      {tiles
        .sort((a, b) => a.col + a.row - b.col - b.row)
        .map(({ col, row }) => {
          const p = isoPoint(col, row);
          return (
            <Sprite key={`${col}-${row}`} kind={col === 7 || row === 1 ? 'path' : 'grass'} {...p} />
          );
        })}
      {Array.from({ length: 7 }, (_, i) => {
        const p = isoPoint(i + 1, 8);
        return <Sprite key={`f-${i}`} kind="fence" x={p.x - 22} y={p.y + 9} width={48} />;
      })}
      {Array.from({ length: 7 }, (_, i) => {
        const p = isoPoint(8, i + 1);
        return <Sprite key={`s-${i}`} kind="fenceSide" x={p.x + 22} y={p.y + 9} width={48} />;
      })}
      <Sprite kind="door" x={485} y={133} width={58} />
      <Sprite kind="wall" x={540} y={133} width={58} />
      <Sprite kind="roof" x={512} y={108} width={112} />
      <Sprite kind="hay" x={610} y={204} width={65} />
      <Sprite kind="hay" x={627} y={222} width={48} />
      {[
        { x: 220, y: 244 },
        { x: 274, y: 326 },
        { x: 698, y: 299 },
        { x: 600, y: 421 },
      ].map((p, i) => (
        <View key={`tree-${i}`} style={{ position: 'absolute', left: p.x - 37, top: p.y - 75 }}>
          <CropArt cropId="apple" size={74} />
        </View>
      ))}
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
