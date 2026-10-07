import { FlatList, View } from 'react-native';
import type { KioskProduct } from '../model';
import { useMetrics } from '../theme';
import { copy, type Locale } from '../i18n';
import { Body, Heading, Wrapper } from './UI';
import { RecommendationCard } from './RecommendationCard';
export function UpsellGrid({
  products,
  addedIds,
  busy,
  locale,
  onAdd,
  onInteraction,
}: {
  products: KioskProduct[];
  addedIds: string[];
  busy: boolean;
  locale: Locale;
  onAdd: (p: KioskProduct) => void;
  onInteraction: () => void;
}) {
  const { px, width, columns } = useMetrics();
  const cardWidth = (width - px(56) - px(20) * (columns - 1)) / columns;
  return (
    <FlatList
      key={columns}
      data={products}
      numColumns={columns}
      keyExtractor={(p) => p.id}
      style={{ flex: 1, minHeight: 0 }}
      onScrollBeginDrag={onInteraction}
      columnWrapperStyle={{ gap: px(20) }}
      contentContainerStyle={{ padding: px(28), gap: px(20) }}
      ListHeaderComponent={
        <Wrapper gap={8} paddingY={12}>
          <Heading>{copy(locale).upsellTitle}</Heading>
          <Body tone="muted">
            {locale === 'ru'
              ? 'К любимому комбо - ещё немного вкусного'
              : 'Сүйікті комбоға тағы бір дәмді қосымша'}
          </Body>
        </Wrapper>
      }
      renderItem={({ item, index }) => (
        <View style={{ width: cardWidth }}>
          <RecommendationCard
            product={item}
            position={index}
            added={addedIds.includes(item.id)}
            busy={busy}
            locale={locale}
            onAdd={() => onAdd(item)}
          />
        </View>
      )}
    />
  );
}
