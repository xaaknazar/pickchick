import { Animated, FlatList, View } from 'react-native';
import type { KioskProduct } from '../model';
import { colors, useMetrics } from '../theme';
import { copy, type Locale } from '../i18n';
import { Body, Heading, Wrapper } from './UI';
import { RecommendationCard } from './RecommendationCard';
import { PhotoImage } from './PhotoImage';
import { useEnter, useLoop } from './motion';
/**
 * Prototype `.uphd`: a peach tile with a tilted sauce that bobs (3 s, 12 pt),
 * then the white title; the block rises in 160 ms after the screen (`.upcard`).
 */
function UpsellHeader({ locale }: { locale: Locale }) {
  const { v } = useMetrics();
  const rise = useEnter(160, 520);
  const bob = useLoop(3000, 0, true);
  return (
    <Animated.View
      style={{
        opacity: rise,
        transform: [
          { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [v(34), 0] }) },
          { scale: rise.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) },
        ],
      }}
    >
      <Wrapper dir="row" align="center" gap={14} paddingY={8}>
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            width: v(64),
            height: v(64),
            borderRadius: v(20),
            backgroundColor: colors.peach,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Animated.View
            style={{
              width: v(54),
              height: v(54),
              transform: [
                { translateY: bob.interpolate({ inputRange: [0, 1], outputRange: [0, -v(12)] }) },
                { rotate: '-8deg' },
              ],
            }}
          >
            <PhotoImage imageId="sauce" variant="option" />
          </Animated.View>
        </View>
        <Wrapper flex={1} gap={6}>
          <Heading tone="inverse">{copy(locale).upsellTitle}</Heading>
          <Body tone="onBlue">{copy(locale).upsellSub}</Body>
        </Wrapper>
      </Wrapper>
    </Animated.View>
  );
}
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
      ListHeaderComponent={<UpsellHeader locale={locale} />}
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
