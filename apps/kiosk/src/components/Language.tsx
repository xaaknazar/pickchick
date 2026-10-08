import { Pressable, View, Text } from 'react-native';
import type { Locale } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
/** v3 language switch: a glass pill; the active language is a white capsule. */
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
      {(['kk', 'ru'] as const).map((value) => {
        const on = value === locale;
        return (
          <Pressable
            key={value}
            testID={'kiosk-language-' + value}
            accessibilityRole="button"
            accessibilityLabel={value === 'kk' ? 'KZ - Қазақша' : 'RU - Русский'}
            accessibilityState={{ selected: on }}
            aria-pressed={on}
            onPress={() => onChange(value)}
            style={{
              minWidth: Math.max(48, v(film ? 84 : 64)),
              minHeight: Math.max(48, v(film ? 60 : 50)),
              paddingHorizontal: v(16),
              borderRadius: 999,
              justifyContent: 'center',
              alignItems: 'center',
              backgroundColor: on ? colors.white : 'transparent',
            }}
          >
            <Text
              style={{
                color: on ? colors.navy : light ? colors.muted : colors.white,
                fontFamily: fonts.heavy,
                fontSize: v(film ? 20 : 17),
              }}
            >
              {value === 'kk' ? 'KZ' : 'RU'}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
