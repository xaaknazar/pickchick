import { localize, t, useLocale } from '../i18n';
import { useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, font, restaurantColors } from '../theme';
import { MotionModal, MotionPressable } from './Motion';
import { Body, Button, Heading, Icon, CloseButton } from './UI';
import {
  COMBO_STAMP_SLOTS,
  comboProgressView,
  comboNextStep,
  practiceRound,
  type ComboProgressState,
} from '../loyalty/combo-progress';

// Owner 27.10.2026: a collected stamp keeps the calm slot background; only the
// checkmark (and a thin rim) is green. The same green marks «open» restaurants.
const STAMP_GREEN = restaurantColors.open;

// Account-scoped server progress. Unknown data never becomes an invented zero balance.
export function ComboRewardCard({
  testID,
  onMenu,
  compact = false,
  progress,
  preview = false,
}: {
  testID: string;
  onMenu(): void;
  compact?: boolean;
  progress?: ComboProgressState;
  preview?: boolean;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const { count, text: progressText } = comboProgressView(progress, preview);
  const nextStep = comboNextStep(progress, preview);

  return (
    <View testID={testID} style={s.card}>
      <MotionPressable
        testID={`${testID}-details`}
        accessibilityRole="button"
        accessibilityLabel={localize(
          t('Комбо-бонус. Купи 6 комбо, 7-е в подарок. {p0}. Условия акции', {
            p0: localize(progressText),
          }),
        )}
        onPress={() => setOpen(true)}
        style={[s.ticket, compact && { minHeight: 136 }]}
      >
        <Image
          source={require('../../assets/campaigns/combo-seven-plus-one.png')}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          accessible={false}
        />
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            (Platform.OS === 'web'
              ? {
                  backgroundImage:
                    'linear-gradient(90deg, rgba(4,20,42,0.78) 0%, rgba(4,20,42,0.42) 55%, rgba(4,20,42,0.06) 100%)',
                }
              : {
                  experimental_backgroundImage:
                    'linear-gradient(90deg, rgba(4,20,42,0.78) 0%, rgba(4,20,42,0.42) 55%, rgba(4,20,42,0.06) 100%)',
                }) as ViewStyle,
          ]}
        />
        <View style={[s.offer, compact && s.offerCompact]}>
          <Text accessibilityRole="header" style={[s.title, compact && s.titleCompact]}>
            {t('Купи 6 комбо.')}
            {localize(`\n`)}
            {t('7-е - в подарок!')}
          </Text>
          <View style={s.progress}>
            <View
              style={s.stamps}
              accessible={false}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              aria-hidden
            >
              {Array.from({ length: COMBO_STAMP_SLOTS + 1 }, (_, index) => {
                const gift = index === COMBO_STAMP_SLOTS;
                const earned = !gift && count !== null && index < count;
                return (
                  <View
                    key={index}
                    testID={`${testID}-stamp-${index + 1}`}
                    style={[s.stamp, earned && s.earned, gift && s.gift]}
                  >
                    {earned ? (
                      <View testID={`${testID}-stamp-${index + 1}-check`}>
                        <Icon name="checkmark-sharp" size={20} color={STAMP_GREEN} />
                      </View>
                    ) : gift ? (
                      <Icon name="gift-outline" size={17} color="#FFE2C3" />
                    ) : (
                      <Text style={s.stampNumber} maxFontSizeMultiplier={1.3}>
                        {localize(index + 1)}
                      </Text>
                    )}
                  </View>
                );
              })}
            </View>
            <View style={s.details}>
              <Text
                testID={`${testID}-progress`}
                style={s.detailsText}
                accessibilityLiveRegion="polite"
              >
                {localize(nextStep.title)}
              </Text>
              <Icon name="arrow-forward" size={16} color={colors.white} />
            </View>
          </View>
        </View>
      </MotionPressable>
      <MotionModal
        visible={open}
        transparent
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <View style={[s.overlay, { paddingTop: Math.max(20, insets.top) }]}>
          <MotionPressable
            style={StyleSheet.absoluteFill}
            onPress={() => setOpen(false)}
            accessible={false}
            importantForAccessibility="no"
          />
          <View
            testID="combo-reward-details"
            accessibilityViewIsModal
            style={[s.sheet, { paddingBottom: Math.max(20, insets.bottom) }]}
          >
            <View style={s.sheetHeader}>
              <CloseButton
                label={t('Закрыть условия акции')}
                testID="combo-reward-close"
                onPress={() => setOpen(false)}
              />
              <Heading small style={{ flex: 1 }}>
                {t('Твоё седьмое комбо')}
              </Heading>
            </View>
            <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={s.rules}>
              <View style={{ gap: 8 }}>
                <Heading small>{localize(nextStep.title)}</Heading>
                <Body muted>{localize(nextStep.detail)}</Body>
              </View>
              {(progress?.commercial
                ? [
                    [
                      '1',
                      t('Покупайте любое комбо'),
                      t(
                        'После подтверждённой оплаты каждое комбо даёт одну отметку. Два комбо в заказе - две отметки.',
                      ),
                    ],
                    [
                      '2',
                      t('Заберите Pick Combo в подарок'),
                      t(
                        'После шести отметок подарок появится в профиле и корзине. Включите «Использовать подарок». Остаток покупок переносится на следующий круг.',
                      ),
                    ],
                    [
                      '3',
                      t('Возвраты учитываются'),
                      t(
                        'Возврат комбо снимает соответствующую отметку. Неиспользованный подарок станет недоступен, если отметок недостаточно. Если подарок уже использован, сотрудник проверит ситуацию.',
                      ),
                    ],
                  ]
                : [
                    [
                      '1',
                      'Покупайте комбо',
                      'За шесть комбо - седьмое в подарок. Акция действует на точке.',
                    ],
                    [
                      '2',
                      'Обратитесь к кассиру',
                      'Уточните, какие комбо участвуют, как собираются отметки и какое комбо можно получить в подарок.',
                    ],
                    [
                      '3',
                      'Сохраните свои отметки',
                      progress?.data?.mode === 'practice'
                        ? t(
                            'Сейчас показан отдельный пробный счётчик без права на подарок. После выдачи Solo, Burger, Pick или Master Combo сервер добавляет одну отметку за каждое комбо. Сеты на двоих, напитки и допы не учитываются. Завершено пробных кругов: {p0}. Остаток переносится. Бумажные отметки остаются у кассира.',
                            { p0: practiceRound(progress.data.earned_units).rounds },
                          )
                        : 'Личные отметки загружаются после входа. При отсутствии связи счётчик не обнуляется. Бумажные отметки и право на подарок пока учитываются на кассе.',
                    ],
                  ]
              ).map(([number, title, text]) => (
                <View key={number} style={s.rule}>
                  <Text style={s.ruleNumber}>{localize(number)}</Text>
                  <View style={{ flex: 1 }}>
                    <Body style={{ fontFamily: font.bold }}>{localize(title)}</Body>
                    <Body muted style={{ marginTop: 6 }}>
                      {localize(text)}
                    </Body>
                  </View>
                </View>
              ))}
            </ScrollView>
            <Button
              title={localize(nextStep.action)}
              testID="combo-reward-menu"
              onPress={() => {
                setOpen(false);
                onMenu();
              }}
            />
          </View>
        </View>
      </MotionModal>
    </View>
  );
}

