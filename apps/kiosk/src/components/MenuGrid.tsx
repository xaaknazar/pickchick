import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, ScrollView, View } from 'react-native';
import type { KioskProduct } from '../model';
import { copy, type Locale } from '../i18n';
import {
  SECTION_HITS,
  badgeOf,
  bentoGeometry,
  bentoLayout,
  sectionHit,
  type BentoFrame,
} from '../menu-presentation';
import { useMetrics } from '../theme';
import { ProductCard } from './ProductCard';
import { MENU_BOTTOM, RAIL_WIDTH } from './CategoryRail';
import { Billboard } from './Billboard';
import { useStagger } from './motion';
import type { Category, MenuMemory } from './categories';
/** Grid metrics in design points (1024 pt mockups): gutter, smallest card and hit rows. */
const GRID = { gap: 16, right: 16, minRow: 300, minHit: 260 };
/**
 * Bento menu grid (kiosk redesign 2026-10-13, README section 3), right of the rail from the
 * header down to 156 pt above the bottom edge: the section's hit across the full width, then
 * its other products by the count rule of `bentoLayout` (rows in `fr`, so the grid stretches
 * with the screen). A section with more rows than fit keeps its rows at their minimum height
 * and scrolls under the checkout panel; the scroll position of every section is remembered in
 * `memory` (e.g. while a product page is open). Cards rise in with a stagger whenever a section
 * opens; cards already in the bag carry a count badge.
 */
export function MenuGrid({
  products,
  category,
  memory,
  locale,
  busy,
  cartCounts = {},
  arriving,
  onOpen,
  onAdd,
  onInteraction,
}: {
  /** Every product of the section, in catalog order. */
  products: KioskProduct[];
  category: Category;
  memory: MenuMemory;
  locale: Locale;
  busy: boolean;
  /** Units of each product already in the bag, shown as the card's count badge. */
  cartCounts?: Record<string, number>;
  /** Product flying into the bag; its badge pops once the photo lands. */
  arriving?: string | null;
  onOpen: (p: KioskProduct) => void;
  onAdd: (p: KioskProduct) => void;
  onInteraction: () => void;
}) {
  const { px, width: screenWidth, height: screenHeight } = useMetrics();
  const t = copy(locale);
  const list = useRef<ScrollView>(null);
  // Before the first layout the grid assumes the header's 128 pt; the measured box wins.
  const [box, setBox] = useState({
    width: screenWidth - px(RAIL_WIDTH),
    height: screenHeight - px(128),
  });
  const hit = sectionHit(products, category);
  const rest = products.filter((p) => p !== hit);
  const layout = bentoLayout(products.length);
  const geometry = bentoGeometry(
    layout,
    Math.max(0, box.width - px(GRID.right)),
    Math.max(0, box.height - px(MENU_BOTTOM)),
    px(GRID.gap),
    px(GRID.minRow),
    px(GRID.minHit),
  );
  const initial = memory.offsets[category] ?? 0;
  const restoration = useMemo(() => ({ done: initial === 0, viewport: 0, content: 0 }), [initial]);
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
    list.current?.scrollTo({
      y: Math.min(initial, Math.max(0, restoration.content - restoration.viewport)),
      animated: false,
    });
  };
  return (
    <ScrollView
      ref={list}
      testID="kiosk-menu-scroll"
      style={{ flex: 1, minHeight: 0 }}
      showsVerticalScrollIndicator={false}
      onScrollBeginDrag={onInteraction}
      contentOffset={{ x: 0, y: initial }}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setBox((current) =>
          current.width === width && current.height === height ? current : { width, height },
        );
        restoration.viewport = height;
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
      contentContainerStyle={{ paddingRight: px(GRID.right), paddingBottom: px(MENU_BOTTOM) }}
    >
      <View style={{ height: geometry.height }}>
        {hit && geometry.hit ? (
          <Rise index={0} frame={geometry.hit}>
            <Billboard
              key={hit.id}
              product={hit}
              label={t[SECTION_HITS[category].label]}
              locale={locale}
              busy={busy}
              inCart={cartCounts[hit.id]}
              arriving={arriving === hit.id}
              onOpen={() => onOpen(hit)}
              onAdd={() => onAdd(hit)}
            />
          </Rise>
        ) : null}
        {geometry.cards.map((cell) => {
          const item = rest[cell.item];
          if (!item) return null;
          return (
            <Rise key={item.id} index={cell.item + 1} frame={cell}>
              <ProductCard
                product={item}
                size={cell.size}
                busy={busy}
                locale={locale}
                badge={badgeOf(item.id)}
                index={cell.item}
                inCart={cartCounts[item.id]}
                arriving={arriving === item.id}
                onOpen={() => onOpen(item)}
                onAdd={() => onAdd(item)}
              />
            </Rise>
          );
        })}
      </View>
    </ScrollView>
  );
}
/** Places a tile on its frame and plays the prototype rise (staggered, static when reduced). */
function Rise({
  index,
  frame,
  children,
}: {
  index: number;
  frame: BentoFrame;
  children: ReactNode;
}) {
  const enter = useStagger(index);
  return (
    <Animated.View
      style={{
        position: 'absolute',
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
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
