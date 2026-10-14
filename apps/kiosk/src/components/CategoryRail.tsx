import { useState } from 'react';
import { Animated, Pressable, ScrollView, View } from 'react-native';
import { PhotoImage } from './PhotoImage';
import { copy, type Locale } from '../i18n';
import { productArtworkId } from '../assets';
import { colors, fonts, redesign, useMetrics } from '../theme';
import type { KioskProduct } from '../model';
import { usePress, useTimingTo } from './motion';
import { categoryKeys, inCategory, type Category } from './categories';
import { ownerOrange } from './ownerOrange';
import { fixedText } from './Body';
/** Rail column in design points: 16 pt gutters around 170 pt tiles (the grid starts at 202). */
export const RAIL_WIDTH = 202;
const TILE = { max: 150, min: 104, gap: 12, radius: 28 };
/** The grid and the rail end 156 pt above the bottom edge, over the checkout panel. */
export const MENU_BOTTOM = 156;
/**
 * Section rail of the bento menu (kiosk redesign 2026-10-13, README section 3): five tiles in
 * a 170 pt column from the header to the checkout panel, each up to 150 pt high and shrinking
 * to 104 pt on shorter screens (scrolling only below that), 12 pt apart, radius 28. A tile is
 * white with a navy label; the chosen one is the design orange with a white label and its
 * photo (104 x 88, contain) on a white plate. The orange glides between tiles on the spring
 * curve (440 ms), the white card and the plate cross-fade over 220 ms and the photo tilts;
 * everything is instant under reduced motion.
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
  const { px, height: screen } = useMetrics();
  const t = copy(locale);
  const [room, setRoom] = useState(0);
  const count = categoryKeys.length;
  // Before the first layout the rail assumes the header's 128 pt; the measured room wins.
  const available = room || screen - px(128) - px(MENU_BOTTOM);
  const tile = Math.round(
    Math.min(
      px(TILE.max),
      Math.max(px(TILE.min), (available - px(TILE.gap) * (count - 1)) / count),
    ),
  );
  const index = categoryKeys.indexOf(category);
  // Prototype `.ind`: transform transition 440 ms on the --spring curve.
  const indicator = useTimingTo(index * (tile + px(TILE.gap)), 440, 'spring');
  return (
    <View
      {...ownerOrange}
      style={{ width: px(RAIL_WIDTH), flexShrink: 0 }}
      onLayout={(e) => setRoom(Math.max(0, e.nativeEvent.layout.height - px(MENU_BOTTOM)))}
    >
      <ScrollView
        accessibilityRole="tablist"
        accessibilityLabel={t.menuCategories}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: px(16),
          paddingBottom: px(MENU_BOTTOM),
          gap: px(TILE.gap),
        }}
      >
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: px(16),
            right: px(16),
            top: 0,
            height: tile,
            borderRadius: px(TILE.radius),
            // Active control: the design orange under a white label (owner decision 2026-10-10).
            backgroundColor: redesign.cta,
            shadowColor: redesign.cta,
            shadowOpacity: 0.45,
            shadowRadius: px(16),
            shadowOffset: { width: 0, height: px(10) },
            transform: [{ translateY: indicator }],
          }}
        />
        {categoryKeys.map((key) => {
          const first = products.find((p) => inCategory(p, key));
          return (
            <Tile
              key={key}
              category={key}
              label={t[key]}
              height={tile}
              selected={key === category}
              imageId={first ? productArtworkId(first) : undefined}
              onSelect={onSelect}
            />
          );
        })}
      </ScrollView>
    </View>
  );
}
function Tile({
  category,
  label,
  height,
  selected,
  imageId,
  onSelect,
}: {
  category: Category;
  label: string;
  height: number;
  selected: boolean;
  imageId?: string;
  onSelect: (key: Category) => void;
}) {
  const { px } = useMetrics();
  // Prototype `.cat`: background and colour transition 220 ms; the photo turns over 440 ms on
  // --spring; `:active` scales to .95.
  const tilt = useTimingTo(selected ? 1 : 0, 440, 'spring');
  const card = useTimingTo(selected ? 0 : 1, 220, 'css');
  const press = usePress(0.95);
  // The photo keeps 104 x 88 on a full tile and gives way on a short one; the label stays.
  const photoHeight = Math.min(px(88), Math.max(px(48), height - px(56)));
  const photoWidth = Math.round((photoHeight * 104) / 88);
  const text = {
    fontFamily: fonts.heavy,
    fontSize: px(15),
    lineHeight: px(19),
    letterSpacing: 0.4,
    textAlign: 'center' as const,
  };
  const stack = {
    flex: 1,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: px(10),
    paddingHorizontal: px(8),
  };
  return (
    <Animated.View style={{ zIndex: 1, height, transform: [{ scale: press.scale }] }}>
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          borderRadius: px(TILE.radius),
          backgroundColor: colors.white,
          shadowColor: '#020A1F',
          shadowOpacity: 0.2,
          shadowRadius: px(14),
          shadowOffset: { width: 0, height: px(8) },
          opacity: card,
        }}
      />
      <Pressable
        testID={'kiosk-category-' + category}
        accessibilityRole="tab"
        accessibilityLabel={label}
        accessibilityState={{ selected }}
        aria-selected={selected}
        onPress={() => onSelect(category)}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={stack}
      >
        <View style={{ width: photoWidth, height: photoHeight }}>
          {/* The chosen tile's photo sits on a white plate over the orange. */}
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              bottom: 0,
              borderRadius: px(18),
              backgroundColor: colors.white,
              opacity: card.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
            }}
          />
          {imageId ? (
            <Animated.View
              style={{
                flex: 1,
                padding: px(4),
                transform: [
                  { scale: tilt.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] }) },
                  {
                    rotate: tilt.interpolate({
                      inputRange: [0, 1],
                      outputRange: ['0deg', '-4deg'],
                    }),
                  },
                ],
              }}
            >
              <PhotoImage imageId={imageId} />
            </Animated.View>
          ) : null}
        </View>
        <Animated.Text
          {...fixedText}
          numberOfLines={1}
          style={{ ...text, color: redesign.cardInk, opacity: card }}
        >
          {label.toUpperCase()}
        </Animated.Text>
      </Pressable>
      {/* The white label of the chosen tile, cross-faded over the navy one. */}
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        aria-hidden
        style={{ ...stack, position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
      >
        <View style={{ height: photoHeight }} />
        <Animated.Text
          {...fixedText}
          numberOfLines={1}
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
