import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copy, type Locale } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
import { Wrapper } from './Wrapper';
import { IconButton } from './IconButton';
import { Icon } from './Icon';
import { Logo } from './Logo';
import { Language } from './Language';
export interface ScreenContext {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  onCancel: () => void;
  onHelp: () => void;
}
/**
 * v3 header on blue/night surfaces: back pill or logo, white title, mode chip,
 * glass help/cancel controls and the language pill.
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
  minimal = false,
}: ScreenContext & {
  back?: () => void;
  backLabel?: string;
  title?: string;
  subtitle?: string;
  mode?: string;
  onMode?: () => void;
  minimal?: boolean;
}) {
  const { v } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(locale);
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
          <Pressable
            testID="kiosk-header-back"
            accessibilityRole="button"
            accessibilityLabel={backLabel ?? t.back}
            onPress={back}
            style={({ pressed }) => ({
              minHeight: Math.max(52, v(64)),
              paddingLeft: v(14),
              paddingRight: v(22),
              borderRadius: 999,
              backgroundColor: colors.glass,
              flexDirection: 'row',
              alignItems: 'center',
              gap: v(8),
              transform: [{ scale: pressed ? 0.95 : 1 }],
            })}
          >
            <Icon name="chevron-back" tone="inverse" />
            <Text style={{ fontFamily: fonts.heavy, fontSize: v(18), color: colors.white }}>
              {backLabel ?? t.back}
            </Text>
          </Pressable>
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
        {mode ? (
          <Pressable
            testID="kiosk-header-mode"
            accessibilityRole={onMode ? 'button' : 'text'}
            accessibilityLabel={mode}
            disabled={!onMode}
            onPress={onMode}
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
