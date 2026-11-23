import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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
import { colors, fonts, useMetrics } from '../theme';
import { fixedText } from './Body';
import { ProductCard } from './ProductCard';
import { MENU_BOTTOM, RAIL_WIDTH } from './CategoryRail';
import { Billboard } from './Billboard';
import { useEnter } from './motion';
import type { Category, MenuMemory } from './categories';
/**
 * Grid metrics in design points (1024 pt mockups): gutter, the smallest card and hit rows that
 * still fit on screen (three rows of cards do on every iPad), and the card row of a section
 * long enough to scroll.
 */
const GRID = { gap: 16, right: 16, minRow: 250, minHit: 284, scrollRow: 320 };
/**
 * Bento menu grid (kiosk redesign 2026-10-13, README section 3), right of the rail from the
 * header down to 156 pt above the bottom edge: the section's hit across the full width, then
 * its other products by the count rule of `bentoLayout` (rows in `fr`, so the grid stretches
 * with the screen). A section with more rows than fit keeps its rows at their minimum height
 * and scrolls under the checkout panel; the scroll position of every section is remembered in
 * `memory` (e.g. while a product page is open). Cards rise in with a stagger whenever a section
 * opens; cards already in the bag carry a count badge.
 */
export const MenuGrid = memo(function MenuGrid({
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
  active = true,
  next,
  previous,
  onPage,
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
  /** False while the section is kept built under the open one (MenuDeck). */
  active?: boolean;
  /** Names of the sections below and above this one in the rail (none at the ends). */
  next?: string;
  previous?: string;
  /** A pull past the end (1) or the top (-1) of the section opens the neighbouring one. */
  onPage?: (section: Category, direction: 1 | -1) => void;
}) {
  const { px, width: screenWidth, height: screenHeight } = useMetrics();
  const t = copy(locale);
  const list = useRef<ScrollView>(null);
  // Native scroll position, for the «Дальше» / «Назад» hints shown while the guest pulls.
  const scrollY = useRef(new Animated.Value(0)).current;
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
    px(GRID.scrollRow),
  );
  const initial = memory.offsets[category] ?? 0;
  // Furthest scroll position: the grid plus the room kept under the checkout panel.
  const end = Math.max(0, geometry.height + px(MENU_BOTTOM) - box.height);
  const restoration = useMemo(() => ({ done: initial === 0, viewport: 0, content: 0 }), [initial]);
  useLayoutEffect(
    () => () => {
      // A departing native/web scroll view can emit a final zero offset.
      // Keep the last browsing position for the next mounted menu.
      restoration.done = false;
    },
    [restoration],
  );
  // A kept section opens from its top, like a freshly built one.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) list.current?.scrollTo({ y: 0, animated: false });
    wasActive.current = active;
  }, [active]);
  const restore = () => {
    if (restoration.done || !restoration.viewport || !restoration.content) return;
    restoration.done = true;
    list.current?.scrollTo({
      y: Math.min(initial, Math.max(0, restoration.content - restoration.viewport)),
      animated: false,
    });
  };
  return (
    <Animated.ScrollView
      ref={list}
      testID={active ? 'kiosk-menu-scroll' : undefined}
      style={{ flex: 1, minHeight: 0 }}
      showsVerticalScrollIndicator={false}
      // Owner 23.11.2026: a pull past the end of a section turns to the next one, a pull down
      // at its top to the previous one, also in a section short enough not to scroll.
      alwaysBounceVertical={!!onPage}
      onScrollBeginDrag={onInteraction}
      onScrollEndDrag={(e) => {
        if (!active || !onPage) return;
        const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
        const end = Math.max(0, contentSize.height - layoutMeasurement.height);
        if (next && contentOffset.y > end + px(PAGE_PULL)) onPage(category, 1);
        else if (previous && contentOffset.y < -px(PAGE_PULL)) onPage(category, -1);
      }}
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
      scrollEventThrottle={16}
      onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
        useNativeDriver: true,
        listener: (e: { nativeEvent: { contentOffset: { y: number } } }) => {
          if (restoration.done && active)
            memory.offsets[category] = Math.max(0, e.nativeEvent.contentOffset.y);
        },
      })}
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
        {onPage && previous ? (
          <PageHint
            label={t.menuPrevSection.replace('{name}', previous)}
            icon="chevron-down"
            top={-px(56)}
            shown={scrollY.interpolate({
              inputRange: [-px(PAGE_PULL), -px(16)],
              outputRange: [1, 0],
              extrapolate: 'clamp',
            })}
          />
        ) : null}
        {onPage && next ? (
          <PageHint
            label={t.menuNextSection.replace('{name}', next)}
            icon="chevron-up"
            top={geometry.height + px(18)}
            shown={scrollY.interpolate({
              inputRange: [end + px(16), end + px(PAGE_PULL)],
              outputRange: [0, 1],
              extrapolate: 'clamp',
            })}
          />
        ) : null}
      </View>
    </Animated.ScrollView>
  );
});
/** How far (design points) a guest pulls past either end of a section to turn the page. */
const PAGE_PULL = 84;
/** The quiet «Дальше: На двоих» pill revealed by a pull, fully shown once the pull counts. */
function PageHint({
  label,
  icon,
  top,
  shown,
}: {
  label: string;
  icon: 'chevron-up' | 'chevron-down';
  top: number;
  shown: Animated.AnimatedInterpolation<number>;
}) {
  const { px } = useMetrics();
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top,
        height: px(40),
        alignItems: 'center',
        justifyContent: 'center',
        opacity: shown,
        transform: [{ scale: shown.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }],
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: px(8),
          height: px(40),
          paddingHorizontal: px(18),
          borderRadius: px(20),
          backgroundColor: 'rgba(255,255,255,0.16)',
        }}
      >
        <Ionicons name={icon} size={px(20)} color={colors.white} />
        <Text
          {...fixedText}
          numberOfLines={1}
          style={{ fontFamily: fonts.heavy, fontSize: px(17), color: colors.white }}
        >
          {label}
        </Text>
      </View>
    </Animated.View>
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
  // Owner 22.11.2026: a tab switch must never show an empty grid. The tiles are visible within
  // the first ~100 ms (opacity reaches 1 at a third of the rise) and settle with a short, soft
  // lift instead of the long 34 pt rise.
  const enter = useEnter(Math.min(index, 6) * 22, 360);
  return (
    <Animated.View
      style={{
        position: 'absolute',
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        opacity: enter.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0, 1, 1] }),
        transform: [
          { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) },
          { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.985, 1] }) },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}
