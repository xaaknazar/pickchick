import { memo } from 'react';
import { useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { assets } from '../../assets';
import { colors, font } from '../../theme';
import { Icon } from '../../components/UI';
import type { PieceKind } from './engine';

export const blockColors: Record<PieceKind, string> = {
  I: '#EAF1FF',
  O: '#FF8A45',
  T: '#5D91FF',
  S: '#76D7C4',
  Z: '#F16951',
  J: '#B0A5FF',
  L: '#FFD173',
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

const posterGradient = 'linear-gradient(135deg, #125BCB 0%, #07377F 54%, #102653 100%)';
const gradientStyle = (
  Platform.OS === 'web'
    ? { backgroundImage: posterGradient }
    : { experimental_backgroundImage: posterGradient }
) as ViewStyle;
export function PickBlocksCard() {
  const router = useRouter();
  return (
    <Pressable
      testID="pick-blocks-open"
      accessibilityRole="button"
      accessibilityLabel="Играть в Pick Blocks. Собирайте ряды и ставьте личный рекорд"
      onPress={() => router.push('/games/pick-blocks')}
      style={({ pressed }) => [
        s.card,
        gradientStyle,
        pressed && { opacity: 0.9, transform: [{ scale: 0.99 }] },
      ]}
    >
      <Image
        source={assets.skyline}
        contentFit="cover"
        pointerEvents="none"
        style={s.skyline}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
      <View pointerEvents="none" style={s.art}>
        <BlockArt />
      </View>
      <View style={s.cardContent}>
        <View style={s.tag}>
          <View style={s.tagDot} />
          <Text style={s.tagText}>НОВАЯ ИГРА</Text>
        </View>
        <Text style={s.title}>
          PICK{`\n`}
          <Text style={s.titleAccent}>BLOCKS</Text>
        </Text>
        <Text style={s.description}>Собирай ряды.{`\n`}Побей свой рекорд.</Text>
        <View style={s.cardBottom}>
          <View style={s.play}>
            <Text style={s.playLabel}>Играть</Text>
            <Icon name="arrow-forward" size={19} color={colors.orangeInk} />
          </View>
          <Text style={s.offline}>Без интернета</Text>
        </View>
      </View>
    </Pressable>
  );
}
const s = StyleSheet.create({
  card: {
    marginTop: 20,
    minHeight: 270,
    borderRadius: 28,
    overflow: 'hidden',
    backgroundColor: '#104596',
    borderWidth: 1,
    borderColor: '#6597E94D',
  },
  cardContent: { padding: 22 },
  skyline: { position: 'absolute', left: 0, right: 0, bottom: -4, height: 120, opacity: 0.13 },
  art: {
    position: 'absolute',
    right: -20,
    top: 44,
    transform: [{ rotate: '-12deg' }],
    opacity: 0.94,
  },
  tag: {
    flexDirection: 'row',
    gap: 7,
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 20,
    backgroundColor: '#FFFFFF16',
  },
  tagDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: '#FFBE8E' },
  tagText: {
    fontFamily: font.bold,
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 1.1,
    color: '#EAF1FF',
  },
  title: {
    fontFamily: font.display,
    fontSize: 39,
    lineHeight: 39,
    letterSpacing: -1.2,
    color: '#FFFFFF',
    marginTop: 16,
  },
  titleAccent: { color: '#FFC497' },
  description: {
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 21,
    color: '#DEE9FF',
    marginTop: 10,
  },
  cardBottom: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
    marginTop: 22,
    justifyContent: 'space-between',
  },
  play: {
    minHeight: 48,
    paddingHorizontal: 19,
    gap: 16,
    borderRadius: 16,
    backgroundColor: '#FFB57F',
    alignItems: 'center',
    flexDirection: 'row',
  },
  playLabel: { fontFamily: font.display, fontSize: 17, color: colors.orangeInk },
  offline: { fontFamily: font.medium, fontSize: 11, lineHeight: 17, color: '#CBDEFF' },
});
