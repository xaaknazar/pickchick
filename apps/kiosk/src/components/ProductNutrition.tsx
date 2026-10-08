import { Text, View } from 'react-native';
import type { KioskProduct } from '../model';
import { copy, displayCopy, type Locale } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
/**
 * v3 nutrition on the blue product page. `facts` is the row of four white KBJU tiles,
 * `details` the basis, ingredients and allergens in white on blue; `all` shows both.
 */
export function ProductNutrition({
  product,
  locale,
  part = 'all',
}: {
  product: KioskProduct;
  locale: Locale;
  part?: 'all' | 'facts' | 'details';
}) {
  const { v } = useMetrics();
  const t = copy(locale);
  const n = product.nutrition;
  const facts = (
    <View testID="kiosk-product-nutrition" style={{ flexDirection: 'row', gap: v(10) }}>
      {[
        [t.kcal, String(n.energy_kcal)],
        [t.protein, n.protein_g + ' ' + t.grams],
        [t.fat, n.fat_g + ' ' + t.grams],
        [t.carbs, n.carbs_g + ' ' + t.grams],
      ].map(([label, value]) => (
        <View
          key={label}
          style={{
            flex: 1,
            minWidth: 0,
            borderRadius: v(18),
            backgroundColor: colors.white,
            paddingVertical: v(12),
            paddingHorizontal: v(16),
            shadowColor: '#020A28',
            shadowOpacity: 0.18,
            shadowRadius: 18,
            shadowOffset: { width: 0, height: 8 },
          }}
        >
          {/* One text run, so assistive tech reads "1240 ккал" as a single caption. */}
          <Text
            numberOfLines={2}
            style={{
              fontFamily: fonts.heavy,
              fontSize: Math.max(18, v(22)),
              color: colors.navy,
              fontVariant: ['tabular-nums'],
            }}
          >
            {value}
            <Text
              style={{
                fontFamily: fonts.body,
                fontSize: Math.max(13, v(14)),
                color: colors.muted,
              }}
            >
              {'\n' + label}
            </Text>
          </Text>
        </View>
      ))}
    </View>
  );
  const caption = {
    fontFamily: fonts.body,
    fontSize: Math.max(15, v(16)),
    lineHeight: Math.max(15, v(16)) * 1.45,
    color: colors.onBlueMuted,
  };
  const details = (
    <View
      testID={part === 'details' ? 'kiosk-product-details' : undefined}
      style={{
        borderRadius: v(24),
        backgroundColor: colors.glass,
        borderWidth: 1,
        borderColor: colors.glassLine,
        padding: v(22),
        gap: v(10),
      }}
    >
      <Text style={{ ...caption, fontFamily: fonts.medium }}>
        {t.nutrition} · {n.basis === 'per_100_g' ? t.per100 : t.perServing} ·{' '}
        {locale === 'ru' ? 'базовый состав' : 'негізгі құрам'}
      </Text>
      <Text
        style={{
          fontFamily: fonts.body,
          fontSize: Math.max(16, v(18)),
          lineHeight: Math.max(16, v(18)) * 1.45,
          color: colors.white,
        }}
      >
        <Text style={{ fontFamily: fonts.bold }}>{t.ingredients}: </Text>
        {displayCopy(product.ingredients)}
      </Text>
      <Text style={caption}>
        {product.allergens.length
          ? `${t.allergens}: ${product.allergens.join(', ')}`
          : t.unknownAllergens}
      </Text>
    </View>
  );
  if (part === 'facts') return facts;
  if (part === 'details') return details;
  return (
    <View style={{ gap: v(20) }}>
      {facts}
      {details}
    </View>
  );
}
