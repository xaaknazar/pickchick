import { useState } from 'react';
import { Keyboard, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { MotionPressable } from './Motion';
import { Body, Button, Caption, Heading, Icon, Row } from './UI';
import { ComboRewardCard } from './ComboRewardCard';
import { usePublishedContent } from '../backoffice/usePublishedContent';
import { PromotionDialog } from '../backoffice/PromotionDialog';
import type { PublishedContent } from '../backoffice/content-model';
import type { ScreenProps } from '../model';
import { colors, font } from '../theme';

export function CartOffers({ props }: { props: ScreenProps }) {
  const { content } = usePublishedContent(props.preview ? null : props.model.branch?.id);
  const [selected, setSelected] = useState<PublishedContent['promos'][number] | null>(null);
  return (
    <View style={{ gap: 14 }}>
      <Heading small>Акции</Heading>
      <ComboRewardCard testID="cart-combo-reward" onMenu={() => props.navigate('M06')} />
      {content?.promos.length ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 12 }}
        >
          {content.promos.map((promo) => (
            <MotionPressable
              key={promo.id}
              accessibilityRole="button"
              accessibilityLabel={`${promo.title.ru}, условия акции`}
              onPress={() => setSelected(promo)}
              style={s.promotion}
            >
              <Icon name="pricetag-outline" color={colors.accent} />
              <Body style={{ fontFamily: font.bold }}>{promo.title.ru}</Body>
              <Caption numberOfLines={3}>{promo.body.ru}</Caption>
              <Body style={{ color: colors.accent }}>Условия акции</Body>
            </MotionPressable>
          ))}
        </ScrollView>
      ) : null}
      <PromotionDialog promotion={selected} onClose={() => setSelected(null)} />
    </View>
  );
}

/** No local discount or fictitious acceptance: redemption needs a server quote. */
export function PromoCodeEntry() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  return (
    <View style={{ gap: 12, paddingVertical: 12 }}>
      <Button
        secondary
        testID="cart-promo-open"
        title={open ? 'Скрыть промокод' : 'Ввести промокод'}
        onPress={() => setOpen(!open)}
        style={{ borderRadius: 28 }}
      />
      {open ? (
        <>
          <Caption nativeID="promo-label">Промокод</Caption>
          <TextInput
            testID="cart-promo-input"
            accessibilityLabel="Промокод"
            aria-labelledby="promo-label"
            value={code}
            onChangeText={(text) => {
              setCode(text.toUpperCase());
              setMessage('');
            }}
            placeholder="Введите код"
            placeholderTextColor={colors.muted}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={32}
            style={s.input}
            returnKeyType="done"
            onSubmitEditing={() => Keyboard.dismiss()}
          />
          <Caption>
            Применение промокодов подключается. Скидка пока не учитывается в сумме заказа.
          </Caption>
          <Button
            secondary
            title="Проверить промокод"
            testID="cart-promo-check"
            disabled={!code.trim()}
            onPress={() => {
              Keyboard.dismiss();
              setMessage('Промокод пока нельзя применить. Сумма заказа не изменилась.');
            }}
          />
          {message ? (
            <Caption testID="cart-promo-result" accessibilityLiveRegion="polite">
              {message}
            </Caption>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

/** Provider enrollment is still pending. Never collect PAN/CVC in our own form. */
export function CheckoutPayments() {
  const [cardInfo, setCardInfo] = useState(false);
  return (
    <View style={{ gap: 14 }}>
      <Heading small>Оплата</Heading>
      <View style={s.methods}>
        <View
          testID="checkout-apple-pay"
          accessible
          accessibilityLabel="Apple Pay, в процессе подключения"
          accessibilityState={{ disabled: true }}
          style={s.method}
        >
          <Row>
            <Icon name="logo-apple" />
            <Body style={{ fontFamily: font.bold }}>Apple Pay</Body>
          </Row>
          <Caption>Подключается</Caption>
        </View>
        <MotionPressable
          testID="checkout-add-card"
          accessibilityRole="button"
          accessibilityLabel="Добавить карту, информация о подключении"
          accessibilityState={{ expanded: cardInfo }}
          onPress={() => setCardInfo(!cardInfo)}
          style={s.method}
        >
          <Row>
            <Icon name="add" />
            <Body style={{ fontFamily: font.bold }}>Добавить карту</Body>
          </Row>
          <Caption>Скоро</Caption>
        </MotionPressable>
      </View>
      {cardInfo ? (
        <Caption testID="checkout-card-info" accessibilityLiveRegion="polite">
          Добавление карты появится после подключения банка. Сейчас вводить реквизиты не нужно.
        </Caption>
      ) : null}
      <Caption>Оплата и чеки - в процессе подключения.</Caption>
    </View>
  );
}
const s = StyleSheet.create({
  promotion: {
    width: 260,
    padding: 18,
    gap: 12,
    borderRadius: 16,
    backgroundColor: colors.surface,
  },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.muted,
    borderRadius: 16,
    padding: 14,
    fontFamily: font.body,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  methods: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  method: {
    flexBasis: 160,
    flexGrow: 1,
    minHeight: 88,
    padding: 16,
    gap: 8,
    borderRadius: 20,
    backgroundColor: colors.raised,
  },
});
