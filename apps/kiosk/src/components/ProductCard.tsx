import { Pressable, View } from 'react-native';
import { money } from '../cart';
import type { KioskProduct } from '../model';
import { displayCopy } from '../i18n';
import { colors, useMetrics } from '../theme';
import { Body, Heading, IconButton, Wrapper } from './UI';
import { ProductArtwork } from './ProductArtwork';
export function ProductCard({
  product,
  onOpen,
  onAdd,
  prefix = 'kiosk-product',
  busy = false,
  variant = 'catalog',
}: {
  product: KioskProduct;
  onOpen: () => void;
  onAdd: () => void;
  prefix?: string;
  busy?: boolean;
  variant?: 'catalog' | 'recommendation';
}) {
  const { px } = useMetrics();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.white,
        borderRadius: 16,
        padding: px(14),
        gap: px(16),
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      <Pressable
        testID={prefix + '-' + product.id}
        accessibilityRole="button"
        onPress={onOpen}
        style={({ pressed }) => ({ gap: px(16), opacity: pressed ? 0.75 : 1 })}
      >
        <ProductArtwork
          imageId={product.image_id}
          variant={variant === 'recommendation' ? 'recommendation' : 'tile'}
        />
        <Heading size="card">{product.name}</Heading>
        <Body variant="caption" tone="muted" lines={variant === 'recommendation' ? 1 : 2}>
          {displayCopy(product.description)}
        </Body>
      </Pressable>
      <View style={{ marginTop: 'auto' }}>
        <Wrapper dir="row" justify="space-between" align="center" gap={8}>
          <Wrapper flex={1}>
            <Body variant="price">{money(product.price_minor)}</Body>
            {product.available === false ? (
              <Body variant="caption" tone="danger">
                Нет в наличии
              </Body>
            ) : null}
          </Wrapper>
          <IconButton
            name="add"
            label={'+ ' + product.name}
            onPress={onAdd}
            testID={prefix + '-plus-' + product.id}
            tone="accent"
            disabled={busy || product.available === false}
          />
        </Wrapper>
      </View>
    </View>
  );
}
