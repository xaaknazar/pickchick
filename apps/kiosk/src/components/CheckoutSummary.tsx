import { View } from 'react-native';
import type { KioskCartLine } from '../model';
import { money } from '../cart';
import { copy, type Locale } from '../i18n';
import { colors, useMetrics } from '../theme';
import { Body, Wrapper } from './UI';
import { CartTotal } from './CartTotal';
import { selectionSummary } from './selectionSummary';
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
  const { px } = useMetrics();
  const t = copy(locale);
  return (
    <View style={{ backgroundColor: colors.white, borderRadius: 16, padding: px(26), gap: px(22) }}>
      {lines.map((line) => (
        <View
          key={line.lineId}
          style={{ borderBottomWidth: 1, borderColor: colors.border, paddingBottom: px(20) }}
        >
          <Wrapper dir="row" align="flex-start" gap={20}>
            <Wrapper flex={1} gap={6}>
              <Body variant="label">
                {line.product.name} × {line.quantity}
              </Body>
              {selectionSummary(line) ? (
                <Body variant="caption" tone="muted">
                  {selectionSummary(line)}
                </Body>
              ) : null}
            </Wrapper>
            <Body variant="label">{money(line.lineTotalMinor)}</Body>
          </Wrapper>
        </View>
      ))}
      <CartTotal total={total} valid={valid} locale={locale} />
      {estimated ? (
        <Body variant="caption" tone="muted">
          {t.preparation} {estimated.min}-{estimated.max} {t.minutes}
        </Body>
      ) : null}
    </View>
  );
}
