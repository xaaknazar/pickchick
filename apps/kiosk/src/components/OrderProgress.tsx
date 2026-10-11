import { Text, View } from 'react-native';
import { copy, type Locale } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
import { fixedText } from './Body';
/** v3 step strip on blue surfaces: white labels, orange dots up to the current step. */
export function OrderProgress({
  step,
  locale,
}: {
  step: 'menu' | 'cart' | 'payment';
  locale: Locale;
}) {
  const { v } = useMetrics();
  const t = copy(locale);
  const current = ['menu', 'cart', 'payment'].indexOf(step);
  return (
    <View
      accessibilityLabel={t.orderStage}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: v(14),
        paddingVertical: v(14),
        paddingHorizontal: v(24),
        borderBottomWidth: 1,
        borderColor: colors.glassLine,
      }}
    >
      {[t.menu, t.yourOrder, t.payment].map((label, i) => (
        <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: v(14) }}>
          {i ? (
            <View
              style={{
                width: v(28),
                height: 2,
                borderRadius: 1,
                backgroundColor: i <= current ? colors.orange : colors.glassLine,
              }}
            />
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: v(8) }}>
            <View
              style={{
                width: Math.max(24, v(28)),
                height: Math.max(24, v(28)),
                borderRadius: 999,
                // The step number is small white text: accessible orangeInk fill.
                backgroundColor: i <= current ? colors.orangeInk : colors.glass,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text
                {...fixedText}
                style={{
                  fontSize: Math.max(13, v(14)),
                  fontFamily: fonts.black,
                  color: i <= current ? colors.white : colors.onBlueMuted,
                }}
              >
                {i + 1}
              </Text>
            </View>
            <Text
              {...fixedText}
              style={{
                fontFamily: i === current ? fonts.heavy : fonts.medium,
                fontSize: Math.max(16, v(17)),
                color: i === current ? colors.white : colors.onBlueMuted,
              }}
            >
              {label}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}
