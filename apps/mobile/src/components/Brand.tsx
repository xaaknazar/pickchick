import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';
import { assets } from '../assets';
import { colors, font } from '../theme';
import { Body, Caption, Heading, Icon, IconButton, Row, styles as ui } from './UI';

export function HeroVideo() {
  const [reduced, setReduced] = useState(true);
  const [playing, setPlaying] = useState(true);
  const player = useVideoPlayer(assets.hero, (video) => {
    video.loop = true;
    video.muted = true;
  });
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (mounted) setReduced(value);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  useFocusEffect(
    useCallback(() => {
      if (!reduced && playing) player.play();
      else player.pause();
      return () => player.pause();
    }, [player, reduced, playing]),
  );
  return (
    <>
      <Image
        source={assets.poster}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
      {!reduced ? (
        <VideoView
          player={player}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          nativeControls={false}
          accessible={false}
        />
      ) : null}
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: '#03102630' }]}
      />
      <View pointerEvents="none" style={brand.heroShadeTop} />
      <View pointerEvents="none" style={brand.heroShadeBottom} />
      {!reduced ? (
        <IconButton
          name={playing ? 'pause' : 'play'}
          label={playing ? 'Остановить фоновое видео' : 'Включить фоновое видео'}
          testID="hero-video-toggle"
          onPress={() => setPlaying(!playing)}
          style={brand.videoControl}
        />
      ) : null}
    </>
  );
}
export function LoyaltyCard({ preview, onPress }: { preview: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Открыть мои Чики"
      style={({ pressed }) => [brand.loyalty, pressed && ui.pressed]}
    >
      <View style={brand.skyline} pointerEvents="none">
        {[28, 42, 22, 62, 36, 48, 23, 72, 43, 55, 31, 61].map((height, index) => (
          <View key={index} style={[brand.building, { height }]} />
        ))}
      </View>
      <View style={brand.ring}>
        <Body style={{ fontFamily: font.bold, fontSize: 14 }}>{preview ? '66%' : 'Ч'}</Body>
      </View>
      <View style={ui.flex}>
        <Heading small style={{ fontSize: 21 }}>
          {preview ? 'Пик-мастер' : 'Твой следующий пик'}
        </Heading>
        <Caption style={{ color: '#D6E3FA', marginTop: 3 }}>
          {preview ? '1 240 Чиков · пример баланса' : 'Чики, награды и любимый вкус'}
        </Caption>
      </View>
      <Icon name="chevron-forward" size={20} />
    </Pressable>
  );
}
export function FeatureTile({
  title,
  subtitle,
  icon,
  onPress,
  orange = false,
}: {
  title: string;
  subtitle: string;
  icon: 'qr-code-outline' | 'star-outline' | 'receipt-outline' | 'gift-outline';
  onPress: () => void;
  orange?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        brand.tile,
        orange && { backgroundColor: '#432C25' },
        pressed && ui.pressed,
      ]}
    >
      <Icon name={icon} color={orange ? colors.accent : '#92BCFF'} size={30} />
      <Heading small style={{ fontSize: 20, marginTop: 14 }}>
        {title}
      </Heading>
      <Caption>{subtitle}</Caption>
    </Pressable>
  );
}
export function DiningSelector({
  value,
  onChange,
}: {
  value: 'takeaway' | 'dine_in';
  onChange: (value: 'takeaway' | 'dine_in') => void;
}) {
  return (
    <Row style={brand.segment}>
      {(
        [
          { value: 'takeaway', label: 'Заберу сам' },
          { value: 'dine_in', label: 'В зале' },
        ] as const
      ).map((option) => (
        <Pressable
          key={option.value}
          testID={`dining-${option.value}`}
          accessibilityRole="radio"
          accessibilityState={{ selected: value === option.value }}
          onPress={() => onChange(option.value)}
          style={({ pressed }) => [
            brand.segmentItem,
            value === option.value && brand.segmentSelected,
            pressed && ui.pressed,
          ]}
        >
          <Body style={{ fontFamily: font.bold, fontSize: 14 }}>{option.label}</Body>
        </Pressable>
      ))}
    </Row>
  );
}
const brand = StyleSheet.create({
  heroShadeTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 185,
    backgroundColor: '#03112670',
  },
  heroShadeBottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 165,
    backgroundColor: '#03112665',
  },
  videoControl: { position: 'absolute', bottom: 49, right: 18, backgroundColor: '#04143A99' },
  loyalty: {
    position: 'relative',
    minHeight: 108,
    borderRadius: 22,
    padding: 17,
    backgroundColor: '#0B2B61',
    borderWidth: 1,
    borderColor: '#315181',
    overflow: 'hidden',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
  },
  skyline: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    opacity: 0.45,
  },
  building: {
    width: 23,
    backgroundColor: '#18447E',
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
  },
  ring: {
    width: 58,
    height: 58,
    borderRadius: 29,
    borderWidth: 5,
    borderColor: colors.accent,
    borderRightColor: '#305183',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  tile: {
    flex: 1,
    minHeight: 159,
    borderRadius: 20,
    padding: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 5,
  },
  segment: { backgroundColor: '#071C3BAA', padding: 5, borderRadius: 17, gap: 5 },
  segmentItem: {
    minHeight: 48,
    borderRadius: 12,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  segmentSelected: { backgroundColor: '#FFFFFF25', borderWidth: 1, borderColor: '#FFFFFF50' },
});
