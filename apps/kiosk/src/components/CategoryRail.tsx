import { Pressable, ScrollView, View, Text } from 'react-native';
import { copy, type Locale } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
import type { KioskProduct } from '../model';
import { ProductArtwork } from './ProductArtwork';
import { categoryKeys, inCategory, type Category } from './categories';
export function CategoryRail({
  category,
  products,
  locale,
  onSelect,
}: {
  category: Category;
  products: KioskProduct[];
  locale: Locale;
  onSelect: (key: Category) => void;
}) {
  const { px } = useMetrics();
  const t = copy(locale);
  return (
    <View
      style={{
        width: px(158),
        backgroundColor: colors.white,
        borderRightWidth: 1,
        borderColor: colors.border,
      }}
    >
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: px(12), gap: px(12) }}
      >
        {categoryKeys.map((key) => {
          const selected = key === category;
          const image = products.find((p) => inCategory(p, key))?.image_id;
          return (
            <Pressable
              key={key}
              testID={'kiosk-category-' + key}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              aria-selected={selected}
              onPress={() => onSelect(key)}
              style={({ pressed }) => ({
                paddingVertical: px(16),
                paddingHorizontal: px(6),
                borderRadius: 16,
                backgroundColor: selected ? colors.blue : 'transparent',
                alignItems: 'center',
                gap: px(10),
                opacity: pressed ? 0.8 : 1,
              })}
            >
              {image ? <ProductArtwork imageId={image} variant="rail" /> : null}
              <Text
                style={{
                  fontFamily: fonts.medium,
                  fontSize: Math.max(16, px(18)),
                  textAlign: 'center',
                  color: selected ? colors.white : colors.muted,
                }}
              >
                {t[key]}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
