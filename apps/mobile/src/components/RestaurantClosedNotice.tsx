import { StyleSheet, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import type { MobileModel } from '../model';
import { paymentStopMessage } from '../payment-availability';
import { usePaymentAvailability } from '../usePaymentAvailability';
import { colors, font } from '../theme';
import { useLocale } from '../i18n';
import { Text } from './LocalizedText';
import { Icon } from './UI';

/** Same opening notice on the storefront and cart; never describes stale data as closing. */
export function RestaurantClosedNotice({ model }: { model: MobileModel }) {
  useLocale();
  const focused = useIsFocused();
  const availability = usePaymentAvailability(model);
  if (!focused || availability.canPay || availability.stop.kind !== 'closed') return null;
  const message = paymentStopMessage(availability.stop);
  return (
    <View style={s.slot} pointerEvents="none">
      <View
        testID="restaurant-closed-notice"
        style={s.pill}
        accessible
        accessibilityLabel={message ?? undefined}
      >
        <Icon name="moon" size={21} color={colors.muted} />
        <Text testID="restaurant-closed-notice-text" style={s.text} maxFontSizeMultiplier={1.5}>
          {message}
        </Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  slot: { alignItems: 'center', paddingHorizontal: 16, paddingBottom: 8 },
  pill: {
    maxWidth: '100%',
    minHeight: 36,
    borderRadius: 24,
    paddingHorizontal: 14,
    paddingVertical: 7,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  text: {
    flexShrink: 1,
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 20,
    color: colors.muted,
  },
});
