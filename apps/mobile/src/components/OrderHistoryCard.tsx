import { StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import type { CustomerCommerceOrder } from '@pickchick/contracts';
import type { Product } from '../model';
import { paymentCopy } from '../commerce-presentation';
import { money } from '../domain';
import { ProductPhoto, productPhoto } from './ProductPhoto';
import { menuPhotos } from '../menu-photo-assets';
import { colors, font } from '../theme';
import { MotionPressable } from './Motion';
import { Body, Caption, Icon } from './UI';

export type OrderHistoryCardProps = {
  order: CustomerCommerceOrder;
  products: Product[];
  onOpen(): void;
  onRate?: (initialStars?: number) => void;
  savedRating?: number | null;
};

/** Historical order facts stay separate from the current menu and review draft. */
export function OrderHistoryCard({
  order,
  products,
  onOpen,
  onRate,
  savedRating,
}: OrderHistoryCardProps) {
  const completed = order.phase === 'handed_over';
  const rating = savedRating && savedRating >= 1 && savedRating <= 5 ? savedRating : 0;
  const quantity = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const date = new Date(order.createdAt).toLocaleString('ru-RU', {
    timeZone: 'Asia/Almaty',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const thumbnails = order.items.slice(0, order.items.length > 4 ? 3 : 4);
  const summary = order.items
    .slice(0, 3)
    .map((item) => `${item.title} ×${item.quantity}`)
    .join(' · ');
  return (
    <View style={s.card} testID={`order-history-${order.orderId}`}>
      <View style={s.heading}>
        <Text style={s.number}>{order.displayNumber ? `№ ${order.displayNumber}` : 'Заказ'}</Text>
        <Text style={s.total}>{money(order.totalMinor)}</Text>
      </View>
      <Caption style={s.date}>{date}</Caption>
      <View style={s.statusRow}>
        <Icon
          name={completed ? 'checkmark-circle-outline' : 'time-outline'}
          size={18}
          color={completed ? colors.success : colors.muted}
        />
        <Body style={[s.status, completed && { color: colors.success }]}>
          {paymentCopy[order.phase].title}
        </Body>
      </View>
      {order.items.length ? (
        <>
          <View
            style={s.thumbnails}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {thumbnails.map((item, index) => {
              const product = products.find((entry) => entry.id === item.productId);
              const photo = product ? productPhoto(product, 'thumb', 'menu') : undefined;
              const image = photo ? undefined : menuPhotos[item.productId];
              return (
                <View key={`${item.productId}-${index}`} style={s.thumbnail}>
                  {photo ? (
                    <ProductPhoto photo={photo} contentFit="contain" style={s.image} />
                  ) : image ? (
                    <Image source={image} contentFit="contain" style={s.image} />
                  ) : (
                    <Icon name="restaurant-outline" color={colors.background} size={26} />
                  )}
                </View>
              );
            })}
            {order.items.length > thumbnails.length ? (
              <View style={s.thumbnail}>
                <Text style={s.remaining}>+{order.items.length - thumbnails.length}</Text>
              </View>
            ) : null}
          </View>
          <Body style={s.summary}>{summary}</Body>
          <Caption style={s.date}>
            {quantity} шт.
            {order.items.length > 3 ? ` · Ещё позиций: ${order.items.length - 3}` : ''}
          </Caption>
        </>
      ) : null}
      <MotionPressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`Подробнее о заказе${order.displayNumber ? ` ${order.displayNumber}` : ''}`}
        testID={`order-history-open-${order.orderId}`}
        style={s.details}
      >
        <Body style={s.actionText}>Подробнее о заказе</Body>
        <Icon name="chevron-forward" size={18} />
      </MotionPressable>
      {completed && onRate ? (
        <View style={s.review}>
          <Body style={s.reviewTitle}>{rating ? 'Ваша оценка' : 'Как вам заказ?'}</Body>
          <View style={s.stars}>
            {[1, 2, 3, 4, 5].map((stars) => (
              <MotionPressable
                key={stars}
                accessibilityRole="button"
                accessibilityLabel={`Оценить заказ на ${stars} из 5`}
                accessibilityState={{ selected: stars === rating }}
                onPress={() => onRate(stars)}
                testID={`order-history-rate-${order.orderId}-${stars}`}
                style={s.star}
              >
                <Icon
                  name={stars <= rating ? 'star' : 'star-outline'}
                  color={stars <= rating ? colors.accentText : colors.muted}
                  size={28}
                />
              </MotionPressable>
            ))}
          </View>
          <MotionPressable
            accessibilityRole="button"
            accessibilityLabel="Оставить комментарий о заказе"
            onPress={() => onRate(rating || undefined)}
            testID={`order-history-comment-${order.orderId}`}
            style={s.comment}
          >
            <Icon name="chatbubble-outline" size={18} color={colors.accentText} />
            <Body style={s.commentText}>Оставить комментарий</Body>
          </MotionPressable>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: 22, padding: 16, gap: 8 },
  heading: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
  },
  number: {
    fontFamily: font.heading,
    fontSize: 22,
    lineHeight: 30,
    color: colors.text,
    flexShrink: 1,
  },
  total: {
    fontFamily: font.bold,
    fontSize: 20,
    lineHeight: 28,
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  date: { fontSize: 13, lineHeight: 20, color: colors.muted },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  status: { fontFamily: font.medium, fontSize: 14, lineHeight: 21, flex: 1, color: colors.muted },
  thumbnails: { flexDirection: 'row', gap: 8, paddingTop: 4 },
  thumbnail: {
    width: 52,
    height: 52,
    backgroundColor: colors.white,
    borderRadius: 12,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  image: { width: '100%', height: '100%' },
  remaining: { color: colors.background, fontFamily: font.bold, fontSize: 18 },
  summary: { fontSize: 14, lineHeight: 21 },
  details: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  actionText: { fontFamily: font.medium, fontSize: 14, lineHeight: 21, flex: 1 },
  review: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: 12,
    gap: 4,
  },
  reviewTitle: { fontFamily: font.medium, fontSize: 14, lineHeight: 21 },
  stars: { flexDirection: 'row', justifyContent: 'space-between' },
  star: { minWidth: 48, minHeight: 48, justifyContent: 'center', alignItems: 'center' },
  comment: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8 },
  commentText: {
    color: colors.accentText,
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 21,
    flex: 1,
  },
});
