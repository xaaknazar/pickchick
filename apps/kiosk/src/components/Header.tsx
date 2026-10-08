import { useEffect, useMemo, useRef } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copy, type Locale } from '../i18n';
import type { KioskMode, KioskStep } from '../model';
import { colors, fonts, useMetrics } from '../theme';
import { Wrapper } from './Wrapper';
import { IconButton } from './IconButton';
import { Icon } from './Icon';
import { Logo } from './Logo';
import { Language } from './Language';
import { DiningSwitch } from './DiningSwitch';
import { usePress, usePulse } from './motion';
export interface ScreenContext {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  onCancel: () => void;
  onHelp: () => void;
  /** How the current screen was reached; drives the screen entrance. */
  direction?: 'forward' | 'back';
  /** The step shown before this one (`boot` before the first screen). */
  from?: KioskStep | 'boot';
}
/**
 * v3 header on blue/night surfaces: back pill or logo, white title, mode chip
 * (or the menu's dining switch), glass help/cancel controls and the language pill.
 */
export function Header({
  locale,
  setLocale,
  onCancel,
  onHelp,
  back,
  backLabel,
  title,
  subtitle,
  mode,
  onMode,
  dining,
  onDining,
  minimal = false,
}: ScreenContext & {
  back?: () => void;
  backLabel?: string;
  title?: string;
  subtitle?: string;
  mode?: string;
  onMode?: () => void;
  /** With `onDining`, the menu's in-place dining switch replaces the mode chip. */
  dining?: KioskMode | null;
  onDining?: (mode: KioskMode) => unknown;
  minimal?: boolean;
}) {
  const { v } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(locale);
  const backPress = usePress(0.96);
  const modePress = usePress(0.96);
  // Prototype `#cMode`: scale .9 -> 1.05 -> 1 over 340 ms when the mode changes.
  const modePulse = usePulse(0.9, 1.05, 340, 'linear');
  const modeScale = useMemo(
    () => Animated.multiply(modePress.scale, modePulse.scale),
    [modePress.scale, modePulse.scale],
  );
  const shownMode = useRef(mode);
  const pulseMode = modePulse.play;
  useEffect(() => {
    if (shownMode.current !== mode && shownMode.current && mode) pulseMode();
    shownMode.current = mode;
  }, [mode, pulseMode]);
  return (
    <View
      style={{
        paddingTop: safe.top,
        paddingLeft: Math.max(safe.left, v(24)),
        paddingRight: Math.max(safe.right, v(24)),
        borderBottomWidth: 1,
        borderColor: colors.glassLine,
      }}
    >
      <Wrapper dir="row" align="center" gap={14} paddingY={14}>
        {back ? (
          <Animated.View style={{ transform: [{ scale: backPress.scale }] }}>
            <Pressable
              testID="kiosk-header-back"
              accessibilityRole="button"
              accessibilityLabel={backLabel ?? t.back}
              onPress={back}
              onPressIn={backPress.onPressIn}
              onPressOut={backPress.onPressOut}
              style={{
                minHeight: Math.max(52, v(64)),
                paddingLeft: v(14),
                paddingRight: v(22),
                borderRadius: 999,
                backgroundColor: colors.glass,
                flexDirection: 'row',
                alignItems: 'center',
                gap: v(8),
              }}
            >
              <Icon name="chevron-back" tone="inverse" />
              <Text style={{ fontFamily: fonts.heavy, fontSize: v(18), color: colors.white }}>
                {backLabel ?? t.back}
              </Text>
            </Pressable>
          </Animated.View>
        ) : (
          <Logo size="large" />
        )}
        <Wrapper flex={1} gap={2}>
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            style={{
              fontFamily: fonts.black,
              fontSize: v(title ? 28 : 15),
              letterSpacing: title ? -0.3 : 1.4,
              color: title ? colors.white : colors.onBlueMuted,
            }}
          >
            {title ?? 'PICK CHICK'}
          </Text>
          {subtitle ? (
            <Text
              numberOfLines={1}
              style={{ fontFamily: fonts.medium, fontSize: v(16), color: colors.onBlueMuted }}
            >
              {subtitle}
            </Text>
          ) : null}
        </Wrapper>
        {onDining ? (
          <DiningSwitch key={locale} mode={dining ?? null} locale={locale} onChange={onDining} />
        ) : mode ? (
          <Animated.View style={{ transform: [{ scale: modeScale }] }}>
            <Pressable
              testID="kiosk-header-mode"
              accessibilityRole={onMode ? 'button' : 'text'}
              accessibilityLabel={mode}
              disabled={!onMode}
              onPress={onMode}
              onPressIn={modePress.onPressIn}
              onPressOut={modePress.onPressOut}
              style={{
                minHeight: v(52),
                paddingLeft: v(14),
                paddingRight: v(18),
                borderRadius: 999,
                backgroundColor: colors.white,
                flexDirection: 'row',
                alignItems: 'center',
                gap: v(8),
              }}
            >
              <Icon name="restaurant-outline" size="small" tone="accent" />
              <Text style={{ fontFamily: fonts.black, fontSize: v(15), color: colors.blue }}>
                {mode.toUpperCase()}
              </Text>
            </Pressable>
          </Animated.View>
        ) : null}
        {!minimal ? (
          <>
            <IconButton name="help-circle-outline" label={t.help} onPress={onHelp} tone="inverse" />
            <IconButton
              name="close"
              label={t.cancel}
              testID="kiosk-cancel-open"
              onPress={onCancel}
              tone="inverse"
            />
          </>
        ) : null}
        <Language locale={locale} onChange={setLocale} />
      </Wrapper>
    </View>
  );
}
