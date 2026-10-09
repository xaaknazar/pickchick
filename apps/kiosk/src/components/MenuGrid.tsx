import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { Animated, FlatList, Text, View } from 'react-native';
import type { KioskProduct } from '../model';
import { copy, itemCount, type Locale } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
import { ProductCard } from './ProductCard';
import { RAIL_WIDTH } from './CategoryRail';
import { Billboard } from './Billboard';
import { useStagger } from './motion';
import type { Category, MenuMemory } from './categories';
const tags: Record<string, 'hit' | 'new'> = {
  'pick-combo': 'hit',
  'solo-combo': 'new',
  'sauce-hot': 'new',
};
/** Design `mixBg`: combo, duo and set cards sit on the bg1-bg4 illustrations. */
const illustratedCategories = new Set<Category>(['combo', 'duo', 'sets']);
const positions = (n: number, locale: Locale) => itemCount(n, locale);
/**
 * v3 menu feed: featured billboard (the Master / 7 + 1 carousel when `onPromo`
 * is given), category title with count and a two-column grid of photo cards
 * that rise in with a stagger whenever a category opens; cards already in the
 * bag carry a count badge.
 */
export function MenuGrid({
  products,
  category,
  memory,
  locale,
  busy,
  featured,
  cartCounts = {},
  arriving,
  onOpen,
  onAdd,
  onPromo,
  onInteraction,
}: {
  products: KioskProduct[];
  category: Category;
  memory: MenuMemory;
  locale: Locale;
  busy: boolean;
  featured?: KioskProduct | null;
  /** Units of each product already in the bag, shown as the card's count badge. */
  cartCounts?: Record<string, number>;
  /** Product flying into the bag; its badge pops once the photo lands. */
  arriving?: string | null;
  onOpen: (p: KioskProduct) => void;
  onAdd: (p: KioskProduct) => void;
  /** The 7 + 1 billboard slide was tapped. */
  onPromo?: () => void;
  onInteraction: () => void;
}) {
  const { v, width, columns } = useMetrics();
  const list = useRef<FlatList<KioskProduct>>(null);
  const initialOffset = useMemo(
    () => ({ x: 0, y: memory.offsets[category] ?? 0 }),
    [category, columns, memory],
  );
  const restoration = useMemo(
    () => ({ done: initialOffset.y === 0, viewport: 0, content: 0 }),
    [initialOffset],
  );
  useLayoutEffect(
    () => () => {
      // A departing native/web scroll view can emit a final zero offset.
      // Keep the last browsing position for the next mounted menu.
      restoration.done = false;
    },
    [restoration],
  );
  const restore = () => {
    if (restoration.done || !restoration.viewport || !restoration.content) return;
    restoration.done = true;
    list.current?.scrollToOffset({
      offset: Math.min(initialOffset.y, Math.max(0, restoration.content - restoration.viewport)),
      animated: false,
    });
  };
  const cardWidth = Math.floor(
    (width - v(RAIL_WIDTH) - v(4) - v(20) - v(14) * (columns - 1)) / columns,
  );
  return (
    <FlatList
      ref={list}
      key={columns + '-' + category}
      testID="kiosk-menu-scroll"
      style={{ flex: 1, minHeight: 0 }}
      data={products}
      numColumns={columns}
      initialNumToRender={products.length}
      keyExtractor={(p) => p.id}
      showsVerticalScrollIndicator={false}
      onScrollBeginDrag={onInteraction}
      contentOffset={initialOffset}
      onLayout={(e) => {
        restoration.viewport = e.nativeEvent.layout.height;
        restore();
      }}
      onContentSizeChange={(_, h) => {
        restoration.content = h;
        restore();
      }}
      scrollEventThrottle={64}
      onScroll={(e) => {
        if (restoration.done) memory.offsets[category] = Math.max(0, e.nativeEvent.contentOffset.y);
      }}
      columnWrapperStyle={{ gap: v(14) }}
      contentContainerStyle={{
        paddingTop: v(18),
        paddingRight: v(20),
        paddingBottom: v(28),
        paddingLeft: v(4),
        gap: v(14),
      }}
      ListHeaderComponent={
        <View style={{ gap: v(18), paddingBottom: v(4) }}>
          {featured ? (
            <Billboard
              product={featured}
              locale={locale}
              slide={memory.billboard}
              onSlide={(slide) => {
                memory.billboard = slide;
              }}
              onOpen={() => onOpen(featured)}
              onPromo={onPromo}
            />
          ) : null}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              paddingHorizontal: v(4),
              gap: v(12),
            }}
          >
            <Text
              accessibilityRole="header"
              style={{
                fontFamily: fonts.black,
                fontSize: v(30),
                color: colors.white,
                flexShrink: 1,
              }}
            >
              {copy(locale)[category]}
            </Text>
            <Text
              style={{
                fontFamily: fonts.body,
                fontSize: Math.max(15, v(16)),
                color: colors.onBlueMuted,
              }}
            >
              {positions(products.length, locale)}
            </Text>
          </View>
        </View>
      }
      renderItem={({ item, index }) => (
        <Rise index={index} span={cardWidth}>
          <ProductCard
            product={item}
            busy={busy}
            locale={locale}
            tag={tags[item.id]}
            index={index}
            illustrated={illustratedCategories.has(category)}
            inCart={cartCounts[item.id]}
            arriving={arriving === item.id}
            onOpen={() => onOpen(item)}
            onAdd={() => onAdd(item)}
          />
        </Rise>
      )}
    />
  );
}
function Rise({ index, span, children }: { index: number; span: number; children: ReactNode }) {
  const enter = useStagger(index);
  return (
    <Animated.View
      style={{
        width: span,
        opacity: enter,
        transform: [
          { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [34, 0] }) },
          { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}
