import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  BackHandler,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { Text } from '../../components/LocalizedText';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Icon, type IconName } from '../../components/UI';
import { useReducedMotion } from '../../components/Motion';
import { useLocale } from '../../i18n';
import { font } from '../../theme';
import { PickBoxEngine, PEAK_THRESHOLDS, type Cue, type Snapshot } from './engine';
import { pickBoxCopy } from './copy';
import { pickBoxCover } from './PickBoxCard';
import { PickBoxRecords, RECORD_KEY } from './storage';
import { World } from './World';

const records = new PickBoxRecords({
  read: () => AsyncStorage.getItem(RECORD_KEY),
  write: (value) => AsyncStorage.setItem(RECORD_KEY, value),
});
const MOUNTAINS = require('../../../assets/games/pick-box/mountains-2d.png');
const INK = '#04143A';

function Control({
  icon,
  label,
  onPress,
  testID,
}: {
  icon: IconName;
  label: string;
  onPress(): void;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [s.control, pressed && s.pressed]}
    >
      <Icon name={icon} size={24} color="#FFF6DC" />
    </Pressable>
  );
}
function Action({
  children,
  onPress,
  testID,
  secondary = false,
}: {
  children: string;
  onPress(): void;
  testID: string;
  secondary?: boolean;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [s.action, secondary && s.secondary, pressed && s.pressed]}
    >
      <Text style={[s.actionText, secondary && { color: '#FFFFFF' }]}>{children}</Text>
    </Pressable>
  );
}

