import { Animated, Text, View } from 'react-native';
import { money } from '../cart';
import { copy, type Locale } from '../i18n';
import { paymentCopy } from '../paymentCopy';
import { colors, fonts, useMetrics } from '../theme';
import { fixedText } from './Body';
import { useEnter } from './motion';
/**
 * Centre of the Kaspi QR screen (kiosk redesign 2026-10-13, product-and-payment.md §4, 1024-pt
 * layout): the Kaspi mark 62 on a white ring beside «Kaspi QR» (Montserrat 900 40), «К оплате»
 * (20, 75 % white) and the amount in Montserrat 900 92, white. The block settles from above as
 * the screen opens (static under reduced motion); a long amount shrinks to fit, never wraps.
 */
export function KaspiAmount({ total, locale }: { total: string; locale: Locale }) {
  const { px } = useMetrics();
  const t = paymentCopy(locale);
  const drop = useEnter(0, 360);
  const rise = useEnter(60, 360);
  const amount = px(92);
  return (
    <View style={{ alignItems: 'center', maxWidth: '100%' }}>
      <Animated.View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: px(14),
          opacity: drop,
          transform: [
            { translateY: drop.interpolate({ inputRange: [0, 1], outputRange: [-10, 0] }) },
          ],
        }}
      >
        <Text
          {...fixedText}
          accessibilityRole="header"
          numberOfLines={1}
          style={{
            fontFamily: fonts.black,
            fontSize: px(40),
            lineHeight: px(48),
            letterSpacing: -0.4,
            color: colors.white,
          }}
        >
          {copy(locale).payKaspiQR}
        </Text>
      </Animated.View>
      <Animated.View
        style={{
          alignItems: 'center',
          marginTop: px(14),
          maxWidth: '100%',
          opacity: rise,
          transform: [
            { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) },
          ],
        }}
      >
        <Text
          {...fixedText}
          style={{
            fontFamily: fonts.medium,
            fontSize: Math.max(15, px(20)),
            lineHeight: Math.max(19, px(26)),
            color: 'rgba(255,255,255,.75)',
          }}
        >
          {t.toPay}
        </Text>
        <Text
          {...fixedText}
          testID="kiosk-payment-amount"
          numberOfLines={1}
          adjustsFontSizeToFit
          style={{
            fontFamily: fonts.black,
            fontSize: amount,
            // Montserrat Black needs 1.2 em for its line box, or the web clips the glyphs.
            lineHeight: Math.round(amount * 1.2),
            letterSpacing: -1,
            color: colors.white,
            fontVariant: ['tabular-nums'],
            textShadowColor: 'rgba(2,10,31,.28)',
            textShadowOffset: { width: 0, height: px(6) },
            textShadowRadius: px(18),
          }}
        >
          {money(total)}
        </Text>
      </Animated.View>
    </View>
  );
}
