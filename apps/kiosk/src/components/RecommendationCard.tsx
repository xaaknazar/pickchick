import { Animated } from 'react-native';
import type { KioskProduct } from '../model';
import { copy, type Locale } from '../i18n';
import { Body, Wrapper } from './UI';
import { ProductCard } from './ProductCard';
import { useEntranceMotion } from './useEntranceMotion';

export function RecommendationCard({
  product,
  position,
  added,
  busy,
  locale,
  onAdd,
}: {
  product: KioskProduct;
  position: number;
  added: boolean;
  busy: boolean;
  locale: Locale;
  onAdd: () => void;
}) {
  const entrance = useEntranceMotion('recommendation', position);
  return (
    <Animated.View
      testID={'kiosk-recommendation-' + product.id}
      style={{
        opacity: entrance.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }),
        transform: [
          { translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) },
        ],
      }}
    >
      <Wrapper gap={8}>
        <ProductCard
          product={product}
          variant="recommendation"
          busy={busy}
          prefix="kiosk-upsell"
          onOpen={onAdd}
          onAdd={onAdd}
        />
        <Body variant="label" tone="brand" announce>
          {added ? copy(locale).selected : ' '}
        </Body>
      </Wrapper>
    </Animated.View>
  );
}
