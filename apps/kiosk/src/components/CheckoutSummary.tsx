import { Animated, Text, View } from 'react-native';
import type { KioskCartLine } from '../model';
import { money } from '../cart';
import { copy, type Locale } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
import { CartTotal } from './CartTotal';
import { selectionLines } from './selectionSummary';
import { useEnter } from './motion';
import { fixedText } from './Body';
import { PhotoImage } from './PhotoImage';
import { productArtworkId } from '../assets';
/**
 * Order composition on the payment page («Проверьте заказ», owner 23.11.2026): a white card
 * titled «Ваш заказ», one row per line with a large photo on a light tile, the name, the
 * quantity, every chosen option on its own row and the line total. The footer carries the
 * order total, so the card repeats it only when `showTotal` is set.
 */
export function CheckoutSummary({
  lines,
  total,
  valid,
  locale,
  showTotal = false,
}: {
  lines: KioskCartLine[];
  total: string;
  valid: boolean;
  locale: Locale;
  estimated?: { min: number; max: number };
  showTotal?: boolean;
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
        paddingBottom: v(showTotal ? 20 : 8),
        paddingHorizontal: v(24),
      }}
    >
      <Text
        {...fixedText}
        style={{
          fontFamily: fonts.black,
          fontSize: Math.max(20, v(22)),
          color: colors.navy,
          paddingBottom: v(6),
        }}
      >
        {t.yourOrder}
      </Text>
      {lines.map((line, index) => {
        const options = selectionLines(line);
        const last = index === lines.length - 1 && !showTotal;
        return (
          <View
            key={line.lineId}
            testID={'kiosk-review-line-' + line.lineId}
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: v(18),
              paddingVertical: v(16),
              borderBottomWidth: last ? 0 : 1,
              borderColor: colors.border,
            }}
          >
            <View
              testID={'kiosk-review-photo-' + line.lineId}
              style={{
                width: v(104),
                height: v(104),
                borderRadius: v(22),
                overflow: 'hidden',
                backgroundColor: '#F3F5FA',
              }}
            >
              <PhotoImage imageId={productArtworkId(line.product)} variant="cart" />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: v(6), paddingTop: v(4) }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: v(10) }}>
                <Text
                  {...fixedText}
                  style={{
                    flexShrink: 1,
                    fontFamily: fonts.heavy,
                    fontSize: Math.max(20, v(23)),
                    lineHeight: Math.max(25, v(28)),
                    color: colors.navy,
                  }}
                >
                  {line.product.name}
                </Text>
                <View
                  style={{
                    paddingHorizontal: v(10),
                    minHeight: v(30),
                    borderRadius: 999,
                    backgroundColor: line.quantity > 1 ? colors.navy : '#EEF2FA',
                    justifyContent: 'center',
                  }}
                >
                  <Text
                    {...fixedText}
                    style={{
                      fontFamily: fonts.heavy,
                      fontSize: Math.max(15, v(16)),
                      color: line.quantity > 1 ? colors.white : colors.navy,
                      fontVariant: ['tabular-nums'],
                    }}
                  >
                    × {line.quantity}
                  </Text>
                </View>
              </View>
              {options.map((option, i) => (
                <Text
                  key={i}
                  {...fixedText}
                  style={{
                    fontFamily: fonts.medium,
                    fontSize: Math.max(16, v(17)),
                    lineHeight: Math.max(21, v(23)),
                    color: colors.muted,
                  }}
                >
                  {'•  ' + option}
                </Text>
              ))}
            </View>
            <Text
              {...fixedText}
              style={{
                paddingTop: v(4),
                fontFamily: fonts.black,
                fontSize: Math.max(20, v(23)),
                lineHeight: Math.max(25, v(28)),
                color: colors.navy,
                fontVariant: ['tabular-nums'],
              }}
            >
              {money(line.lineTotalMinor)}
            </Text>
          </View>
        );
      })}
      {showTotal ? <CartTotal total={total} valid={valid} locale={locale} /> : null}
    </Animated.View>
  );
}
