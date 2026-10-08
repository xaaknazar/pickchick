import { useState } from 'react';
import { Animated, Pressable, ScrollView, View } from 'react-native';
import { PhotoImage } from './PhotoImage';
import { copy, type Locale } from '../i18n';
import { productPhoto } from '../assets';
import { colors, fonts, useMetrics } from '../theme';
import type { KioskProduct } from '../model';
import { ProductArtwork } from './ProductArtwork';
import { usePress, useTimingTo } from './motion';
import { categoryKeys, inCategory, type Category } from './categories';
/**
 * v3 category rail on the blue menu: white photo tiles; the selected one rides
 * on a spring-sliding orange indicator, its white card and navy label fade out
 * (220 ms) and its photo tilts.
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
  // Prototype `.ind`: transform transition 440 ms on the --spring curve.
  const indicator = useTimingTo(
    offsets[category] ?? v(18) + index * (v(142) + v(10)),
    440,
    'spring',
  );
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
            // Carries the small white label of the selected tile.
            backgroundColor: colors.orangeInk,
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
  // Prototype `.cat`: background, colour and shadow transition 220 ms; the photo
  // turns over 440 ms on --spring; `:active` scales to .95.
  const tilt = useTimingTo(selected ? 1 : 0, 440, 'spring');
  const card = useTimingTo(selected ? 0 : 1, 220, 'css');
  const press = usePress(0.95);
  const photo = imageId ? productPhoto(imageId) : null;
  const text = {
    fontFamily: fonts.heavy,
    fontSize: v(14),
    lineHeight: v(17),
    textAlign: 'center' as const,
    paddingHorizontal: v(6),
  };
  const stack = {
    flex: 1,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: v(8),
  };
  return (
    <Animated.View
      onLayout={(e) => onMeasure(e.nativeEvent.layout.y)}
      style={{ zIndex: 1, height: v(142), transform: [{ scale: press.scale }] }}
    >
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          borderRadius: v(24),
          backgroundColor: colors.white,
          shadowColor: '#020A28',
          shadowOpacity: 0.2,
          shadowRadius: 18,
          shadowOffset: { width: 0, height: 8 },
          opacity: card,
        }}
      />
      <Pressable
        testID={'kiosk-category-' + category}
        accessibilityRole="tab"
        accessibilityState={{ selected }}
        aria-selected={selected}
        onPress={() => onSelect(category)}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={stack}
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
                    rotate: tilt.interpolate({
                      inputRange: [0, 1],
                      outputRange: ['0deg', '-5deg'],
                    }),
                  },
                ],
              }}
            >
              <PhotoImage imageId={imageId!} />
            </Animated.View>
          ) : imageId ? (
            <ProductArtwork imageId={imageId} variant="rail" />
          ) : null}
        </View>
        <Animated.Text numberOfLines={2} style={{ ...text, color: colors.navy, opacity: card }}>
          {label.toUpperCase()}
        </Animated.Text>
      </Pressable>
      {/* The white label of the selected tile, cross-faded over the navy one. */}
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        aria-hidden
        style={{ ...stack, position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
      >
        <View style={{ height: v(88) }} />
        <Animated.Text
          numberOfLines={2}
          style={{
            ...text,
            color: colors.white,
            opacity: card.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
          }}
        >
          {label.toUpperCase()}
        </Animated.Text>
      </View>
    </Animated.View>
  );
}
