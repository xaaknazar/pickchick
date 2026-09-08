import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import {
  AccessibilityInfo,
  AppState,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import { assets } from '../assets';
import { WebHeroVideo } from './WebHeroVideo';
import { colors, font } from '../theme';
import { Body, Caption, Heading, Icon, Row, styles as ui } from './UI';

export function HeroVideo({ shaded = true }: { shaded?: boolean }) {
  return Platform.OS === 'web' ? (
    <WebHeroVideo gradient={shaded ? gradient : undefined} />
  ) : (
    <NativeHeroVideo shaded={shaded} />
  );
}
function NativeHeroVideo({ shaded = true }: { shaded?: boolean }) {
  const [reduced, setReduced] = useState(true);
  const [firstFrame, setFirstFrame] = useState(false);
  const [failed, setFailed] = useState(false);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const player = useVideoPlayer(assets.hero, (video) => {
    video.loop = true;
    video.muted = true;
  });
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (mounted) setReduced(value);
    });
    const appState = AppState.addEventListener('change', (state) => setActive(state === 'active'));
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      mounted = false;
      subscription.remove();
      appState.remove();
    };
  }, []);
  useEffect(() => {
    const status = player.addListener('statusChange', ({ status }) => {
      if (status === 'error') setFailed(true);
    });
    return () => status.remove();
  }, [player]);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      // useVideoPlayer releases the native object during unmount. Focus cleanup
      // only changes state; calling pause here would access an already freed player.
      return () => setFocused(false);
    }, []),
  );
  useEffect(() => {
    if (!reduced && active && focused && !failed) player.play();
    else player.pause();
  }, [player, reduced, active, focused, failed]);
  return (
    <>
      <Image
        source={assets.poster}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
      {!reduced && !failed ? (
        <VideoView
          player={player}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          nativeControls={false}
          onFirstFrameRender={() => setFirstFrame(true)}
          accessible={false}
        />
      ) : null}
      {!firstFrame || failed ? (
        <Image
          source={assets.poster}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      ) : null}
      {shaded ? (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, heroGradient]} />
      ) : null}
    </>
  );
}
export function LoyaltyCard({ preview, onPress }: { preview: boolean; onPress: () => void }) {
  const [cardHeight, setCardHeight] = useState(84);
  // Source SVG peak y=44/240 remains 6px above the card at every text size.
  const skylineTop = -(44 * cardHeight + 6 * 240) / (240 - 44);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Открыть мои Чики"
      testID="loyalty-card"
      onLayout={(event) => setCardHeight(event.nativeEvent.layout.height)}
      style={({ pressed }) => [brand.loyalty, pressed && ui.pressed]}
    >
      <Image
        source={assets.skyline}
        testID="loyalty-skyline"
        pointerEvents="none"
        style={[brand.skyline, { top: skylineTop }]}
        contentFit="fill"
        contentPosition="bottom"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
      <View style={brand.ring}>
        <Body style={{ fontFamily: font.display, fontSize: 14, lineHeight: 18 }}>
          {preview ? '66%' : 'Ч'}
        </Body>
      </View>
      <View style={ui.flex}>
        <Heading small style={{ fontSize: 17, lineHeight: 22 }}>
          {preview ? 'Фурманова · пример уровня' : 'Чики за любимый вкус'}
        </Heading>
        <Caption style={{ color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 3 }}>
          {preview ? '6 вершин Алматы · пример пути' : '6 вершин Алматы · скоро'}
        </Caption>
      </View>
      <Icon name="chevron-forward" size={17} color={colors.muted} />
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
          hitSlop={{ top: 4, bottom: 4 }}
          accessibilityRole="radio"
          accessibilityState={{ selected: value === option.value }}
          onPress={() => onChange(option.value)}
          style={({ pressed }) => [
            brand.segmentItem,
            value === option.value && brand.segmentSelected,
            pressed && ui.pressed,
          ]}
        >
          <Body
            style={{
              fontFamily: font.medium,
              fontSize: 13.5,
              lineHeight: 19,
              color: value === option.value ? '#0047BB' : '#FFFFFFDD',
            }}
          >
            {option.label}
          </Body>
        </Pressable>
      ))}
    </Row>
  );
}
// Match the owner screenshot: keep the product visible through the caption,
// then fade broadly behind the first card into the exact page color at the edge.
const gradient =
  'linear-gradient(180deg, rgba(4,20,58,0.45) 0%, rgba(4,20,58,0.05) 26%, rgba(4,20,58,0) 40%, rgba(4,20,58,0.07) 50%, rgba(4,20,58,0.19) 60%, rgba(4,20,58,0.40) 70%, rgba(4,20,58,0.66) 80%, rgba(4,20,58,0.86) 88%, rgba(4,20,58,0.965) 94%, #04143A 99%, #04143A 100%)';
const heroGradient = (
  Platform.OS === 'web' ? { backgroundImage: gradient } : { experimental_backgroundImage: gradient }
) as ViewStyle;
const brand = StyleSheet.create({
  loyalty: {
    minHeight: 84,
    borderRadius: 20,
    padding: 16,
    backgroundColor: colors.surface,
    // The supplied skyline deliberately rises above the card's top edge.
    overflow: 'visible',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  skyline: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    right: 0,
    top: -26,
    opacity: 0.34,
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 20,
  },
  ring: {
    width: 52,
    height: 52,
    flexShrink: 0,
    borderRadius: 26,
    borderWidth: 6,
    borderColor: colors.accent,
    borderRightColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
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
  segment: { backgroundColor: '#FFFFFF33', padding: 2, borderRadius: 11, gap: 0 },
  segmentItem: {
    minHeight: 36,
    borderRadius: 9,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  segmentSelected: { backgroundColor: '#FFFFFF' },
});