export function PickBoxScreen() {
  const router = useRouter();
  const copy = pickBoxCopy(useLocale());
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const [game, setGame] = useState(() => new PickBoxEngine());
  const [hud, setHud] = useState<Snapshot>(game.snapshot());
  const [best, setBest] = useState(0);
  const [saveError, setSaveError] = useState(false);
  const [feedback, setFeedback] = useState<Cue['kind'] | null>(null);
  const [resultVisible, setResultVisible] = useState(false);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bg = useSharedValue(0);
  const toast = useSharedValue(0);
  const scorePop = useSharedValue(1);
  const width = Math.min(window.width, 540);
  const bgWidth = window.height * 1.5;
  const bgStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -Math.max(0, bgWidth - width) * bg.value }],
  }));
  const feedbackStyle = useAnimatedStyle(() => ({
    opacity: toast.value,
    transform: [{ translateY: (1 - toast.value) * 10 }],
  }));
  const scoreStyle = useAnimatedStyle(() => ({ transform: [{ scale: scorePop.value }] }));

  const exit = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/events');
  }, [router]);
  const change = useCallback((snapshot: Snapshot) => setHud(snapshot), []);
  const pause = useCallback(() => {
    game.pause();
    setHud(game.snapshot());
  }, [game]);
  const restart = () => {
    const next = new PickBoxEngine();
    next.start();
    setGame(next);
    setHud(next.snapshot());
    setFeedback(null);
    setResultVisible(false);
  };
  const drop = useCallback(() => {
    if (game.drop()) setHud(game.snapshot());
  }, [game]);
  const cue = useCallback(
    (event: Cue) => {
      if (event.kind === 'impact' && !reduced && Platform.OS !== 'web') {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      }
      if (['land', 'perfect', 'miss', 'peak', 'collapse'].includes(event.kind)) {
        setFeedback(event.kind);
        toast.value = 1;
        if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
        feedbackTimer.current = setTimeout(() => {
          toast.value = withTiming(0, { duration: reduced ? 0 : 200 });
        }, 1100);
        if (event.kind === 'land' || event.kind === 'perfect') {
          scorePop.value = reduced ? 1 : 1.12;
          scorePop.value = withTiming(1, { duration: reduced ? 0 : 240 });
        }
        if (
          (event.kind === 'miss' || event.kind === 'perfect') &&
          !reduced &&
          Platform.OS !== 'web'
        ) {
          void Haptics.notificationAsync(
            event.kind === 'perfect'
              ? Haptics.NotificationFeedbackType.Success
              : Haptics.NotificationFeedbackType.Warning,
          ).catch(() => {});
        }
      }
    },
    [reduced, scorePop, toast],
  );

  useEffect(() => {
    let live = true;
    void records.record(hud.score).then((value) => {
      if (live) {
        setBest(Math.max(value.best, hud.score));
        setSaveError(!value.saved);
      }
    });
    return () => {
      live = false;
    };
  }, [hud.score]);
  useEffect(() => {
    bg.value = withTiming(Math.min(hud.score / 36, 1), { duration: reduced ? 0 : 1400 });
  }, [bg, hud.score, reduced]);
  useEffect(() => {
    if (hud.phase !== 'over') return;
    const timer = setTimeout(() => setResultVisible(true), reduced ? 0 : 1100);
    return () => clearTimeout(timer);
  }, [hud.phase, reduced]);
  useEffect(() => () => game.dispose(), [game]);
  useEffect(
    () => () => {
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    },
    [],
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') pause();
    });
    const hide = () => {
      if (document.hidden) pause();
    };
    if (Platform.OS === 'web') document.addEventListener('visibilitychange', hide);
    return () => {
      sub.remove();
      if (Platform.OS === 'web') document.removeEventListener('visibilitychange', hide);
    };
  }, [pause]);
  useFocusEffect(
    useCallback(() => {
      const back = BackHandler.addEventListener('hardwareBackPress', () => {
        if (game.phase === 'playing') pause();
        else exit();
        return true;
      });
      return () => {
        back.remove();
        game.pause();
      };
    }, [game, pause, exit]),
  );
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const key = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('[role="button"],button,input,textarea')) return;
      if (event.code === 'Space') {
        event.preventDefault();
        drop();
      }
      if (event.code === 'Escape') pause();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [drop, pause]);

  const nextThreshold = PEAK_THRESHOLDS[hud.peak + 1];
  const feedbackText =
    feedback === 'perfect'
      ? copy.perfect
      : feedback === 'land'
        ? copy.land
        : feedback === 'miss'
          ? copy.miss
          : feedback === 'peak'
            ? copy.peak
            : feedback === 'collapse'
              ? copy.collapse
              : '';
  return (
    <View style={s.screen}>
      <View testID="pick-box-screen" style={[s.frame, { width }]}>
        <Animated.Image
          source={MOUNTAINS}
          accessible={false}
          style={[s.background, { width: bgWidth, height: window.height }, bgStyle]}
        />
        <View style={[s.header, { paddingTop: insets.top + 8 }]}>
          <Control icon="close" label={copy.exit} onPress={exit} testID="pick-box-exit" />
          <Text style={s.wordmark}>Pick Box</Text>
          {hud.phase !== 'ready' ? (
            <Control icon="pause" label={copy.pause} onPress={pause} testID="pick-box-pause" />
          ) : (
            <View style={{ width: 48 }} />
          )}
        </View>

        {hud.phase === 'ready' ? (
          <View style={s.start}>
            <View style={s.startHeading}>
              <Text style={s.heroTitle}>Pick Box</Text>
              <Text style={s.heroSubtitle}>{copy.description}</Text>
            </View>
            <Image source={pickBoxCover} resizeMode="cover" style={s.hero} accessible={false} />
            <View style={[s.startBottom, { paddingBottom: Math.max(20, insets.bottom + 12) }]}>
              <Text style={s.rule}>{copy.rule}</Text>
              <Action
                testID="pick-box-start"
                onPress={() => {
                  game.start();
                  setHud(game.snapshot());
                }}
              >
                {copy.start}
              </Action>
              <Text style={s.local}>
                {copy.best}: {best} · {copy.local}
              </Text>
            </View>
          </View>
        ) : (
          <>
            <View style={s.hud} pointerEvents="none">
              <View style={s.statRow}>
                <View style={s.best}>
                  <Icon name="trophy" size={16} color="#FFE28A" />
                  <Text testID="pick-box-best" style={s.bestText}>
                    {best}
                  </Text>
                </View>
                <View
                  accessibilityLabel={`${copy.lives}: ${hud.lives}`}
                  testID="pick-box-lives"
                  style={s.hearts}
                >
                  {[0, 1, 2].map((i) => (
                    <Icon
                      key={i}
                      name={i < hud.lives ? 'heart' : 'heart-outline'}
                      size={23}
                      color={i < hud.lives ? '#FF6900' : '#17466B'}
                    />
                  ))}
                </View>
              </View>
              <Animated.View style={[s.scoreWrap, scoreStyle]}>
                <Text testID="pick-box-score" accessibilityLiveRegion="polite" style={s.score}>
                  {hud.score}
                </Text>
              </Animated.View>
              <View style={s.peakRow}>
                <Icon name="trail-sign" size={17} color={INK} />
                <Text testID="pick-box-peak" style={s.peak}>
                  {copy.peaks[hud.peak]}
                </Text>
              </View>
            </View>
            <Pressable
              testID="pick-box-drop-zone"
              accessible={false}
              onPressIn={drop}
              style={s.playfield}
            >
              <World game={game} reduced={reduced} onChange={change} onCue={cue} />
              <Animated.View pointerEvents="none" style={[s.feedback, feedbackStyle]}>
                <Text style={[s.feedbackText, feedback === 'miss' && { color: '#FFE28A' }]}>
                  {feedbackText}
                </Text>
                {hud.combo > 1 && feedback === 'perfect' ? (
                  <Text style={s.combo}>
                    {hud.combo} {copy.combo}
                  </Text>
                ) : null}
              </Animated.View>
            </Pressable>
            <View style={[s.bottom, { paddingBottom: Math.max(14, insets.bottom + 8) }]}>
              <Pressable
                testID="pick-box-drop"
                accessibilityRole="button"
                accessibilityLabel={copy.drop}
                accessibilityState={{ disabled: !hud.canDrop }}
                disabled={!hud.canDrop}
                onPress={drop}
                style={({ pressed }) => [s.drop, !hud.canDrop && s.dropBusy, pressed && s.pressed]}
              >
                <Icon
                  name={hud.canDrop ? 'hand-left' : 'hourglass-outline'}
                  size={20}
                  color={INK}
                />
                <Text style={s.dropText}>{hud.canDrop ? copy.hint : copy.falling}</Text>
              </Pressable>
              <Text style={s.progress}>
                {nextThreshold ? `${copy.next}: ${nextThreshold - hud.score}` : copy.peaks[3]}
              </Text>
            </View>
          </>
        )}

        {hud.phase === 'paused' || resultVisible ? (
          <Modal
            transparent
            visible
            animationType={reduced ? 'none' : 'fade'}
            onRequestClose={() => {
              if (resultVisible) exit();
              else {
                game.resume();
                setHud(game.snapshot());
              }
            }}
          >
            <View style={s.modalBackdrop}>
              <ScrollView
                testID="pick-box-overlay"
                style={s.overlay}
                contentContainerStyle={[
                  s.overlayContent,
                  { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
                ]}
              >
                <Icon name={resultVisible ? 'trophy' : 'pause'} size={44} color="#FFE28A" />
                <Text
                  testID="pick-box-overlay-title"
                  accessibilityRole="header"
                  style={s.overlayTitle}
                >
                  {resultVisible
                    ? hud.reason === 'collapse'
                      ? copy.collapse
                      : copy.missed
                    : copy.pause}
                </Text>
                <Text style={s.resultScore}>{hud.score}</Text>
                <Text style={s.resultLabel}>
                  {copy.boxes} · {copy.peaks[hud.peak]}
                </Text>
                <Text style={s.resultBest}>
                  {copy.best}: {best}
                </Text>
                <View style={s.overlayActions}>
                  <Action
                    testID={resultVisible ? 'pick-box-retry' : 'pick-box-resume'}
                    onPress={
                      resultVisible
                        ? restart
                        : () => {
                            game.resume();
                            setHud(game.snapshot());
                          }
                    }
                  >
                    {resultVisible ? copy.retry : copy.resume}
                  </Action>
                  <Action secondary testID="pick-box-menu" onPress={exit}>
                    {copy.exit}
                  </Action>
                </View>
                <Text style={s.overlayNote}>{saveError ? copy.storage : copy.local}</Text>
              </ScrollView>
            </View>
          </Modal>
        ) : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: INK, alignItems: 'center' },
  frame: { flex: 1, backgroundColor: '#16C2DC', overflow: 'hidden' },
  background: { position: 'absolute', left: 0, top: 0 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 4,
  },
  control: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: INK,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.75 },
  wordmark: { fontFamily: font.display, color: INK, fontSize: 25, letterSpacing: -0.5 },
  start: { flex: 1 },
  startHeading: { paddingTop: 8, paddingHorizontal: 24, alignItems: 'center' },
  heroTitle: {
    fontFamily: font.display,
    fontSize: 54,
    lineHeight: 66,
    color: INK,
    letterSpacing: -1.4,
  },
  heroSubtitle: {
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 21,
    color: INK,
    textAlign: 'center',
    maxWidth: 310,
  },
  hero: { flex: 1, width: '100%', marginTop: 12 },
  startBottom: { paddingTop: 18, paddingHorizontal: 24, backgroundColor: INK, gap: 14 },
  rule: {
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 20,
    color: '#FFF4D5',
    textAlign: 'center',
  },
  action: {
    minHeight: 56,
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 16,
    backgroundColor: '#FF842F',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: {
    fontFamily: font.bold,
    color: INK,
    fontSize: 18,
    lineHeight: 25,
    textAlign: 'center',
  },
  secondary: { backgroundColor: '#18315A' },
  local: {
    color: '#C7DDFB',
    fontFamily: font.body,
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
  },
  hud: { paddingHorizontal: 20, paddingTop: 8, alignItems: 'center' },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
  },
  best: {
    flexDirection: 'row',
    gap: 7,
    alignItems: 'center',
    backgroundColor: INK,
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  bestText: { color: '#FFF4D5', fontFamily: font.bold, fontSize: 15 },
  hearts: {
    flexDirection: 'row',
    gap: 4,
    backgroundColor: '#FFFAE4',
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  scoreWrap: { marginTop: -28, minWidth: 85, alignItems: 'center' },
  score: {
    color: INK,
    fontFamily: font.display,
    fontSize: 64,
    lineHeight: 74,
    fontVariant: ['tabular-nums'],
  },
  peakRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 0 },
  peak: { fontFamily: font.bold, color: INK, fontSize: 14, lineHeight: 21 },
  playfield: { flex: 1, overflow: 'hidden' },
  feedback: { position: 'absolute', left: 0, right: 0, top: '13%', alignItems: 'center' },
  feedbackText: {
    fontFamily: font.display,
    fontSize: 25,
    color: '#FFF8D9',
    textShadowColor: INK,
    textShadowRadius: 2,
    textShadowOffset: { width: 0, height: 2 },
    backgroundColor: '#04143AD9',
    paddingHorizontal: 14,
    paddingVertical: 3,
    borderRadius: 10,
  },
  combo: {
    color: INK,
    backgroundColor: '#FFE28A',
    paddingHorizontal: 10,
    borderRadius: 8,
    fontFamily: font.bold,
    fontSize: 12,
    paddingVertical: 3,
    marginTop: 4,
  },
  bottom: { paddingHorizontal: 22, paddingTop: 4, gap: 7 },
  drop: {
    backgroundColor: '#FFF4D5',
    minHeight: 54,
    borderRadius: 18,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  dropBusy: { backgroundColor: '#D3E7DB' },
  dropText: {
    color: INK,
    fontFamily: font.bold,
    fontSize: 12,
    lineHeight: 19,
    flexShrink: 1,
    textAlign: 'center',
  },
  progress: {
    color: '#FFF8DC',
    fontFamily: font.bold,
    fontSize: 11,
    textAlign: 'center',
    textShadowColor: INK,
    textShadowRadius: 3,
    textShadowOffset: { width: 0, height: 1 },
  },
  modalBackdrop: { flex: 1, backgroundColor: '#04143AF2', alignItems: 'center' },
  overlay: { flex: 1, width: '100%', maxWidth: 540 },
  overlayContent: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 28,
  },
  overlayTitle: {
    width: '100%',
    color: '#FFF4D5',
    fontFamily: font.display,
    fontSize: 30,
    lineHeight: 39,
    textAlign: 'center',
    marginTop: 18,
  },
  resultScore: {
    color: '#FFFFFF',
    fontFamily: font.display,
    fontSize: 100,
    lineHeight: 118,
    marginTop: 12,
  },
  resultLabel: {
    color: '#C7DDFB',
    fontFamily: font.medium,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  resultBest: { color: '#FFE28A', fontFamily: font.bold, fontSize: 18, marginTop: 16 },
  overlayActions: { width: '100%', maxWidth: 340, gap: 12, marginTop: 30 },
  overlayNote: {
    color: '#C7DDFB',
    fontFamily: font.body,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 22,
  },
});
