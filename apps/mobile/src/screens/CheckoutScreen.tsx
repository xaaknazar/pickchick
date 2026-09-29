import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { ScreenProps } from '../model';
import { restaurantLocation } from '../restaurant-location';
import { cartTotal, money, preparationMinutes } from '../domain';
import { MotionPressable } from '../components/Motion';
import { CheckoutPayments } from '../components/CartExtras';
import { OrderHeader, OrderTotal, orderUI } from '../components/OrderPresentation';
import {
  Body,
  Button,
  Caption,
  Empty,
  Heading,
  Icon,
  Page,
  Row,
  SummaryRow,
} from '../components/UI';
import { colors, font } from '../theme';

export function CheckoutHeader({ props }: { props: ScreenProps }) {
  return <OrderHeader title="Оформление" testID="checkout-close" onClose={props.goBack} back />;
}
export function CheckoutDetails({
  props,
  lockedMode,
  restaurantName,
  address,
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
  const count = model.cart.reduce((sum, line) => sum + line.quantity, 0);
  return (
    <>
      <View style={s.section}>
        <Heading style={orderUI.title}>Как заберёте заказ?</Heading>
        {lockedMode ? (
          <Body style={orderUI.label}>{lockedMode === 'takeaway' ? 'С собой' : 'В зале'}</Body>
        ) : (
          <View
            style={s.modes}
            accessibilityRole="radiogroup"
            accessibilityLabel="Способ получения"
          >
            {(['takeaway', 'dine_in'] as const).map((mode) => {
              const selected = model.diningMode === mode;
              const label = mode === 'takeaway' ? 'С собой' : 'В зале';
              return (
                <MotionPressable
                  key={mode}
                  accessibilityRole="radio"
                  accessibilityLabel={label}
                  aria-checked={selected}
                  accessibilityState={{ selected, checked: selected }}
                  onPress={() => model.setDiningMode(mode)}
                  style={[s.mode, selected && s.modeSelected]}
                >
                  <Icon
                    name={mode === 'takeaway' ? 'bag-handle-outline' : 'restaurant-outline'}
                    size={20}
                    color={selected ? colors.orangeInk : colors.muted}
                  />
                  <Body
                    style={[
                      orderUI.label,
                      { color: selected ? colors.orangeInk : colors.text, flexShrink: 1 },
                    ]}
                  >
                    {label}
                  </Body>
                  {selected ? <Icon name="checkmark" size={16} color={colors.orangeInk} /> : null}
                </MotionPressable>
              );
            })}
          </View>
        )}
      </View>
      <View style={s.restaurant}>
        <Row style={{ alignItems: 'flex-start' }}>
          <View style={s.icon}>
            <Icon name="location-outline" color={colors.accent} size={22} />
          </View>
          <View style={s.place}>
            <Body style={[orderUI.label, { fontFamily: font.bold }]}>
              {restaurantName ?? location?.name ?? model.branch?.name ?? 'Ресторан PickChick'}
            </Body>
            {(address ?? location?.address) ? (
              <Caption style={orderUI.detail}>
                {address ?? `${location?.city}, ${location?.address}`}
              </Caption>
            ) : null}
            <Caption style={orderUI.detail}>
              {lockedMode
                ? 'Способ получения сохранён в заказе'
                : 'Заказ приготовят в этом ресторане'}
            </Caption>
          </View>
        </Row>
        {!lockedMode ? (
          <Row style={s.timing}>
            <View style={s.icon}>
              <Icon name="time-outline" size={22} color={colors.muted} />
            </View>
            <View style={s.place}>
              <Caption style={orderUI.detail}>Когда приготовить</Caption>
              <Body style={orderUI.label}>Как можно скорее</Body>
              <Caption style={orderUI.detail}>
                Ориентир - около {preparationMinutes(model.cart)} мин
              </Caption>
            </View>
          </Row>
        ) : null}
      </View>
      {paymentContent ?? <CheckoutPayments />}
      <View style={s.section}>
        <Heading small style={orderUI.section}>
          Детали
        </Heading>
        {details ?? (
          <>
            <SummaryRow label={`Блюда · ${count} шт.`} value={money(cartTotal(model.cart))} />
            <Button
              testID="checkout-edit-cart"
              title="Изменить заказ"
              secondary
              textStyle={orderUI.actionText}
              onPress={props.goBack}
            />
          </>
        )}
      </View>
    </>
  );
}

export function Checkout(props: ScreenProps) {
  const total = cartTotal(props.model.cart);
  return (
    <Page
      props={props}
      title="Оформление"
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
  section: { gap: 12 },
  modes: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  mode: {
    flexGrow: 1,
    flexBasis: 120,
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 12,
    borderRadius: 16,
    backgroundColor: colors.surface,
  },
  modeSelected: { backgroundColor: colors.accent },
  restaurant: { backgroundColor: colors.surface, borderRadius: 16, padding: 16, gap: 16 },
  icon: { width: 32, minHeight: 32, alignItems: 'center', justifyContent: 'center' },
  place: { flex: 1, minWidth: 0, gap: 4 },
  timing: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: 16,
    alignItems: 'flex-start',
  },
});
