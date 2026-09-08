import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  AccessibilityInfo,
  Animated,
  BackHandler,
  Easing,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Icon, Logo, type IconName } from '../../components/UI';
import { font } from '../../theme';
import {
  COLS,
  ROWS,
  MAZE,
  FOOD_IDS,
  stepDuration,
  foodKind,
  type Actor,
  type Direction,
  type MazeGame,
} from './engine';
import { Chick, FoodIcon, MazeArt, Rival } from './visuals';
import { usePickMan } from './usePickMan';

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
const Walls = memo(function Walls({ cell }: { cell: number }) {
  return (
    <>
      {MAZE.flatMap((row, y) => {
        const runs: { x: number; length: number }[] = [];
        for (let x = 0; x < COLS; x++)
          if (row[x] === '#') {
            const start = x;
            while (x + 1 < COLS && row[x + 1] === '#') x++;
            runs.push({ x: start, length: x - start + 1 });
          }
        return runs.map(({ x, length }) => (
          <View
            key={`${x}-${y}`}
            style={{
              position: 'absolute',
              left: x * cell + 1,
              top: y * cell + 1,
              width: length * cell - 2,
              height: cell - 2,
              borderRadius: cell * 0.25,
              backgroundColor: '#08337E',
              borderWidth: 1,
              borderColor: '#3679D9',
            }}
          />
        ));
      })}
    </>
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
        <View
          key={id}
          style={{
            position: 'absolute',
            left: (id % COLS) * cell + cell * 0.13,
            top: Math.floor(id / COLS) * cell + cell * 0.13,
          }}
        >
          <FoodIcon kind={foodKind(id)} size={cell * 0.74} />
        </View>
      ))}
    </>
  );
});
function MovingActor({
  actor,
  cell,
  duration,
  reduced,
  enemy = false,
  scared = false,
  shield = false,
}: {
  actor: Actor;
  cell: number;
  duration: number;
  reduced: boolean;
  enemy?: boolean;
  scared?: boolean;
  shield?: boolean;
}) {
  const position = useRef(new Animated.ValueXY({ x: actor.x * cell, y: actor.y * cell })).current;
  const previous = useRef({ actor, cell });
  useEffect(() => {
    const before = previous.current;
    previous.current = { actor, cell };
    const target = { x: actor.x * cell, y: actor.y * cell };
    if (
      reduced ||
      before.cell !== cell ||
      Math.abs(before.actor.x - actor.x) + Math.abs(before.actor.y - actor.y) > 1
    ) {
      position.setValue(target);
      return;
    }
    const animation = Animated.timing(position, {
      toValue: target,
      duration,
      easing: Easing.linear,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [actor.x, actor.y, cell, duration, position, reduced]);
  return (
    <Animated.View
      testID={enemy ? undefined : 'pick-man-player'}
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: cell,
        height: cell,
        transform: position.getTranslateTransform(),
        backgroundColor: shield ? '#FFF2D330' : 'transparent',
        borderRadius: cell / 2,
      }}
    >
      {enemy ? (
        <Rival size={cell} scared={scared} />
      ) : (
        <Chick size={cell} direction={actor.direction} />
      )}
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
      testID="pick-man-board"
      {...pan.panHandlers}
      accessibilityLabel="Лабиринт Pick Man. Направляйте Чика свайпами или кнопками стрелок."
      style={{
        width: COLS * cell,
        height: ROWS * cell,
        backgroundColor: '#020D27',
        borderRadius: cell * 0.4,
        overflow: 'hidden',
      }}
    >
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={StyleSheet.absoluteFill}
      >
        <Walls cell={cell} />
        <FoodLayer remaining={game.remaining} cell={cell} />
        {game.enemies.map((actor, i) => (
          <MovingActor
            key={i}
            actor={actor}
            cell={cell}
            duration={stepDuration(game.level) * 0.94}
            reduced={reduced || !playing}
            enemy
            scared={game.power > 0}
          />
        ))}
        <MovingActor
          actor={game.player}
          cell={cell}
          duration={stepDuration(game.level) * 0.94}
          reduced={reduced || !playing}
          shield={game.shield > 0}
        />
      </View>
    </View>
  );
}
function DirectionPad({
  enabled,
  onDirection,
}: {
  enabled: boolean;
  onDirection(d: Direction): void;
}) {
  const button = (d: Direction, icon: IconName) => (
    <Pressable
      testID={`pick-man-${d}`}
      accessibilityRole="button"
      accessibilityLabel={{ up: 'Вверх', down: 'Вниз', left: 'Влево', right: 'Вправо' }[d]}
      disabled={!enabled}
      onPressIn={() => onDirection(d)}
      style={({ pressed }) => [s.arrow, pressed && s.arrowPressed, !enabled && { opacity: 0.4 }]}
    >
      <Icon name={icon} size={23} color="#FFFFFF" />
    </Pressable>
  );
  return (
    <View style={s.pad}>
      <View style={s.padRow}>{button('up', 'arrow-up')}</View>
      <View style={s.padRow}>
        {button('left', 'arrow-back')}
        {button('down', 'arrow-down')}
        {button('right', 'arrow-forward')}
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
  const cell = Math.floor(Math.min(25, region.width / COLS, region.height / ROWS));
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
      <View style={s.header}>
        <Pressable
          testID="pick-man-exit"
          accessibilityRole="button"
          accessibilityLabel="К событиям"
          onPress={close}
          style={s.icon}
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
          style={s.icon}
        >
          <Icon name={playing ? 'pause' : 'help-circle-outline'} size={24} />
        </Pressable>
      </View>
      {status === 'loading' ? (
        <View style={s.center}>
          <Text style={s.body}>Готовим вкусный маршрут…</Text>
        </View>
      ) : status === 'ready' ? (
        <>
          <ScrollView contentContainerStyle={s.intro} showsVerticalScrollIndicator={false}>
            <Text style={s.eyebrow}>ПОЙМАЙ СВОЙ ВКУС</Text>
            <MazeArt size={Math.min(width - 110, 220)} />
            <Text style={s.introTitle}>Аппетит к победе.</Text>
            <Text style={[s.body, s.centerText]}>
              Веди Чика по лабиринту. Собирай{`\n`}любимые блюда и обходи соперников.
            </Text>
            <View style={s.legend}>
              {(['burger', 'fingers', 'cola'] as const).map((kind, i) => (
                <View key={kind} style={s.legendItem}>
                  <FoodIcon kind={kind} size={34} />
                  <Text style={s.small}>{[30, 20, 10][i]} очков</Text>
                </View>
              ))}
            </View>
            <Text style={s.caption}>Три жизни · свайпы или стрелки</Text>
            {best > 0 ? (
              <Text style={s.best}>Твой рекорд — {best.toLocaleString('ru-RU')}</Text>
            ) : null}
          </ScrollView>
          <View style={s.footer}>
            <Button
              testID="pick-man-start"
              title="Начать игру"
              disabled={controller.storageError}
              onPress={controller.start}
            />
            <Text style={[s.caption, s.centerText]}>Игровые очки не переводятся в Чики.</Text>
          </View>
        </>
      ) : game ? (
        <>
          <View style={s.stats}>
            <View>
              <Text style={s.caption}>СЧЁТ</Text>
              <Text testID="pick-man-score" style={s.score}>
                {game.score.toLocaleString('ru-RU')}
              </Text>
            </View>
            <View style={s.statCenter}>
              <Text style={s.caption}>УРОВЕНЬ {game.level}</Text>
              <Text testID="pick-man-remaining" style={s.count}>
                {FOOD_IDS.length - game.remaining.length} / {FOOD_IDS.length}
              </Text>
            </View>
            <View>
              <Text style={[s.caption, { textAlign: 'right' }]}>ЖИЗНИ</Text>
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
          <View style={[s.main, wide && s.mainWide]}>
            <View
              testID="pick-man-stage"
              onLayout={(e) => setRegion(e.nativeEvent.layout)}
              style={s.stage}
            >
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
            <View style={[s.controls, wide && s.controlsWide]}>
              <View style={s.controlCopy}>
                <Text style={s.hint}>
                  {game.power > 0 ? 'Острый режим!' : 'Следующий поворот — твой.'}
                </Text>
                <Text style={s.caption}>
                  {game.power > 0 ? 'Лови соперников' : 'Свайпни заранее или нажми стрелку.'}
                </Text>
                {game.power > 0 ? (
                  <View style={s.powerTrack}>
                    <View style={[s.powerFill, { width: `${(game.power / 42) * 100}%` }]} />
                  </View>
                ) : null}
              </View>
              <DirectionPad enabled={playing && !tooSmall} onDirection={controller.steer} />
            </View>
            {overlay ? (
              <View testID="pick-man-overlay" style={s.scrim}>
                <ScrollView contentContainerStyle={s.overlayScroll}>
                  <View style={s.dialog}>
                    <Logo size={42} />
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
                        ? 'Свайпайте или нажимайте стрелки. Чик движется сам, поворот можно выбрать заранее. Соберите все блюда и не попадитесь соперникам. Острый соус на время позволяет ловить их.'
                        : restart
                          ? 'Текущая партия закончится. Личный рекорд сохранится.'
                          : status === 'won'
                            ? 'Все блюда собраны. Следующий маршрут будет немного быстрее.'
                            : status === 'over'
                              ? `Твой счёт — ${game.score}. Рекорд — ${best}. Ещё один вкусный маршрут?`
                              : 'Игра на паузе. Продолжим, когда будешь готов.'}
                    </Text>
                    {help ? (
                      <>
                        <View style={s.legend}>
                          <FoodIcon kind="power" size={32} />
                          <Text style={s.small}>Острый соус: +50 · соперник: +200</Text>
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
        </>
      ) : null}
      {status === 'ready' && help ? (
        <View style={s.readyHelp}>
          <Text style={[s.body, s.centerText]}>
            Соберите все блюда. Свайп задаёт поворот заранее. Острый соус позволяет ловить
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
  page: { flex: 1, backgroundColor: '#04143A', paddingHorizontal: 16 },
  header: {
    height: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  icon: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  name: { fontFamily: font.display, fontSize: 19, color: '#FFF', letterSpacing: 0.4 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { fontFamily: font.body, fontSize: 14, lineHeight: 21, color: '#CDDAF1' },
  centerText: { textAlign: 'center' },
  intro: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 22,
    paddingVertical: 24,
  },
  eyebrow: { fontFamily: font.bold, fontSize: 10, letterSpacing: 2, color: '#FFB38A' },
  introTitle: {
    fontFamily: font.display,
    fontSize: 30,
    lineHeight: 36,
    color: '#FFF',
    textAlign: 'center',
  },
  legend: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 18 },
  legendItem: { alignItems: 'center', gap: 7 },
  small: { fontFamily: font.medium, fontSize: 12, lineHeight: 18, color: '#D8E5FD' },
  caption: { fontFamily: font.medium, fontSize: 10, lineHeight: 16, color: '#9FB6DA' },
  best: { fontFamily: font.display, fontSize: 17, color: '#FFB38A' },
  footer: { paddingTop: 12, paddingBottom: 12, gap: 10 },
  stats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  score: { fontFamily: font.display, fontSize: 25, color: '#FFF', lineHeight: 30 },
  statCenter: { alignItems: 'center' },
  count: { fontFamily: font.display, fontSize: 17, color: '#D4E4FF' },
  lives: { fontSize: 20, color: '#FF9359', letterSpacing: 2 },
  main: { flex: 1, minHeight: 0 },
  mainWide: { flexDirection: 'row' },
  stage: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 2,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    gap: 8,
    paddingVertical: 8,
  },
  controlsWide: { width: 190, flexDirection: 'column', justifyContent: 'center' },
  controlCopy: { maxWidth: 130, gap: 4 },
  hint: { fontFamily: font.bold, fontSize: 12, lineHeight: 17, color: '#FFF' },
  pad: { gap: 5 },
  padRow: { flexDirection: 'row', justifyContent: 'center', gap: 5 },
  arrow: {
    width: 48,
    height: 48,
    borderRadius: 15,
    backgroundColor: '#173362',
    borderWidth: 1,
    borderColor: '#325488',
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowPressed: { backgroundColor: '#0047BB', borderColor: '#FF7A3D' },
  powerTrack: {
    height: 4,
    borderRadius: 3,
    backgroundColor: '#233B64',
    overflow: 'hidden',
    marginTop: 5,
  },
  powerFill: { height: 4, backgroundColor: '#FF7A3D' },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: '#020919DB', borderRadius: 24 },
  overlayScroll: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 16 },
  dialog: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#0D2550',
    borderWidth: 1,
    borderColor: '#2B4773',
    borderRadius: 26,
    padding: 22,
    alignItems: 'stretch',
    gap: 16,
  },
  dialogTitle: {
    fontFamily: font.display,
    fontSize: 27,
    lineHeight: 32,
    color: '#FFF',
    textAlign: 'center',
  },
  leave: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  storage: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12 },
  retry: { minHeight: 44, justifyContent: 'center' },
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
