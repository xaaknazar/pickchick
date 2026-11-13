import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  BackHandler,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
  useWindowDimensions,
} from 'react-native';
import { Text } from '../../components/LocalizedText';
import { useRouter, useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Icon, type IconName } from '../../components/UI';
import { useReducedMotion } from '../../components/Motion';
import { useLocale } from '../../i18n';
import { font } from '../../theme';
import { PickBoxEngine, type Cue, type Snapshot } from './engine';
import { pickBoxCopy, boxCount } from './copy';
import { PickBoxRecords, RECORD_KEY } from './storage';
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_KEY,
  parsePreferences,
  type Preferences,
} from './preferences';
import { nextMilestone } from './ascent';
import { usePickBoxAudio } from './audio';
import { World } from './World';
import { Scenery } from './Scenery';

const records = new PickBoxRecords({
  read: () => AsyncStorage.getItem(RECORD_KEY),
  write: (value) => AsyncStorage.setItem(RECORD_KEY, value),
});
const INK = '#04143A';

function Control({
  icon,
  label,
  onPress,
  testID,
  dark = false,
}: {
  dark?: boolean;
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
      style={({ pressed }) => [s.control, dark && s.controlDark, pressed && s.pressed]}
    >
      <Icon name={icon} size={22} color={dark ? '#FFF6DC' : INK} />
    </Pressable>
  );
}
function Action({
  children,
  onPress,
  testID,
  secondary = false,
  disabled = false,
}: {
  children: string;
  onPress(): void;
  testID: string;
  secondary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.action,
        secondary && s.secondary,
        (pressed || disabled) && s.pressed,
      ]}
    >
      <Text style={[s.actionText, secondary && { color: '#FFFFFF' }]}>{children}</Text>
    </Pressable>
  );
}
function Setting({
  label,
  icon,
  value,
  onChange,
  testID,
}: {
  label: string;
  icon: IconName;
  value: boolean;
  onChange(value: boolean): void;
  testID: string;
}) {
  return (
    <View style={s.setting}>
      <Icon name={icon} size={19} color="#C7DDFB" />
      <Text style={s.settingLabel}>{label}</Text>
      <Switch
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        trackColor={{ false: '#415879', true: '#FF842F' }}
        thumbColor="#FFF4D5"
      />
    </View>
  );
}

