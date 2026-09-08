import { Image } from 'expo-image';
import { Pressable, StyleSheet, View } from 'react-native';
import type { ScreenProps } from '../model';
import { colors, font } from '../theme';
import { restaurantLocation } from '../restaurant-location';
import { cartLineKey, cartTotal, lineUnitPrice, money, selectionDescription } from '../domain';
import { DiningSelector } from '../components/Brand';
import { PaymentChoice } from '../components/PaymentChoice';
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
  styles as ui,
} from '../components/UI';

/** Customer checkout follows the supplied cart/payment layout; no simulated charges. */
export function Checkout(props: ScreenProps) {
  const { model } = props;
  const location = restaurantLocation(model.branch?.id);
  const total = cartTotal(model.cart);
  const count = model.cart.reduce((sum, line) => sum + line.quantity, 0);
  return (
    <Page
      props={props}
      title="Оплата"
      footer={
        model.cart.length ? (
          <>
            <Row style={s.paymentRow}>
              <PaymentChoice model={model} />
              <View style={s.payable}>
                <Caption>К оплате</Caption>
                <Heading style={s.total} testID="checkout-total">
                  {money(total)}
                </Heading>
              </View>
            </Row>
            <Button
              testID="checkout-pay-disabled"
              title={model.paymentMethod === 'kaspi' ? 'Оплатить через Kaspi' : 'Оплатить картой'}
              disabled
            />
            <Row style={s.availability}>
              <Icon name="time-outline" size={15} color={colors.muted} />
              <Caption style={s.availabilityText}>Онлайн-оплата скоро появится</Caption>
            </Row>
          </>
        ) : undefined
      }
    >
      {!model.cart.length ? (
        <Empty
          title="В корзине пока пусто"
          detail="Выберите любимые блюда, чтобы перейти к оплате."
          action={<Button title="В меню" onPress={() => props.navigate('M06')} />}
        />
      ) : (
        <>
          <View style={s.restaurant}>
            <Row style={{ alignItems: 'flex-start' }}>
              <View style={s.locationMark}>
                <Icon name="location-outline" color={colors.accent} size={23} />
              </View>
              <View style={[ui.flex, { gap: 4 }]}>
                <Caption style={s.eyebrow}>ВАШ РЕСТОРАН</Caption>
                <Heading small style={s.restaurantName}>
                  {location?.name ?? model.branch?.name ?? 'Pick Chick'}
                </Heading>
                {location ? (
                  <Caption>
                    {location.city}, {location.address}
                  </Caption>
                ) : null}
              </View>
            </Row>
            <DiningSelector value={model.diningMode} onChange={model.setDiningMode} />
          </View>
          <Row style={s.sectionHeading}>
            <Heading small>Ваш заказ</Heading>
            <Pressable
              accessibilityRole="button"
              testID="checkout-edit-cart"
              onPress={() => props.navigate('M09')}
              style={s.edit}
            >
              <Body style={s.editText}>Изменить</Body>
              <Icon name="chevron-forward" size={14} color="#A8C8FF" />
            </Pressable>
          </Row>
          <View style={s.order}>
            {model.cart.map((line, index) => (
              <View key={cartLineKey(line)} style={[s.line, index > 0 && s.lineBorder]}>
                <Image source={line.product.image} contentFit="cover" style={s.foodImage} />
                <View style={[ui.flex, { gap: 4 }]}>
                  <Body style={s.productName}>{line.product.name}</Body>
                  {selectionDescription(line) ? (
                    <Caption style={s.selections}>{selectionDescription(line)}</Caption>
                  ) : null}
                  <Row style={s.lineBottom}>
                    <Caption>{line.quantity} шт.</Caption>
                    <Body style={s.linePrice}>
                      {money((BigInt(lineUnitPrice(line)) * BigInt(line.quantity)).toString())}
                    </Body>
                  </Row>
                </View>
              </View>
            ))}
          </View>
          <View style={s.summary}>
            <SummaryRow label={`Блюда · ${count} шт.`} value={money(total)} />
            <View style={s.divider} />
            <SummaryRow label="Итого" value={money(total)} strong />
          </View>
        </>
      )}
    </Page>
  );
}
const s = StyleSheet.create({
  restaurant: { backgroundColor: colors.surface, borderRadius: 24, padding: 18, gap: 18 },
  locationMark: {
    width: 44,
    height: 44,
    borderRadius: 15,
    backgroundColor: '#FF7A3D14',
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyebrow: { fontSize: 10, lineHeight: 15, letterSpacing: 1.1 },
  restaurantName: { fontSize: 20, lineHeight: 30 },
  sectionHeading: { justifyContent: 'space-between', gap: 12, marginTop: 4 },
  edit: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 4 },
  editText: { fontFamily: font.medium, fontSize: 13, color: '#A8C8FF' },
  order: { backgroundColor: colors.surface, borderRadius: 24, paddingHorizontal: 16 },
  line: { flexDirection: 'row', alignItems: 'center', paddingVertical: 16, gap: 12 },
  lineBorder: { borderTopWidth: 1, borderTopColor: colors.border },
  foodImage: { width: 60, height: 60, borderRadius: 16, backgroundColor: colors.raised },
  productName: { fontFamily: font.bold, fontSize: 15, lineHeight: 22 },
  selections: { fontSize: 11, lineHeight: 16 },
  lineBottom: { justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  linePrice: { fontFamily: font.bold, fontSize: 14, lineHeight: 21 },
  summary: { backgroundColor: colors.surface, borderRadius: 22, padding: 18, gap: 7 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 5 },
  paymentRow: { justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  payable: { alignItems: 'flex-end', flexShrink: 1 },
  total: { fontSize: 25, lineHeight: 36 },
  availability: { justifyContent: 'center', gap: 6 },
  availabilityText: { fontSize: 11, lineHeight: 17 },
});
