import { memo } from 'react';
import { Image, View } from 'react-native';

export const GARDEN_ART_IDS = [
  'path',
  'fence',
  'flowerpot',
  'bench',
  'lantern',
  'birdhouse',
  'fountain',
  'arch',
  'pond',
  'picnic',
  'statue',
  'gazebo',
  'kitchen',
  'florist',
  'mint',
  'sunshine',
] as const;
export type GardenArtId = (typeof GARDEN_ART_IDS)[number];

// Measured sprite rectangles in the 1254×1254 source, excluding neighbouring-cell spill.
export const GARDEN_ART_BOUNDS: Record<GardenArtId, readonly [number, number, number, number]> = {
  path: [20, 70, 320, 290],
  fence: [345, 50, 625, 294],
  flowerpot: [678, 22, 883, 298],
  bench: [936, 45, 1227, 311],
  lantern: [76, 316, 267, 626],
  birdhouse: [393, 315, 550, 626],
  fountain: [624, 336, 928, 612],
  arch: [950, 308, 1230, 629],
  pond: [17, 650, 320, 907],
  picnic: [328, 651, 637, 912],
  statue: [658, 645, 884, 918],
  gazebo: [942, 626, 1226, 927],
  kitchen: [20, 927, 323, 1217],
  florist: [345, 924, 633, 1225],
  mint: [651, 945, 915, 1221],
  sunshine: [966, 945, 1229, 1231],
};
/** Intact original atlas. Artwork fits without distortion and rests on the local bottom anchor. */
export const GardenArt = memo(function GardenArt({
  id,
  size = 92,
}: {
  id: GardenArtId;
  size?: number;
}) {
  const bounds = GARDEN_ART_BOUNDS[id];
  if (!bounds) return null;
  const [left, top, right, bottom] = bounds;
  const scale = size / Math.max(right - left, bottom - top);
  const width = (right - left) * scale,
    height = (bottom - top) * scale;
  return (
    <View
      pointerEvents="none"
      accessible={false}
      style={{ width: size, height: size, position: 'relative', flexShrink: 0 }}
    >
      <View
        style={{
          position: 'absolute',
          left: (size - width) / 2,
          bottom: 0,
          width,
          height,
          overflow: 'hidden',
        }}
      >
        <Image
          source={require('../../../assets/games/pick-farm/garden-atlas-v1.png')}
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
