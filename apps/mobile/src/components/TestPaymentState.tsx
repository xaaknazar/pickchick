import { ActivityIndicator, ScrollView, StyleSheet } from 'react-native';
import type { CustomerTestPayment } from '@pickchick/contracts';
import { Body, Button, Caption, Heading } from './UI';
import { PaymentMark, paymentName } from './PaymentChoice';
import { colors } from '../theme';
import { money } from '../domain';

export function TestPaymentState({
  payment,
  error,
  onClose,
  onRetry,
  onFinish,
  onOpen,
}: {
  payment?: CustomerTestPayment | null;
  error?: string;
  onClose(): void;
  onRetry(): void;
  onFinish(): void;
  onOpen?(): void;
}) {
  const pending = !payment || payment.state === 'pending';
  return (
    <ScrollView style={s.scroll} contentContainerStyle={s.root} testID="test-payment-state">
      <Heading>
        {payment?.state === 'paid'
          ? 'Тестовая оплата прошла'
          : payment?.state === 'failed'
            ? 'Тестовая оплата не прошла'
            : payment?.state === 'expired'
              ? 'Время тестовой оплаты истекло'
              : 'Тестовая оплата'}
      </Heading>
      <Body testID="test-payment-disclaimer">Тестовая оплата - деньги не спишутся</Body>
      {payment ? (
        <>
          <PaymentMark method={payment.method} size={48} />
          <Body>
            {paymentName(payment.method)} · {money(payment.amountMinor)}
          </Body>
        </>
      ) : null}
      {pending ? <ActivityIndicator color={colors.action} /> : null}
      <Caption>
        {pending
          ? 'Завершите тест на защищённой странице и вернитесь в приложение. Результат проверяет сервер.'
          : 'Это проверка оплаты. Заказ не создан и на кухню не отправлен. Корзина сохранена.'}
      </Caption>
      {error ? (
        <>
          <Caption accessibilityRole="alert">{error}</Caption>
          <Button title="Проверить тестовую оплату" secondary onPress={onRetry} />
        </>
      ) : null}
      {pending && onOpen ? <Button title="Открыть тестовую страницу" onPress={onOpen} /> : null}
      {pending ? (
        <Button title="Закрыть" secondary onPress={onClose} />
      ) : (
        <Button title="Вернуться к оформлению" onPress={onFinish} />
      )}
    </ScrollView>
  );
}
const s = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.background },
  root: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 20,
    padding: 24,
    backgroundColor: colors.background,
  },
});
