import { useState } from 'react';
import { Image, type ImageContentPosition } from 'expo-image';
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ImageSourcePropType,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewStyle,
} from 'react-native';
import { carouselIndex } from '../games/order-games';
import { colors, font } from '../theme';
import { MotionPressable } from './Motion';
import { Icon } from './UI';

export type CarouselGame<Id extends string = string> = {
  id: Id;
  title: string;
  description: string;
  cover: ImageSourcePropType;
  coverPosition?: ImageContentPosition;
  testID: string;
};

const CARD_WIDTH = 300;
const CARD_HEIGHT = 200;
const GAP = 12;
// Eased stops keep the 120 pt fade free of a visible edge or a solid plate.
const fade =
  'linear-gradient(180deg, rgba(4,20,58,0) 0%, rgba(4,20,58,0.06) 16%, rgba(4,20,58,0.2) 32%, rgba(4,20,58,0.4) 50%, rgba(4,20,58,0.62) 68%, rgba(4,20,58,0.8) 84%, rgba(4,20,58,0.92) 100%)';
const shade = (
  Platform.OS === 'web' ? { backgroundImage: fade } : { experimental_backgroundImage: fade }
) as ViewStyle;
// React Native Web ignores snapToInterval; CSS scroll snapping gives the same resting points.
const webTrack = (inset: number) =>
  (Platform.OS === 'web'
    ? { scrollSnapType: 'x mandatory', scrollPaddingLeft: inset }
    : {}) as ViewStyle;
const webCard = (Platform.OS === 'web' ? { scrollSnapAlign: 'start' } : {}) as ViewStyle;

/** Horizontal game posters with a peeking next card. Never scrolls by itself. */
export function GameCarousel<Id extends string>({
  title,
  games,
  onOpen,
  inset = 20,
  testID = 'order-games',
}: {
  title: string;
  games: CarouselGame<Id>[];
  onOpen(id: Id): void;
  inset?: number;
  testID?: string;
}) {
  const { width } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  if (!games.length) return null;
  // Keep part of the next poster visible on narrow phones.
  const cardWidth = Math.min(CARD_WIDTH, Math.max(220, width - inset - 52));
  const interval = cardWidth + GAP;
  const current = Math.min(index, games.length - 1);
  const several = games.length > 1;
  // Below ~280 pt the title and the button cannot share a row without cutting the name.
  const stacked = cardWidth < 280;
  const onScroll = ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) =>
    setIndex(
      carouselIndex(
        nativeEvent.contentOffset.x,
        interval,
        games.length,
        nativeEvent.contentSize.width - nativeEvent.layoutMeasurement.width,
      ),
    );
  return (
    <View testID={testID} style={s.root}>
      <View style={[s.header, { paddingHorizontal: inset }]}>
        <Text accessibilityRole="header" style={s.title} testID={`${testID}-title`}>
          {title}
        </Text>
        {several ? (
          <Text
            testID={`${testID}-counter`}
            accessibilityLabel={`Игра ${current + 1} из ${games.length}`}
            style={s.counter}
          >
            {current + 1} / {games.length}
          </Text>
        ) : null}
      </View>
      <ScrollView
        horizontal
        testID={`${testID}-track`}
        showsHorizontalScrollIndicator={false}
        directionalLockEnabled
        nestedScrollEnabled
        decelerationRate="fast"
        snapToInterval={interval}
        snapToAlignment="start"
        disableIntervalMomentum
        onScroll={onScroll}
        scrollEventThrottle={32}
        style={webTrack(inset)}
        contentContainerStyle={[s.track, { paddingHorizontal: inset }]}
      >
        {games.map((game) => (
          <MotionPressable
            key={game.id}
            testID={game.testID}
            feedback="scale"
            accessibilityRole="button"
            accessibilityLabel={`Играть в ${game.title}. ${game.description}`}
            onPress={() => onOpen(game.id)}
            style={[s.card, { width: cardWidth }, webCard]}
          >
            <Image
              source={game.cover}
              contentFit="cover"
              contentPosition={game.coverPosition ?? 'center'}
              style={StyleSheet.absoluteFill}
              accessible={false}
              pointerEvents="none"
            />
            <View pointerEvents="none" style={[s.shade, shade]} />
            <View pointerEvents="none" style={[s.cardBottom, stacked && s.cardStacked]}>
              <View style={stacked ? s.copyStacked : s.copy}>
                <Text numberOfLines={1} style={s.cardTitle}>
                  {game.title}
                </Text>
                <Text numberOfLines={1} style={s.cardText}>
                  {game.description}
                </Text>
              </View>
              <View style={s.play}>
                <Text style={s.playText}>Играть</Text>
                <Icon name="arrow-forward" size={18} color={colors.orangeInk} />
              </View>
            </View>
          </MotionPressable>
        ))}
      </ScrollView>
      {several ? (
        <View
          style={s.dots}
          aria-hidden
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {games.map((game, i) => (
            <View
              key={game.id}
              testID={`${testID}-dot-${i}`}
              style={[s.dot, i === current && s.dotActive]}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const textShadow = {
  textShadowColor: 'rgba(2,10,30,0.7)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 6,
};
const s = StyleSheet.create({
  root: { gap: 10 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: {
    flex: 1,
    fontFamily: font.display,
    fontSize: 20,
    lineHeight: 26,
    color: colors.text,
  },
  counter: {
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 20,
    color: colors.muted,
    fontVariant: ['tabular-nums'],
  },
  track: { gap: GAP },
  card: {
    height: CARD_HEIGHT,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: colors.raised,
    justifyContent: 'flex-end',
  },
  shade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 120 },
  cardBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
  cardStacked: { flexDirection: 'column', alignItems: 'flex-start', gap: 8 },
  copy: { flex: 1, minWidth: 0 },
  copyStacked: { alignSelf: 'stretch' },
  cardTitle: {
    fontFamily: font.display,
    fontSize: 24,
    lineHeight: 31,
    color: colors.white,
    ...textShadow,
  },
  cardText: {
    fontFamily: font.medium,
    fontSize: 12.5,
    lineHeight: 17,
    color: '#E6EEFF',
    ...textShadow,
  },
  play: {
    height: 40,
    borderRadius: 20,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.accent,
  },
  playText: { fontFamily: font.bold, fontSize: 15, lineHeight: 20, color: colors.orangeInk },
  dots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#2A3E66' },
  dotActive: { width: 18, backgroundColor: colors.accent },
});
