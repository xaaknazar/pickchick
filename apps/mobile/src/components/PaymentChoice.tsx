import { useLocale } from '../i18n';
import { Image } from 'expo-image';
import { assets } from '../assets';
import { View } from 'react-native';
import type { PaymentMethod } from '../model';
import type { PaymentMethodId } from '../payment-method';
import { Icon, type IconName } from './UI';
import { colors } from '../theme';

// The old «Способ оплаты» sheet of this file (Kaspi / card with «Онлайн-оплата скоро появится»)
// had no caller since the Kaspi cart got its own selector (CartSheet); removed 29.10.2026 for the
// App Store build. The marks below are shared by the cart, the cart bar handle and checkout.

export function paymentName(method: PaymentMethod) {
  return method === 'kaspi' ? 'Kaspi' : 'Банковская карта';
}
/** Square-ish mark of a payment method: the Kaspi logo, the Apple Pay / Google Pay glyph or a card. */
export function PaymentMark({
  method,
  size = 34,
}: {
  method: PaymentMethod | PaymentMethodId;
  size?: number;
}) {
  useLocale();
  if (method === 'kaspi')
    return (
      <Image
        source={assets.kaspi}
        accessibilityLabel="Kaspi"
        testID="kaspi-logo"
        contentFit="contain"
        style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: '#FFFFFF' }}
      />
    );
  const mark = methodGlyph(method);
  return (
    <View
      testID={`payment-mark-${method}`}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        backgroundColor: mark.background,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon name={mark.icon} size={size * 0.6} color={mark.color} />
    </View>
  );
}

/** Glyph and colours of the non-Kaspi marks (the cart bar handle uses the same). */
export function methodGlyph(method: Exclude<PaymentMethodId, 'kaspi'>): {
  icon: IconName;
  color: string;
  background: string;
} {
  if (method === 'apple_pay')
    return { icon: 'logo-apple', color: '#FFFFFF', background: '#000000' };
  if (method === 'google_pay')
    return { icon: 'logo-google', color: '#1A73E8', background: '#FFFFFF' };
  return { icon: 'card-outline', color: colors.white, background: colors.action };
}
