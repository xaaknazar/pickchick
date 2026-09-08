import type { ReactNode } from 'react';
import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { assets } from '../assets';
import { font } from '../theme';
import { Icon, Logo } from '../components/UI';

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
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`Играть в ${name}. ${description}`}
      onPress={onPress}
      style={({ pressed }) => [s.card, pressed && { opacity: 0.88 }]}
    >
      <Image
        source={assets.blue}
        contentFit="cover"
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={s.tint} pointerEvents="none" />
      <View style={s.top}>
        <Logo size={38} />
        <Text style={s.tag}>{subtitle}</Text>
      </View>
      <View style={s.middle}>
        <View style={s.copy}>
          <Text style={s.title}>{name.replace(' ', '\n')}</Text>
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
    padding: 20,
    borderRadius: 26,
    overflow: 'hidden',
    backgroundColor: '#0047BB',
    borderWidth: 1,
    borderColor: '#5286DC60',
  },
  tint: { ...StyleSheet.absoluteFill, backgroundColor: '#003485BA' },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  tag: { fontFamily: font.bold, fontSize: 10, letterSpacing: 1.1, color: '#E6EEFF' },
  middle: { flexDirection: 'row', minHeight: 165, marginTop: 16, alignItems: 'center' },
  copy: { flex: 1, zIndex: 1 },
  title: {
    fontFamily: font.display,
    fontSize: 34,
    lineHeight: 34,
    letterSpacing: -0.7,
    color: '#FFFFFF',
  },
  description: {
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 18,
    color: '#D6E5FF',
    marginTop: 12,
    maxWidth: 155,
  },
  art: { width: '42%', height: 155, alignItems: 'center', justifyContent: 'center' },
  bottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 12,
  },
  play: {
    minHeight: 48,
    borderRadius: 15,
    paddingHorizontal: 18,
    backgroundColor: '#FF7A3D',
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
