import { useEffect, useMemo, useRef } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copy, type Locale } from '../i18n';
import type { KioskMode, KioskStep } from '../model';
import { colors, fonts, useMetrics } from '../theme';
import { Wrapper } from './Wrapper';
import { fixedText } from './Body';
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
/** Single pilot point; the catalog carries only a branch id, not its display name. */
export const pilotBranch = 'ТЦ Abay Plaza';
/**
 * v3 header on blue/night surfaces, per design screen:
 * - dining choice (`onClose`): round close disc, logo, "PICK CHICK" over the
 *   branch, language pill (design 02, 105 high, side padding 28);
 * - menu (`onDining`, `minimal`): logo, title over the
 *   branch, two-segment dining switch, language pill (design 03, 113 high,
 *   side padding 24); with `logoCancels` the logo opens the cancel dialog, as the
 *   design has no help/close discs there;
 * - other screens: back pill or logo, white title, mode chip, glass help/cancel
 *   controls and the language pill.
 */
export function Header({
  locale,
  setLocale,
  onCancel,
  onHelp,
  back,
  backLabel,
  onClose,
  title,
  subtitle,
  mode,
  onMode,
  dining,
  onDining,
  minimal = false,
  logoCancels = false,
}: ScreenContext & {
  back?: () => void;
  /** Accessible name of the back pill or the close disc. */
  backLabel?: string;
  /** Design 02: a round close disc replaces the back pill, with the brand block. */
  onClose?: () => void;
  title?: string;
  subtitle?: string;
  mode?: string;
  onMode?: () => void;
  /** With `onDining`, the menu's in-place dining switch replaces the mode chip. */
  dining?: KioskMode | null;
  onDining?: (mode: KioskMode) => unknown;
  minimal?: boolean;
  /** Without visible help/close discs, the logo keeps the guest's way out. */
  logoCancels?: boolean;
}) {
  const { v, px } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(locale);
  const backPress = usePress(0.96);
  const closePress = usePress(0.92);
  const logoPress = usePress(0.96);
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
  const brand = !!onClose;
  // Only the menu (design 03) carries the dining switch; cart, upsell, loyalty
  // and payment headers keep their own title/subtitle styling.
  const menu = !brand && !!onDining;
  const side = v(brand ? 28 : 24);
  const close = v(64);
  const logo = <Logo size={brand ? 'regular' : 'large'} />;
  return (
    <View
      style={{
        paddingTop: safe.top,
        paddingLeft: Math.max(safe.left, side),
        paddingRight: Math.max(safe.right, side),
        borderBottomWidth: 1,
        borderColor: colors.glassLine,
      }}
    >
      <View
        style={{
          minHeight: brand ? v(104) : menu ? v(112) : undefined,
          paddingVertical: brand || menu ? v(10) : px(14),
          flexDirection: 'row',
          alignItems: 'center',
          gap: brand || menu ? v(16) : px(14),
        }}
      >
        {onClose ? (
          <Animated.View style={{ transform: [{ scale: closePress.scale }] }}>
            <Pressable
              testID="kiosk-header-back"
              accessibilityRole="button"
              accessibilityLabel={backLabel ?? t.back}
              onPress={onClose}
              onPressIn={closePress.onPressIn}
              onPressOut={closePress.onPressOut}
              style={{
                width: close,
                height: close,
                borderRadius: close / 2,
                backgroundColor: colors.glass,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="close" tone="inverse" />
            </Pressable>
          </Animated.View>
        ) : null}
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
              <Text
                {...fixedText}
                style={{ fontFamily: fonts.heavy, fontSize: v(18), color: colors.white }}
              >
                {backLabel ?? t.back}
              </Text>
            </Pressable>
          </Animated.View>
        ) : logoCancels ? (
          <Animated.View style={{ transform: [{ scale: logoPress.scale }] }}>
            <Pressable
              testID="kiosk-cancel-open"
              accessibilityRole="button"
              accessibilityLabel={t.cancel}
              onPress={onCancel}
              onPressIn={logoPress.onPressIn}
              onPressOut={logoPress.onPressOut}
            >
              {logo}
            </Pressable>
          </Animated.View>
        ) : (
          logo
        )}
        {brand ? (
          <Wrapper flex={1} gap={2}>
            <Text
              {...fixedText}
              numberOfLines={1}
              style={{
                fontFamily: fonts.heavy,
                fontSize: v(13),
                letterSpacing: v(1.4),
                color: 'rgba(255,255,255,.6)',
              }}
            >
              PICK CHICK
            </Text>
            <Text
              {...fixedText}
              accessibilityRole="header"
              numberOfLines={1}
              style={{
                fontFamily: fonts.bold,
                fontSize: v(19),
                lineHeight: v(24),
                color: colors.white,
              }}
            >
              {subtitle ?? pilotBranch}
            </Text>
          </Wrapper>
        ) : (
          <Wrapper flex={1} gap={2}>
            <Text
              {...fixedText}
              accessibilityRole="header"
              numberOfLines={1}
              style={{
                fontFamily: fonts.black,
                fontSize: v(title ? (menu ? 26 : 28) : 15),
                lineHeight: menu ? v(30) : undefined,
                letterSpacing: title ? -0.3 : 1.4,
                color: title ? colors.white : colors.onBlueMuted,
              }}
            >
              {title ?? 'PICK CHICK'}
            </Text>
            {subtitle ? (
              <Text
                {...fixedText}
                numberOfLines={1}
                style={{
                  fontFamily: fonts.medium,
                  fontSize: v(16),
                  color: menu ? 'rgba(255,255,255,.8)' : colors.onBlueMuted,
                }}
              >
                {subtitle}
              </Text>
            ) : null}
          </Wrapper>
        )}
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
              <Text
                {...fixedText}
                style={{ fontFamily: fonts.black, fontSize: v(15), color: colors.blue }}
              >
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
      </View>
    </View>
  );
}
