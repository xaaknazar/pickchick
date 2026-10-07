import { View, Text } from 'react-native';
import { copy, type Locale } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
export function OrderProgress({
  step,
  locale,
}: {
  step: 'menu' | 'cart' | 'payment';
  locale: Locale;
}) {
  const { px } = useMetrics();
  const t = copy(locale);
  const current = ['menu', 'cart', 'payment'].indexOf(step);
  return (
    <View
      accessibilityLabel={locale === 'ru' ? 'Этап оформления' : 'Тапсырыс кезеңі'}
      style={{
        flexDirection: 'row',
        gap: px(24),
        paddingVertical: px(16),
        paddingHorizontal: px(28),
        backgroundColor: colors.white,
        borderBottomWidth: 1,
        borderColor: colors.border,
      }}
    >
      {[locale === 'ru' ? 'Меню' : 'Мәзір', t.yourOrder, t.payment].map((label, i) => (
        <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View
            style={{
              width: 24,
              height: 24,
              borderRadius: 12,
              backgroundColor: i <= current ? colors.blue : colors.light,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text
              style={{
                fontSize: 13,
                fontFamily: fonts.medium,
                color: i <= current ? colors.white : colors.muted,
              }}
            >
              {i + 1}
            </Text>
          </View>
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: Math.max(16, px(18)),
              color: i === current ? colors.blue : colors.muted,
            }}
          >
            {label}
          </Text>
        </View>
      ))}
    </View>
  );
}
