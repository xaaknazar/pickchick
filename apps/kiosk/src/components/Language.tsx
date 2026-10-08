import { Animated, Pressable, StyleSheet, View } from 'react-native';
import type { Locale } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
import { useTimingTo } from './motion';
/**
 * v3 language switch: a glass pill; the active language is a white capsule.
 * Switching crossfades the capsule and the label colour over 200 ms, like the
 * prototype's background/colour transition (instant under reduced motion).
 */
export function Language({
  locale,
  onChange,
  tone = 'default',
}: {
  locale: Locale;
  onChange: (locale: Locale) => void;
  /** `default` sits on blue glass, `inverse` on photos, `light` on light surfaces. */
  tone?: 'default' | 'inverse' | 'light';
}) {
  const { v } = useMetrics();
  const film = tone === 'inverse';
  const light = tone === 'light';
  return (
    <View
      style={{
        flexDirection: 'row',
        padding: v(5),
        borderRadius: 999,
        backgroundColor: film ? 'rgba(4,20,58,.42)' : light ? colors.light : colors.glass,
        borderWidth: film ? 1 : 0,
        borderColor: colors.glassLine,
        gap: v(4),
      }}
    >
      {(['kk', 'ru'] as const).map((value) => (
        <Option
          key={value}
          value={value}
          on={value === locale}
          tone={tone}
          onPress={() => onChange(value)}
        />
      ))}
    </View>
  );
}

function Option({
  value,
  on,
  tone,
  onPress,
}: {
  value: Locale;
  on: boolean;
  tone: 'default' | 'inverse' | 'light';
  onPress: () => void;
}) {
  const { v } = useMetrics();
  const film = tone === 'inverse';
  const fill = useTimingTo(on ? 1 : 0, 200, 'css');
  const label = value === 'kk' ? 'KZ' : 'RU';
  const text = { fontFamily: fonts.heavy, fontSize: v(film ? 20 : 17) };
  return (
    <Pressable
      testID={'kiosk-language-' + value}
      accessibilityRole="button"
      accessibilityLabel={value === 'kk' ? 'KZ - Қазақша' : 'RU - Русский'}
      accessibilityState={{ selected: on }}
      aria-pressed={on}
      onPress={onPress}
      style={{
        minWidth: Math.max(48, v(film ? 84 : 64)),
        minHeight: Math.max(48, v(film ? 60 : 50)),
        paddingHorizontal: v(16),
        borderRadius: 999,
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { borderRadius: 999, backgroundColor: colors.white, opacity: fill },
        ]}
      />
      <View pointerEvents="none">
        <Animated.Text
          style={{
            ...text,
            color: tone === 'light' ? colors.muted : colors.white,
            opacity: fill.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
          }}
        >
          {label}
        </Animated.Text>
        <Animated.Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          aria-hidden
          style={{
            ...text,
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            textAlign: 'center',
            color: colors.navy,
            opacity: fill,
          }}
        >
          {label}
        </Animated.Text>
      </View>
    </Pressable>
  );
}
