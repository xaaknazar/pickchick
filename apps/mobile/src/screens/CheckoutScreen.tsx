import { CheckoutSheetHeader, checkoutStyle } from '../components/CheckoutPresentation';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { ScreenProps } from '../model';
import { restaurantLocation } from '../restaurant-location';
import { cartTotal, money } from '../domain';
import { MotionPressable } from '../components/Motion';
import { CheckoutPayments } from '../components/CartExtras';
import { OrderTotal, orderUI } from '../components/OrderPresentation';
import { Body, Button, Caption, Empty, Icon, Page, Row } from '../components/UI';
import { colors, font } from '../theme';

export function CheckoutHeader({ props }: { props: ScreenProps }) {
  return (
    <CheckoutSheetHeader title="Оформление" testID="checkout-close" onBack={props.goBack} back />
  );
}
export function CheckoutDetails({
  props,
  lockedMode,
  restaurantName,
  details,
  paymentContent,
}: {
  props: ScreenProps;
  lockedMode?: 'takeaway' | 'dine_in';
  restaurantName?: string;
  address?: string;
  details?: ReactNode;
  paymentContent?: ReactNode;
}) {
  const { model } = props;
  const location = restaurantLocation(model.branch?.id);
  return (
    <View style={s.layout}>
      <Caption style={s.sectionLabel}>КАК ЗАБЕРЁТЕ</Caption>
      {lockedMode ? (
        <Body>{lockedMode === 'takeaway' ? 'С собой' : 'В зале'}</Body>
      ) : (
        <View style={s.modes} accessibilityRole="radiogroup" accessibilityLabel="Способ получения">
          {(['dine_in', 'takeaway'] as const).map((mode) => {
            const selected = model.diningMode === mode;
            return (
              <MotionPressable
                key={mode}
                accessibilityRole="radio"
                accessibilityLabel={mode === 'dine_in' ? 'В зале' : 'С собой'}
                aria-checked={selected}
                accessibilityState={{ selected, checked: selected }}
                onPress={() => model.setDiningMode(mode)}
                style={[s.mode, selected && s.modeSelected]}
              >
                <Icon
                  name={mode === 'dine_in' ? 'restaurant-outline' : 'bag-handle-outline'}
                  size={26}
                  color={selected ? colors.accent : '#A3B4D6'}
                />
                {selected ? (
                  <View style={s.selected}>
                    <Icon name="checkmark" size={14} color={colors.orangeInk} />
                  </View>
                ) : null}
                <Body style={s.modeTitle}>{mode === 'dine_in' ? 'В зале' : 'С собой'}</Body>
                <Caption style={[s.modeHint, selected && { color: '#FFC9A3' }]}>
                  {mode === 'dine_in' ? 'Подадим на подносе' : 'Упакуем в пакет'}
                </Caption>
              </MotionPressable>
            );
          })}
        </View>
      )}
      <View style={s.restaurant}>
        <Row style={s.placeRow}>
          <Icon name="location-outline" color="#A3B4D6" size={20} />
          <View style={s.place}>
            <Body style={s.placeName}>
              {restaurantName ?? location?.name ?? model.branch?.name ?? 'Ресторан PickChick'}
            </Body>
            <Caption style={s.modeHint}>Выдача по номеру заказа</Caption>
          </View>
        </Row>
        <View
          style={s.commentRow}
          accessible
          accessibilityLabel="Комментарий к заказу, скоро"
          accessibilityState={{ disabled: true }}
        >
          <Icon name="chatbubble-outline" size={20} color="#A3B4D6" />
          <View style={s.place}>
            <Body style={s.commentLabel}>Комментарий к заказу</Body>
            <Caption style={s.modeHint}>Передача на кухню подключается</Caption>
          </View>
        </View>
      </View>
      <Caption style={[s.sectionLabel, { marginTop: 10 }]}>ОПЛАТА</Caption>
      {paymentContent ?? <CheckoutPayments />}
      {details ? <View style={s.section}>{details}</View> : null}
    </View>
  );
}

export function Checkout(props: ScreenProps) {
  const total = cartTotal(props.model.cart);
  return (
    <Page
      props={props}
      title="Оформление"
      contentStyle={checkoutStyle.content}
      footerStyle={checkoutStyle.footer}
      header={<CheckoutHeader props={props} />}
      footer={
        props.model.cart.length ? (
          <>
            <OrderTotal value={money(total)} />
            <Button
              testID="checkout-pay-disabled"
              title="Оформление скоро появится"
              disabled
              style={orderUI.action}
              textStyle={orderUI.actionText}
            />
          </>
        ) : undefined
      }
    >
      {!props.model.cart.length ? (
        <Empty
          title="В корзине пока пусто"
          detail="Выберите любимые блюда, чтобы оформить заказ."
          action={<Button title="В меню" onPress={() => props.navigate('M06')} />}
        />
      ) : (
        <CheckoutDetails props={props} />
      )}
    </Page>
  );
}
const s = StyleSheet.create({
  layout: { gap: 10 },
  section: { gap: 10, paddingVertical: 12 },
  sectionLabel: {
    fontFamily: font.bold,
    fontSize: 12,
    lineHeight: 18,
    letterSpacing: 1.2,
    color: '#A3B4D6',
    marginHorizontal: 8,
  },
  modes: { flexDirection: 'row', gap: 10 },
  mode: {
    flex: 1,
    minHeight: 102,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 22,
    borderWidth: 1.5,
    borderColor: '#FFFFFF0F',
    backgroundColor: '#0B2255',
    gap: 3,
  },
  modeSelected: { borderColor: colors.accent, backgroundColor: '#FF69001F' },
  selected: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeTitle: { fontFamily: font.heading, fontSize: 18, lineHeight: 23, marginTop: 4 },
  modeHint: { fontSize: 12, lineHeight: 18, color: '#A3B4D6' },
  restaurant: {
    backgroundColor: '#0B2255',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#FFFFFF0F',
    marginTop: 2,
  },
  placeRow: { minHeight: 62, padding: 14, gap: 12 },
  place: { flex: 1, minWidth: 0, gap: 2 },
  placeName: { fontFamily: font.medium, fontSize: 15, lineHeight: 21 },
  commentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 54,
    padding: 14,
    borderTopWidth: 1,
    borderTopColor: '#FFFFFF0A',
  },
  commentLabel: { fontSize: 15, lineHeight: 21, color: '#A3B4D6' },
});
