import { useState } from 'react';
import { Animated, Pressable, ScrollView, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { copy, type Locale } from '../i18n';
import { productPhoto } from '../assets';
import { colors, fonts, useMetrics } from '../theme';
import type { KioskProduct } from '../model';
import { ProductArtwork } from './ProductArtwork';
import { useSpringTo } from './motion';
import { categoryKeys, inCategory, type Category } from './categories';
/**
 * v3 category rail on the blue menu: white photo tiles; the selected one rides
 * on a spring-sliding orange indicator and its photo tilts.
 */
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
  const { v } = useMetrics();
  const t = copy(locale);
  const [offsets, setOffsets] = useState<Partial<Record<Category, number>>>({});
  const index = categoryKeys.indexOf(category);
  const indicator = useSpringTo(offsets[category] ?? v(18) + index * (v(142) + v(10)));
  return (
    <View style={{ width: v(156), flexShrink: 0 }}>
      <ScrollView
        accessibilityRole="tablist"
        accessibilityLabel={locale === 'ru' ? 'Категории меню' : 'Мәзір санаттары'}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingVertical: v(18), paddingHorizontal: v(12), gap: v(10) }}
      >
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: v(12),
            right: v(12),
            top: 0,
            height: v(142),
            borderRadius: v(24),
            backgroundColor: colors.orange,
            shadowColor: colors.orange,
            shadowOpacity: 0.4,
            shadowRadius: 22,
            shadowOffset: { width: 0, height: 10 },
            transform: [{ translateY: indicator }],
          }}
        />
        {categoryKeys.map((key) => (
          <Tile
            key={key}
            category={key}
            label={t[key]}
            selected={key === category}
            imageId={products.find((p) => inCategory(p, key))?.image_id}
            onSelect={onSelect}
            onMeasure={(y) =>
              setOffsets((current) => (current[key] === y ? current : { ...current, [key]: y }))
            }
          />
        ))}
      </ScrollView>
    </View>
  );
}
function Tile({
  category,
  label,
  selected,
  imageId,
  onSelect,
  onMeasure,
}: {
  category: Category;
  label: string;
  selected: boolean;
  imageId?: string;
  onSelect: (key: Category) => void;
  onMeasure: (y: number) => void;
}) {
  const { v } = useMetrics();
  const tilt = useSpringTo(selected ? 1 : 0);
  const photo = imageId ? productPhoto(imageId) : null;
  return (
    <Pressable
      testID={'kiosk-category-' + category}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      aria-selected={selected}
      onPress={() => onSelect(category)}
      onLayout={(e) => onMeasure(e.nativeEvent.layout.y)}
      style={({ pressed }) => ({
        zIndex: 1,
        height: v(142),
        borderRadius: v(24),
        backgroundColor: selected ? 'transparent' : colors.white,
        shadowColor: '#020A28',
        shadowOpacity: selected ? 0 : 0.2,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 8 },
        alignItems: 'center',
        justifyContent: 'center',
        gap: v(8),
        transform: [{ scale: pressed ? 0.95 : 1 }],
      })}
    >
      <View
        style={{
          width: v(88),
          height: v(88),
          borderRadius: v(20),
          overflow: 'hidden',
          backgroundColor: photo?.tile ?? colors.white,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {photo ? (
          <Animated.View
            style={{
              width: '100%',
              height: '100%',
              padding: photo.cutout ? v(8) : 0,
              transform: [
                { scale: tilt.interpolate({ inputRange: [0, 1], outputRange: [1.12, 1.22] }) },
                {
                  rotate: tilt.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-5deg'] }),
                },
              ],
            }}
          >
            <Image
              accessible={false}
              accessibilityLabel=""
              source={photo.source}
              contentFit="contain"
              style={{ width: '100%', height: '100%' }}
            />
          </Animated.View>
        ) : imageId ? (
          <ProductArtwork imageId={imageId} variant="rail" />
        ) : null}
      </View>
      <Text
        numberOfLines={2}
        style={{
          fontFamily: fonts.heavy,
          fontSize: v(14),
          lineHeight: v(17),
          textAlign: 'center',
          paddingHorizontal: v(6),
          color: selected ? colors.white : colors.navy,
        }}
      >
        {label.toUpperCase()}
      </Text>
    </Pressable>
  );
}
