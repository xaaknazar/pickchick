import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  AccessibilityInfo,
  BackHandler,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, {
  runOnUI,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  type FrameInfo,
} from 'react-native-reanimated';
import { advanceMotion, createMotion, queueMotion } from './motion';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon, Logo } from '../../components/UI';
import { colors, font } from '../../theme';
import {
  COLS,
  ROWS,
  FOOD_IDS,
  stepDuration,
  foodKind,
  type Actor,
  type Direction,
  type MazeGame,
} from './engine';
import { Chick, FoodIcon, MazeWalls, Rival } from './visuals';
import { usePickMan } from './usePickMan';
import { assets } from '../../assets';
import {
  ArcadeButton as Button,
  ArcadeBackdrop,
  ArcadeFeedback,
  ArcadeIntro,
  arcade,
} from '../ArcadeExperience';

function useReducedMotion() {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (active) setReduced(v);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      active = false;
      sub.remove();
    };
  }, []);
  return reduced;
}
const FoodTile = memo(function FoodTile({ id, cell }: { id: number; cell: number }) {
  return (
    <View
      style={{
        position: 'absolute',
        left: (id % COLS) * cell + cell * 0.15,
        top: Math.floor(id / COLS) * cell + cell * 0.15,
      }}
    >
      <FoodIcon kind={foodKind(id)} size={cell * 0.7} />
    </View>
  );
});
const FoodLayer = memo(function FoodLayer({
  remaining,
  cell,
}: {
  remaining: number[];
  cell: number;
}) {
  return (
    <>
      {remaining.map((id) => (
        <FoodTile key={id} id={id} cell={cell} />
      ))}
    </>
  );
});
function MovingActor({
  actor,
  cell,
  duration,
  reduced,
  playing,
  reset,
  epoch,
  enemy = false,
  variant = 0,
  scared = false,
  shield = false,
}: {
  actor: Actor;
  cell: number;
  duration: number;
  reduced: boolean;
  playing: boolean;
  reset: boolean;
  epoch: string;
  enemy?: boolean;
  variant?: number;
  scared?: boolean;
  shield?: boolean;
}) {
  const motion = useSharedValue(createMotion(actor));
  const running = useSharedValue(false);
  const interval = useSharedValue(duration);
  const previous = useRef({ cell, epoch });
  useLayoutEffect(() => {
    const forceReset =
      reset || reduced || previous.current.cell !== cell || previous.current.epoch !== epoch;
    previous.current = { cell, epoch };
    runOnUI((target: Actor, force: boolean, active: boolean, stepMs: number) => {
      'worklet';
      motion.value = queueMotion(motion.value, target, force);
      interval.value = stepMs;
      running.value = active;
    })(actor, forceReset, playing && !reduced, duration);
  }, [
    actor.x,
    actor.y,
    actor.direction,
    cell,
    duration,
    epoch,
    reset,
    playing,
    reduced,
    motion,
    running,
    interval,
  ]);
  const updateFrame = useCallback(
    (frame: FrameInfo) => {
      'worklet';
      if (running.value && frame.timeSincePreviousFrame !== null) {
        motion.value = advanceMotion(motion.value, frame.timeSincePreviousFrame, interval.value);
      }
    },
    [motion, running, interval],
  );
  const frame = useFrameCallback(updateFrame, false);
  useEffect(() => {
    frame.setActive(playing && !reduced);
    return () => frame.setActive(false);
  }, [frame, playing, reduced]);
  const position = useAnimatedStyle(() => ({
    transform: [{ translateX: motion.value.x * cell }, { translateY: motion.value.y * cell }],
  }));
  const facing = useAnimatedStyle(() => ({
    transform: [
      {
        rotate:
          motion.value.direction === 'up'
            ? '-90deg'
            : motion.value.direction === 'down'
              ? '90deg'
              : '0deg',
      },
      { scaleX: motion.value.direction === 'left' ? -1 : 1 },
    ],
  }));
  return (
    <Animated.View
      testID={enemy ? `pick-man-rival-${variant}` : 'pick-man-player'}
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          left: 0,
          top: 0,
          width: cell,
          height: cell,
          backgroundColor: shield ? '#FFC57655' : enemy ? 'transparent' : '#FFAA4026',
          borderWidth: shield ? 1 : 0,
          borderColor: '#FFD68E',
          borderRadius: cell / 2,
        },
        position,
      ]}
    >
      <View style={{ position: 'absolute', left: -cell * 0.04, top: -cell * 0.04 }}>
        {enemy ? (
          <Rival size={cell * 1.08} scared={scared} variant={variant} />
        ) : (
          <Animated.View style={facing}>
            <Chick size={cell * 1.08} />
          </Animated.View>
        )}
      </View>
    </Animated.View>
  );
}
function MazeBoard({
  game,
  cell,
  reduced,
  playing,
  steer,
}: {
  game: MazeGame;
  cell: number;
  reduced: boolean;
  playing: boolean;
  steer(d: Direction): void;
}) {
  const live = useRef({ playing, steer });
  live.current = { playing, steer };
  const origin = useRef({ x: 0, y: 0 });
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => live.current.playing,
      onMoveShouldSetPanResponder: () => live.current.playing,
      onPanResponderGrant: () => {
        origin.current = { x: 0, y: 0 };
      },
      onPanResponderMove: (_, gesture) => {
        if (!live.current.playing || gesture.numberActiveTouches !== 1) return;
        const dx = gesture.dx - origin.current.x,
          dy = gesture.dy - origin.current.y;
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 14) return;
        live.current.steer(
          Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up',
        );
        origin.current = { x: gesture.dx, y: gesture.dy };
      },
      onPanResponderTerminationRequest: () => true,
    }),
  ).current;
  return (
    <View
      testID="pick-man-swipe-area"
      {...pan.panHandlers}
      accessible
      accessibilityActions={[
        { name: 'left', label: 'Влево' },
        { name: 'right', label: 'Вправо' },
        { name: 'up', label: 'Вверх' },
        { name: 'down', label: 'Вниз' },
      ]}
      onAccessibilityAction={({ nativeEvent }) => {
        const direction = nativeEvent.actionName as Direction;
        if (live.current.playing && ['left', 'right', 'up', 'down'].includes(direction))
          live.current.steer(direction);
      }}
      accessibilityLabel="Лабиринт Pick Man. Свайпните влево, вправо, вверх или вниз, чтобы направить Чика."
      style={{
        flex: 1,
        width: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        ...(Platform.OS === 'web' ? { touchAction: 'none' } : {}),
      }}
    >
      <View style={[s.boardHeading, { width: COLS * cell }]} pointerEvents="none">
        <View style={s.boardLabel}>
          <View style={s.statusDot} />
          <Text style={s.boardTitle}>СОБЕРИ СВОЙ ВКУС</Text>
        </View>
        <Text style={s.boardMeta}>
          {game.power > 0
            ? `Соус: ${Math.ceil((game.power * stepDuration(game.level)) / 1000)} с`
            : `${game.remaining.length} осталось`}
        </Text>
      </View>
      <View
        testID="pick-man-board"
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          width: COLS * cell,
          height: ROWS * cell,
          backgroundColor: '#060F22',
          borderRadius: cell * 0.4,
          overflow: 'hidden',
        }}
      >
        <MazeWalls cell={cell} />
        <FoodLayer remaining={game.remaining} cell={cell} />
        {game.enemies.map((actor, i) => (
          <MovingActor
            key={i}
            actor={actor}
            cell={cell}
            duration={stepDuration(game.level)}
            reduced={reduced}
            playing={playing}
            reset={game.ticks === 0}
            epoch={`${game.level}:${game.lives}`}
            enemy
            variant={i}
            scared={game.power > 0}
          />
        ))}
        <MovingActor
          actor={game.player}
          cell={cell}
          duration={stepDuration(game.level)}
          reduced={reduced}
          playing={playing}
          reset={game.ticks === 0}
          epoch={`${game.level}:${game.lives}`}
          shield={game.shield > 0}
        />
      </View>
      <View style={[s.gestureStatus, { width: COLS * cell }]} pointerEvents="none">
        <Text style={s.gestureText} numberOfLines={1}>
          {game.power > 0
            ? 'Острый режим!'
            : game.shield > 0
              ? 'Чик под защитой'
              : 'Управляй свайпами по полю'}
        </Text>
        <View
          testID="pick-man-power"
          accessibilityRole="progressbar"
          accessibilityLabel="Защита фирменного соуса"
          accessible
          aria-valuemin={0}
          aria-valuemax={42}
          aria-valuenow={game.power}
          style={[s.powerTrack, { opacity: game.power > 0 ? 1 : 0 }]}
        >
          <View style={[s.powerFill, { width: `${(game.power / 42) * 100}%` }]} />
        </View>
      </View>
    </View>
  );
}
export function PickManScreen() {
  const router = useRouter(),
    controller = usePickMan(),
    reduced = useReducedMotion();
  const { width, height } = useWindowDimensions(),
    wide = width > height;
  const [region, setRegion] = useState({ width: 0, height: 0 });
  const [help, setHelp] = useState(false),
    [restart, setRestart] = useState(false);
  const { game, status, best } = controller;
  const playing = status === 'playing';
  const last = useRef({ score: 0, lives: 3, power: 0, level: 1 });
  const [feedback, setFeedback] = useState({ event: 0, text: '', danger: false });
  useEffect(() => {
    if (!game || status !== 'playing') return;
    const before = last.current;
    if (
      game.lives < before.lives ||
      (game.power > before.power && game.power === 42) ||
      (game.level === before.level && game.score - before.score >= 200)
    ) {
      const danger = game.lives < before.lives;
      setFeedback({
        event: game.ticks,
        danger,
        text: danger
          ? 'Ты под защитой. Продолжай!'
          : game.power > before.power
            ? 'Острый режим! +50'
            : 'Пойман! +200',
      });
    }
    last.current = { score: game.score, lives: game.lives, power: game.power, level: game.level };
  }, [game, status]);
  const cell = Math.min(region.width / COLS, (region.height - 56) / ROWS);
  const compact = height < 680;
  const collected = game ? FOOD_IDS.length - game.remaining.length : 0;
  const tooSmall = region.width > 0 && cell < 10;
  const close = useCallback(() => {
    controller.pause();
    router.replace('/(tabs)/events');
  }, [controller.pause, router]);
  const openHelp = useCallback(() => {
    controller.pause();
    setHelp(true);
  }, [controller.pause]);
  useEffect(() => {
    controller.pause();
  }, [width, height, controller.pause]);
  useEffect(() => {
    if (tooSmall) controller.pause();
  }, [tooSmall, controller.pause]);
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      if (help) {
        setHelp(false);
        return true;
      }
      if (restart) {
        setRestart(false);
        return true;
      }
      if (playing) {
        controller.pause();
        return true;
      }
      close();
      return true;
    });
    return () => listener.remove();
  }, [close, controller.pause, help, playing, restart]);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const key = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const direction = (
        {
          ArrowUp: 'up',
          ArrowDown: 'down',
          ArrowLeft: 'left',
          ArrowRight: 'right',
          w: 'up',
          s: 'down',
          a: 'left',
          d: 'right',
        } as Record<string, Direction>
      )[event.key];
      if (direction && playing && !help && !restart) {
        event.preventDefault();
        controller.steer(direction);
      }
      if (event.key === 'Escape' || event.key.toLowerCase() === 'p') {
        event.preventDefault();
        controller.pause();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [controller.pause, controller.steer, help, playing, restart]);
  const overlay = help || restart || status === 'paused' || status === 'over' || status === 'won';
  return (
    <SafeAreaView testID="pick-man-screen" style={s.page}>
      <ArcadeBackdrop />
      <View style={[s.header, compact && { height: wide ? 48 : 58 }]}>
        <Pressable
          testID="pick-man-exit"
          accessibilityRole="button"
          accessibilityLabel="К событиям"
          onPress={close}
          style={({ pressed }) => [s.icon, pressed && s.iconPressed]}
        >
          <Icon name="arrow-back" size={24} />
        </Pressable>
        <View style={s.brand}>
          <Logo size={30} />
          <Text style={s.name}>PICK MAN</Text>
        </View>
        <Pressable
          testID={playing ? 'pick-man-pause' : 'pick-man-help'}
          accessibilityRole="button"
          accessibilityLabel={playing ? 'Пауза' : 'Как играть'}
          onPress={playing ? controller.pause : openHelp}
          style={({ pressed }) => [s.icon, pressed && s.iconPressed]}
        >
          <Icon name={playing ? 'pause' : 'help-circle-outline'} size={24} />
        </Pressable>
      </View>
      {status === 'loading' ? (
        <View style={s.center}>
          <Text style={s.body}>Готовим вкусный маршрут…</Text>
        </View>
      ) : status === 'ready' ? (
        <ArcadeIntro
          cover={assets.pickManCover}
          title="Охота за вкусом."
          subtitle="Твой Чик. Любимое меню. Целый лабиринт приключений."
          best={best}
          testID="pick-man-start"
          onStart={controller.start}
          disabled={controller.storageError}
          steps={[
            ['move-outline', 'Задай направление', 'Свайпай по полю в нужную сторону.'],
            ['fast-food-outline', 'Собери всё меню', 'Бургер +30 · фингерсы +20 · кола +10.'],
            ['flash-outline', 'Добавь остроты', 'Фирменный соус даёт защиту от соперников.'],
          ]}
        />
      ) : game ? (
        <View style={[s.gameLayout, wide && s.gameLayoutWide]}>
          <View style={[s.stats, compact && s.statsCompact, wide && s.statsWide]}>
            <View style={[s.statCard, s.scoreCard, compact && s.statCompact]}>
              <Text style={s.caption}>СЧЁТ</Text>
              <Text
                testID="pick-man-score"
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.55}
                style={[
                  s.score,
                  {
                    fontSize:
                      game.score >= 10000000
                        ? 10
                        : game.score >= 1000000
                          ? 12
                          : game.score >= 100000
                            ? 14
                            : game.score >= 10000
                              ? 17
                              : 25,
                  },
                ]}
              >
                {game.score.toLocaleString('ru-RU')}
              </Text>
            </View>
            <View style={[s.statCard, compact && s.statCompact]}>
              <Text style={s.caption}>УРОВЕНЬ {game.level}</Text>
              <Text testID="pick-man-remaining" style={s.count}>
                {collected} / {FOOD_IDS.length}
              </Text>
              <View
                testID="pick-man-progress"
                accessibilityRole="progressbar"
                accessibilityLabel="Блюда собраны"
                accessible
                aria-valuemin={0}
                aria-valuemax={FOOD_IDS.length}
                aria-valuenow={collected}
                style={s.progressTrack}
              >
                <View
                  style={[s.progressFill, { width: `${(collected / FOOD_IDS.length) * 100}%` }]}
                />
              </View>
            </View>
            <View style={[s.statCard, compact && s.statCompact]}>
              <Text style={s.caption}>ЖИЗНИ</Text>
              <Text
                testID="pick-man-lives"
                accessibilityLabel={`${game.lives} жизни`}
                style={s.lives}
              >
                {'♥'.repeat(game.lives)}
                {'♡'.repeat(3 - game.lives)}
              </Text>
            </View>
          </View>
          <View style={[s.main, wide && { paddingBottom: 0 }]}>
            <View
              testID="pick-man-stage"
              onLayout={(e) => setRegion(e.nativeEvent.layout)}
              style={s.stage}
            >
              <ArcadeFeedback
                event={feedback.event}
                text={feedback.text}
                danger={feedback.danger}
                reduced={reduced}
              />
              {cell >= 10 ? (
                <MazeBoard
                  game={game}
                  cell={cell}
                  reduced={reduced}
                  playing={playing}
                  steer={controller.steer}
                />
              ) : tooSmall ? (
                <Text style={[s.body, s.centerText]}>
                  Поверните телефон, чтобы поместился лабиринт.
                </Text>
              ) : null}
            </View>
            {overlay ? (
              <View testID="pick-man-overlay" style={s.scrim}>
                <ScrollView contentContainerStyle={s.overlayScroll}>
                  <View style={s.dialog}>
                    <View style={s.dialogBadge}>
                      <Icon
                        name={
                          help
                            ? 'help-circle-outline'
                            : restart
                              ? 'refresh'
                              : status === 'won'
                                ? 'trophy-outline'
                                : status === 'over'
                                  ? 'flag-outline'
                                  : 'pause'
                        }
                        size={30}
                        color="#FFB878"
                      />
                    </View>
                    <Text testID="pick-man-dialog-title" style={s.dialogTitle}>
                      {help
                        ? 'Как играть'
                        : restart
                          ? 'Новая партия?'
                          : status === 'won'
                            ? 'Вкусная победа!'
                            : status === 'over'
                              ? 'Отличный забег.'
                              : 'Перекусим?'}
                    </Text>
                    <Text style={[s.body, s.centerText]}>
                      {help
                        ? 'Свайп влево, вправо, вверх или вниз задаёт направление. Чик движется сам; у стены поворот выполнится в ближайшем проходе. Соберите все блюда и не попадитесь соперникам. Фирменный соус на время позволяет ловить их.'
                        : restart
                          ? 'Текущая партия закончится. Личный рекорд сохранится.'
                          : status === 'won'
                            ? 'Все блюда собраны. Следующий маршрут будет немного быстрее.'
                            : status === 'over'
                              ? `Твой счёт - ${game.score}. Рекорд - ${best}. Ещё один вкусный маршрут?`
                              : 'Игра на паузе. Продолжим, когда будешь готов.'}
                    </Text>
                    {help ? (
                      <>
                        <View style={s.legend}>
                          <FoodIcon kind="power" size={32} />
                          <Text style={s.small}>Фирменный соус: +50 · соперник: +200</Text>
                        </View>
                        <Text style={[s.caption, s.centerText]}>
                          Очки и рекорд сохраняются на этом устройстве. Чики за игру не начисляются.
                        </Text>
                        <Button
                          testID="pick-man-help-close"
                          title="Всё понятно"
                          onPress={() => setHelp(false)}
                        />
                      </>
                    ) : restart ? (
                      <>
                        <Button
                          testID="pick-man-restart-confirm"
                          title="Начать заново"
                          onPress={() => {
                            setRestart(false);
                            controller.start();
                          }}
                        />
                        <Button
                          title="Остаться в игре"
                          secondary
                          onPress={() => setRestart(false)}
                        />
                      </>
                    ) : (
                      <>
                        <Button
                          testID={
                            status === 'paused'
                              ? 'pick-man-resume'
                              : status === 'won'
                                ? 'pick-man-next'
                                : 'pick-man-again'
                          }
                          title={
                            status === 'paused'
                              ? 'Продолжить'
                              : status === 'won'
                                ? 'Следующий уровень'
                                : 'Ещё раз'
                          }
                          disabled={tooSmall}
                          onPress={
                            status === 'paused'
                              ? controller.resume
                              : status === 'won'
                                ? controller.levelUp
                                : controller.start
                          }
                        />
                        {status === 'paused' ? (
                          <>
                            <Button
                              testID="pick-man-rules"
                              title="Как играть"
                              secondary
                              onPress={openHelp}
                            />
                            <Button
                              testID="pick-man-restart"
                              title="Новая партия"
                              secondary
                              onPress={() => setRestart(true)}
                            />
                          </>
                        ) : null}
                        <Pressable accessibilityRole="button" onPress={close} style={s.leave}>
                          <Text style={s.small}>К событиям</Text>
                        </Pressable>
                      </>
                    )}
                  </View>
                </ScrollView>
              </View>
            ) : null}
          </View>
        </View>
      ) : null}
      {status === 'ready' && help ? (
        <View style={s.readyHelp}>
          <Text style={[s.body, s.centerText]}>
            Соберите все блюда. Свайп задаёт поворот заранее. Фирменный соус позволяет ловить
            соперников. У вас три жизни.
          </Text>
          <Button title="Понятно" onPress={() => setHelp(false)} />
        </View>
      ) : null}
      {controller.storageError ? (
        <View style={s.storage}>
          <Text style={s.caption}>
            {game ? 'Не удалось сохранить партию.' : 'Не удалось прочитать сохранение.'}
          </Text>
          <Pressable
            testID="pick-man-storage-retry"
            accessibilityRole="button"
            style={s.retry}
            onPress={game ? controller.retrySave : () => void controller.retryRestore()}
          >
            <Text style={s.small}>Повторить</Text>
          </Pressable>
        </View>
      ) : null}
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: arcade.ink, paddingHorizontal: 6 },
  header: {
    marginHorizontal: 10,
    height: 66,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  icon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: '#10213D',
    borderWidth: 1,
    borderColor: '#203655',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconPressed: { backgroundColor: '#213F66', transform: [{ scale: 0.96 }] },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  name: {
    fontFamily: font.display,
    fontSize: 18,
    lineHeight: 28,
    color: '#FFF',
    letterSpacing: 0.4,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { fontFamily: font.body, fontSize: 14, lineHeight: 21, color: '#CDDAF1' },
  centerText: { textAlign: 'center' },
  intro: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
    paddingVertical: 22,
  },
  eyebrow: { fontFamily: font.bold, fontSize: 10, letterSpacing: 2, color: '#FFB38A' },
  introTitle: {
    fontFamily: font.display,
    fontSize: 34,
    lineHeight: 46,
    color: '#FFF',
    textAlign: 'center',
  },
  legend: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 18 },
  legendItem: {
    alignItems: 'center',
    gap: 7,
    backgroundColor: '#10213D',
    borderRadius: 18,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#213655',
  },
  small: { fontFamily: font.medium, fontSize: 12, lineHeight: 18, color: '#D8E5FD' },
  caption: { fontFamily: font.medium, fontSize: 10, lineHeight: 16, color: '#9FB6DA' },
  best: { fontFamily: font.display, fontSize: 17, color: '#FFB38A' },
  footer: { paddingTop: 12, paddingBottom: 12, gap: 10 },
  stats: { flexDirection: 'row', gap: 8, marginHorizontal: 6, paddingTop: 4, paddingBottom: 6 },
  gameLayout: { flex: 1, minHeight: 0 },
  gameLayoutWide: { flexDirection: 'row', gap: 12 },
  statsWide: { width: 132, flexDirection: 'column', paddingTop: 8, paddingBottom: 8 },
  statsCompact: { paddingTop: 4, paddingBottom: 6 },
  statCard: {
    flex: 1,
    minWidth: 0,
    backgroundColor: '#10213D',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#203655',
    paddingHorizontal: 12,
    paddingVertical: 10,
    justifyContent: 'center',
    gap: 2,
  },
  statCompact: { paddingVertical: 6 },
  scoreCard: { backgroundColor: '#30251F', borderColor: '#65452F' },
  score: { fontFamily: font.display, fontSize: 25, color: '#FFC388', lineHeight: 34 },
  count: { fontFamily: font.bold, fontSize: 15, lineHeight: 23, color: '#E4EDFC' },
  lives: { fontSize: 20, lineHeight: 32, color: '#FFAB76', letterSpacing: 1 },
  progressTrack: {
    height: 3,
    backgroundColor: '#293D5E',
    borderRadius: 3,
    overflow: 'hidden',
    marginTop: 4,
  },
  progressFill: { height: '100%', backgroundColor: '#FFAA70' },
  main: { flex: 1, minHeight: 0, justifyContent: 'center', paddingBottom: 10 },
  stage: { flex: 1, minWidth: 0, minHeight: 0, alignItems: 'center', justifyContent: 'center' },
  boardHeading: {
    height: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  boardLabel: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  statusDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: '#FFB878' },
  boardTitle: {
    fontFamily: font.bold,
    fontSize: 10,
    lineHeight: 14,
    color: '#B9CDE8',
    letterSpacing: 1,
  },
  boardMeta: { fontFamily: font.medium, fontSize: 10, lineHeight: 16, color: '#8FA9CB' },
  gestureStatus: { height: 24, justifyContent: 'center' },
  gestureText: {
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 16,
    color: '#9FB6DA',
    textAlign: 'center',
  },
  powerTrack: {
    height: 4,
    borderRadius: 3,
    backgroundColor: '#233B64',
    overflow: 'hidden',
    marginTop: 1,
  },
  powerFill: { height: 4, backgroundColor: colors.accent },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: '#020919DB', borderRadius: 24 },
  overlayScroll: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 16 },
  dialog: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#10213D',
    borderWidth: 1,
    borderColor: '#304864',
    borderRadius: 26,
    padding: 22,
    alignItems: 'stretch',
    gap: 16,
  },
  dialogBadge: {
    width: 64,
    height: 64,
    borderRadius: 22,
    backgroundColor: '#FFB87812',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
  dialogTitle: {
    fontFamily: font.display,
    fontSize: 27,
    lineHeight: 40,
    color: '#FFF',
    textAlign: 'center',
  },
  leave: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  storage: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12 },
  retry: { minHeight: 48, justifyContent: 'center' },
  readyHelp: {
    position: 'absolute',
    left: 20,
    right: 20,
    top: '30%',
    backgroundColor: '#102A54',
    padding: 24,
    borderRadius: 24,
    gap: 20,
    borderWidth: 1,
    borderColor: '#426398',
  },
});
