import { ComboRewardCard } from '../components/ComboRewardCard';
import { MotionPressable as Pressable } from '../components/Motion';
import { usePublishedContent } from '../backoffice/usePublishedContent';
import { Image } from 'expo-image';
import { Platform, ScrollView, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { assets } from '../assets';
import { colors, font } from '../theme';
import type { ScreenProps } from '../model';
import { useGameCardHeight } from '../games/ArcadeCard';
import { PickBlocksCard } from '../games/pick-blocks/visuals';
import { PickManCard } from '../games/pick-man/visuals';
import {
  Body,
  Caption,
  Heading,
  Icon,
  ReviewBadge,
  Row,
  styles as ui,
  type IconName,
} from '../components/UI';

export function Events(props: ScreenProps) {
  const published = usePublishedContent(props.model.branch?.id);
  const cardHeight = useGameCardHeight();
  const insets = useSafeAreaInsets();
  const posterGradient =
    'linear-gradient(180deg, rgba(4,20,58,0.35) 0%, rgba(4,20,58,0) 34%, rgba(2,10,30,0.88) 100%)';
  const gradientStyle = (
    Platform.OS === 'web'
      ? { backgroundImage: posterGradient }
      : { experimental_backgroundImage: posterGradient }
  ) as ViewStyle;
  return (
    <View testID="screen-M26" style={s.eventsPage}>
      <ScrollView
        testID="scroll-M26"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          s.eventsContent,
          { paddingTop: insets.top + 6, paddingBottom: Math.max(28, insets.bottom + 16) },
        ]}
      >
        {props.preview ? <ReviewBadge /> : null}
        <Heading style={s.eventsTitle}>События</Heading>
        <Body muted style={s.eventsSubtitle}>
          Афиша Pick Chick: игры, события и новые поводы заглянуть к нам.
        </Body>

        <View style={{ marginTop: 20 }}>
          <ComboRewardCard testID="events-combo-reward" onMenu={() => props.navigate('M06')} />
        </View>

        <Heading testID="events-games" style={s.eventSection}>
          Игры
        </Heading>
        {published.gameEnabled('pick-blocks') ? <PickBlocksCard /> : null}
        {published.gameEnabled('pick-man') ? <PickManCard /> : null}
        {published.gameEnabled('pick-run') ? (
          <Pressable
            testID="pickrun-open"
            accessibilityRole="button"
            accessibilityLabel="Играть в Pick Run, тренировочный режим без начисления Чиков"
            onPress={() => props.navigate('M27')}
            style={[s.eventPoster, { height: cardHeight }]}
          >
            <Image
              source={assets.pickrunRunner}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              contentPosition={{ top: '30%', left: '50%' }}
            />
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, gradientStyle]} />
            <Row style={s.posterTags}>
              <Text style={s.posterTag}>ТРЕНИРОВКА</Text>
              <Text style={s.posterTag}>3 ПОПЫТКИ</Text>
            </Row>
            <Row style={s.posterBottom}>
              <View style={ui.flex}>
                <Heading testID="pickrun-open-title" style={s.posterTitle}>
                  PICK RUN
                </Heading>
                <Body style={s.posterDescription}>
                  Прыжки через препятствия.{`\n`}Без начисления Чиков.
                </Body>
              </View>
              <View style={s.posterPlay}>
                <Icon name="play" size={25} color="#FFFFFF" />
              </View>
            </Row>
          </Pressable>
        ) : null}
        <Heading style={s.eventSection}>Миссии</Heading>
        <View style={s.missionCard}>
          <View style={s.missionIcon}>
            <Icon name="restaurant-outline" size={26} color={colors.accent} />
          </View>
          <View style={ui.flex}>
            <Body style={s.upcomingTitle}>Найди свой любимый вкус</Body>
            <Caption style={s.upcomingDetail}>Новые задания и вкусные открытия. Скоро.</Caption>
          </View>
        </View>
        <Heading style={s.eventSection}>Скоро</Heading>
        <View style={s.upcomingList}>
          {[
            ['gift-outline', 'События недели', 'Условия и награды готовятся'],
            ['trophy-outline', 'Лидерборд Pick Run', 'Рейтинг появится после запуска'],
            ['sparkles-outline', 'День рождения', 'Праздничные предложения Pick Chick'],
          ].map(([icon, title, detail]) => (
            <Row key={title} style={s.upcomingRow}>
              <View style={s.upcomingIcon}>
                <Icon name={icon as IconName} size={22} color={colors.muted} />
              </View>
              <View style={ui.flex}>
                <Body style={s.upcomingTitle}>{title}</Body>
                <Caption style={s.upcomingDetail}>{detail}</Caption>
              </View>
            </Row>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
export { PickRunScreen as Game } from '../games/pick-run/PickRunScreen';
export { PickRunResult as GameResult } from '../games/pick-run/PickRunScreen';
const s = StyleSheet.create({
  eventsPage: { flex: 1, minHeight: 0, backgroundColor: colors.background },
  eventsContent: { paddingHorizontal: 18, width: '100%', maxWidth: 680, alignSelf: 'center' },
  eventsTitle: { fontFamily: font.display, fontSize: 34, lineHeight: 41, letterSpacing: -0.68 },
  eventsSubtitle: { fontSize: 14, lineHeight: 21, marginTop: 6 },
  eventSection: {
    fontFamily: font.display,
    fontSize: 20,
    lineHeight: 26,
    marginTop: 24,
    letterSpacing: -0.2,
  },
  eventPoster: {
    minHeight: 212,
    marginTop: 12,
    borderRadius: 26,
    overflow: 'hidden',
    backgroundColor: colors.background,
  },
  posterTags: { padding: 14, gap: 7, flexWrap: 'wrap' },
  posterTag: {
    fontFamily: font.bold,
    fontSize: 10.5,
    letterSpacing: 0.63,
    color: '#FFFFFF',
    backgroundColor: '#FFFFFF38',
    borderRadius: 20,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  posterBottom: { flex: 1, alignItems: 'flex-end', padding: 16, paddingTop: 45, gap: 14 },
  posterTitle: {
    fontFamily: font.display,
    fontSize: 34,
    lineHeight: 50,
    letterSpacing: -0.85,
    color: '#FFFFFF',
  },
  posterDescription: { marginTop: 7, fontSize: 12.5, lineHeight: 18, color: '#FFFFFFE0' },
  posterPlay: {
    width: 58,
    height: 58,
    flexShrink: 0,
    borderRadius: 29,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 3,
  },
  missionCard: {
    marginTop: 12,
    padding: 18,
    borderRadius: 22,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  missionIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  upcomingList: {
    marginTop: 12,
    backgroundColor: colors.surface,
    borderRadius: 20,
    overflow: 'hidden',
  },
  upcomingRow: {
    paddingVertical: 15,
    paddingHorizontal: 16,
    gap: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  upcomingIcon: {
    width: 42,
    height: 42,
    borderRadius: 13,
    backgroundColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  upcomingTitle: { fontFamily: font.medium, fontSize: 14.5, lineHeight: 21 },
  upcomingDetail: { fontSize: 12.5, lineHeight: 18, marginTop: 2 },
});
