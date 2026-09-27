import { useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, font } from '../theme';
import { MotionModal, MotionPressable } from './Motion';
import { Body, Button, Heading, Icon, IconButton } from './UI';
import { comboProgressView, type ComboProgressState } from '../loyalty/combo-progress';

// Read-only progress. Undefined means not connected, never an invented zero balance.
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
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const { count, text: progressText } = comboProgressView(progress, preview);

  return (
    <View testID={testID} style={s.card}>
      <MotionPressable
        testID={`${testID}-details`}
        accessibilityRole="button"
        accessibilityLabel={`Комбо-бонус. Купи 7 комбо, 8-е в подарок. ${progressText}. Условия акции`}
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
            Купи 7 комбо.{`\n`}8-е - в подарок!
          </Text>
          <View style={s.progress}>
            <View
              style={s.stamps}
              accessible={false}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              aria-hidden
            >
              {Array.from({ length: 8 }, (_, index) => {
                const earned = count !== null && index < count;
                return (
                  <View
                    key={index}
                    testID={`${testID}-stamp-${index + 1}`}
                    style={[s.stamp, earned && s.earned, index === 7 && s.gift]}
                  >
                    {earned ? (
                      <Icon name="checkmark" size={17} color="#5E290C" />
                    ) : index === 7 ? (
                      <Icon name="gift-outline" size={17} color="#FFE2C3" />
                    ) : (
                      <Text style={s.stampNumber}>{index + 1}</Text>
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
                {progressText}
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
              <Heading small style={{ flex: 1 }}>
                Твоё восьмое комбо
              </Heading>
              <IconButton
                name="close"
                label="Закрыть условия акции"
                testID="combo-reward-close"
                onPress={() => setOpen(false)}
              />
            </View>
            <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={s.rules}>
              {[
                [
                  '1',
                  'Покупайте комбо',
                  'За семь комбо - восьмое в подарок. Акция действует на точке.',
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
                    ? `Сейчас показан отдельный пробный счётчик без права на подарок. После выдачи Solo, Burger, Pick или Master Combo сервер добавляет одну отметку за каждое комбо. Сеты на двоих, напитки и допы не учитываются. Завершено пробных кругов: ${progress.data.completed_cycles}. Остаток переносится. Бумажные отметки остаются у кассира.`
                    : 'Личные отметки загружаются после входа. При отсутствии связи счётчик не обнуляется. Бумажные отметки и право на подарок пока учитываются на кассе.',
                ],
              ].map(([number, title, text]) => (
                <View key={number} style={s.rule}>
                  <Text style={s.ruleNumber}>{number}</Text>
                  <View style={{ flex: 1 }}>
                    <Body style={{ fontFamily: font.bold }}>{title}</Body>
                    <Body muted style={{ marginTop: 6 }}>
                      {text}
                    </Body>
                  </View>
                </View>
              ))}
            </ScrollView>
            <Button
              title="Открыть меню"
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
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#132B45',
    borderWidth: 1,
    borderColor: '#738699',
  },
  earned: { backgroundColor: '#FFE2C3', borderColor: '#FFE2C3' },
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
    color: colors.accent,
    fontSize: 24,
    lineHeight: 30,
    minWidth: 24,
  },
});