const s = StyleSheet.create({
  card: { borderRadius: 20, overflow: 'hidden', backgroundColor: '#263C55' },
  ticket: { minHeight: 174 },
  offer: { flex: 1, minWidth: 0, padding: 18, gap: 10, justifyContent: 'space-between' },
  offerCompact: { paddingHorizontal: 16, paddingVertical: 12, gap: 6 },
  title: {
    maxWidth: '74%',
    fontFamily: font.display,
    fontSize: 22,
    lineHeight: 28,
    letterSpacing: -0.3,
    color: colors.white,
  },
  titleCompact: { fontFamily: font.heading, fontSize: 20, lineHeight: 24 },
  progress: { gap: 6 },
  stamps: { flexDirection: 'row', gap: 6 },
  stamp: {
    flex: 1,
    minHeight: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#132B45',
    borderWidth: 1,
    borderColor: '#738699',
  },
  // Same fill as an empty slot; the green check and rim carry the state.
  earned: { borderColor: STAMP_GREEN },
  gift: { backgroundColor: '#163755', borderColor: '#FFE2C3' },
  stampNumber: { fontFamily: font.bold, fontSize: 13, lineHeight: 18, color: '#E3EDF7' },
  details: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  detailsText: { fontFamily: font.medium, fontSize: 12, lineHeight: 18, color: colors.white },
  overlay: { flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '100%',
    width: '100%',
    maxWidth: 600,
    alignSelf: 'center',
    backgroundColor: colors.background,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 20,
    gap: 20,
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rules: { gap: 24, paddingBottom: 8 },
  rule: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  ruleNumber: {
    fontFamily: font.display,
    color: colors.accentText,
    fontSize: 24,
    lineHeight: 30,
    minWidth: 24,
  },
});
