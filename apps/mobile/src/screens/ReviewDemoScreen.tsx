import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Body, Button, Caption, Heading, Row } from '../components/UI';
import { t, useLocale } from '../i18n';
import { useMobile } from '../store';
import { lineUnitPrice, money, selectionDescription } from '../domain';
import { OrderStatusView } from './OrderStatusScreen';
import type { ScreenProps } from '../model';
import { colors } from '../theme';
import {
  REVIEW_DEMO_KEY,
  createDemoOrder,
  parseDemoOrder,
  advanceDemoOrder,
  type DemoOrder,
  type DemoAction,
} from '../review-demo';

/** Public, labelled tutorial. It never calls commerce or changes the real basket. */
export default function ReviewDemoScreen() {
  useLocale();
  const router = useRouter(),
    insets = useSafeAreaInsets(),
    model = useMobile();
  const [order, setOrder] = useState<DemoOrder | null>(null);
  const [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    let live = true;
    AsyncStorage.getItem(REVIEW_DEMO_KEY)
      .then(parseDemoOrder)
      .then((value) => {
        if (live) setOrder(value);
      })
      .catch(() => {
        if (live) setError(true);
      })
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, []);
  const save = async (next: DemoOrder | null) => {
    if (lock.current || !loaded) return;
    lock.current = true;
    setBusy(true);
    setError(false);
    try {
      if (next) await AsyncStorage.setItem(REVIEW_DEMO_KEY, JSON.stringify(next));
      else await AsyncStorage.removeItem(REVIEW_DEMO_KEY);
      setOrder(next);
    } catch {
      setError(true);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const start = () => {
    try {
      const lines = model.cart.map((line) => ({
        name: line.product.name,
        quantity: line.quantity,
        productId: line.product.id,
        description: selectionDescription(line),
        totalMinor: (BigInt(lineUnitPrice(line)) * BigInt(line.quantity)).toString(),
      }));
      void save(createDemoOrder(lines, model.diningMode));
    } catch {
      setError(true);
    }
  };
  const advance = (action: DemoAction) => {
    if (order) void save(advanceDemoOrder(order, action));
  };
  const back = () => (router.canGoBack() ? router.back() : router.replace('/profile'));
  const notice = (
    <View style={s.notice}>
      <Body>{t('Демонстрация - без оплаты')}</Body>
      <Caption>{t('Деньги не списываются. Заказ не поступает в ресторан.')}</Caption>
    </View>
  );
  if (order && ['preparing', 'ready', 'fulfilled'].includes(order.stage)) {
    const props: ScreenProps = {
      model,
      screenId: 'M17',
      goBack: back,
      preview: true,
      inSheet: true,
      navigate: () => router.push('/profile'),
    };
    return (
      <View style={[s.root, { paddingTop: insets.top }]} testID="review-demo">
        {notice}
        <OrderStatusView
          props={props}
          order={{
            order_id: 'demonstration-local',
            number: 'DEMO-1',
            branch_id: model.branch?.id ?? '',
            state: order.stage as 'preparing' | 'ready' | 'fulfilled',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            cancellation_reason: null,
            tasks: [{ station: 'prep', state: order.stage === 'preparing' ? 'pending' : 'done' }],
            snapshot: {
              service_mode: order.serviceMode,
              total_minor: order.totalMinor,
              lines: order.lines.map((line, i) => ({
                id: line.productId ?? String(i),
                line_id: String(i),
                name: line.name,
                description: line.description,
                quantity: line.quantity,
                line_total_minor: line.totalMinor,
              })),
            },
          }}
          receipt={{
            caption: t('Сумма только для примера. Банковского счёта и фискального чека нет.'),
          }}
          afterItems={
            <View style={s.actions}>
              {order.stage === 'preparing' ? (
                <Button
                  title={t('Показать готовый заказ')}
                  testID="demo-ready"
                  disabled={busy}
                  onPress={() => advance('ready')}
                />
              ) : null}
              {order.stage === 'ready' ? (
                <Button
                  title={t('Показать выдачу')}
                  testID="demo-collect"
                  disabled={busy}
                  onPress={() => advance('collect')}
                />
              ) : null}
              {order.stage === 'fulfilled' ? (
                <Body>{t('Демонстрация завершена. Покупка, чек и бонусы не создавались.')}</Body>
              ) : null}
              {error ? (
                <Body>{t('Не удалось сохранить демонстрацию. Попробуйте ещё раз.')}</Body>
              ) : null}
              <Button
                title={t('Начать демонстрацию заново')}
                secondary
                testID="demo-reset"
                disabled={busy}
                onPress={() => void save(null)}
              />
              <Button title={t('Закрыть демонстрацию')} secondary onPress={back} />
            </View>
          }
        />
      </View>
    );
  }
  return (
    <View style={[s.root, { paddingTop: insets.top }]} testID="review-demo">
      {notice}
      <ScrollView contentContainerStyle={[s.content, { paddingBottom: insets.bottom + 24 }]}>
        <Heading>{t('Как проходит заказ')}</Heading>
        {!loaded ? <Body>{t('Загрузка')}</Body> : null}
        {error ? (
          <View accessibilityRole="alert">
            <Body>{t('Не удалось сохранить демонстрацию. Попробуйте ещё раз.')}</Body>
          </View>
        ) : null}
        {loaded && !order ? (
          <>
            <Body>
              {t(
                'Добавьте блюда в корзину. Здесь можно пройти учебный заказ с этим составом. Настоящая корзина сохранится.',
              )}
            </Body>
            <Button
              title={t('Начать демонстрацию')}
              testID="demo-start"
              disabled={busy || !model.cart.length}
              onPress={start}
            />
            <Button
              title={t('Перейти в меню')}
              secondary
              onPress={() => router.replace('/(tabs)/menu')}
            />
          </>
        ) : null}
        {order ? (
          <>
            <Caption>{t('Учебный заказ DEMO-1')}</Caption>
            <Heading small>
              {t(order.stage === 'payment' ? 'Демонстрация оплаты' : 'Демонстрация отказа')}
            </Heading>
            <Body>{t(order.serviceMode === 'takeaway' ? 'С собой' : 'В зале')}</Body>
            {order.lines.map((line, i) => (
              <Row key={i}>
                <Body style={s.line}>
                  {line.name} ×{line.quantity}
                </Body>
                <Body>{money(line.totalMinor)}</Body>
              </Row>
            ))}
            <Heading small>{money(order.totalMinor)}</Heading>
            <Caption>
              {t('Сумма только для примера. Банковского счёта и фискального чека нет.')}
            </Caption>
            {order.stage === 'payment' ? (
              <>
                <Body>
                  {t(
                    'В настоящем заказе результат подтверждает банк. Здесь выберите учебный результат сами.',
                  )}
                </Body>
                <Button
                  title={t('Показать успешную оплату')}
                  testID="demo-approve"
                  disabled={busy}
                  onPress={() => advance('approve')}
                />
                <Button
                  title={t('Показать отказ оплаты')}
                  testID="demo-decline"
                  secondary
                  disabled={busy}
                  onPress={() => advance('decline')}
                />
              </>
            ) : (
              <>
                <Body>
                  {t('Учебная оплата отклонена. Можно повторить или вернуться в корзину.')}
                </Body>
                <Button
                  title={t('Повторить')}
                  testID="demo-retry"
                  disabled={busy}
                  onPress={() => advance('retry')}
                />
              </>
            )}
            <Button
              title={t('Начать демонстрацию заново')}
              secondary
              testID="demo-reset"
              disabled={busy}
              onPress={() => void save(null)}
            />
          </>
        ) : null}
        <Button title={t('Закрыть демонстрацию')} secondary onPress={back} />
      </ScrollView>
    </View>
  );
}
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  notice: { padding: 16, gap: 4, backgroundColor: colors.surface },
  content: { padding: 20, gap: 18, maxWidth: 680, width: '100%', alignSelf: 'center' },
  line: { flex: 1 },
  actions: { gap: 16 },
});
