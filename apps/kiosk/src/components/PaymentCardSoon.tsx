import { Text, View } from 'react-native';
import type { Locale } from '../i18n';
import { checkoutCopy } from '../checkoutCopy';
import { colors, fonts, useMetrics } from '../theme';
import { Icon } from './Icon';
import { fixedText } from './Body';
/**
 * Design 07: the card option beside "Cancel", shown but not yet available
 * ("Банковская карта · Скоро"). Not a button: nothing can be started from it.
 */
export function PaymentCardSoon({ locale }: { locale: Locale }) {
  const { v } = useMetrics();
  const c = checkoutCopy(locale);
  return (
    <View
      testID="kiosk-payment-card-soon"
      accessible
      accessibilityLabel={c.card + ', ' + c.soon}
      accessibilityState={{ disabled: true }}
      style={{
        minHeight: Math.max(52, v(96)),
        borderRadius: 999,
        backgroundColor: 'rgba(255,255,255,.08)',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: v(12),
        paddingHorizontal: v(24),
      }}
    >
      <Icon name="card-outline" tone="onBlue" />
      <Text
        {...fixedText}
        numberOfLines={1}
        style={{
          flexShrink: 1,
          fontFamily: fonts.heavy,
          fontSize: Math.max(20, v(22)),
          // Dimmed like the design, but kept readable (4.5:1 on the blue).
          color: colors.onBlueMuted,
        }}
      >
        {c.card}
      </Text>
      <View
        style={{
          paddingHorizontal: v(12),
          paddingVertical: v(4),
          borderRadius: 999,
          backgroundColor: colors.glass,
        }}
      >
        <Text
          {...fixedText}
          style={{ fontFamily: fonts.heavy, fontSize: Math.max(15, v(15)), color: colors.white }}
        >
          {c.soon}
        </Text>
      </View>
    </View>
  );
}
