import type { ReactNode } from 'react';
import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { assets } from '../assets';
import { colors, font } from '../theme';
import { Icon, Logo } from '../components/UI';

export function useGameCardHeight() {
  const { fontScale } = useWindowDimensions();
  return Math.ceil(212 * Math.max(1, fontScale));
}

export function ArcadeCard({
  name,
  subtitle,
  description,
  art,
  onPress,
  testID,
}: {
  name: string;
  subtitle: string;
  description: string;
  art: ReactNode;
  onPress(): void;
  testID: string;
}) {
  const height = useGameCardHeight();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`Играть в ${name}. ${description}`}
      onPress={onPress}
      style={({ pressed }) => [s.card, { height }, pressed && { opacity: 0.88 }]}
    >
      <Image
        source={assets.blue}
        contentFit="cover"
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={s.tint} pointerEvents="none" />
      <View style={s.logo}>
        <Logo size={30} />
      </View>
      <Text style={s.tag}>{subtitle}</Text>
      <View style={s.middle}>
        <View style={s.copy}>
          <Text testID={`${testID}-title`} style={s.title}>
            {name.replace(' ', '\n')}
          </Text>
          <Text style={s.description}>{description}</Text>
        </View>
        <View
          pointerEvents="none"
          style={s.art}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {art}
        </View>
      </View>
      <View style={s.bottom}>
        <View style={s.play}>
          <Text style={s.playText}>Играть</Text>
          <Icon name="arrow-forward" color="#241208" size={19} />
        </View>
        <Text style={s.note}>Твой пик. Твой рекорд.</Text>
      </View>
    </Pressable>
  );
}
const s = StyleSheet.create({
  card: {
    marginTop: 12,
    padding: 16,
    borderRadius: 26,
    overflow: 'hidden',
    backgroundColor: '#0047BB',
    borderWidth: 1,
    borderColor: '#5286DC60',
  },
  tint: { ...StyleSheet.absoluteFill, backgroundColor: '#003485BA' },
  logo: { position: 'absolute', top: 12, right: 14 },
  tag: {
    fontFamily: font.bold,
    fontSize: 9,
    lineHeight: 14,
    letterSpacing: 0.8,
    color: '#E6EEFF',
    paddingRight: 40,
  },
  middle: { flex: 1, flexDirection: 'row', marginTop: 4, alignItems: 'center' },
  copy: { flex: 1, zIndex: 1 },
  title: {
    fontFamily: font.display,
    fontSize: 24,
    lineHeight: 36,
    letterSpacing: -0.7,
    color: '#FFFFFF',
  },
  description: {
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 16,
    color: '#D6E5FF',
    marginTop: 2,
  },
  art: {
    width: '38%',
    height: 100,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ scale: 0.75 }],
  },
  bottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 8,
  },
  play: {
    minHeight: 48,
    borderRadius: 15,
    paddingHorizontal: 18,
    backgroundColor: colors.accent,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
  },
  playText: { fontFamily: font.display, fontSize: 17, color: '#241208' },
  note: {
    flexShrink: 1,
    maxWidth: 120,
    textAlign: 'right',
    fontFamily: font.medium,
    fontSize: 10,
    lineHeight: 16,
    color: '#D6E5FF',
  },
});
