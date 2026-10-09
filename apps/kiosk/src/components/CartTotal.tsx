import { Text, View } from 'react-native';
import { Image } from 'expo-image';
import { copy, itemCount, type Locale } from '../i18n';
import { money } from '../cart';
import { colors, fonts, useMetrics } from '../theme';
import { useTween } from './motion';
const kaspiLogo = require('../../assets/v3/kaspi.webp');
/** "3 позиции" / "3 позиция" / "3 items" (see `itemCount`). */
export const positionsLabel = (n: number, locale: Locale) => itemCount(n, locale);
/**
 * v3 order total. `large` is the footer sheet: "Итого · N позиций", an optional
 * Kaspi QR chip (Kaspi mark) and the 52-pt total, which counts to each new total (prototype
 * `tween()`, 380 ms ease-out cubic). `regular` is the summary-card row.
 */
export function CartTotal({
  total,
  valid,
  locale,
  count,
  qr = false,
  size = 'regular',
}: {
  total: string;
  valid: boolean;
  locale: Locale;
  count?: number;
  qr?: boolean;
  size?: 'regular' | 'large';
}) {
  const { v } = useMetrics();
  const t = copy(locale);
  const large = size === 'large';
  const amount = valid ? money(total) : t.checkCart;
  const target = valid ? Number(total) : 0;
  const counted = useTween(target);
  // Whole tenge while counting; the spoken label is always the final amount.
  const shown =
    large && valid && counted !== target
      ? money(String(Math.max(0, Math.round(counted / 100) * 100)))
      : amount;
  const amountSize = valid ? v(large ? 52 : 34) : v(large ? 30 : 24);
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: large ? 'flex-end' : 'center',
        justifyContent: 'space-between',
        gap: v(16),
      }}
    >
      <View style={{ gap: v(8), flexShrink: 1 }}>
        <Text
          style={{
            fontFamily: fonts.medium,
            fontSize: Math.max(17, v(large ? 19 : 18)),
            color: colors.muted,
          }}
        >
          {count === undefined ? t.total : t.total + ' · ' + positionsLabel(count, locale)}
        </Text>
        {qr ? (
          <View
            style={{
              alignSelf: 'flex-start',
              minHeight: v(44),
              paddingLeft: v(6),
              paddingRight: v(16),
              borderRadius: 999,
              backgroundColor: '#F3F5FA',
              flexDirection: 'row',
              alignItems: 'center',
              gap: v(8),
            }}
          >
            <Image
              source={kaspiLogo}
              contentFit="contain"
              accessible={false}
              accessibilityLabel=""
              style={{ width: v(32), height: v(32) }}
            />
            <Text
              style={{
                fontFamily: fonts.medium,
                fontSize: Math.max(15, v(17)),
                color: colors.navy,
              }}
            >
              {t.payKaspiQR}
            </Text>
          </View>
        ) : null}
      </View>
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        accessibilityLabel={amount}
        style={{
          flexShrink: 1,
          fontFamily: fonts.black,
          fontSize: amountSize,
          lineHeight: Math.round(amountSize * 1.08),
          letterSpacing: valid ? -amountSize * 0.02 : 0,
          color: valid ? colors.navy : colors.error,
          textAlign: 'right',
          fontVariant: ['tabular-nums'],
        }}
      >
        {shown}
      </Text>
    </View>
  );
}
