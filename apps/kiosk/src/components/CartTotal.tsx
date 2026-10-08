import { Text, View } from 'react-native';
import { copy, type Locale } from '../i18n';
import { money } from '../cart';
import { colors, fonts, useMetrics } from '../theme';
import { Icon } from './Icon';
import { useTween } from './motion';
/** "3 позиции" / "3 позиция": Russian plural, Kazakh keeps the singular after a number. */
export const positionsLabel = (n: number, locale: Locale) => {
  if (locale !== 'ru') return n + ' позиция';
  const tens = n % 100;
  const ones = n % 10;
  return (
    n +
    (tens >= 11 && tens <= 14
      ? ' позиций'
      : ones === 1
        ? ' позиция'
        : ones >= 2 && ones <= 4
          ? ' позиции'
          : ' позиций')
  );
};
/**
 * v3 order total. `large` is the footer sheet: "Итого · N позиций", an optional
 * orange QR chip and the 52-pt total, which counts to each new total (prototype
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
  const amount = valid
    ? money(total)
    : locale === 'ru'
      ? 'Проверьте корзину'
      : 'Себетті тексеріңіз';
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
              minHeight: v(40),
              paddingLeft: v(6),
              paddingRight: v(14),
              borderRadius: 999,
              backgroundColor: '#F3F5FA',
              flexDirection: 'row',
              alignItems: 'center',
              gap: v(8),
            }}
          >
            <View
              style={{
                width: v(30),
                height: v(30),
                borderRadius: 999,
                backgroundColor: colors.orange,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="qr-code-outline" size="small" tone="inverse" />
            </View>
            <Text
              style={{
                fontFamily: fonts.medium,
                fontSize: Math.max(15, v(16)),
                color: colors.navy,
              }}
            >
              {t.payQR}
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
