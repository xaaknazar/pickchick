import { Pressable, View, Text } from 'react-native';
import type { Locale } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
export function Language({
  locale,
  onChange,
  tone = 'default',
}: {
  locale: Locale;
  onChange: (locale: Locale) => void;
  tone?: 'default' | 'inverse';
}) {
  const { px } = useMetrics();
  return (
    <View
      style={{
        flexDirection: 'row',
        padding: 4,
        borderRadius: 16,
        backgroundColor: tone === 'inverse' ? 'rgba(255,255,255,.14)' : colors.light,
        gap: 2,
      }}
    >
      {(['kk', 'ru'] as const).map((value) => (
        <Pressable
          key={value}
          testID={'kiosk-language-' + value}
          accessibilityRole="button"
          accessibilityLabel={value === 'kk' ? 'KZ - Қазақша' : 'RU - Русский'}
          accessibilityState={{ selected: value === locale }}
          aria-pressed={value === locale}
          onPress={() => onChange(value)}
          style={{
            minWidth: Math.max(48, px(62)),
            minHeight: 48,
            paddingHorizontal: 12,
            borderRadius: 12,
            justifyContent: 'center',
            alignItems: 'center',
            backgroundColor: value === locale ? colors.white : 'transparent',
          }}
        >
          <Text
            style={{
              color:
                value === locale ? colors.blue : tone === 'inverse' ? colors.white : colors.muted,
              fontFamily: fonts.medium,
              fontSize: 18,
            }}
          >
            {value === 'kk' ? 'KZ' : 'RU'}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
