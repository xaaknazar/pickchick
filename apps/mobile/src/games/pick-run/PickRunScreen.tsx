import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  BackHandler,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { Image } from 'expo-image';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ScreenProps } from '../../model';
import { assets } from '../../assets';
import { font } from '../../theme';
import { Icon } from '../../components/UI';
import { FoodIcon } from '../pick-man/visuals';
import {
  ArcadeBackdrop,
  ArcadeButton,
  ArcadeFeedback,
  ArcadeIntro,
  ArcadeMetric,
  arcade,
  useArcadeMotion,
} from '../ArcadeExperience';
import { advanceRun, createRun, jumpRun, parseRunBest, RUN_DURATION, RUN_WIDTH } from './engine';

const BEST_KEY = 'pickchick.pick-run.best.v2';
let saveQueue = Promise.resolve();
function saveBest(score: number) {
  const next = saveQueue
    .catch(() => {})
    .then(async () => {
      const previous = parseRunBest(await AsyncStorage.getItem(BEST_KEY));
      await AsyncStorage.setItem(BEST_KEY, String(Math.max(previous, score)));
    });
  saveQueue = next.catch(() => {});
  return next;
}
type Status = 'ready' | 'countdown' | 'playing' | 'paused' | 'over';
export function PickRunScreen(props: ScreenProps) {
  const reduced = useArcadeMotion();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const [status, setStatus] = useState<Status>('ready');
  const statusRef = useRef<Status>('ready');
  const game = useRef(createRun());
  const [hud, setHud] = useState(game.current);
  const [best, setBest] = useState(0);
  const [saveError, setSaveError] = useState(false);
  const [count, setCount] = useState(3);
  const [fieldWidth, setFieldWidth] = useState(340);
  const x = useRef(new Animated.Value(440)).current;
  const y = useRef(new Animated.Value(0)).current;
  const city = useRef(new Animated.Value(0)).current;
  const ground = useRef(new Animated.Value(0)).current;
  const change = useCallback((next: Status) => {
    statusRef.current = next;
    setStatus(next);
  }, []);
  const pause = useCallback(() => {
    if (statusRef.current === 'playing' || statusRef.current === 'countdown') change('paused');
  }, [change]);
  useEffect(() => {
    let alive = true;
    void AsyncStorage.getItem(BEST_KEY)
      .then((raw) => {
        if (alive) setBest((previous) => Math.max(previous, parseRunBest(raw)));
      })
      .catch(() => {
        if (alive) setSaveError(true);
      });
    return () => {
      alive = false;
    };
  }, []);
  useFocusEffect(useCallback(() => () => pause(), [pause]));
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') pause();
    });
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (['playing', 'countdown'].includes(statusRef.current)) {
        pause();
        return true;
      }
      return false;
    });
    const hide = () => {
      if (document.visibilityState === 'hidden') pause();
    };
    if (Platform.OS === 'web') {
      document.addEventListener('visibilitychange', hide);
      window.addEventListener('blur', pause);
    }
    return () => {
      sub.remove();
      back.remove();
      if (Platform.OS === 'web') {
        document.removeEventListener('visibilitychange', hide);
        window.removeEventListener('blur', pause);
      }
    };
  }, [pause]);
  useEffect(() => {
    pause();
  }, [width, height, pause]);
  useEffect(() => {
    if (status !== 'countdown') return;
    setCount(3);
    let left = 3;
    const timer = setInterval(() => {
      left--;
      if (left === 0) {
        clearInterval(timer);
        change('playing');
      } else setCount(left);
    }, 650);
    return () => clearInterval(timer);
  }, [status, change]);
  useEffect(() => {
    if (status !== 'playing') return;
    let frame = 0,
      last = performance.now(),
      painted = 0;
    const tick = (now: number) => {
      if (statusRef.current !== 'playing') return;
      const previous = game.current;
      const next = advanceRun(previous, now - last);
      last = now;
      game.current = next;
      const scale = fieldWidth / RUN_WIDTH;
      x.setValue(next.x * scale);
      y.setValue(-next.y * scale);
      city.setValue(reduced ? 0 : -((next.distance * 0.16) % 180) * scale);
      ground.setValue(reduced ? 0 : -(next.distance % 80) * scale);
      if (
        now - painted > 90 ||
        next.event !== previous.event ||
        next.obstacle !== previous.obstacle ||
        next.over
      ) {
        setHud(next);
        painted = now;
      }
      if (next.over) {
        change('over');
        props.model.setPracticeScore(next.score);
        setBest((old) => Math.max(old, next.score));
        void saveBest(next.score)
          .then(() => setSaveError(false))
          .catch(() => setSaveError(true));
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [status, fieldWidth, reduced, x, y, city, ground, change, props.model.setPracticeScore]);
  const start = () => {
    game.current = createRun(Math.floor(Math.random() * 0x100000000));
    setHud(game.current);
    x.setValue((440 * fieldWidth) / RUN_WIDTH);
    y.setValue(0);
    props.model.setPracticeScore(null);
    change('countdown');
  };
  const leap = () => {
    if (statusRef.current === 'playing') game.current = jumpRun(game.current);
  };
  const exit = () => {
    pause();
    props.navigate('M26');
  };
  const scale = fieldWidth / RUN_WIDTH;
  const field = (
    <View style={[r.stage, landscape && { flex: 1, maxWidth: 430 }]}>
      <Pressable
        testID="game-field"
        accessibilityRole="button"
        accessibilityLabel="Игровое поле. Коснитесь для прыжка"
        onPressIn={leap}
        onLayout={(e) => setFieldWidth(e.nativeEvent.layout.width)}
        style={[
          r.field,
          {
            height: landscape
              ? Math.max(190, height - 112)
              : Math.min(365, Math.max(230, height * 0.4)),
          },
        ]}
      >
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <Image
            source={require('../../../assets/games/almaty-night.svg')}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            contentPosition="bottom"
            accessible={false}
          />
          <View style={r.moon} />
          <Text style={r.cityLabel}>ALMATY / NIGHT RUN</Text>
          <Animated.View style={[r.skyline, { transform: [{ translateX: city }] }]}>
            {Array.from({ length: 11 }, (_, i) => (
              <View
                key={i}
                style={[r.building, { height: 45 + (i % 4) * 20, width: 34 + (i % 3) * 12 }]}
              >
                <View style={r.window} />
                <View style={r.window} />
                <View style={r.window} />
              </View>
            ))}
          </Animated.View>
          <View style={r.hill} />
          <View style={r.track} />
          <Animated.View style={[r.lanes, { transform: [{ translateX: ground }] }]}>
            {Array.from({ length: 10 }, (_, i) => (
              <View key={i} style={[r.lane, { marginRight: 45 * scale, width: 35 * scale }]} />
            ))}
          </Animated.View>
          <View
            style={[
              r.shadow,
              { left: 46 * scale, width: 44 * scale, opacity: Math.max(0.12, 0.5 - hud.y / 300) },
            ]}
          />
          <Animated.View
            style={[
              r.runner,
              {
                left: 42 * scale,
                width: 62 * scale,
                height: 62 * scale,
                opacity: hud.shield > 0 ? 0.55 : 1,
                transform: [{ translateY: y }],
              },
            ]}
          >
            <Image
              source={assets.pickManChick}
              contentFit="contain"
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
          <Animated.View style={[r.hazardGroup, { transform: [{ translateX: x }] }]}>
            <View
              style={[
                r.hazard,
                { width: 34 * scale, height: [32, 43, 37][hud.obstacle % 3]! * scale },
              ]}
            >
              <Icon
                name={hud.obstacle % 2 ? 'cube-outline' : 'flame'}
                color="#FFB97D"
                size={22 * scale}
              />
            </View>
            {!hud.collected ? (
              <View style={[r.food, { bottom: 88 * scale, left: -4 * scale }]}>
                <FoodIcon
                  kind={(['burger', 'fingers', 'cola'] as const)[hud.obstacle % 3]!}
                  size={34 * scale}
                />
              </View>
            ) : null}
          </Animated.View>
        </View>
        <ArcadeFeedback
          event={hud.event}
          text={hud.notice}
          danger={hud.shield > 0}
          reduced={reduced}
        />
        {status === 'countdown' ? (
          <View style={r.countdown}>
            <Text style={r.countNumber}>{count}</Text>
            <Text style={r.body}>Лови ритм</Text>
          </View>
        ) : null}
      </Pressable>
      <View style={r.trackProgress}>
        <View
          style={[r.trackFill, { width: `${Math.min(100, (hud.elapsed / RUN_DURATION) * 100)}%` }]}
        />
      </View>
    </View>
  );
  return (
    <SafeAreaView style={r.page} testID="pick-run-screen">
      <ArcadeBackdrop />
      <View style={r.header}>
        <Pressable
          onPress={exit}
          accessibilityRole="button"
          accessibilityLabel="К событиям"
          style={r.icon}
        >
          <Icon name="chevron-back" color={arcade.white} size={24} />
        </Pressable>
        <Text style={r.name}>PICK RUN</Text>
        <Pressable
          testID="game-pause"
          onPress={pause}
          disabled={!['playing', 'countdown'].includes(status)}
          accessibilityRole="button"
          accessibilityLabel="Пауза"
          style={r.icon}
        >
          <Icon name="pause" color={arcade.white} size={22} />
        </Pressable>
      </View>
      {status === 'ready' ? (
        <ArcadeIntro
          cover={assets.pickrun}
          title="Город твой."
          subtitle="Ночной Алматы. Один палец. Новый личный рекорд."
          best={best}
          testID="game-start"
          onStart={start}
          steps={[
            ['hand-left-outline', 'Коснись - взлетай', 'Прыгай через препятствия касанием поля.'],
            ['fast-food-outline', 'Собирай свой вкус', 'Блюда в воздухе дают очки и серии.'],
            ['flash-outline', 'Поймай ритм', '45 секунд, три жизни и растущий темп.'],
          ]}
        />
      ) : (
        <View style={[r.game, landscape && r.gameWide]}>
          {landscape ? field : null}
          <View
            style={[
              r.dashboard,
              landscape && {
                width: 220,
                flexBasis: 220,
                flexGrow: 0,
                flexShrink: 0,
                justifyContent: 'center',
              },
            ]}
          >
            <View style={r.metrics}>
              <ArcadeMetric label="СЧЁТ" value={hud.score} accent testID="run-score" />
              <ArcadeMetric
                label="ДО ФИНИША"
                value={`${Math.max(0, Math.ceil((RUN_DURATION - hud.elapsed) / 1000))} с`}
              />
            </View>
            <View style={r.livesRow}>
              <Text accessibilityLabel={`Осталось жизней: ${hud.lives}`} style={r.hearts}>
                {'♥'.repeat(hud.lives)}
                {'♡'.repeat(3 - hud.lives)}
              </Text>
              <Text style={r.caption}>
                Рекорд {Math.max(best, hud.score)} · серия {hud.combo}
              </Text>
            </View>
            {!landscape ? field : null}
            <Pressable
              testID="game-jump"
              accessibilityRole="button"
              accessibilityLabel="Прыжок"
              disabled={status !== 'playing'}
              onPressIn={leap}
              style={({ pressed }) => [
                r.jump,
                pressed && { transform: [{ scale: 0.98 }], backgroundColor: '#FFD3AC' },
              ]}
            >
              <Icon name="arrow-up" color="#24130A" size={24} />
              <Text style={r.jumpLabel}>ПРЫЖОК</Text>
              {!landscape ? <Text style={r.jumpHint}>или коснись поля</Text> : null}
            </Pressable>
            <Text style={r.caption}>Перепрыгни +5 · блюдо +10 · серия даёт больше</Text>
          </View>
        </View>
      )}
      {status === 'paused' || status === 'over' ? (
        <View style={r.shade}>
          <ScrollView contentContainerStyle={r.dialogScroll}>
            <View style={r.dialog} accessibilityViewIsModal>
              <View style={r.medal}>
                <Icon
                  name={status === 'over' ? 'trophy-outline' : 'pause'}
                  color={arcade.orange}
                  size={36}
                />
              </View>
              <Text style={r.dialogTitle}>
                {status === 'paused'
                  ? 'Переведём дух.'
                  : hud.elapsed >= RUN_DURATION - 1
                    ? 'Финиш. Красиво!'
                    : 'Ещё один забег?'}
              </Text>
              <Text style={r.body}>
                {status === 'paused'
                  ? 'Продолжим с того же места.'
                  : 'Каждый прыжок приближает к новому пику.'}
              </Text>
              <View style={r.metrics}>
                <ArcadeMetric label="СЧЁТ" value={hud.score} accent />
                <ArcadeMetric label="ЛУЧШАЯ СЕРИЯ" value={hud.bestCombo} />
              </View>
              <Text style={r.caption}>Рекорд {best} · игровые очки без начисления Чиков</Text>
              <ArcadeButton
                title={status === 'paused' ? 'Продолжить' : 'Ещё раз!'}
                testID={status === 'paused' ? 'game-resume' : 'game-replay'}
                icon="play"
                onPress={status === 'paused' ? () => change('countdown') : start}
              />
              <ArcadeButton title="К событиям" secondary onPress={exit} />
            </View>
          </ScrollView>
        </View>
      ) : null}
      {saveError ? <Text style={r.caption}>Рекорд пока не сохранился на устройстве.</Text> : null}
    </SafeAreaView>
  );
}
/** Legacy result deep links use the same arcade presentation as the in-game finish. */
export function PickRunResult(props: ScreenProps) {
  const score = props.model.practiceScore;
  return (
    <SafeAreaView style={r.page}>
      <ArcadeBackdrop />
      <View style={r.header}>
        <Text style={r.name}>PICK RUN / РЕЗУЛЬТАТ</Text>
      </View>
      <ScrollView contentContainerStyle={r.dialogScroll}>
        <View style={r.dialog}>
          <View style={r.medal}>
            <Icon name="trophy-outline" size={38} color={arcade.orange} />
          </View>
          <Text style={r.dialogTitle}>
            {score === null ? 'Твой пик впереди.' : 'Красивый забег!'}
          </Text>
          <ArcadeMetric label="ТВОЙ СЧЁТ" value={score ?? '-'} accent />
          <Text style={r.body}>Игровые очки не переводятся в Чики.</Text>
          <ArcadeButton
            title={score === null ? 'Начать игру' : 'Ещё раз!'}
            testID="game-replay"
            icon="play"
            onPress={() => props.navigate('M27')}
          />
          <ArcadeButton title="К событиям" secondary onPress={() => props.navigate('M26')} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
const r = StyleSheet.create({
  page: { flex: 1, backgroundColor: arcade.ink, paddingHorizontal: 16 },
  header: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 8 },
  icon: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  name: {
    flex: 1,
    textAlign: 'center',
    fontFamily: font.display,
    fontSize: 19,
    lineHeight: 30,
    color: arcade.white,
    letterSpacing: 0.7,
  },
  game: { flex: 1, minHeight: 0, gap: 12 },
  gameWide: { flexDirection: 'row', alignItems: 'stretch', justifyContent: 'center' },
  dashboard: { gap: 12, flexShrink: 1, flex: 1 },
  metrics: { flexDirection: 'row', gap: 10 },
  livesRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  hearts: { fontSize: 22, color: arcade.orange },
  caption: {
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 17,
    color: arcade.muted,
    textAlign: 'center',
  },
  stage: { flexShrink: 1, flex: 1 },
  field: {
    flex: 1,
    backgroundColor: '#101D3B',
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#375275',
  },
  moon: {
    position: 'absolute',
    width: 55,
    height: 55,
    borderRadius: 30,
    top: 36,
    right: 35,
    backgroundColor: '#EEDFCC',
  },
  cityLabel: {
    position: 'absolute',
    left: 18,
    top: 18,
    fontFamily: font.bold,
    fontSize: 10,
    letterSpacing: 1.5,
    color: '#B5C9E8',
  },
  skyline: {
    position: 'absolute',
    left: 0,
    bottom: 76,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 5,
  },
  building: {
    backgroundColor: '#1B3760',
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
    padding: 7,
    gap: 10,
  },
  window: { height: 4, width: 5, backgroundColor: '#E2B78780' },
  hill: {
    position: 'absolute',
    bottom: 66,
    left: -25,
    width: 230,
    height: 90,
    borderTopRightRadius: 170,
    backgroundColor: '#112841',
  },
  track: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 69,
    backgroundColor: '#0B1426',
    borderTopWidth: 3,
    borderTopColor: '#FFAC70',
  },
  lanes: { position: 'absolute', left: 0, bottom: 24, flexDirection: 'row' },
  lane: { height: 3, backgroundColor: '#72849A55' },
  runner: {
    position: 'absolute',
    bottom: 67,
    borderRadius: 40,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: '#7DC2FA60',
  },
  shadow: {
    position: 'absolute',
    bottom: 63,
    height: 7,
    borderRadius: 10,
    backgroundColor: '#000',
  },
  hazardGroup: { position: 'absolute', left: 0, bottom: 68 },
  hazard: {
    backgroundColor: '#442F32',
    borderWidth: 2,
    borderColor: '#D98A63',
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  food: { position: 'absolute', backgroundColor: '#FFB87815', borderRadius: 25 },
  trackProgress: {
    height: 4,
    marginTop: 9,
    borderRadius: 4,
    backgroundColor: '#20324C',
    overflow: 'hidden',
  },
  trackFill: { height: 4, backgroundColor: arcade.orange },
  jump: {
    minHeight: 62,
    borderRadius: 19,
    backgroundColor: arcade.orange,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
  },
  jumpLabel: { fontFamily: font.display, fontSize: 18, color: '#24130A' },
  jumpHint: { fontFamily: font.medium, fontSize: 11, color: '#533018' },
  countdown: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#070F21AA',
    alignItems: 'center',
    justifyContent: 'center',
  },
  countNumber: { fontFamily: font.display, fontSize: 78, lineHeight: 98, color: arcade.orange },
  body: {
    fontFamily: font.body,
    fontSize: 14,
    lineHeight: 22,
    color: arcade.muted,
    textAlign: 'center',
  },
  shade: { ...StyleSheet.absoluteFill, backgroundColor: '#030916E8', zIndex: 10 },
  dialogScroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  dialog: {
    width: '100%',
    maxWidth: 380,
    padding: 23,
    borderRadius: 28,
    backgroundColor: arcade.panel,
    borderWidth: 1,
    borderColor: arcade.border,
    gap: 16,
  },
  medal: {
    alignSelf: 'center',
    width: 72,
    height: 72,
    borderRadius: 24,
    backgroundColor: '#FFAC7012',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialogTitle: {
    fontFamily: font.display,
    fontSize: 27,
    lineHeight: 38,
    color: arcade.white,
    textAlign: 'center',
  },
});
