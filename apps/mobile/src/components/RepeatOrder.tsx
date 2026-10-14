import { t, localize, useLocale } from '../i18n';
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
import { RepeatLink } from './OrdersTab';

export function RepeatOrder({
  order,
  props,
  variant = 'button',
}: {
  order: TestOrder;
  props: ScreenProps;
  /** `link`: compact «↻ Повторить» for the orders list; the flow below is the same. */
  variant?: 'button' | 'link';
}) {
  useLocale();
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
  const start = () => {
    submitted.current = false;
    setError('');
    setOpen(true);
  };
  return (
    <>
      {variant === 'link' ? (
        <RepeatLink
          onPress={start}
          testID={`repeat-order-${order.order_id}`}
          number={order.number}
        />
      ) : (
        <Button
          secondary
          icon="refresh-outline"
          title={t('Повторить заказ')}
          testID={`repeat-order-${order.order_id}`}
          onPress={start}
        />
      )}
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
                  <CloseButton label={t('Закрыть повтор заказа')} onPress={close} />
                  <Heading small style={{ flex: 1 }}>
                    {t('Повторить заказ №')}
                    {localize(order.number)}
                  </Heading>
                </Row>
                <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 12 }}>
                  <Body muted>
                    {t('Проверьте состав и актуальную сумму. Оформление будет следующим шагом.')}
                  </Body>
                  {props.model.cart.length ? (
                    <Caption>{t('Добавим к тому, что уже в корзине.')}</Caption>
                  ) : null}
                  {!sameBranch ? (
                    <Notice warning>
                      {t('Этот заказ из другой точки. Сначала выберите её в меню.')}
                    </Notice>
                  ) : !online ? (
                    <Notice warning>
                      {t('Для проверки меню нужен интернет. Обновите меню и попробуйте снова.')}
                    </Notice>
                  ) : null}
                  {plan.changes.map((c, i) => (
                    <Notice key={i} warning title={localize(c.name)}>
                      {localize(c.reason)}
                      {localize(
                        c.before && c.after ? `: ${money(c.before)} → ${money(c.after)}` : '',
                      )}
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
                          {localize(line.product.name)} ×{localize(line.quantity)}
                        </Body>
                        {selectionDescription(line) ? (
                          <Caption>{localize(selectionDescription(line))}</Caption>
                        ) : null}
                        <Body>{localize(money(cartTotal([line])))}</Body>
                      </View>
                    </Row>
                  ))}
                  {!plan.lines.length ? (
                    <>
                      <Body>{t('Нет позиций, которые можно повторить с прежним составом.')}</Body>
                      <Button
                        secondary
                        title={t('Выбрать блюда в меню')}
                        onPress={() => {
                          setOpen(false);
                          props.navigate('M06');
                        }}
                      />
                    </>
                  ) : null}
                  {limit ? (
                    <Notice warning>
                      {t(
                        'Не помещается в корзину: максимум 11 вариантов и 20 одинаковых позиций. Сначала измените корзину.',
                      )}
                    </Notice>
                  ) : null}
                </ScrollView>
                {error ? <Notice warning>{localize(error)}</Notice> : null}
                <Button
                  title={localize(
                    plan.lines.length
                      ? t('Добавить в корзину · {p0}', { p0: money(cartTotal(plan.lines)) })
                      : 'Нет доступных позиций',
                  )}
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
                  {t('Ничего не оплачивается автоматически')}
                </Caption>
              </View>
            )}
          </OrderSheet>
        ) : null}
      </MotionModal>
    </>
  );
}
