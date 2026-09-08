import { usePublishedContent } from '../backoffice/usePublishedContent';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Image } from 'expo-image';
import {
  Animated,
  AppState,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { assets } from '../assets';
import { colors, font } from '../theme';
import type { ScreenProps } from '../model';
import { useGameCardHeight } from '../games/ArcadeCard';
import { PickBlocksCard } from '../games/pick-blocks/visuals';
import { PickManCard } from '../games/pick-man/visuals';
import {
  Body,
  Button,
  Caption,
  Card,
  Heading,
  Icon,
  Notice,
  Page,
  Pill,
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

        <View testID="events-streak" style={s.streakCard}>
          <Image source={assets.skyline} style={s.skyline} contentFit="cover" />
          <Row style={{ alignItems: 'flex-start' }}>
            <View style={ui.flex}>
              <Caption style={s.streakLabel}>СТРИК ЗАКАЗОВ · АЛМАТЫ</Caption>
              <Row style={s.streakCountRow}>
                <Text style={s.streakCount}>{props.preview ? '5' : '-'}</Text>
                <Text style={s.streakWeeks}>недели подряд</Text>
              </Row>
            </View>
            <View style={s.freezeChip}>
              <Icon name="snow-outline" size={13} color={colors.muted} />
              <Text style={s.freezeLabel}>{props.preview ? 'Пример' : 'Скоро'}</Text>
            </View>
          </Row>
          <View style={s.streakTrack}>
            {props.preview ? <View style={s.streakFill} /> : null}
            {['Соус', 'Лимонад', '−30%', 'Комбо'].map((label, index) => (
              <View
                key={label}
                style={[
                  s.streakFlag,
                  { left: `${(index + 1) * 25}%`, marginLeft: index === 3 ? -45 : -36 },
                ]}
              >
                <View style={[s.streakMarker, props.preview && index < 2 && s.streakMarkerDone]}>
                  <Text
                    style={[s.streakWeekNumber, props.preview && index < 2 && { color: '#C2410C' }]}
                  >
                    {(index + 1) * 2}
                  </Text>
                </View>
                <Text style={s.streakReward}>{props.preview ? label : 'Неделя'}</Text>
              </View>
            ))}
          </View>
          {!props.preview ? (
            <Caption style={s.streakHint}>
              Программа готовится · прогресс ещё не начисляется
            </Caption>
          ) : null}
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
type GameStatus = 'idle' | 'running' | 'paused';
export function Game(props: ScreenProps) {
  const [status, setStatus] = useState<GameStatus>('idle');
  const [seconds, setSeconds] = useState(30);
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(3);
  const [width, setWidth] = useState(340);
  const position = useRef(new Animated.Value(340)).current;
  const jump = useRef(new Animated.Value(0)).current;
  const session = useRef({
    remaining: 30000,
    x: 340,
    score: 0,
    lives: 3,
    jumpRemaining: 0,
    passed: false,
  });
  const finish = useRef(() => {});
  finish.current = () => {
    props.model.setPracticeScore(session.current.score);
    setStatus('idle');
    props.navigate('M28');
  };
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') setStatus((current) => (current === 'running' ? 'paused' : current));
    });
    return () => subscription.remove();
  }, []);
  useFocusEffect(
    useCallback(
      () => () => {
        setStatus((current) => (current === 'running' ? 'paused' : current));
      },
      [],
    ),
  );
  useEffect(() => {
    if (status !== 'running') {
      jump.stopAnimation();
      return;
    }
    let last = Date.now();
    let frame = 0;
    const tick = () => {
      const now = Date.now();
      const delta = Math.min(now - last, 80);
      last = now;
      const game = session.current;
      game.remaining = Math.max(0, game.remaining - delta);
      game.jumpRemaining = Math.max(0, game.jumpRemaining - delta);
      game.x -= delta * (0.18 + Math.min(game.score, 8) * 0.012);
      if (game.x <= 85 && !game.passed) {
        game.passed = true;
        if (game.jumpRemaining > 60) {
          game.score += 1;
          setScore(game.score);
        } else {
          game.lives -= 1;
          setLives(game.lives);
        }
      }
      if (game.x < -35) {
        game.x = width + 45;
        game.passed = false;
      }
      position.setValue(game.x);
      jump.setValue(
        game.jumpRemaining > 0 ? -Math.sin((1 - game.jumpRemaining / 620) * Math.PI) * 115 : 0,
      );
      setSeconds(Math.ceil(game.remaining / 1000));
      if (game.remaining === 0 || game.lives === 0) {
        finish.current();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [status, position, jump, width]);
  function start() {
    session.current = {
      remaining: 30000,
      x: width + 45,
      score: 0,
      lives: 3,
      jumpRemaining: 0,
      passed: false,
    };
    props.model.setPracticeScore(null);
    setScore(0);
    setLives(3);
    setSeconds(30);
    position.setValue(width + 45);
    jump.setValue(0);
    setStatus('running');
  }
  function leap() {
    if (status === 'running' && session.current.jumpRemaining === 0)
      session.current.jumpRemaining = 620;
  }
  return (
    <Page props={props} title="Pick Run">
      <Row>
        <Pill>Тренировка</Pill>
        <Caption style={ui.flex}>Без начисления Чиков</Caption>
      </Row>
      <Row style={s.gameStats}>
        <View>
          <Caption>ОЧКИ</Caption>
          <Heading small>{score}</Heading>
        </View>
        <View>
          <Caption>ВРЕМЯ</Caption>
          <Heading small>{seconds} с</Heading>
        </View>
        <View>
          <Caption>ПОПЫТКИ</Caption>
          <Row style={{ gap: 3 }}>
            {[0, 1, 2].map((index) => (
              <Icon
                key={index}
                name={index < lives ? 'heart' : 'heart-outline'}
                size={20}
                color={colors.accent}
              />
            ))}
          </Row>
        </View>
      </Row>
      <Pressable
        testID="game-field"
        accessibilityRole="button"
        accessibilityLabel="Игровое поле. Нажмите, чтобы перепрыгнуть препятствие"
        disabled={status !== 'running'}
        onPress={leap}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={s.gameField}
      >
        <View style={s.sun} />
        <View style={s.gameCloudOne} />
        <View style={s.gameCloudTwo} />
        <View style={s.mountainA} />
        <View style={s.mountainB} />
        <View style={s.ground} />
        <View style={s.roadLine} />
        <Animated.View style={[s.runner, { transform: [{ translateY: jump }] }]}>
          <View style={s.runnerBody}>
            <Icon name="flash" size={31} color={colors.orangeInk} />
          </View>
          <View style={s.runnerFeet}>
            <View style={s.runnerFoot} />
            <View style={s.runnerFoot} />
          </View>
        </Animated.View>
        <Animated.View style={[s.obstacle, { transform: [{ translateX: position }] }]}>
          <Icon name="flame" size={28} color={colors.orangeInk} />
        </Animated.View>
        {status !== 'running' ? (
          <View style={s.gameOverlay}>
            <Heading style={{ textAlign: 'center' }}>
              {status === 'paused' ? 'Пауза' : 'Готовы к забегу?'}
            </Heading>
            <Body style={{ textAlign: 'center' }}>
              {status === 'paused'
                ? 'Продолжите, когда будете готовы'
                : 'Прыгайте через препятствия одним касанием'}
            </Body>
          </View>
        ) : null}
      </Pressable>
      {status === 'idle' ? (
        <Button title="Начать тренировку" testID="game-start" onPress={start} />
      ) : status === 'paused' ? (
        <Button title="Продолжить" testID="game-resume" onPress={() => setStatus('running')} />
      ) : (
        <Row>
          <Button title="Прыжок" testID="game-jump" onPress={leap} style={ui.flex} />
          <Button title="Пауза" testID="game-pause" secondary onPress={() => setStatus('paused')} />
        </Row>
      )}
      <Caption style={{ textAlign: 'center' }}>
        30 секунд, три попытки. За каждое преодолённое препятствие - одно игровое очко.
      </Caption>
      <Notice>
        Результат сохраняется только в этой сессии приложения. Доступ к кошельку и бонусам игре не
        предоставлен.
      </Notice>
    </Page>
  );
}
export function GameResult(props: ScreenProps) {
  const score = props.model.practiceScore;
  return (
    <Page props={props} title="Твой результат">
      <View style={s.resultHero}>
        <View style={s.trophy}>
          <Icon name="trophy" color={colors.accent} size={66} />
        </View>
        <Heading style={{ textAlign: 'center' }}>
          {score === null ? 'Твой пик впереди' : 'Хороший забег!'}
        </Heading>
        <Caption>ТРЕНИРОВОЧНЫЙ РЕЗУЛЬТАТ</Caption>
        <Text style={s.resultScore}>{score === null ? '-' : score}</Text>
        <Body muted>игровых очков</Body>
      </View>
      <Card>
        <Row>
          <Icon name="sparkles-outline" color={colors.accent} />
          <View style={ui.flex}>
            <Body style={{ fontFamily: font.bold }}>Чики не начисляются</Body>
            <Caption>Этот забег - для тренировки</Caption>
          </View>
        </Row>
      </Card>
      <Button
        title={score === null ? 'Начать тренировку' : 'Попробовать ещё раз'}
        testID="game-replay"
        onPress={() => props.navigate('M27')}
      />
      <Button title="К событиям" secondary onPress={() => props.navigate('M26')} />
    </Page>
  );
}
const s = StyleSheet.create({
  eventsPage: { flex: 1, minHeight: 0, backgroundColor: colors.background },
  eventsContent: { paddingHorizontal: 18 },
  eventsTitle: { fontFamily: font.display, fontSize: 34, lineHeight: 41, letterSpacing: -0.68 },
  eventsSubtitle: { fontSize: 14, lineHeight: 21, marginTop: 6 },
  streakCard: {
    marginTop: 18,
    padding: 18,
    borderRadius: 24,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  skyline: { position: 'absolute', left: 0, right: 0, top: 0, height: 118, opacity: 0.4 },
  streakLabel: { fontFamily: font.bold, fontSize: 10.5, letterSpacing: 1.26, lineHeight: 15 },
  streakCountRow: { alignItems: 'baseline', gap: 7, marginTop: 5 },
  streakCount: { fontFamily: font.display, color: colors.accent, fontSize: 38, lineHeight: 42 },
  streakWeeks: { fontFamily: font.heading, color: colors.text, fontSize: 17 },
  freezeChip: {
    flexDirection: 'row',
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 20,
    backgroundColor: colors.raised,
    alignItems: 'center',
  },
  freezeLabel: { fontFamily: font.bold, fontSize: 11.5, color: colors.muted },
  streakTrack: {
    marginTop: 40,
    marginBottom: 38,
    height: 10,
    borderRadius: 6,
    backgroundColor: colors.raised,
  },
  streakFill: { width: '62%', height: 10, borderRadius: 6, backgroundColor: colors.accent },
  streakFlag: { position: 'absolute', top: -12, width: 72, alignItems: 'center' },
  streakMarker: {
    width: 24,
    height: 34,
    borderRadius: 7,
    backgroundColor: colors.raised,
    borderWidth: 2,
    borderColor: colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
  },
  streakMarkerDone: { backgroundColor: '#FFFFFF', borderColor: colors.accent },
  streakWeekNumber: { fontFamily: font.display, fontSize: 11.5, color: colors.muted },
  streakReward: { marginTop: 8, fontFamily: font.medium, fontSize: 11, color: colors.muted },
  streakHint: { fontSize: 11, lineHeight: 16 },
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
  gameStats: { paddingVertical: 4, justifyContent: 'space-between' },
  gameField: { height: 305, borderRadius: 24, backgroundColor: '#235491', overflow: 'hidden' },
  sun: {
    position: 'absolute',
    top: 28,
    right: 25,
    width: 57,
    height: 57,
    borderRadius: 29,
    backgroundColor: '#FFBC72',
  },
  gameCloudOne: {
    position: 'absolute',
    top: 44,
    left: 23,
    width: 79,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#92B8E4',
  },
  gameCloudTwo: {
    position: 'absolute',
    top: 81,
    right: 72,
    width: 54,
    height: 17,
    borderRadius: 9,
    backgroundColor: '#92B8E4',
  },
  mountainA: {
    position: 'absolute',
    bottom: 62,
    left: -55,
    width: 250,
    height: 180,
    borderTopLeftRadius: 130,
    borderTopRightRadius: 130,
    backgroundColor: '#173C72',
    transform: [{ rotate: '-16deg' }],
  },
  mountainB: {
    position: 'absolute',
    bottom: 60,
    right: -40,
    width: 200,
    height: 146,
    borderTopLeftRadius: 100,
    borderTopRightRadius: 100,
    backgroundColor: '#0A2C5D',
  },
  ground: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 63,
    backgroundColor: '#10244C',
    borderTopWidth: 5,
    borderTopColor: '#FF9D59',
  },
  roadLine: {
    position: 'absolute',
    bottom: 25,
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: '#30466B',
  },
  runner: {
    position: 'absolute',
    bottom: 64,
    left: 46,
    width: 45,
    height: 58,
    alignItems: 'center',
  },
  runnerBody: {
    width: 43,
    height: 44,
    borderRadius: 15,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-7deg' }],
  },
  runnerFeet: { flexDirection: 'row', gap: 7 },
  runnerFoot: { width: 14, height: 12, backgroundColor: '#FFBC72', borderRadius: 5 },
  obstacle: {
    position: 'absolute',
    bottom: 64,
    left: 0,
    width: 31,
    height: 43,
    borderRadius: 8,
    backgroundColor: '#FFBC72',
    alignItems: 'center',
    justifyContent: 'center',
  },
  gameOverlay: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#04143ABF',
    justifyContent: 'center',
    padding: 24,
    gap: 15,
  },
  resultHero: { paddingVertical: 20, gap: 15, alignItems: 'center' },
  trophy: {
    width: 130,
    height: 130,
    borderRadius: 45,
    backgroundColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  resultScore: { fontFamily: font.display, fontSize: 84, lineHeight: 96, color: colors.accent },
});
