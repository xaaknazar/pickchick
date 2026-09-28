import { MotionPressable as Pressable, MotionModal as Modal } from '../components/Motion';
import { useState } from 'react';
import { Image } from 'expo-image';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  CloseButton,
  Body,
  Button,
  Heading,
  Icon,
  NavRow,
  Page,
  Row,
  type IconName,
} from '../components/UI';
import type { ScreenProps } from '../model';
import { colors, font } from '../theme';
import { ascentProgress, peaks, proposedProgram, type Peak } from './peaks';

const art = {
  furmanov: require('../../assets/loyalty/furmanov.svg'),
  kumbel: require('../../assets/loyalty/kumbel.svg'),
  panorama: require('../../assets/loyalty/panorama.svg'),
  'big-almaty': require('../../assets/loyalty/big-almaty.svg'),
  molodezhny: require('../../assets/loyalty/molodezhny.svg'),
  talgar: require('../../assets/loyalty/talgar.svg'),
};
const number = (value: number) => value.toLocaleString('ru-RU');

function ProposalLabel() {
  return (
    <View style={s.proposal}>
      <View style={s.dot} />
      <Text style={s.proposalText}>СКОРО</Text>
    </View>
  );
}

function MountainHero({ preview }: { preview: boolean }) {
  const progress = ascentProgress(preview ? 540 : 0);
  return (
    <View testID="ascent-hero" style={s.hero}>
      <Image
        source={require('../../assets/loyalty/almaty-ascent.svg')}
        style={s.heroArt}
        contentFit="cover"
        accessible={false}
      />
      <View style={s.heroCopy}>
        <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <Text style={s.eyebrow}>АЛМАТЫ · 6 ВЕРШИН</Text>
          <ProposalLabel />
        </Row>
        <Text style={s.heroTitle}>Твой вкус.{`\n`}Твои вершины.</Text>
        <Text style={s.heroSubtitle}>Большой путь начинается{`\n`}с любимого заказа.</Text>
      </View>
      <View style={s.heroProgress}>
        <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <View style={{ flex: 1 }}>
            <Text style={s.heroProgressTitle}>
              {preview ? 'Следом - Кумбель' : 'Первая вершина - Фурманова'}
            </Text>
            <Text style={s.heroProgressCopy}>
              {preview
                ? `${number(progress.remaining)} Чиков до следующего пика · пример`
                : '300 заработанных Чиков до первого подарка'}
            </Text>
          </View>
          <Icon name="flag-outline" color={colors.accent} size={24} />
        </Row>
        <View style={s.track}>
          <View style={[s.fill, { width: `${progress.fraction * 100}%` }]} />
        </View>
      </View>
    </View>
  );
}

