import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Platform,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
  type ViewStyle,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MotionModal, motion, useReducedMotion } from './Motion';
import { Body, Button, Heading, Icon, IconButton, type IconName } from './UI';
import { colors, font } from '../theme';
import { SHEET_SPRING, lumaPalette } from '../luma-patterns';

// iOS "Reduce Transparency" and the web media query replace the blur with a deeper solid dim.
export function useReducedTransparency() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web') {
      const query =
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          ? window.matchMedia('(prefers-reduced-transparency: reduce)')
          : null;
      if (!query) return;
      const update = () => setReduced(query.matches);
      update();
      query.addEventListener?.('change', update);
      return () => query.removeEventListener?.('change', update);
    }
    let active = true;
    AccessibilityInfo.isReduceTransparencyEnabled()
      .then((value) => active && setReduced(value))
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener(
      'reduceTransparencyChanged',
      (value: boolean) => setReduced(value),
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

// Native blur needs an extra native module (expo-blur); native keeps the dim only.
const webBlur = (
  Platform.OS === 'web' ? { backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)' } : {}
) as ViewStyle;

/**
 * One confirmation surface (Luma pattern): icon in a soft square, bold title, short text,
 * one full-width primary action and a round close control. Springs up from the bottom over
 * a dimmed, blurred backdrop; reduced motion shows it at once.
 */
export function ConfirmSheet({
  visible,
  title,
  message,
  icon,
  iconColor = colors.accentText,
  primaryLabel,
  onPrimary,
  primaryDisabled = false,
  action,
  children,
  onClose,
  testID = 'confirm-sheet',
  primaryTestID,
}: {
  visible: boolean;
  title: string;
  message?: string;
  icon: IconName;
  iconColor?: string;
  primaryLabel?: string;
  onPrimary?(): void;
  primaryDisabled?: boolean;
  /** Replaces the primary button, e.g. a slide-to-confirm control. */
  action?: ReactNode;
  children?: ReactNode;
  onClose(): void;
  testID?: string;
  primaryTestID?: string;
}) {
  const reduced = useReducedMotion();
  const solid = useReducedTransparency();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [mounted, setMounted] = useState(visible);
  const y = useSharedValue(reduced ? 0 : height);
  const close = useRef<View>(null);
  useEffect(() => {
    if (visible) {
      setMounted(true);
      y.value = reduced ? 0 : height;
      y.value = reduced ? 0 : withSpring(0, SHEET_SPRING);
      return;
    }
    if (!mounted) return;
    if (reduced) {
      setMounted(false);
      return;
    }
    y.value = withTiming(
      height,
      { duration: motion.sheetExit, easing: Easing.in(Easing.cubic) },
      (done) => {
        if (done) runOnJS(setMounted)(false);
      },
    );
    // `mounted` only gates the exit; re-running on its change would restart the animation.
  }, [visible, reduced, height, y]);
  useEffect(() => {
    if (!visible || Platform.OS !== 'web') return;
    const node = close.current as unknown as HTMLElement | null;
    node?.focus?.();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [visible, onClose]);
  const sheet = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const scrim = useAnimatedStyle(() => ({ opacity: Math.max(0, 1 - y.value / height) }));
  if (!mounted) return null;
  return (
    <MotionModal visible transparent animationType="none" onRequestClose={onClose}>
      <GestureHandlerRootView style={s.root}>
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: solid ? lumaPalette.scrimSolid : lumaPalette.scrim },
            !solid && webBlur,
            scrim,
          ]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Закрыть: ${title}`}
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <Animated.View
          testID={testID}
          role="dialog"
          aria-modal
          accessibilityViewIsModal
          accessibilityLabel={title}
          style={[
            s.card,
            { marginBottom: Math.max(12, insets.bottom + 4), maxHeight: height - insets.top - 24 },
            sheet,
          ]}
        >
          <View style={s.top}>
            <View style={s.symbol}>
              <Icon name={icon} size={26} color={iconColor} />
            </View>
            <View ref={close}>
              <IconButton
                name="close"
                label="Закрыть"
                testID={`${testID}-close`}
                onPress={onClose}
                style={s.close}
              />
            </View>
          </View>
          <Heading style={s.title}>{title}</Heading>
          {message ? <Body style={s.message}>{message}</Body> : null}
          {children}
          <View style={s.action}>
            {action ?? (
              <Button
                title={primaryLabel ?? 'Понятно'}
                testID={primaryTestID ?? `${testID}-primary`}
                disabled={primaryDisabled}
                onPress={onPrimary}
                style={s.primary}
              />
            )}
          </View>
        </Animated.View>
      </GestureHandlerRootView>
    </MotionModal>
  );
}
const s = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end', alignItems: 'center', paddingHorizontal: 12 },
  card: {
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 20,
    gap: 10,
    borderRadius: 28,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    shadowColor: '#000000',
    shadowOpacity: 0.35,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  symbol: {
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  close: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.raised },
  title: { fontFamily: font.display, fontSize: 24, lineHeight: 30, marginTop: 6 },
  message: { color: colors.muted, fontSize: 15, lineHeight: 22 },
  action: { marginTop: 10 },
  primary: { minHeight: 56, borderRadius: 28 },
});
