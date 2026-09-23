import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { brandColors, colors, font } from '../theme';
import { MotionModal, MotionPressable } from './Motion';
import { Body, Button, Heading, Icon, IconButton } from './UI';

// Campaign illustration only: no local stamps, balance or redeem operation.
export function ComboRewardCard({ testID, onMenu }: { testID: string; onMenu(): void }) {
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  return (
    <View testID={testID} style={s.card}>
      <View style={s.top}>
        <Text style={s.eyebrow}>КОМБО-БОНУС</Text>
        <View style={s.badge}>
          <Icon name="gift-outline" size={16} color={colors.orangeInk} />
          <Text style={s.badgeText}>7 + 1</Text>
        </View>
      </View>
      <Text accessibilityRole="header" style={s.title}>
        Купи 7 комбо.{`\n`}8-е - в подарок!
      </Text>
      <Text style={s.subtitle}>Любимый вкус. Ещё один повод вернуться.</Text>
      <View style={s.ticket}>
        <View
          accessible
          accessibilityLabel="Схема акции: семь комбо и восьмое в подарок. Это не личный счётчик покупок."
          style={s.stamps}
        >
          {Array.from({ length: 8 }, (_, i) => (
            <View
              key={i}
              style={[s.stamp, fontScale > 1.5 && { minHeight: 64 }, i === 7 && s.gift]}
            >
              {i === 7 ? (
                <Icon name="gift-outline" size={25} color={colors.orangeInk} />
              ) : (
                <Text allowFontScaling={false} style={s.number}>
                  {i + 1}
                </Text>
              )}
            </View>
          ))}
        </View>
        <View style={s.ticketLegend}>
          <Text style={s.legend}>7 комбо</Text>
          <Text style={s.legend}>1 подарок</Text>
        </View>
      </View>
      <View style={s.status}>
        <Icon name="storefront-outline" size={18} color="#FFFFFF" />
        <Text style={s.statusText}>
          Участвуйте на кассе.{`\n`}Отметки в приложении появятся позже.
        </Text>
      </View>
      <MotionPressable
        testID={`${testID}-details`}
        accessibilityRole="button"
        onPress={() => setOpen(true)}
        style={s.details}
      >
        <Text style={s.detailsText}>Как получить подарок</Text>
        <Icon name="arrow-forward" size={21} color={colors.orangeInk} />
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
                  'Цифровая карточка готовится. Сейчас покупки и подарок учитываются на кассе; эта схема не показывает ваш личный прогресс.',
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
  card: {
    backgroundColor: brandColors.brandBlue,
    borderRadius: 28,
    padding: 20,
    gap: 16,
    overflow: 'hidden',
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    flexWrap: 'wrap',
  },
  eyebrow: {
    fontFamily: font.bold,
    color: '#FFFFFF',
    fontSize: 11,
    lineHeight: 17,
    letterSpacing: 1.4,
  },
  badge: {
    backgroundColor: brandColors.brandOrange,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  badgeText: { color: colors.orangeInk, fontFamily: font.display, fontSize: 15, lineHeight: 20 },
  title: {
    fontFamily: font.display,
    fontSize: 30,
    lineHeight: 36,
    letterSpacing: -0.5,
    color: '#FFFFFF',
  },
  subtitle: {
    fontFamily: font.body,
    fontSize: 14,
    lineHeight: 21,
    color: '#DBE8FF',
    marginTop: -6,
  },
  ticket: { padding: 12, borderRadius: 18, backgroundColor: '#FFFFFF', gap: 10 },
  stamps: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stamp: {
    width: '22%',
    flexGrow: 1,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#EDF3FD',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#D3E2FA',
  },
  number: { fontFamily: font.display, fontSize: 23, lineHeight: 30, color: brandColors.brandBlue },
  gift: { backgroundColor: brandColors.brandOrange, borderColor: brandColors.brandOrange },
  ticketLegend: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  legend: { fontFamily: font.bold, fontSize: 12, lineHeight: 18, color: brandColors.brandBlue },
  status: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  statusText: { flex: 1, fontFamily: font.body, fontSize: 12, lineHeight: 18, color: '#FFFFFF' },
  details: {
    minHeight: 50,
    backgroundColor: brandColors.brandOrange,
    borderRadius: 15,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  detailsText: {
    flex: 1,
    fontFamily: font.bold,
    fontSize: 14,
    lineHeight: 21,
    color: colors.orangeInk,
  },
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
