import { useEffect, useRef, useState } from 'react';
import type { CustomerCommerceOrder } from '@pickchick/contracts';
import { Image } from 'expo-image';
import { ActivityIndicator, Keyboard, StyleSheet, TextInput, View } from 'react-native';
import { CheckoutKeyboardDone } from '../components/CheckoutKeyboard';
import { checkoutStyle } from '../components/CheckoutPresentation';
import { MotionPressable } from '../components/Motion';
import { Body, Button, Caption, CloseButton, Heading, Icon, Page, Row } from '../components/UI';
import { money } from '../domain';
import { menuPhotos } from '../menu-photo-assets';
import type { ScreenProps } from '../model';
import { colors, font } from '../theme';

export type CompletedOrderScreenProps = {
  props: ScreenProps;
  order: CustomerCommerceOrder;
  review?: { rating: number; comment: string | null } | null;
  reviewLoading?: boolean;
  reviewSaving?: boolean;
  reviewError?: string | null;
  reviewUnavailable?: string | null;
  initialRating?: number;
  onSaveReview?: (rating: number, comment: string) => void;
  onRetryReview?: () => void;
  preparationStartedAt?: string | null;
  readyAt?: string | null;
  onOpenReceipt?: () => void;
  onSupport?: () => void;
};

/** A completed order is a durable receipt of the visit, with a separate review draft. */
export function CompletedOrderScreen({
  props,
  order,
  review,
  reviewLoading = false,
  reviewSaving = false,
  reviewError,
  reviewUnavailable,
  initialRating,
  onSaveReview,
  onRetryReview,
  preparationStartedAt,
  readyAt,
  onOpenReceipt,
  onSupport,
}: CompletedOrderScreenProps) {
  const [rating, setRating] = useState(initialRating ?? review?.rating ?? 0);
  const [comment, setComment] = useState(review?.comment ?? '');
  const [focused, setFocused] = useState(false);
  const ratingEdited = useRef(false);
  const commentEdited = useRef(false);
  // The order-keyed parent remounts this form when a different order opens.
  // Late fetches must not replace a list selection or a draft already being edited.
  useEffect(() => {
    if (initialRating === undefined && !ratingEdited.current) setRating(review?.rating ?? 0);
    if (!commentEdited.current) setComment(review?.comment ?? '');
  }, [review?.rating, review?.comment, initialRating]);
  const locked = reviewLoading || reviewSaving || !!reviewUnavailable || !onSaveReview;
  const changed = rating !== (review?.rating ?? 0) || comment.trim() !== (review?.comment ?? '');
  const created = new Date(order.createdAt);
  const date = Number.isFinite(created.getTime())
    ? created.toLocaleString('ru-KZ', {
        timeZone: 'Asia/Almaty',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;
  const started = preparationStartedAt ? Date.parse(preparationStartedAt) : NaN;
  const ready = readyAt ? Date.parse(readyAt) : NaN;
  const preparationMinutes =
    Number.isFinite(started) && Number.isFinite(ready) && ready >= started
      ? Math.ceil((ready - started) / 60_000)
      : null;
  const receiptAvailable = order.receipt === 'issued' && !!order.receiptUrl && !!onOpenReceipt;
  return (
    <Page
      props={props}
      title="Завершённый заказ"
      contentStyle={[checkoutStyle.content, s.content]}
      keyboardFooter={<CheckoutKeyboardDone />}
      header={
        <View style={s.header}>
          <CloseButton
            label="Закрыть заказ"
            testID="completed-order-close"
            onPress={props.goBack}
          />
          <Heading style={s.headerTitle}>Ваш заказ</Heading>
        </View>
      }
    >
      <View testID="completed-order" style={s.layout}>
        <View style={s.overview}>
          <Row style={s.status}>
            <Icon name="checkmark-circle-outline" color={colors.success} size={22} />
            <Body style={s.statusText}>Заказ получен</Body>
          </Row>
          <Heading testID="completed-order-number" style={s.number}>
            {order.displayNumber ? `№ ${order.displayNumber}` : 'Заказ завершён'}
          </Heading>
          <Body style={s.restaurant}>{order.restaurant}</Body>
          {date ? (
            <Caption testID="completed-order-date" style={s.muted}>
              {date} · Алматы
            </Caption>
          ) : null}
          <View style={s.facts}>
            <Caption style={s.muted}>
              {order.serviceMode === 'takeaway' ? 'С собой' : 'В зале'}
            </Caption>
            {preparationMinutes !== null ? (
              <Caption testID="completed-order-duration" style={s.muted}>
                Приготовление:{' '}
                {preparationMinutes < 1 ? 'меньше минуты' : `${preparationMinutes} мин`}
              </Caption>
            ) : null}
          </View>
        </View>

        <View style={s.section}>
          <Heading small style={s.sectionTitle}>
            Состав заказа
          </Heading>
          {order.items.map((item, index) => {
            const product = props.model.products.find(
              (candidate) => candidate.id === item.productId,
            );
            const photo = menuPhotos[item.productId] ?? product?.image;
            return (
              <View
                key={`${item.productId}-${index}`}
                testID={`completed-item-${index}`}
                style={s.item}
              >
                <View style={s.photo}>
                  {photo ? (
                    <Image
                      source={photo}
                      contentFit="contain"
                      style={s.image}
                      accessibilityLabel={item.title}
                    />
                  ) : (
                    <Icon name="restaurant-outline" color={colors.orangeInk} size={28} />
                  )}
                </View>
                <View style={s.itemCopy}>
                  <Body style={s.itemName}>{item.title}</Body>
                  {item.modifiers.length ? (
                    <Caption style={s.modifiers}>{item.modifiers.join(' · ')}</Caption>
                  ) : null}
                  <Row style={s.itemBottom}>
                    <Caption style={s.muted}>{item.quantity} шт.</Caption>
                    <Body style={s.itemAmount}>{money(item.totalMinor)}</Body>
                  </Row>
                </View>
              </View>
            );
          })}
          <Row style={s.total}>
            <Body style={s.totalLabel}>Итого</Body>
            <Heading small testID="completed-order-total" style={s.totalAmount}>
              {money(order.totalMinor)}
            </Heading>
          </Row>
          {order.kitchenComment ? (
            <View testID="order-kitchen-comment" style={s.kitchenComment}>
              <Caption style={s.muted}>Ваш комментарий к заказу</Caption>
              <Body>{order.kitchenComment}</Body>
            </View>
          ) : null}
        </View>

        <View testID="completed-order-review" style={s.review}>
          <Heading small style={s.sectionTitle}>
            Как вам заказ?
          </Heading>
          <Body style={s.muted}>Оцените блюда и поделитесь впечатлениями.</Body>
          {reviewLoading ? (
            <ActivityIndicator accessibilityLabel="Загружаем оценку заказа" color={colors.accent} />
          ) : null}
          <View style={s.stars} accessibilityRole="radiogroup" accessibilityLabel="Оценка заказа">
            {[1, 2, 3, 4, 5].map((value) => (
              <MotionPressable
                key={value}
                testID={`completed-rating-${value}`}
                accessibilityRole="radio"
                accessibilityLabel={`Оценка ${value} из 5`}
                accessibilityState={{ checked: rating === value, disabled: locked }}
                aria-checked={rating === value}
                disabled={locked}
                onPress={() => {
                  ratingEdited.current = true;
                  setRating(value);
                }}
                style={[s.star, locked && s.locked]}
              >
                <Icon
                  name={value <= rating ? 'star' : 'star-outline'}
                  color={colors.accent}
                  size={30}
                />
              </MotionPressable>
            ))}
          </View>
          <Caption style={s.muted}>
            {rating ? `Ваша оценка: ${rating} из 5` : 'Выберите от 1 до 5 звёзд'}
          </Caption>
          <View style={s.commentGroup}>
            <Body style={s.fieldLabel}>Отзыв - по желанию</Body>
            <TextInput
              testID="completed-review-comment"
              accessibilityLabel="Отзыв о заказе, необязательно"
              value={comment}
              onChangeText={(value) => {
                commentEdited.current = true;
                setComment(value);
              }}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              editable={!locked}
              maxLength={500}
              multiline
              scrollEnabled
              textAlignVertical="top"
              returnKeyType="done"
              submitBehavior="blurAndSubmit"
              onSubmitEditing={Keyboard.dismiss}
              placeholder="Что понравилось или что можно улучшить?"
              placeholderTextColor={colors.muted}
              selectionColor={colors.accent}
              style={[s.input, focused && s.inputFocused, locked && s.locked]}
            />
            <Caption style={s.counter}>{comment.length}/500</Caption>
          </View>
          {reviewUnavailable ? <Body style={s.muted}>{reviewUnavailable}</Body> : null}
          {reviewError ? (
            <Caption
              testID="completed-review-error"
              accessibilityLiveRegion="polite"
              style={s.error}
            >
              {reviewError}
            </Caption>
          ) : null}
          {reviewError && onRetryReview ? (
            <Button
              secondary
              testID="completed-review-retry"
              title="Повторить загрузку"
              disabled={reviewLoading || reviewSaving}
              onPress={onRetryReview}
            />
          ) : null}
          {review && !changed && !reviewError ? (
            <Caption
              testID="completed-review-saved"
              accessibilityLiveRegion="polite"
              style={s.saved}
            >
              Спасибо! Ваша оценка сохранена.
            </Caption>
          ) : null}
          <Button
            testID="completed-review-save"
            title={reviewSaving ? 'Сохраняем...' : review ? 'Обновить отзыв' : 'Отправить отзыв'}
            disabled={locked || !rating || !changed}
            onPress={() => {
              Keyboard.dismiss();
              onSaveReview?.(rating, comment.trim());
            }}
            style={s.save}
          />
        </View>

        <View style={s.section}>
          <Heading small style={s.sectionTitle}>
            {onSupport ? 'Чек и помощь' : 'Фискальный чек'}
          </Heading>
          {receiptAvailable ? (
            <Button
              testID="completed-order-receipt"
              title="Открыть фискальный чек"
              secondary
              icon="receipt-outline"
              onPress={onOpenReceipt}
            />
          ) : (
            <View testID="completed-receipt-unavailable" style={s.receipt}>
              <Icon name="receipt-outline" color={colors.muted} size={22} />
              <Caption style={[s.muted, s.flex]}>
                {order.receipt === 'issued'
                  ? 'Чек выпущен. Ссылка пока недоступна.'
                  : order.receipt === 'deferred'
                    ? 'Фискальный чек пока недоступен - подключаем сервис чеков.'
                    : 'Ожидаем фискальный чек. Ссылка появится после выпуска.'}
              </Caption>
            </View>
          )}
          {onSupport ? (
            <Button
              testID="completed-order-support"
              title="Связаться с поддержкой"
              secondary
              icon="chatbubble-outline"
              onPress={onSupport}
            />
          ) : null}
        </View>
      </View>
    </Page>
  );
}

const s = StyleSheet.create({
  content: { paddingBottom: 28 },
  layout: { gap: 28 },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 14, gap: 12 },
  headerTitle: { fontSize: 30, lineHeight: 36 },
  overview: { gap: 8 },
  status: { gap: 8 },
  statusText: { color: colors.success, fontFamily: font.medium, fontSize: 14 },
  number: { fontSize: 40, lineHeight: 48 },
  restaurant: { fontFamily: font.bold, fontSize: 17, lineHeight: 25 },
  muted: { color: colors.muted },
  facts: { gap: 6, marginTop: 4 },
  section: { gap: 14 },
  sectionTitle: { fontSize: 23, lineHeight: 30 },
  item: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  photo: {
    width: 76,
    height: 76,
    borderRadius: 12,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  image: { width: 72, height: 72 },
  itemCopy: { flex: 1, minWidth: 0, gap: 6 },
  itemName: { fontFamily: font.bold, fontSize: 15, lineHeight: 22 },
  modifiers: { color: colors.muted, lineHeight: 20 },
  itemBottom: { justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  itemAmount: { fontFamily: font.bold, fontSize: 15 },
  total: { justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  totalLabel: { fontFamily: font.bold, fontSize: 17 },
  totalAmount: { color: colors.accent, fontSize: 25 },
  kitchenComment: { gap: 6, paddingTop: 6 },
  review: { gap: 12 },
  stars: { flexDirection: 'row', gap: 8 },
  star: { minWidth: 48, minHeight: 48, flex: 1, alignItems: 'center', justifyContent: 'center' },
  locked: { opacity: 0.6 },
  commentGroup: { gap: 8 },
  fieldLabel: { fontSize: 15, fontFamily: font.medium },
  input: {
    minHeight: 116,
    maxHeight: 156,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 14,
    color: colors.text,
    fontFamily: font.body,
    fontSize: 16,
    lineHeight: 24,
    backgroundColor: colors.raised,
  },
  inputFocused: { borderColor: colors.accent },
  counter: { textAlign: 'right', color: colors.muted },
  error: { color: colors.danger, lineHeight: 21 },
  saved: { color: colors.success, lineHeight: 21 },
  save: { minHeight: 48 },
  receipt: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  flex: { flex: 1, minWidth: 0 },
});
