import { useLayoutEffect, useMemo, useRef } from 'react';
import { FlatList, View } from 'react-native';
import type { KioskProduct } from '../model';
import { copy, type Locale } from '../i18n';
import { useMetrics } from '../theme';
import { ProductCard } from './ProductCard';
import { Heading, Body, Wrapper } from './UI';
import type { Category, MenuMemory } from './categories';
export function MenuGrid({
  products,
  category,
  memory,
  locale,
  busy,
  onOpen,
  onAdd,
  onInteraction,
}: {
  products: KioskProduct[];
  category: Category;
  memory: MenuMemory;
  locale: Locale;
  busy: boolean;
  onOpen: (p: KioskProduct) => void;
  onAdd: (p: KioskProduct) => void;
  onInteraction: () => void;
}) {
  const { px, width, columns } = useMetrics();
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
  const cardWidth = (width - px(158) - px(40) - px(18) * (columns - 1)) / columns;
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
      columnWrapperStyle={{ gap: px(18) }}
      contentContainerStyle={{ padding: px(20), gap: px(18), paddingBottom: px(28) }}
      ListHeaderComponent={
        <Wrapper gap={8} paddingY={8}>
          <Heading size="title">{copy(locale)[category]}</Heading>
          <Body tone="muted">
            {locale === 'ru' ? 'Выберите то, что хочется сейчас' : 'Қазір қалағаныңызды таңдаңыз'}
          </Body>
        </Wrapper>
      }
      renderItem={({ item }) => (
        <View style={{ width: cardWidth }}>
          <ProductCard
            product={item}
            busy={busy}
            onOpen={() => onOpen(item)}
            onAdd={() => onAdd(item)}
          />
        </View>
      )}
    />
  );
}
