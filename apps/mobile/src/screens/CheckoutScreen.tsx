import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { ScreenProps } from '../model';
import { restaurantLocation } from '../restaurant-location';
import { cartTotal, money, preparationMinutes } from '../domain';
import { DiningSelector } from '../components/Brand';
import { CheckoutPayments } from '../components/CartExtras';
import {
  Body,
  Button,
  Caption,
  Empty,
  Heading,
  IconButton,
  Page,
  Row,
  SummaryRow,
} from '../components/UI';
import { colors, font } from '../theme';

export function CheckoutHeader({ props }: { props: ScreenProps }) {
  return (
    <Row style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
      <IconButton
        name="close"
        label="Вернуться в корзину"
        testID="checkout-close"
        onPress={props.goBack}
      />
      <Heading small style={{ flex: 1 }}>
        Оформление
      </Heading>
    </Row>
  );
}
export function CheckoutDetails({
  props,
  lockedMode,
  restaurantName,
  address,
  details,
}: {
  props: ScreenProps;
  lockedMode?: 'takeaway' | 'dine_in';
  restaurantName?: string;
  address?: string;
  details?: ReactNode;
}) {
  const { model } = props;
  const location = restaurantLocation(model.branch?.id);
  const count = model.cart.reduce((sum, line) => sum + line.quantity, 0);
  return (
    <>
      <Heading style={{ fontSize: 32, lineHeight: 40 }}>Как заберёте заказ?</Heading>
      {lockedMode ? (
        <Body>{lockedMode === 'takeaway' ? 'С собой' : 'В зале'}</Body>
      ) : (
        <DiningSelector value={model.diningMode} onChange={model.setDiningMode} />
      )}
      <View style={{ gap: 8, backgroundColor: colors.surface, padding: 18, borderRadius: 20 }}>
        <Heading small>
          {restaurantName ?? location?.name ?? model.branch?.name ?? 'Ресторан PickChick'}
        </Heading>
        {(address ?? location?.address) ? (
          <Caption>{address ?? `${location?.city}, ${location?.address}`}</Caption>
        ) : null}
        <Caption>
          {lockedMode ? 'Способ получения сохранён в заказе' : 'Заказ приготовят в этом ресторане'}
        </Caption>
      </View>
      {!lockedMode ? (
        <View style={{ gap: 8 }}>
          <Heading small>Когда приготовить</Heading>
          <Body style={{ fontFamily: font.medium }}>Как можно скорее</Body>
          <Caption>Ориентир - около {preparationMinutes(model.cart)} мин</Caption>
        </View>
      ) : null}
      <CheckoutPayments />
      <View style={{ gap: 12 }}>
        <Heading small>Детали</Heading>
        {details ?? (
          <>
            <SummaryRow label={`Блюда · ${count} шт.`} value={money(cartTotal(model.cart))} />
            <Button
              testID="checkout-edit-cart"
              title="Изменить заказ"
              secondary
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
            <SummaryRow label="Итого" value={money(total)} strong />
            <Button
              testID="checkout-pay-disabled"
              title="Оформление скоро появится"
              disabled
              style={{ borderRadius: 28 }}
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
