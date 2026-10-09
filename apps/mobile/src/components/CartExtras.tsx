import { UpcomingPayments, checkoutStyle } from './CheckoutPresentation';
import { PaymentMark } from './PaymentChoice';
import { useState } from 'react';
import { Keyboard, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { MotionPressable } from './Motion';
import { Body, Button, Caption, Heading, Icon } from './UI';
import { ComboRewardCard } from './ComboRewardCard';
import { usePublishedContent } from '../backoffice/usePublishedContent';
import { PromotionDialog } from '../backoffice/PromotionDialog';
import type { PublishedContent } from '../backoffice/content-model';
import type { ScreenProps } from '../model';
import { orderUI } from './OrderPresentation';
import { cartRecommendations } from '../cart-actions';
import { lineUnitPrice, money, selectionDescription } from '../domain';
import { ProductPhoto, productPhoto } from './ProductPhoto';
import { colors, font } from '../theme';

export function CartRecommendations({ props }: { props: ScreenProps }) {
  const recommendations = cartRecommendations(props.model.cart, props.model.products);
  const [added, setAdded] = useState('');
  return (
    <View style={{ gap: 12 }}>
      {recommendations.length ? (
        <>
          <Heading
            small
            style={[
              orderUI.section,
              {
                fontFamily: font.display,
                fontSize: 22,
                lineHeight: 28,
                marginTop: 18,
                marginLeft: 8,
              },
            ]}
          >
            Всегда кстати
          </Heading>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 12 }}
            testID="cart-recommendations"
          >
            {recommendations.map((line) => (
              <View key={line.product.id} style={s.extra}>
                <ProductPhoto
                  photo={productPhoto(line.product, 'card', 'extra')}
                  contentFit="contain"
                  style={s.extraPhoto}
                  accessible={false}
                />
                <Body style={s.extraName}>{line.product.name}</Body>
                <Caption numberOfLines={1} style={s.extraDetail}>
                  {selectionDescription(line) || line.product.servingLabel}
                </Caption>
                <View style={{ flex: 1 }} />
                <MotionPressable
                  style={s.extraAdd}
                  accessibilityRole="button"
                  testID={`cart-recommend-${line.product.id}`}
                  accessibilityLabel={`Добавить ${line.product.name}, ${money(lineUnitPrice(line))}`}
                  onPress={() => {
                    setAdded(
                      props.model.appendCartLines([line])
                        ? `${line.product.name} добавлен в корзину`
                        : 'Меню или корзина изменились. Попробуйте ещё раз.',
                    );
                  }}
                >
                  <Body style={s.extraPrice}>{money(lineUnitPrice(line))}</Body>
                  <Icon name="add" size={19} color={colors.accent} />
                </MotionPressable>
              </View>
            ))}
          </ScrollView>
        </>
      ) : null}
      {added ? (
        <Caption accessibilityLiveRegion="polite" testID="cart-recommend-added">
          {added}
        </Caption>
      ) : null}
    </View>
  );
}

export function CartOffers({ props }: { props: ScreenProps }) {
  const { content } = usePublishedContent(props.preview ? null : props.model.branch?.id);
  const [selected, setSelected] = useState<PublishedContent['promos'][number] | null>(null);
  return (
    <View style={{ gap: 14 }}>
      <Heading small style={orderUI.section}>
        Акции
      </Heading>
      <ComboRewardCard
        preview={props.preview}
        progress={props.model.testFlow.comboProgress}
        compact
        testID="cart-combo-reward"
        onMenu={() => props.navigate('M06')}
      />
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
              <Body style={{ color: colors.accentText }}>Условия акции</Body>
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
        style={{ borderRadius: 16 }}
        textStyle={orderUI.actionText}
      />
      {open ? (
        <>
          <Caption style={orderUI.detail} nativeID="promo-label">
            Промокод
          </Caption>
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
          <Caption style={orderUI.detail}>
            Применение промокодов подключается. Скидка пока не учитывается в сумме заказа.
          </Caption>
          <Button
            secondary
            textStyle={orderUI.actionText}
            title="Проверить промокод"
            testID="cart-promo-check"
            disabled={!code.trim()}
            onPress={() => {
              Keyboard.dismiss();
              setMessage('Промокод пока нельзя применить. Сумма заказа не изменилась.');
            }}
          />
          {message ? (
            <Caption
              style={orderUI.detail}
              testID="cart-promo-result"
              accessibilityLiveRegion="polite"
            >
              {message}
            </Caption>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

/** Provider enrollment is still pending. No card details are collected. */
export function CheckoutPayments() {
  return (
    <View style={{ gap: 10 }}>
      <View style={checkoutStyle.paymentPanel}>
        <View
          style={s.method}
          accessible
          accessibilityLabel="Kaspi, подключается"
          accessibilityState={{ disabled: true }}
        >
          <PaymentMark method="kaspi" size={36} />
          <View style={{ flex: 1 }}>
            <Body style={orderUI.label}>Kaspi.kz</Body>
            <Caption>Подключается</Caption>
          </View>
        </View>
        <UpcomingPayments />
      </View>
      <Caption style={orderUI.detail}>Оплата и чеки - в процессе подключения.</Caption>
    </View>
  );
}
const s = StyleSheet.create({
  extra: {
    width: 136,
    padding: 12,
    paddingTop: 0,
    gap: 3,
    borderRadius: 22,
    backgroundColor: '#0B2255',
    borderWidth: 1,
    borderColor: '#FFFFFF0F',
  },
  extraPhoto: { width: 110, height: 96, borderRadius: 16, backgroundColor: '#FFFFFF' },
  extraName: { fontFamily: font.heading, fontSize: 15, lineHeight: 19, marginTop: 6 },
  extraDetail: { fontSize: 12, lineHeight: 17, color: '#A3B4D6' },
  extraAdd: {
    minHeight: 48,
    paddingHorizontal: 10,
    marginTop: 8,
    borderRadius: 24,
    backgroundColor: '#14306B',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 4,
  },
  extraPrice: { fontFamily: font.heading, fontSize: 15, lineHeight: 20 },
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
  methods: { gap: 8 },
  method: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 80,
    padding: 16,
    gap: 12,
    borderRadius: 16,
    backgroundColor: colors.surface,
  },
  methodIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: colors.raised,
  },
  methodText: { flex: 1, minWidth: 0, gap: 2 },
});
