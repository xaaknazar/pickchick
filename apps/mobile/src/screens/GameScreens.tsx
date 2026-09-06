import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Image } from 'expo-image';
import { Animated, AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { assets } from '../assets';
import { colors, font } from '../theme';
import type { ScreenProps } from '../model';
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
  Row,
  styles as ui,
} from '../components/UI';

export function Events(props: ScreenProps) {
  return (
    <Page props={props} title="События" noBack>
      <Heading>Играй. Собирай.{`\n`}Открывай новое.</Heading>
      <Body muted>Ещё один повод заглянуть к нам.</Body>
      <Pressable
        testID="pickrun-open"
        accessibilityRole="button"
        accessibilityLabel="Играть в Pick Run, тренировочный режим"
        onPress={() => props.navigate('M27')}
        style={s.eventPoster}
      >
        <Image source={assets.pickrun} style={StyleSheet.absoluteFill} contentFit="cover" />
        <View style={s.eventBadge}>
          <Pill>Доступно · тренировка</Pill>
        </View>
      </Pressable>
      <Row>
        <View style={ui.flex}>
          <Heading small>Pick Run</Heading>
          <Caption>Твой хрустящий забег</Caption>
        </View>
        <Button title="Играть" onPress={() => props.navigate('M27')} />
      </Row>
      <Notice>
        Тренировка работает на устройстве. Игровые очки не превращаются в Чики и не дают денежные
        награды.
      </Notice>
      <View style={s.nextEvent}>
        <Image
          source={assets.blue}
          style={[StyleSheet.absoluteFill, { opacity: 0.32 }]}
          contentFit="cover"
        />
        <Caption style={{ color: '#DFE9FF' }}>СКОРО</Caption>
        <Heading>Больше поводов{`\n`}заглянуть к нам</Heading>
        <Body>Следи за событиями Pick Chick</Body>
      </View>
    </Page>
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
        30 секунд, три попытки. За каждое преодолённое препятствие — одно игровое очко.
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
        <Text style={s.resultScore}>{score === null ? '—' : score}</Text>
        <Body muted>игровых очков</Body>
      </View>
      <Card>
        <Row>
          <Icon name="sparkles-outline" color={colors.accent} />
          <View style={ui.flex}>
            <Body style={{ fontFamily: font.bold }}>Чики не начисляются</Body>
            <Caption>Этот забег — для тренировки</Caption>
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
  eventPoster: {
    height: 350,
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: colors.action,
  },
  eventBadge: { position: 'absolute', bottom: 16, left: 16 },
  nextEvent: {
    backgroundColor: colors.action,
    borderRadius: 24,
    overflow: 'hidden',
    padding: 24,
    minHeight: 225,
    gap: 17,
    justifyContent: 'center',
  },
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