function PeakDetails({ peak, close }: { peak: Peak | null; close(): void }) {
  const safe = useSafeAreaInsets();
  return (
    <Modal visible={peak !== null} transparent animationType="none" onRequestClose={close}>
      <View
        style={[
          s.shade,
          { paddingTop: Math.max(safe.top, 16), paddingBottom: Math.max(safe.bottom, 16) },
        ]}
      >
        <ScrollView contentContainerStyle={s.modalScroll}>
          {peak ? (
            <View testID="peak-details" style={s.sheet} accessibilityViewIsModal>
              <View style={s.sheetTop}>
                <CloseButton testID="peak-close" label="Закрыть вершину" onPress={close} />
                <Text style={s.eyebrow}>ВЕРШИНА {peaks.indexOf(peak) + 1} ИЗ 6</Text>
              </View>
              <Image
                source={art[peak.id]}
                style={s.sheetMountain}
                contentFit="contain"
                accessible={false}
              />
              <Text style={s.sheetTitle}>{peak.name}</Text>
              <Body muted style={{ textAlign: 'center' }}>
                {peak.mood}
              </Body>
              <Text style={s.sheetPoints}>{number(peak.points)} Чиков за всё время</Text>
              <View style={s.giftPanel}>
                <Icon name="gift-outline" color={colors.accent} size={28} />
                <View style={{ flex: 1 }}>
                  <Text style={s.giftTitle}>{peak.reward}</Text>
                  <Text style={s.copy}>{peak.detail}</Text>
                </View>
              </View>
              <Text style={s.copy}>
                Предлагаем дарить награду один раз при достижении вершины. После открытия -{' '}
                {proposedProgram.giftDays} дней, чтобы использовать подарок. Тратить Чики для этого
                не нужно.
              </Text>
              <Text style={s.note}>
                Готовим программу. Пороги, состав подарков и условия пока предварительные.
              </Text>
              <Button title="Понятно" onPress={close} />
            </View>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

function MountainRoad({ preview }: { preview: boolean }) {
  const [selected, setSelected] = useState<Peak | null>(null);
  const progress = ascentProgress(preview ? 540 : 0);
  return (
    <View testID="mountain-road">
      <View style={s.roadHeading}>
        <Heading style={s.sectionTitle}>Шесть вершин вкуса</Heading>
        <Text style={s.note}>Каждый пик - новый подарок. Посмотри, что ждёт впереди.</Text>
      </View>
      <View style={s.road}>
        {peaks.map((peak, index) => {
          const reached = preview && index < progress.reached;
          const next = index === progress.reached;
          return (
            <View key={peak.id} style={s.stop}>
              <View style={s.rail}>
                {index < peaks.length - 1 ? (
                  <View style={[s.railLine, reached && { borderColor: colors.accent }]} />
                ) : null}
                <View style={[s.node, reached && s.nodeReached, next && s.nodeNext]}>
                  {reached ? (
                    <Icon name="checkmark" color={colors.orangeInk} size={20} />
                  ) : (
                    <Text style={[s.nodeText, next && { color: colors.accentText }]}>
                      {index + 1}
                    </Text>
                  )}
                </View>
              </View>
              <Pressable
                testID={`peak-${peak.id}`}
                accessibilityRole="button"
                accessibilityLabel={`${peak.name}, ${number(peak.points)} Чиков, ${peak.reward}. Подробнее`}
                onPress={() => setSelected(peak)}
                style={({ pressed }) => [
                  s.peakCard,
                  next && s.nextCard,
                  pressed && { opacity: 0.8 },
                ]}
              >
                <View style={s.peakTop}>
                  <Text style={s.peakOverline}>
                    {reached ? 'ОТКРЫТА · ПРИМЕР' : `ВЕРШИНА ${index + 1}`}
                  </Text>
                  <Image
                    testID={`peak-art-${peak.id}`}
                    source={art[peak.id]}
                    style={s.peakArt}
                    contentFit="contain"
                    accessible={false}
                  />
                </View>
                <Text style={s.peakName}>{peak.name}</Text>
                <Text style={s.peakThreshold}>{number(peak.points)} Чиков</Text>
                <View style={s.rewardRow}>
                  <Icon name="gift-outline" size={18} color={colors.accent} />
                  <Text style={s.rewardText}>{peak.reward}</Text>
                  <Icon name="chevron-forward" size={16} color={colors.muted} />
                </View>
              </Pressable>
            </View>
          );
        })}
        <View style={s.finish}>
          <Icon name="sparkles-outline" color={colors.accent} size={20} />
          <Text style={s.finishText}>Талгар - твоя вершина вкуса</Text>
        </View>
      </View>
      <PeakDetails peak={selected} close={() => setSelected(null)} />
    </View>
  );
}

function HowItWorks() {
  const [open, setOpen] = useState(false);
  return (
    <View style={s.explainer}>
      <Pressable
        testID="ascent-rules-toggle"
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        onPress={() => setOpen(!open)}
        style={s.explainerButton}
      >
        <Icon name="compass-outline" color={colors.accent} size={23} />
        <Text style={s.explainerTitle}>Как устроено восхождение</Text>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} color={colors.muted} size={20} />
      </Pressable>
      {open ? (
        <View testID="ascent-rules" style={s.explainerBody}>
          <Text style={s.copy}>
            Чики за выданные заказы, проверенные игры и миссии пополняют баланс и прогресс. Уже
            потраченные Чики продолжают учитываться для уровня.
          </Text>
          <Text style={s.copy}>
            Предлагаем возвращать {proposedProgram.earnPercent}% Чиками, считать 1 Чик равным 1 ₸ и
            разрешить оплачивать Чиками до {proposedProgram.maxSpendPercent}% подходящих позиций
            заказа.
          </Text>
          <Text style={s.copy}>
            Возврат заказа корректирует начисление и прогресс. Подарок за одну вершину выдаётся
            только один раз. Высота реальной горы и порог Чиков - разные числа.
          </Text>
          <Text style={s.note}>
            Это предварительная программа. Сейчас начисления, подарки и прогресс ещё не
            активированы.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export function PeakWallet(props: ScreenProps) {
  return (
    <Page props={props} title="Мои Чики и вершины">
      <MountainHero preview={props.preview} />
      <View style={s.balances}>
        <View style={s.balanceCell}>
          <Text style={s.balanceLabel}>БАЛАНС ЧИКОВ</Text>
          <Text testID="peak-wallet-balance" style={s.balanceNumber}>
            {props.preview ? '180' : '-'}
          </Text>
          <Text style={s.balanceHint}>Можно потратить</Text>
        </View>
        <View style={s.balanceCell}>
          <Text style={s.balanceLabel}>ДЛЯ УРОВНЯ</Text>
          <Text
            testID="peak-earned-progress"
            style={[s.balanceNumber, { color: colors.accentText }]}
          >
            {props.preview ? '540' : '-'}
          </Text>
          <Text style={s.balanceHint}>Всего заработано</Text>
        </View>
      </View>
      {props.preview ? (
        <Text style={s.note}>
          Пример: 540 Чиков заработано, 360 потрачено. Вершина Фурманова остаётся открытой.
        </Text>
      ) : null}
      <MountainRoad preview={props.preview} />
      <NavRow
        title="Миссии и подарки"
        subtitle="Больше поводов подняться выше"
        onPress={() => props.navigate('M25')}
      />
      <HowItWorks />
      <NavRow
        title="История Чиков"
        subtitle="Начисления, списания и возвраты"
        onPress={() => props.navigate('M24')}
      />
      <NavRow
        title="Мой QR"
        subtitle="Для начисления на кассе"
        onPress={() => props.navigate('M29')}
      />
    </Page>
  );
}

export function PeakRewards(props: ScreenProps) {
  return (
    <Page props={props} title="Миссии и подарки">
      <View style={s.missionHero}>
        <ProposalLabel />
        <Heading style={s.missionTitle}>Маленькие шаги.{`\n`}Большие вершины.</Heading>
        <Body muted>Заказывай любимое, пробуй новое и находи время для игры.</Body>
      </View>
      <View style={s.comboGift}>
        <Image
          source={art.kumbel}
          style={s.comboMountain}
          contentFit="contain"
          accessible={false}
        />
        <Text style={s.eyebrow}>ПОДАРОК ВТОРОЙ ВЕРШИНЫ</Text>
        <Text style={s.comboTitle}>Кумбель.{`\n`}Комбо за твой путь.</Text>
        <Text style={s.copy}>
          1 000 заработанных Чиков - и базовое комбо в подарок. Баланс останется с тобой.
        </Text>
        <Text style={s.note}>Предварительные условия · подарок ещё не активен</Text>
        <Button title="Посмотреть вершины" secondary onPress={() => props.navigate('M23')} />
      </View>
      <Heading style={s.sectionTitle}>Путь состоит из моментов</Heading>
      {(
        [
          [
            'bag-handle-outline',
            'Любимый заказ',
            'Предлагаем возвращать 5% Чиками после оплаты и выдачи заказа.',
            'Посмотреть меню',
            'M06',
          ],
          [
            'game-controller-outline',
            'Поймай ритм в PICK BLOCKS',
            'Игра уже доступна. Наградные партии с проверкой результата готовятся.',
            'К играм',
            'M26',
          ],
          [
            'calendar-outline',
            'В своём ритме',
            'Миссия месяца: 3 выданных заказа в разные дни. Предлагаем +50 Чиков.',
            null,
            null,
          ],
          [
            'sparkles-outline',
            'Открой новый вкус',
            'Миссия месяца: получи заказы с двумя разными основными блюдами из подборки. Предлагаем +50 Чиков.',
            null,
            null,
          ],
        ] as const
      ).map(([icon, title, copy, action, target], index) => (
        <View key={title} style={s.mission}>
          <View style={s.missionIcon}>
            <Icon name={icon as IconName} size={24} color={colors.accent} />
          </View>
          <Text style={s.giftTitle}>{title}</Text>
          <Text style={s.copy}>{copy}</Text>
          {action && target ? (
            <Button
              testID={`ascent-mission-${index}`}
              title={action}
              secondary
              onPress={() => props.navigate(target)}
            />
          ) : (
            <Text style={s.missionSoon}>Миссия появится после запуска</Text>
          )}
        </View>
      ))}
      <Text style={s.note}>
        Предлагаем общий лимит 200 Чиков в месяц за игры и миссии. Уровни и подарки пока не
        начисляются. Игровой счёт PICK BLOCKS не равен Чикам.
      </Text>
      <HowItWorks />
    </Page>
  );
}

const s = StyleSheet.create({
  hero: {
    backgroundColor: '#0A2558',
    borderRadius: 28,
    overflow: 'hidden',
    minHeight: 380,
    justifyContent: 'space-between',
  },
  heroArt: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 260 },
  heroCopy: { padding: 20, gap: 12 },
  eyebrow: {
    fontFamily: font.bold,
    fontSize: 11,
    lineHeight: 16,
    letterSpacing: 1,
    color: '#C7DCFF',
  },
  proposal: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#102E59',
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 5,
    alignSelf: 'flex-start',
  },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: '#FFBA88' },
  proposalText: {
    fontFamily: font.bold,
    fontSize: 11,
    lineHeight: 16,
    letterSpacing: 1,
    color: '#FFCFAC',
  },
  heroTitle: {
    fontFamily: font.display,
    fontSize: 34,
    lineHeight: 37,
    color: colors.white,
    letterSpacing: -0.7,
  },
  heroSubtitle: { fontFamily: font.medium, fontSize: 14, lineHeight: 21, color: '#C6D7F3' },
  heroProgress: {
    margin: 14,
    padding: 14,
    borderRadius: 18,
    backgroundColor: '#061936ED',
    gap: 12,
  },
  heroProgressTitle: { fontFamily: font.bold, fontSize: 14, lineHeight: 20, color: colors.white },
  heroProgressCopy: {
    fontFamily: font.body,
    fontSize: 12,
    lineHeight: 18,
    color: '#B8CCE9',
    marginTop: 4,
  },
  track: { height: 5, borderRadius: 3, backgroundColor: '#264776', overflow: 'hidden' },
  fill: { height: 5, backgroundColor: colors.accent, borderRadius: 3 },
  balances: { flexDirection: 'row', gap: 10 },
  balanceCell: { flex: 1, padding: 16, borderRadius: 20, backgroundColor: colors.surface },
  balanceLabel: {
    fontFamily: font.bold,
    fontSize: 11,
    lineHeight: 16,
    color: colors.muted,
    letterSpacing: 0.6,
  },
  balanceNumber: { fontFamily: font.display, fontSize: 34, lineHeight: 43, color: colors.text },
  balanceHint: { fontFamily: font.body, fontSize: 12, lineHeight: 18, color: colors.muted },
  note: { fontFamily: font.body, fontSize: 12, lineHeight: 18, color: '#A8BCDE' },
  roadHeading: { gap: 8, marginBottom: 20 },
  sectionTitle: { fontSize: 24, lineHeight: 30 },
  road: { gap: 0 },
  stop: { flexDirection: 'row', alignItems: 'stretch', gap: 10 },
  rail: { width: 30, alignItems: 'center' },
  railLine: {
    position: 'absolute',
    top: 28,
    bottom: -15,
    width: 1,
    borderLeftWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#47618C',
  },
  node: {
    marginTop: 23,
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: '#395983',
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nodeReached: { backgroundColor: colors.accent, borderColor: colors.accent },
  nodeNext: { borderColor: colors.accent },
  nodeText: { fontFamily: font.bold, fontSize: 12, lineHeight: 17, color: colors.muted },
  peakCard: {
    flex: 1,
    minWidth: 0,
    marginBottom: 14,
    padding: 14,
    borderRadius: 23,
    borderWidth: 1,
    borderColor: '#213C67',
    backgroundColor: '#0C2247',
  },
  nextCard: { borderColor: '#C08863', backgroundColor: '#102C59' },
  peakTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  peakOverline: {
    flex: 1,
    fontFamily: font.bold,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 0.8,
    color: '#9DB9E2',
  },
  peakName: {
    fontFamily: font.display,
    fontSize: 21,
    lineHeight: 25,
    color: colors.text,
    marginTop: 4,
  },
  peakThreshold: {
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 20,
    color: '#FFD2AC',
    marginTop: 6,
  },
  peakArt: { width: 94, height: 72 },
  rewardRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#345074',
    paddingTop: 12,
    marginTop: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rewardText: { flex: 1, fontFamily: font.medium, fontSize: 13, lineHeight: 19, color: '#DCE8FF' },
  finish: {
    flexDirection: 'row',
    gap: 8,
    padding: 8,
    paddingLeft: 40,
    marginTop: 2,
    alignItems: 'center',
  },
  finishText: {
    flex: 1,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 18,
    color: colors.muted,
  },
  shade: { flex: 1, backgroundColor: '#010B22D9', paddingHorizontal: 18 },
  modalScroll: { flexGrow: 1, justifyContent: 'center' },
  sheet: {
    backgroundColor: '#0C2348',
    borderRadius: 28,
    padding: 20,
    gap: 16,
    borderWidth: 1,
    borderColor: '#355788',
  },
  sheetTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetMountain: { height: 170, width: '100%' },
  sheetTitle: {
    fontFamily: font.display,
    fontSize: 32,
    lineHeight: 38,
    color: colors.white,
    textAlign: 'center',
  },
  sheetPoints: {
    fontFamily: font.bold,
    fontSize: 16,
    lineHeight: 23,
    color: colors.accentText,
    textAlign: 'center',
  },
  giftPanel: {
    backgroundColor: '#163765',
    padding: 16,
    borderRadius: 20,
    gap: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  giftTitle: { fontFamily: font.bold, fontSize: 17, lineHeight: 24, color: colors.text },
  copy: { fontFamily: font.body, fontSize: 14, lineHeight: 22, color: '#C8D8EF' },
  explainer: { backgroundColor: colors.surface, borderRadius: 20, overflow: 'hidden' },
  explainerButton: {
    minHeight: 56,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  explainerTitle: {
    flex: 1,
    fontFamily: font.bold,
    fontSize: 14,
    lineHeight: 21,
    color: colors.text,
  },
  explainerBody: { padding: 16, paddingTop: 0, gap: 12 },
  missionHero: { gap: 16, paddingVertical: 8 },
  missionTitle: { fontSize: 32, lineHeight: 36 },
  comboGift: {
    padding: 20,
    borderRadius: 26,
    backgroundColor: '#0E2D60',
    gap: 14,
    overflow: 'hidden',
  },
  comboMountain: {
    position: 'absolute',
    width: 155,
    height: 135,
    right: -12,
    top: 10,
    opacity: 0.5,
  },
  comboTitle: {
    fontFamily: font.display,
    fontSize: 29,
    lineHeight: 34,
    color: colors.white,
    maxWidth: 250,
  },
  mission: { backgroundColor: colors.surface, borderRadius: 23, padding: 18, gap: 12 },
  missionIcon: {
    width: 46,
    height: 46,
    borderRadius: 16,
    backgroundColor: '#213A60',
    alignItems: 'center',
    justifyContent: 'center',
  },
  missionSoon: { fontFamily: font.medium, fontSize: 12, lineHeight: 18, color: '#ADBFD9' },
});
