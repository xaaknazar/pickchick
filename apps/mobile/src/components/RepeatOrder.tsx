import { useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { TestOrder } from '@pickchick/test-order-flow/contracts';
import type { ScreenProps } from '../model';
import { cartTotal, money, selectionDescription } from '../domain';
import { mergeCartLines, repeatOrderPlan } from '../cart-actions';
import { ProductPhoto, productPhoto } from './ProductPhoto';
import { colors } from '../theme';
import { Body, Button, Caption, CloseButton, Heading, Notice, Row } from './UI';
import { MotionModal } from './Motion';
import { OrderSheet } from './OrderSheet';
import { orderUI } from './OrderPresentation';

export function RepeatOrder({ order, props }: { order: TestOrder; props: ScreenProps }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const submitted = useRef(false);
  const insets = useSafeAreaInsets();
  const plan = repeatOrderPlan(order, props.model.products);
  const sameBranch = props.preview || order.branch_id === props.model.branch?.id;
  const online =
    props.preview ||
    (props.model.connection.status === 'online' && props.model.catalogMode === 'server');
  const limit = !mergeCartLines(props.model.cart, plan.lines, props.model.products);
  const blocked = !sameBranch || !online || !plan.lines.length || limit;
  return (
    <>
      <Button
        secondary
        icon="refresh-outline"
        title="Повторить заказ"
        testID={`repeat-order-${order.order_id}`}
        onPress={() => {
          submitted.current = false;
          setError('');
          setOpen(true);
        }}
      />
      <MotionModal
        visible={open}
        transparent
        animationType="none"
        onRequestClose={() => setOpen(false)}
      >
        {open ? (
          <OrderSheet name="Повторить заказ" productHeight onClose={() => setOpen(false)}>
            {(close) => (
              <View
                style={{
                  flex: 1,
                  padding: 20,
                  gap: 16,
                  paddingBottom: Math.max(20, insets.bottom),
                }}
              >
                <Row>
                  <CloseButton label="Закрыть повтор заказа" onPress={close} />
                  <Heading small style={{ flex: 1 }}>
                    Повторить заказ №{order.number}
                  </Heading>
                </Row>
                <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 12 }}>
                  <Body muted>
                    Проверьте состав и актуальную сумму. Оформление будет следующим шагом.
                  </Body>
                  {props.model.cart.length ? (
                    <Caption>Добавим к тому, что уже в корзине.</Caption>
                  ) : null}
                  {!sameBranch ? (
                    <Notice warning>Этот заказ из другой точки. Сначала выберите её в меню.</Notice>
                  ) : !online ? (
                    <Notice warning>
                      Для проверки меню нужен интернет. Обновите меню и попробуйте снова.
                    </Notice>
                  ) : null}
                  {plan.changes.map((c, i) => (
                    <Notice key={i} warning title={c.name}>
                      {c.reason}
                      {c.before && c.after ? `: ${money(c.before)} → ${money(c.after)}` : ''}
                    </Notice>
                  ))}
                  {plan.lines.map((line, i) => (
                    <Row key={i} style={{ alignItems: 'flex-start', gap: 12 }}>
                      <ProductPhoto
                        photo={productPhoto(line.product, 'thumb', 'menu')}
                        contentFit="contain"
                        style={{
                          width: 80,
                          height: 80,
                          borderRadius: 14,
                          backgroundColor: '#FFF8EE',
                        }}
                      />
                      <View style={{ flex: 1, gap: 4 }}>
                        <Body style={orderUI.label}>
                          {line.product.name} ×{line.quantity}
                        </Body>
                        {selectionDescription(line) ? (
                          <Caption>{selectionDescription(line)}</Caption>
                        ) : null}
                        <Body>{money(cartTotal([line]))}</Body>
                      </View>
                    </Row>
                  ))}
                  {!plan.lines.length ? (
                    <>
                      <Body>Нет позиций, которые можно повторить с прежним составом.</Body>
                      <Button
                        secondary
                        title="Выбрать блюда в меню"
                        onPress={() => {
                          setOpen(false);
                          props.navigate('M06');
                        }}
                      />
                    </>
                  ) : null}
                  {limit ? (
                    <Notice warning>
                      Не помещается в корзину: максимум 11 вариантов и 20 одинаковых позиций.
                      Сначала измените корзину.
                    </Notice>
                  ) : null}
                </ScrollView>
                {error ? <Notice warning>{error}</Notice> : null}
                <Button
                  title={
                    plan.lines.length
                      ? `Добавить в корзину · ${money(cartTotal(plan.lines))}`
                      : 'Нет доступных позиций'
                  }
                  testID="repeat-order-confirm"
                  disabled={blocked}
                  style={orderUI.action}
                  textStyle={orderUI.actionText}
                  onPress={() => {
                    if (submitted.current || blocked) return;
                    submitted.current = true;
                    if (!props.model.appendCartLines(plan.lines)) {
                      submitted.current = false;
                      setError('Корзина или меню изменились. Проверьте состав и попробуйте снова.');
                      return;
                    }
                    setOpen(false);
                    props.navigate('M09');
                  }}
                />
                <Caption style={{ textAlign: 'center', color: colors.muted }}>
                  Ничего не оплачивается автоматически
                </Caption>
              </View>
            )}
          </OrderSheet>
        ) : null}
      </MotionModal>
    </>
  );
}
