import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  AppState,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { assets } from '../assets';
import { colors, fonts } from '../theme';
import type { Locale } from '../i18n';
import { PhotoController } from '../photobooth/controller';
import { createPhotoIO } from '../photobooth/io';
import { photoCopy } from '../photobooth/copy';
import { fixedText } from './Body';
import { PhotoCamera } from './PhotoCamera';

export function PhotoBooth({
  locale,
  onClose,
  onInteraction,
  controller: supplied,
}: {
  locale: Locale;
  onClose: () => void;
  onInteraction: () => void;
  controller?: PhotoController;
}) {
  const [controller] = useState(() => supplied ?? new PhotoController(createPhotoIO()));
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [setup, setSetup] = useState(false);
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [cameraReady, setCameraReady] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [shot, setShot] = useState(0);
  const t = photoCopy(locale);
  const { height } = useWindowDimensions();
  const cameraWidth = Math.min(760, Math.max(320, ((height - 370) * 4) / 3));
  const lastTouch = useRef(Date.now());
  const callbacks = useRef({ onClose, onInteraction });
  callbacks.current = { onClose, onInteraction };
  const touch = () => {
    lastTouch.current = Date.now();
    callbacks.current.onInteraction();
  };
  useEffect(() => {
    if (!supplied) void controller.init();
    const close = () => {
      // Finding 3.8: a final print result is acknowledged before the next guest can open the
      // booth; an ambiguous one is kept for its own status check.
      void controller.close().finally(() => controller.dispose());
      callbacks.current.onClose();
    };
    const timeout = setInterval(() => {
      if (Date.now() - lastTouch.current >= 60000) close();
      else callbacks.current.onInteraction(); // Bound the camera visit without starting an order.
    }, 1000);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background') close();
      else if (s === 'inactive') setCount(null); // iOS camera permission temporarily deactivates the app.
    });
    return () => {
      clearInterval(timeout);
      sub.remove();
      controller.dispose();
    };
  }, [controller, supplied]);
  useEffect(() => {
    if (count === null) return;
    const timer = setTimeout(() => {
      if (count > 1) setCount(count - 1);
      else {
        setCount(null);
        setShot((s) => s + 1);
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [count]);
  useEffect(() => {
    if (state.ready && state.phase === 'intro' && !setup) controller.camera();
  }, [controller, state.ready, state.phase, setup]);
  const completed = useRef<string | null>(null);
  useEffect(() => {
    if (
      state.phase !== 'result' ||
      state.job?.state !== 'sent' ||
      state.busy ||
      completed.current === state.job.id
    )
      return;
    completed.current = state.job.id;
    let active = true;
    void controller.finishIfSent().then((done) => {
      if (active && done) callbacks.current.onClose();
    });
    return () => {
      active = false;
    };
  }, [controller, state.phase, state.job, state.busy]);
  const exit = () => {
    void controller
      .finish()
      .catch(() => {})
      .finally(onClose);
  };
  const result = state.phase === 'result';
  const sent = state.job?.state === 'sent',
    failed = state.job?.state === 'failed';
  const resultTitle = sent ? t.sent : failed ? t.failed : t.unknown;
  const resultBody = sent ? t.sentBody : failed ? t.failedBody : t.unknownBody;
  const preview = state.preview;
  const photoUri = preview ? 'data:image/png;base64,' + preview.png : state.localUri;
  const action = (
    label: string,
    fn: () => void,
    id: string,
    secondary = false,
    disabled = false,
  ) => (
    <Pressable
      key={id}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      testID={id}
      disabled={disabled}
      onPress={() => {
        touch();
        fn();
      }}
      style={({ pressed }) => [
        styles.button,
        secondary ? styles.secondary : styles.primary,
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      <Text {...fixedText} style={[styles.buttonText, secondary && styles.secondaryText]}>
        {label}
      </Text>
    </Pressable>
  );
  return (
    <SafeAreaView style={styles.root} onTouchStart={touch}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.back}
          testID="photo-close"
          onPress={exit}
          style={styles.back}
        >
          <Ionicons name="arrow-back" size={28} color={colors.blue} accessible={false} />
          <Text {...fixedText} style={styles.backText}>
            {t.back}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.operator}
          testID="photo-staff-hold"
          delayLongPress={5000}
          onLongPress={() => {
            touch();
            setCount(null);
            setSetup(true);
          }}
          disabled={state.busy}
        >
          <Image source={assets.logo} style={styles.logo} accessibilityLabel="PickChick" />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text {...fixedText} accessibilityRole="header" style={styles.title}>
          {setup ? t.operator : result ? resultTitle : t.title}
        </Text>
        <Text {...fixedText} style={styles.subtitle}>
          {setup
            ? t.pairHelp
            : result
              ? resultBody
              : state.phase === 'preview'
                ? state.preview
                  ? t.preview
                  : t.local
                : t.subtitle}
        </Text>
        {setup ? (
          <View style={styles.setup}>
            <Text {...fixedText} style={styles.label}>
              {t.url}
            </Text>
            <TextInput
              {...fixedText}
              accessibilityLabel={t.url}
              testID="photo-url"
              value={url}
              onChangeText={setUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              maxLength={200}
              style={styles.input}
            />
            <Text {...fixedText} style={styles.label}>
              {t.code}
            </Text>
            <TextInput
              {...fixedText}
              accessibilityLabel={t.code}
              testID="photo-code"
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={6}
              style={styles.input}
            />
            {action(
              t.save,
              () =>
                void controller.connect(url, code).then(() => {
                  setCode('');
                  if (controller.state.connected) setSetup(false);
                }),
              'photo-connect',
              false,
              state.busy || code.length !== 6 || !url,
            )}
            {action(
              t.cancel,
              () => {
                setSetup(false);
                setCode('');
              },
              'photo-setup-cancel',
              true,
              state.busy,
            )}
          </View>
        ) : (
          <>
            {!state.ready ? <ActivityIndicator size="large" color={colors.blue} /> : null}
            {state.phase === 'camera' ? (
              <View style={[styles.camera, { maxWidth: cameraWidth }]}>
                <PhotoCamera
                  locale={locale}
                  shot={shot}
                  onReady={setCameraReady}
                  onError={() => {
                    setCount(null);
                    controller.cameraError();
                  }}
                  onCapture={(b, u, d) => void controller.captured(b, u, d, locale)}
                />
                {count !== null ? (
                  <View pointerEvents="none" style={styles.countdown}>
                    <Text {...fixedText} accessibilityLiveRegion="assertive" style={styles.count}>
                      {count}
                    </Text>
                  </View>
                ) : null}
                {action(
                  count === null ? t.capture : t.countdown,
                  () => setCount(3),
                  'photo-capture',
                  false,
                  !cameraReady || count !== null || state.busy,
                )}
              </View>
            ) : null}
            {state.phase === 'preview' && photoUri ? (
              <>
                <View style={styles.receipt}>
                  <Image
                    source={{ uri: photoUri }}
                    resizeMode="contain"
                    testID="photo-preview"
                    accessibilityLabel={preview ? t.preview : t.local}
                    style={{
                      width: '100%',
                      aspectRatio: preview ? preview.width / preview.height : 4 / 3,
                    }}
                  />
                  {!preview ? (
                    <Image
                      source={assets.logo}
                      resizeMode="contain"
                      style={styles.sampleLogo}
                      accessibilityLabel="PickChick"
                    />
                  ) : null}
                </View>
                <View style={styles.actions}>
                  {action(t.retake, () => controller.camera(), 'photo-retake', true)}
                  {action(
                    t.print,
                    () => void controller.print(),
                    'photo-print',
                    false,
                    !preview || !state.printingEnabled || state.busy,
                  )}
                </View>
              </>
            ) : null}
            {state.phase === 'preparing' || state.phase === 'submitting' ? (
              <View style={styles.progress}>
                <ActivityIndicator size="large" color={colors.blue} />
                <Text {...fixedText} accessibilityLiveRegion="polite" style={styles.hint}>
                  {state.phase === 'preparing' ? t.preparing : t.sending}
                </Text>
              </View>
            ) : null}
            {result ? (
              <View style={styles.result}>
                <Ionicons
                  name={sent ? 'print-outline' : failed ? 'alert-circle-outline' : 'time-outline'}
                  size={88}
                  color={colors.blue}
                  accessible={false}
                />
                {!sent && !failed
                  ? action(t.check, () => void controller.check(), 'photo-check', false, state.busy)
                  : null}
                {action(t.back, exit, 'photo-done', true)}
              </View>
            ) : null}
          </>
        )}
        {state.error && state.error !== 'UNKNOWN' ? (
          <Text {...fixedText} accessibilityRole="alert" style={styles.error}>
            {t.errors[state.error] ?? t.errors.CONNECTION}
          </Text>
        ) : null}
        {!setup && !result && state.ready && !state.printingEnabled ? (
          <Text {...fixedText} style={styles.small}>
            {t.unconfigured}
          </Text>
        ) : null}
        <Text {...fixedText} style={styles.privacy}>
          {t.privacy}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 28,
    paddingVertical: 16,
  },
  back: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12, paddingRight: 16 },
  backText: { fontFamily: fonts.bold, fontSize: 18, color: colors.blue },
  logo: { width: 76, height: 72, resizeMode: 'contain' },
  content: { alignItems: 'center', paddingHorizontal: 32, paddingBottom: 32, gap: 24, flexGrow: 1 },
  title: {
    fontFamily: fonts.black,
    fontSize: 32,
    lineHeight: 40,
    color: colors.navy,
    textAlign: 'center',
    maxWidth: 760,
  },
  subtitle: {
    fontFamily: fonts.body,
    fontSize: 19,
    lineHeight: 28,
    color: colors.navy,
    textAlign: 'center',
    maxWidth: 620,
  },
  sampleLogo: {
    width: 112,
    height: 104,
    resizeMode: 'contain',
    alignSelf: 'center',
    marginVertical: 12,
  },
  hint: {
    color: colors.navy,
    fontFamily: fonts.body,
    fontSize: 19,
    lineHeight: 28,
    textAlign: 'center',
    maxWidth: 640,
  },
  small: {
    color: colors.navy,
    fontFamily: fonts.body,
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
    maxWidth: 580,
  },
  privacy: {
    color: colors.navy,
    fontFamily: fonts.body,
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
    maxWidth: 600,
    marginTop: 'auto',
    paddingTop: 16,
  },
  camera: { width: '100%', maxWidth: 760, gap: 24 },
  countdown: {
    position: 'absolute',
    top: '24%',
    alignSelf: 'center',
    backgroundColor: colors.navy,
    borderRadius: 16,
    padding: 24,
  },
  count: { color: colors.white, fontFamily: fonts.black, fontSize: 80, textAlign: 'center' },
  receipt: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: colors.white,
    padding: 8,
    alignSelf: 'center',
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 16 },
  button: {
    minHeight: 64,
    paddingVertical: 18,
    paddingHorizontal: 28,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: { backgroundColor: colors.orange },
  secondary: { backgroundColor: colors.white },
  buttonText: { color: colors.navy, fontFamily: fonts.heavy, fontSize: 21, textAlign: 'center' },
  secondaryText: { color: colors.blue },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.8 },
  progress: { minHeight: 240, gap: 24, alignItems: 'center', justifyContent: 'center' },
  result: { gap: 32, alignItems: 'center', width: '100%', maxWidth: 620, paddingVertical: 32 },
  setup: { width: '100%', maxWidth: 620, gap: 16 },
  label: { color: colors.navy, fontFamily: fonts.bold, fontSize: 18 },
  input: {
    backgroundColor: colors.white,
    color: colors.ink,
    borderRadius: 12,
    padding: 18,
    minHeight: 60,
    fontSize: 20,
    fontFamily: fonts.body,
  },
  error: {
    color: colors.ink,
    backgroundColor: colors.cream,
    fontFamily: fonts.bold,
    fontSize: 18,
    lineHeight: 28,
    padding: 20,
    borderRadius: 16,
    maxWidth: 640,
  },
});
