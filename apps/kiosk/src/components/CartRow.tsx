import { View } from 'react-native';
import type { KioskCartLine } from '../model';
import { money } from '../cart';
import { copy, type Locale } from '../i18n';
import { colors, useMetrics } from '../theme';
import { Body, Heading, Button, Stepper, Wrapper } from './UI';
import { ProductArtwork } from './ProductArtwork';
import { selectionSummary } from './selectionSummary';
import { productArtworkId } from '../assets';
export function CartRow({
  line,
  locale,
  busy,
  onQuantity,
}: {
  line: KioskCartLine;
  locale: Locale;
  busy: boolean;
  onQuantity: (quantity: number) => void;
}) {
  const { px } = useMetrics();
  const t = copy(locale);
  const summary = selectionSummary(line);
  return (
    <View
      testID={'kiosk-cart-line-' + line.lineId}
      style={{
        backgroundColor: colors.white,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: colors.border,
        padding: px(24),
        gap: px(18),
      }}
    >
      <Wrapper dir="row" gap={20} align="flex-start">
        <ProductArtwork
          imageId={productArtworkId(line.product, line.selections)}
          variant="thumbnail"
        />
        <Wrapper flex={1} gap={8}>
          <Heading size="card">{line.product.name}</Heading>
          {summary ? (
            <Body tone="muted" variant="caption">
              {summary}
            </Body>
          ) : null}
        </Wrapper>
        <Button
          label={t.remove}
          tone="quiet"
          size="compact"
          disabled={busy}
          onPress={() => onQuantity(0)}
        />
      </Wrapper>
      <Wrapper dir="row" align="center" justify="space-between" gap={20}>
        <Stepper
          locale={locale}
          quantity={line.quantity}
          prefix={'kiosk-cart-line-' + line.lineId}
          disabled={busy}
          max={20}
          onMinus={() => onQuantity(line.quantity - 1)}
          onPlus={() => onQuantity(line.quantity + 1)}
        />
        <Body variant="price">{money(line.lineTotalMinor)}</Body>
      </Wrapper>
    </View>
  );
}
