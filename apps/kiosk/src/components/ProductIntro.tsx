import type { KioskProduct } from '../model';
import { Animated } from 'react-native';
import { copy, displayCopy, type Locale } from '../i18n';
import { Body, Heading, Wrapper } from './UI';
import { ProductArtwork } from './ProductArtwork';
import { useEntranceMotion } from './useEntranceMotion';
export function ProductIntro({ product, locale }: { product: KioskProduct; locale: Locale }) {
  const t = copy(locale);
  const entrance = useEntranceMotion('product');
  return (
    <Animated.View
      testID="kiosk-product-intro"
      style={{
        opacity: entrance.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }),
        transform: [
          { translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) },
        ],
      }}
    >
      <Wrapper gap={24}>
        <ProductArtwork imageId={product.image_id} variant="feature" />
        <Wrapper gap={10}>
          <Heading size="title">{product.name}</Heading>
          <Body tone="muted">{displayCopy(product.description)}</Body>
          <Body variant="caption" tone="muted">
            {product.serving_label} · {product.nutrition.energy_kcal} {t.kcal}
          </Body>
        </Wrapper>
      </Wrapper>
    </Animated.View>
  );
}
