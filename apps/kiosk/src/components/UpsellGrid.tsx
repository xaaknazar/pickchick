import { FlatList, View } from 'react-native';
import type { KioskProduct } from '../model';
import { useMetrics } from '../theme';
import { copy, type Locale } from '../i18n';
import { Body, Heading, Wrapper } from './UI';
import { RecommendationCard } from './RecommendationCard';
/** v3 upsell on the blue surface: white 900 title and a 3-column grid of add cards. */
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
  const { v, width } = useMetrics();
  const columns = width >= 700 ? 3 : 2;
  const pad = v(24);
  const gap = v(14);
  const cardWidth = Math.floor((width - pad * 2 - gap * (columns - 1)) / columns);
  return (
    <FlatList
      key={columns}
      data={products}
      numColumns={columns}
      keyExtractor={(p) => p.id}
      style={{ flex: 1, minHeight: 0 }}
      onScrollBeginDrag={onInteraction}
      columnWrapperStyle={{ gap }}
      contentContainerStyle={{
        paddingHorizontal: pad,
        paddingTop: v(18),
        paddingBottom: v(30),
        gap,
      }}
      ListHeaderComponent={
        <Wrapper gap={6} paddingY={8}>
          <Heading tone="inverse">{copy(locale).upsellTitle}</Heading>
          <Body tone="onBlue">
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
