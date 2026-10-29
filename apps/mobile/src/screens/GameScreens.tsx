import { t, localize, useLocale } from '../i18n';
import { ComboRewardCard } from '../components/ComboRewardCard';
import { usePublishedContent } from '../backoffice/usePublishedContent';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, font } from '../theme';
import type { ScreenProps } from '../model';
import { PickBlocksCard } from '../games/pick-blocks/visuals';
import { PickFarmCard } from '../games/pick-farm/visuals';
import { FARM_ENABLED } from '../games/pick-farm/api';
import { MagicSortCard } from '../games/magic-sort/MagicSortCard';
import { PickManCard } from '../games/pick-man/visuals';
import { AppHeader } from '../components/AppHeader';
import { comboCardShown, upcomingFeaturesShown } from '../store-build';
import { Body, Caption, Heading, Icon, Row, styles as ui, type IconName } from '../components/UI';

export function Events(props: ScreenProps) {
  useLocale();
  const published = usePublishedContent(props.model.branch?.id);
  const progress = props.model.comboRewards?.progress ?? props.model.testFlow.comboProgress;
  const insets = useSafeAreaInsets();
  return (
    <View testID="screen-M26" style={s.eventsPage}>
      {/* Owner 27.10.2026: the same top header as the menu (logo, restaurant, profile). */}
      <AppHeader />
      <ScrollView
        testID="scroll-M26"
        style={s.eventsScroll}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          s.eventsContent,
          {
            paddingTop: 4,
            paddingBottom: Math.max(28, insets.bottom + 16, (props.cartBottomInset ?? 0) + 16),
          },
        ]}
      >
        <Heading style={s.eventsTitle}>{t('События')}</Heading>
        <Body muted style={s.eventsSubtitle}>
          {t('Мини-игры Pick Chick: рекорды сохраняются на этом устройстве.')}
        </Body>

        {/* App Store build (owner 29.10.2026): the 6 + 1 card only while the server runs it. */}
        {comboCardShown(progress, undefined, props.preview) ? (
          <View style={{ marginTop: 20 }}>
            <ComboRewardCard
              preview={props.preview}
              progress={progress}
              testID="events-combo-reward"
              onMenu={() => props.navigate('M06')}
            />
          </View>
        ) : null}

        <Heading testID="events-games" style={s.eventSection}>
          {t('Игры')}
        </Heading>
        <MagicSortCard />
        {FARM_ENABLED ? <PickFarmCard /> : null}
        {published.gameEnabled('pick-blocks') ? <PickBlocksCard /> : null}
        {published.gameEnabled('pick-man') ? <PickManCard /> : null}
        {/* Missions and the «Скоро» list announce what is not live yet: not in the App Store
            build (owner 29.10.2026, App Review 2.1); test builds and the preview keep them. */}
        {upcomingFeaturesShown(undefined, props.preview) ? <UpcomingEvents /> : null}
      </ScrollView>
    </View>
  );
}
function UpcomingEvents() {
  useLocale();
  return (
    <>
      <Heading style={s.eventSection}>{t('Миссии')}</Heading>
      <View style={s.missionCard}>
        <View style={s.missionIcon}>
          <Icon name="restaurant-outline" size={26} color={colors.accent} />
        </View>
        <View style={ui.flex}>
          <Body style={s.upcomingTitle}>{t('Найди свой любимый вкус')}</Body>
          <Caption style={s.upcomingDetail}>
            {t('Новые задания и вкусные открытия. Скоро.')}
          </Caption>
        </View>
      </View>
      <Heading style={s.eventSection}>{t('Скоро')}</Heading>
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
              <Body style={s.upcomingTitle}>{localize(title)}</Body>
              <Caption style={s.upcomingDetail}>{localize(detail)}</Caption>
            </View>
          </Row>
        ))}
      </View>
    </>
  );
}
export { PickRunScreen as Game } from '../games/pick-run/PickRunScreen';
export { PickRunResult as GameResult } from '../games/pick-run/PickRunScreen';
const s = StyleSheet.create({
  eventsPage: { flex: 1, minHeight: 0, backgroundColor: colors.background },
  eventsScroll: { flex: 1, minHeight: 0 },
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
