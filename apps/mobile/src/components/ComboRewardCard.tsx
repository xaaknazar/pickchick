import { useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, font } from '../theme';
import { MotionModal, MotionPressable } from './Motion';
import { Body, Button, Heading, Icon, IconButton } from './UI';

// Campaign illustration only: no local stamps, balance or redeem operation.
export function ComboRewardCard({
  testID,
  onMenu,
  compact = false,
}: {
  testID: string;
  onMenu(): void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();
  return (
    <View testID={testID} style={s.card}>
      <MotionPressable
        testID={`${testID}-details`}
        accessibilityRole="button"
        accessibilityLabel="Комбо-бонус. Купи 7 комбо, 8-е в подарок. Как получить подарок"
        onPress={() => setOpen(true)}
        style={[s.ticket, compact && { minHeight: 136 }]}
      >
        <Image
          source={require('../../assets/catalog-hd/reward-seven-plus-one.png')}
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
                    'linear-gradient(90deg, rgba(29,23,18,0.94) 0%, rgba(29,23,18,0.78) 55%, rgba(29,23,18,0.12) 100%)',
                }
              : {
                  experimental_backgroundImage:
                    'linear-gradient(90deg, rgba(29,23,18,0.94) 0%, rgba(29,23,18,0.78) 55%, rgba(29,23,18,0.12) 100%)',
                }) as ViewStyle,
          ]}
        />
        <View style={[s.offer, compact && { padding: 16, gap: 4 }]}>
          <Text style={s.label}>Комбо-бонус</Text>
          <Text
            accessibilityRole="header"
            style={[s.title, compact && { fontFamily: font.heading, fontSize: 20, lineHeight: 26 }]}
          >
            Купи 7 комбо.{`\n`}8-е - в подарок!
          </Text>
          <View style={s.details}>
            <Text style={s.detailsText}>Условия акции</Text>
            <Icon name="arrow-forward" size={18} color={colors.white} />
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
  card: { borderRadius: 20, overflow: 'hidden', backgroundColor: '#30271F' },
  ticket: { flexDirection: 'row', minHeight: 174 },
  offer: { width: '73%', minWidth: 0, padding: 18, gap: 8 },
  label: { fontFamily: font.medium, color: '#F3D8BD', fontSize: 13, lineHeight: 20 },
  title: {
    fontFamily: font.display,
    fontSize: 22,
    lineHeight: 28,
    letterSpacing: -0.3,
    color: colors.white,
  },
  details: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' },
  detailsText: { fontFamily: font.medium, fontSize: 13, lineHeight: 20, color: colors.white },
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
