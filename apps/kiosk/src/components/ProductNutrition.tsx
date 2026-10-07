import { View } from 'react-native';
import type { KioskProduct } from '../model';
import { copy, displayCopy, type Locale } from '../i18n';
import { colors, useMetrics } from '../theme';
import { Body, Heading, Wrapper } from './UI';
export function ProductNutrition({ product, locale }: { product: KioskProduct; locale: Locale }) {
  const { px } = useMetrics();
  const t = copy(locale);
  const n = product.nutrition;
  return (
    <View
      testID="kiosk-product-nutrition"
      style={{ borderTopWidth: 1, borderColor: colors.border, paddingTop: px(26), gap: px(20) }}
    >
      <Body tone="muted">
        {t.nutrition} · {n.basis === 'per_100_g' ? t.per100 : t.perServing} ·{' '}
        {locale === 'ru' ? 'базовый состав' : 'негізгі құрам'}
      </Body>
      <Wrapper dir="row" gap={12} wrap>
        {[
          [t.kcal, n.energy_kcal],
          [t.protein, n.protein_g + ' ' + t.grams],
          [t.fat, n.fat_g + ' ' + t.grams],
          [t.carbs, n.carbs_g + ' ' + t.grams],
        ].map(([label, value]) => (
          <Wrapper key={label} flex={1} gap={4}>
            <Heading size="card">{value}</Heading>
            <Body variant="caption" tone="muted">
              {label}
            </Body>
          </Wrapper>
        ))}
      </Wrapper>
      <Body>
        <Body variant="label">{t.ingredients}: </Body>
        {displayCopy(product.ingredients)}
      </Body>
      <Body variant="caption" tone="muted">
        {product.allergens.length
          ? `${t.allergens}: ${product.allergens.join(', ')}`
          : t.unknownAllergens}
      </Body>
    </View>
  );
}
