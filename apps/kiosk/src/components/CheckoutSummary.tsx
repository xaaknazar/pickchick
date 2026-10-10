import { Animated, Text, View } from 'react-native';
import type { KioskCartLine } from '../model';
import { money } from '../cart';
import { copy, type Locale } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
import { Icon } from './Icon';
import { CartTotal } from './CartTotal';
import { selectionSummary } from './selectionSummary';
import { useEnter } from './motion';
import { fixedText } from './Body';
/**
 * v3 order summary card on the blue review screen: white 30-pt card, one row per
 * line (name × qty, chosen options, line total), the total and the preparation time.
 */
export function CheckoutSummary({
  lines,
  total,
  valid,
  locale,
  estimated,
}: {
  lines: KioskCartLine[];
  total: string;
  valid: boolean;
  locale: Locale;
  estimated?: { min: number; max: number };
}) {
  const { v } = useMetrics();
  const t = copy(locale);
  const rise = useEnter();
  return (
    <Animated.View
      style={{
        opacity: rise,
        transform: [
          { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [v(22), 0] }) },
        ],
        borderRadius: v(30),
        backgroundColor: colors.white,
        shadowColor: '#020A28',
        shadowOpacity: 0.22,
        shadowRadius: 28,
        shadowOffset: { width: 0, height: 12 },
        elevation: 6,
        paddingTop: v(22),
        paddingBottom: v(20),
        paddingHorizontal: v(24),
        gap: v(16),
      }}
    >
      {lines.map((line) => {
        const summary = selectionSummary(line);
        return (
          <View
            key={line.lineId}
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: v(16),
              paddingBottom: v(16),
              borderBottomWidth: 1,
              borderColor: colors.border,
            }}
          >
            <View style={{ flex: 1, minWidth: 0, gap: v(4) }}>
              <Text
                {...fixedText}
                style={{
                  fontFamily: fonts.heavy,
                  fontSize: Math.max(18, v(20)),
                  lineHeight: Math.max(23, v(25)),
                  color: colors.navy,
                }}
              >
                {line.product.name} × {line.quantity}
              </Text>
              {summary ? (
                <Text
                  {...fixedText}
                  style={{
                    fontFamily: fonts.body,
                    fontSize: Math.max(15, v(15)),
                    lineHeight: Math.max(20, v(20)),
                    color: colors.muted,
                  }}
                >
                  {summary}
                </Text>
              ) : null}
            </View>
            <Text
              {...fixedText}
              style={{
                fontFamily: fonts.black,
                fontSize: Math.max(18, v(20)),
                color: colors.navy,
                fontVariant: ['tabular-nums'],
              }}
            >
              {money(line.lineTotalMinor)}
            </Text>
          </View>
        );
      })}
      <CartTotal total={total} valid={valid} locale={locale} />
      {estimated ? (
        <View
          style={{
            alignSelf: 'flex-start',
            minHeight: v(40),
            paddingLeft: v(12),
            paddingRight: v(16),
            borderRadius: 999,
            backgroundColor: colors.sky,
            flexDirection: 'row',
            alignItems: 'center',
            gap: v(8),
          }}
        >
          <Icon name="time-outline" size="small" tone="brand" />
          <Text
            {...fixedText}
            style={{
              fontFamily: fonts.medium,
              fontSize: Math.max(15, v(15)),
              color: colors.navy,
            }}
          >
            {t.preparation} {estimated.min}-{estimated.max} {t.minutes}
          </Text>
        </View>
      ) : null}
    </Animated.View>
  );
}
