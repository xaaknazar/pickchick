import { GardenArt } from './GardenArt';
import { memo } from 'react';
import { useRouter } from 'expo-router';
import { Image as NativeImage, Pressable, Text } from 'react-native';
import { Icon } from '../../components/UI';
import { font } from '../../theme';
import { useGameCardHeight } from '../ArcadeCard';
import { Image } from 'expo-image';
import { View } from 'react-native';
import { PLANTING_BOUNDS, HOUSE_DISPLAY_CELL, type CropId } from '@pickchick/farm-game';
import { isoPoint, GROUND_TRANSFORM, TILE_WIDTH, GRASS_CELLS } from './geometry';
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

/** Soil and selection use the same projected square, not separate rotated line segments. */
export const SoilTile = memo(function SoilTile({
  x,
  y,
  size = TILE_WIDTH,
}: {
  x: number;
  y: number;
  size?: number;
}) {
  const frame = {
    position: 'absolute' as const,
    left: x - size / 2,
    top: y - size / 2,
    width: size,
    height: size,
    borderRadius: 3,
    transform: GROUND_TRANSFORM,
  };
  return (
    <View pointerEvents="none" accessible={false}>
      <View style={[frame, { top: y - size / 2 + size * 0.025, backgroundColor: '#694328' }]} />
      <View style={[frame, { overflow: 'hidden', backgroundColor: '#986239' }]}>
        <NativeImage
          source={require('../../../assets/games/pick-farm/soil-texture-v3.png')}
          resizeMode="cover"
          accessible={false}
          style={{ width: '100%', height: '100%' }}
        />
        <View
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 3,
            borderWidth: 1.5,
            borderColor: '#B78350',
          }}
        />
      </View>
    </View>
  );
});

export function CellOutline({
  x,
  y,
  color = '#FFF3CF',
  size = TILE_WIDTH,
}: {
  x: number;
  y: number;
  color?: string;
  size?: number;
}) {
  return (
    <View
      testID="pick-farm-cell-outline"
      pointerEvents="none"
      accessible={false}
      style={{
        position: 'absolute',
        left: x - size / 2,
        top: y - size / 2,
        width: size,
        height: size,
        borderRadius: 3,
        borderWidth: 3,
        borderColor: color,
        transform: GROUND_TRANSFORM,
      }}
    />
  );
}

const GRASS_BLOCK = 8;
const grassBlock = require('../../../assets/games/pick-farm/grass-block.png');
/**
 * Ground made of one generated grass cell repeated everywhere. The plane is drawn as
 * square blocks (8x8 cells each) and projected with the same transform as the soil, so
 * every grass square lands exactly on one field cell. Centered on cell (31.5, 31.5).
 */
export const GrassGround = memo(function GrassGround() {
  const side = GRASS_CELLS * TILE_WIDTH;
  const center = isoPoint(31.5, 31.5);
  const blocks = GRASS_CELLS / GRASS_BLOCK;
  const block = GRASS_BLOCK * TILE_WIDTH;
  return (
    <View
      pointerEvents="none"
      accessible={false}
      testID="pick-farm-grass"
      style={{
        position: 'absolute',
        left: center.x - side / 2,
        top: center.y - side / 2,
        width: side,
        height: side,
        transform: GROUND_TRANSFORM,
      }}
    >
      {Array.from({ length: blocks * blocks }, (_, i) => (
        <NativeImage
          key={i}
          source={grassBlock}
          resizeMode="stretch"
          accessible={false}
          style={{
            position: 'absolute',
            // A hair of overlap hides seams from sub-pixel rounding after the transform.
            left: (i % blocks) * block - 0.5,
            top: Math.floor(i / blocks) * block - 0.5,
            width: block + 1,
            height: block + 1,
          }}
        />
      ))}
    </View>
  );
});

export const Landscape = memo(function Landscape({
  grid = false,
  houseStyle = 'classic',
}: {
  grid?: boolean;
  houseStyle?: 'classic' | 'mint' | 'sunshine';
}) {
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
        {houseStyle !== 'classic' && (
          <View style={{ position: 'absolute', left: 30, top: -45 }}>
            <GardenArt id={houseStyle} size={100} />
          </View>
        )}
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
        backgroundColor: 'transparent',
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
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text
            style={{
              fontFamily: font.display,
              fontSize: 26,
              color: '#FFFFFF',
              textShadowColor: '#000000CC',
              textShadowOffset: { width: 0, height: 1 },
              textShadowRadius: 4,
            }}
          >
            PICK FARM
          </Text>
          <Text
            style={{
              fontFamily: font.medium,
              fontSize: 12,
              lineHeight: 18,
              color: '#FFFFFF',
              textShadowColor: '#000000',
              textShadowOffset: { width: 0, height: 1 },
              textShadowRadius: 3,
            }}
          >
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