export function PickBoxScreen() {
  const router = useRouter();
  const locale = useLocale();
  const copy = pickBoxCopy(locale);
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const [game, setGame] = useState(() => new PickBoxEngine());
  const [hud, setHud] = useState<Snapshot>(game.snapshot());
  const [best, setBest] = useState(0);
  const [bestAtStart, setBestAtStart] = useState(0);
  const [saveError, setSaveError] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
  const preferencesRef = useRef(preferences);
  const preferencesWrites = useRef(Promise.resolve());
  const [feedback, setFeedback] = useState<Cue['kind'] | null>(null);
  const [milestone, setMilestone] = useState<number | null>(null);
  const [resultVisible, setResultVisible] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const milestoneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const { play, stop } = usePickBoxAudio(preferences.sound);
  const scorePop = useSharedValue(1);
  const width = Math.min(window.width, 540);
  const compact = window.width < 360 || window.height < 700 || window.fontScale > 1.3;
  const scoreStyle = useAnimatedStyle(() => ({ transform: [{ scale: scorePop.value }] }));

  useEffect(() => {
    let live = true;
    void Promise.all([
      AsyncStorage.getItem(PREFERENCES_KEY).catch(() => null),
      records.record(),
    ]).then(([raw, record]) => {
      if (!live) return;
      preferencesRef.current = parsePreferences(raw);
      setPreferences(preferencesRef.current);
      setBest(record.best);
      setBestAtStart(record.best);
      setSaveError(!record.saved);
      const next = new PickBoxEngine({ guideFirstDrop: !preferencesRef.current.tutorialDone });
      next.start();
      if (AppState.currentState && AppState.currentState !== 'active') next.pause();
      setGame(next);
      setHud(next.snapshot());
    });
    return () => {
      live = false;
    };
  }, []);
  const updatePreferences = useCallback((patch: Partial<Preferences>) => {
    const value = { ...preferencesRef.current, ...patch };
    preferencesRef.current = value;
    setPreferences(value);
    preferencesWrites.current = preferencesWrites.current
      .catch(() => {})
      .then(() => AsyncStorage.setItem(PREFERENCES_KEY, JSON.stringify(value)))
      .catch(() => {});
  }, []);
  const cancelCountdown = useCallback(() => {
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    countdownTimer.current = null;
    setCountdown(0);
  }, []);
  const exit = useCallback(() => {
    cancelCountdown();
    stop();
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/events');
  }, [router, cancelCountdown, stop]);
  const change = useCallback((snapshot: Snapshot) => setHud(snapshot), []);
  const pause = useCallback(() => {
    cancelCountdown();
    stop();
    game.pause();
    setHud(game.snapshot());
  }, [game, cancelCountdown, stop]);
  const close = useCallback(() => {
    if (game.phase === 'playing' || game.phase === 'paused') pause();
    else exit();
  }, [game, pause, exit]);
  const resume = useCallback(() => {
    if (game.phase !== 'paused' || countdownTimer.current) return;
    let remaining = 3;
    setCountdown(remaining);
    countdownTimer.current = setInterval(() => {
      remaining--;
      if (remaining === 0) {
        cancelCountdown();
        game.resume();
        setHud(game.snapshot());
      } else setCountdown(remaining);
    }, 500);
  }, [game, cancelCountdown]);
  const restart = () => {
    cancelCountdown();
    stop();
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    if (milestoneTimer.current) clearTimeout(milestoneTimer.current);
    const next = new PickBoxEngine({ guideFirstDrop: !preferencesRef.current.tutorialDone });
    next.start();
    setBestAtStart(best);
    setGame(next);
    setHud(next.snapshot());
    setFeedback(null);
    setMilestone(null);
    setResultVisible(false);
  };
  const drop = useCallback(() => {
    if (!game.drop()) return;
    setHud(game.snapshot());
    if (!preferencesRef.current.tutorialDone) updatePreferences({ tutorialDone: true });
  }, [game, updatePreferences]);
  const cue = useCallback(
    (event: Cue) => {
      play(event.kind, game.combo);
      if (event.kind === 'peak') {
        setMilestone(game.snapshot().peak);
        if (milestoneTimer.current) clearTimeout(milestoneTimer.current);
        milestoneTimer.current = setTimeout(() => setMilestone(null), 2400);
        return;
      }
      if (event.kind === 'impact' && preferencesRef.current.haptics && Platform.OS !== 'web') {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      }
      if (['land', 'perfect', 'miss', 'collapse'].includes(event.kind)) {
        setFeedback(event.kind);
        if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
        feedbackTimer.current = setTimeout(() => setFeedback(null), 1100);
        if (event.kind === 'land' || event.kind === 'perfect') {
          scorePop.value = reduced ? 1 : 1.12;
          scorePop.value = withTiming(1, { duration: reduced ? 0 : 240 });
        }
        if (
          (event.kind === 'miss' || event.kind === 'perfect') &&
          preferencesRef.current.haptics &&
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
    [game, play, reduced, scorePop],
  );
  useEffect(() => {
    let live = true;
    void records.record(hud.score).then((value) => {
      if (live) {
        setBest(value.best);
        setSaveError(!value.saved);
      }
    });
    return () => {
      live = false;
    };
  }, [hud.score]);
  useEffect(() => {
    if (hud.phase !== 'over') return;
    const timer = setTimeout(() => setResultVisible(true), reduced ? 0 : 1100);
    return () => clearTimeout(timer);
  }, [hud.phase, reduced]);
  useEffect(() => () => game.dispose(), [game]);
  useEffect(
    () => () => {
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
      if (milestoneTimer.current) clearTimeout(milestoneTimer.current);
      if (countdownTimer.current) clearInterval(countdownTimer.current);
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
      const back =
        Platform.OS === 'android'
          ? BackHandler.addEventListener('hardwareBackPress', () => {
              close();
              return true;
            })
          : undefined;
      return () => {
        back?.remove();
        game.pause();
        stop();
        if (countdownTimer.current) clearInterval(countdownTimer.current);
      };
    }, [game, close, stop]),
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

  const darkSky = hud.score >= 28;
  const ink = darkSky ? '#FFF6DC' : INK;
  const goal = nextMilestone(hud.score);
  const goalName = hud.peak === 4 ? `${copy.height}: ${goal.target}` : copy.peaks[goal.stage];
  const goalText =
    locale === 'en'
      ? `${goalName} · ${boxCount(goal.remaining, locale)} ${copy.toGo}`
      : `${goalName} · ${copy.toGo} ${boxCount(goal.remaining, locale)}`;
  const coaching = !preferences.tutorialDone && hud.drops === 0;
  const statusText = coaching
    ? copy.hint
    : hud.canDrop
      ? copy.ready
      : hud.settling
        ? copy.settling
        : game.isWaiting
          ? copy.waiting
          : copy.falling;
  const newBest = hud.score > bestAtStart && hud.score > 0;
  const feedbackText =
    feedback === 'perfect'
      ? copy.perfect
      : feedback === 'land'
        ? copy.land
        : feedback === 'miss'
          ? copy.miss
          : feedback === 'collapse'
            ? copy.collapse
            : '';
  const settings = (
    <View style={s.settings}>
      <Setting
        label={copy.sound}
        icon={preferences.sound ? 'volume-high-outline' : 'volume-mute-outline'}
        value={preferences.sound}
        onChange={(sound) => updatePreferences({ sound })}
        testID="pick-box-sound"
      />
      <Setting
        label={copy.haptics}
        icon="phone-portrait-outline"
        value={preferences.haptics}
        onChange={(haptics) => updatePreferences({ haptics })}
        testID="pick-box-haptics"
      />
    </View>
  );
  return (
    <View style={s.screen}>
      <StatusBar style={hud.phase === 'paused' || resultVisible || darkSky ? 'light' : 'dark'} />
      <View testID="pick-box-screen" style={[s.frame, { width }]}>
        <Scenery
          score={hud.score}
          active={hud.phase === 'playing'}
          reduced={reduced}
          width={width}
          height={window.height}
        />
        <View style={[s.header, { paddingTop: insets.top + 8 }]}>
          <Control
            icon="close"
            label={hud.phase === 'playing' ? copy.pause : copy.exit}
            onPress={close}
            testID="pick-box-exit"
            dark={darkSky}
          />
          <Text style={[s.wordmark, { color: ink }]}>Pick Box</Text>
          <Control
            icon="pause"
            label={copy.pause}
            onPress={pause}
            testID="pick-box-pause"
            dark={darkSky}
          />
        </View>
        <>
          <View testID="pick-box-hud" style={s.hud} pointerEvents="none">
            <View style={s.statRow}>
              <View style={s.best} accessible accessibilityLabel={`${copy.best}: ${best}`}>
                <Icon name="trophy" size={16} color="#FFE28A" />
                <Text testID="pick-box-best" maxFontSizeMultiplier={1.4} style={s.bestText}>
                  {best}
                </Text>
              </View>
              <View
                accessible
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
            <Animated.View style={[s.scoreWrap, compact && { marginTop: 0 }, scoreStyle]}>
              <Text
                testID="pick-box-score"
                accessibilityLabel={boxCount(hud.score, locale)}
                accessibilityLiveRegion="polite"
                maxFontSizeMultiplier={1.25}
                style={[s.score, compact && { fontSize: 46, lineHeight: 52 }, { color: ink }]}
              >
                {hud.score}
              </Text>
            </Animated.View>
            <View style={s.peakRow}>
              <Icon name={hud.peak >= 3 ? 'planet-outline' : 'trail-sign'} size={15} color={ink} />
              <Text
                testID="pick-box-peak"
                maxFontSizeMultiplier={1.4}
                style={[s.peak, { color: ink }]}
              >
                {copy.peaks[hud.peak]}
              </Text>
            </View>
            <Text
              testID="pick-box-goal"
              accessibilityLiveRegion="polite"
              maxFontSizeMultiplier={1.4}
              style={[s.goal, { color: ink }]}
            >
              {milestone !== null ? `${copy.opened}: ${copy.peaks[milestone]}` : goalText}
            </Text>
            <View pointerEvents="none" style={s.stateWrap}>
              <View style={[s.stateBadge, coaching && !feedback && s.coach]}>
                {coaching && !feedback ? (
                  <Icon name="hand-left-outline" size={16} color={INK} />
                ) : null}
                <Text
                  testID="pick-box-status"
                  accessibilityLiveRegion="polite"
                  maxFontSizeMultiplier={1.4}
                  style={[s.stateText, coaching && !feedback && { color: INK }]}
                >
                  {feedback
                    ? `${feedbackText}${hud.combo > 1 && feedback === 'perfect' ? ` · ${hud.combo} ${copy.combo}` : ''}`
                    : statusText}
                </Text>
              </View>
            </View>
          </View>
          <Pressable
            testID="pick-box-drop"
            accessibilityRole="button"
            accessibilityLabel={copy.drop}
            accessibilityHint={statusText}
            accessibilityState={{ disabled: !hud.canDrop }}
            disabled={!hud.canDrop}
            onPress={drop}
            style={s.playfield}
          >
            <World game={game} reduced={reduced} phase={hud.phase} onChange={change} onCue={cue} />
          </Pressable>
        </>
        {(hud.phase === 'paused' && countdown === 0) || resultVisible ? (
          <Modal
            transparent
            visible
            animationType={reduced ? 'none' : 'fade'}
            onRequestClose={resultVisible ? exit : resume}
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
                <Icon
                  name={
                    resultVisible
                      ? newBest
                        ? 'trophy'
                        : hud.score
                          ? 'trail-sign'
                          : 'refresh'
                      : 'pause'
                  }
                  size={44}
                  color="#FFE28A"
                />
                <Text
                  testID="pick-box-overlay-title"
                  accessibilityRole="header"
                  style={s.overlayTitle}
                >
                  {resultVisible ? (newBest ? copy.newBest : copy.over) : copy.pause}
                </Text>
                <Text style={s.resultScore}>{hud.score}</Text>
                <Text style={s.resultLabel}>
                  {boxCount(hud.score, locale)} · {copy.peaks[hud.peak]}
                </Text>
                <Text style={s.resultBest}>
                  {copy.best}: {best}
                </Text>
                {resultVisible ? (
                  <View style={s.resultDetails}>
                    <Text style={s.resultLabel}>
                      {hud.reason === 'collapse' ? copy.collapse : copy.missed}
                    </Text>
                    <Text style={s.resultLabel}>
                      {copy.bestCombo}: {hud.bestCombo}
                    </Text>
                    <Text style={s.goalLight}>{goalText}</Text>
                    <Text style={s.resultTip}>
                      {hud.reason === 'collapse' ? copy.collapseTip : copy.missTip}
                    </Text>
                  </View>
                ) : null}
                <View style={s.overlayActions}>
                  <Action
                    testID={resultVisible ? 'pick-box-retry' : 'pick-box-resume'}
                    onPress={resultVisible ? restart : resume}
                  >
                    {resultVisible ? copy.retry : copy.resume}
                  </Action>
                  <Action secondary testID="pick-box-menu" onPress={exit}>
                    {copy.exit}
                  </Action>
                  {settings}
                </View>
                <Text style={s.overlayNote}>{saveError ? copy.storage : copy.local}</Text>
              </ScrollView>
            </View>
          </Modal>
        ) : null}
        {countdown > 0 ? (
          <View style={s.countdown} pointerEvents="none" accessibilityLiveRegion="assertive">
            <Text style={s.countdownLabel}>{copy.countdown}</Text>
            <Text testID="pick-box-countdown" style={s.countdownNumber}>
              {countdown}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}
const s = StyleSheet.create({
  settings: { width: '100%', gap: 2 },
  setting: { minHeight: 48, flexDirection: 'row', gap: 10, alignItems: 'center' },
  settingLabel: { flex: 1, color: '#C7DDFB', fontFamily: font.medium, fontSize: 14 },
  goal: {
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 3,
    marginBottom: 4,
  },
  stateWrap: { alignItems: 'center', minHeight: 40, paddingTop: 2, paddingBottom: 6 },
  stateBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 12,
    backgroundColor: '#04143AC9',
  },
  coach: { backgroundColor: '#FFF4D5' },
  stateText: {
    flexShrink: 1,
    color: '#FFF4D5',
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  resultDetails: { gap: 10, marginTop: 16, maxWidth: 340 },
  goalLight: {
    color: '#FFE28A',
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
  },
  resultTip: {
    color: '#C7DDFB',
    fontFamily: font.body,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
  },
  countdown: {
    ...StyleSheet.absoluteFill,
    zIndex: 5,
    backgroundColor: '#04143A80',
    alignItems: 'center',
    justifyContent: 'center',
  },
  countdownLabel: { color: '#FFF4D5', fontFamily: font.bold, fontSize: 22 },
  countdownNumber: { color: '#FFE28A', fontFamily: font.display, fontSize: 110, lineHeight: 140 },

  screen: { flex: 1, backgroundColor: INK, alignItems: 'center' },
  frame: { flex: 1, backgroundColor: '#16C2DC', overflow: 'hidden' },
  header: {
    zIndex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 4,
  },
  control: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: '#FFFFFF38',
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlDark: { backgroundColor: '#FFFFFF18' },
  pressed: { opacity: 0.65 },
  wordmark: { fontFamily: font.display, color: INK, fontSize: 21, letterSpacing: -0.4 },
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
  hud: { zIndex: 2, paddingHorizontal: 20, paddingTop: 8, alignItems: 'center' },
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
  playfield: { flex: 1 },
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
