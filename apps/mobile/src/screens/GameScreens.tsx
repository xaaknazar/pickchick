import { ComboRewardCard } from '../components/ComboRewardCard';
import { usePublishedContent } from '../backoffice/usePublishedContent';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, font } from '../theme';
import type { ScreenProps } from '../model';
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
  const insets = useSafeAreaInsets();
  return (
    <View testID="screen-M26" style={s.eventsPage}>
      <ScrollView
        testID="scroll-M26"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          s.eventsContent,
          {
            paddingTop: insets.top + 6,
            paddingBottom: Math.max(28, insets.bottom + 16, (props.cartBottomInset ?? 0) + 16),
          },
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
