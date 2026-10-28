import type { OrderStatusData } from './order-status';
import type { PaymentStuck } from './checkout-resume';
import type { CustomerCommerceOrder } from '@pickchick/contracts';
export const paymentCopy: Record<
  CustomerCommerceOrder['phase'],
  { title: string; detail: string; step: number }
> = {
  awaiting_restaurant: {
    title: 'Связываемся с рестораном',
    detail: 'Проверяем, что кухня может принять заказ. Счёт ещё не выставлен.',
    step: 0,
  },
  ready_to_pay: {
    title: 'Ресторан принял заказ',
    detail: 'Можно отправить счёт в Kaspi. Сумма заказа уже зафиксирована.',
    step: 0,
  },
  sending: {
    title: 'Отправляем счёт',
    detail: 'Подождите немного. Отправляем счёт в Kaspi.',
    step: 1,
  },
  awaiting_payment: {
    title: 'Счёт отправлен в Kaspi',
    detail: 'Откройте Kaspi.kz и оплатите счёт от PickChick. После оплаты вернитесь сюда.',
    step: 1,
  },
  checking: {
    title: 'Уточняем оплату',
    detail: 'Ждём подтверждение оплаты от Kaspi.',
    step: 1,
  },
  failed: {
    title: 'Счёт не оплачен',
    detail: 'Банк завершил эту попытку без оплаты. Если деньги списались, обратитесь в ресторан.',
    step: 1,
  },
  paid: {
    title: 'Оплата получена',
    detail: 'Передаём заказ кухне. Статус изменится, когда ресторан подтвердит приготовление.',
    step: 2,
  },
  preparing: {
    title: 'Готовим для вас',
    detail: 'Кухня приняла заказ. Сообщим здесь, когда можно будет забрать.',
    step: 2,
  },
  ready: {
    title: 'Заказ готов',
    detail: 'Подойдите к выдаче и назовите номер заказа. Приятного аппетита!',
    step: 3,
  },
  handed_over: {
    title: 'Заказ у вас',
    detail: 'Спасибо, что выбрали PickChick. Будем ждать снова!',
    step: 3,
  },
  attention: {
    title: 'Проверяем заказ',
    detail:
      'Ресторан проверяет этот заказ: его могли отменить или оформить возврат. Новый заказ можно сделать сразу. Если деньги списались, а заказ не выдан, свяжитесь с поддержкой.',
    step: 1,
  },
};
export const paymentReceived = (phase: CustomerCommerceOrder['phase']) =>
  ['paid', 'preparing', 'ready', 'handed_over'].includes(phase);

/**
 * Owner 28.10.2026 (TestFlight 25): a payment screen stuck for 20 s (checkout-resume.ts
 * paymentStuck) says honestly what is happening instead of «Подождите немного».
 */
export const stuckCopy: Record<PaymentStuck, { title: string; detail: string }> = {
  bank: {
    title: 'Kaspi отвечает дольше обычного',
    detail:
      'Счёт ещё не пришёл в Kaspi. Если он всё же придёт, его можно оплатить - заказ появится в «Заказах».',
  },
  restaurant: {
    title: 'Ресторан не подтверждает заказ',
    detail: 'Ресторан пока не ответил. Счёт не выставлен, деньги не списаны.',
  },
};

/**
 * «Закрыть оплату?» before the X leaves a payment the bank may still act on (closeNeedsConfirm).
 * What the code guarantees (KaspiCheckoutScreen closeOrder / submit): the order is not cancelled
 * at the bank; its intent stays saved without an automatic invoice; while the bank may still act
 * for it, the next «Оплатить» first reopens this same order (submit restores the intent, then
 * GET /orders resumes any order still at the bank) instead of creating a second order and invoice.
 */
export function closePaymentCopy(phase?: CustomerCommerceOrder['phase']) {
  const invoiced = phase === 'awaiting_payment' || phase === 'checking';
  return {
    title: 'Закрыть оплату?',
    detail: invoiced
      ? 'Счёт уже в Kaspi. Если вы его оплатите, заказ появится в «Заказах». Повторная оплата откроет этот же заказ - второй счёт не создаётся.'
      : 'Если счёт всё же придёт в Kaspi и вы его оплатите, заказ появится в «Заказах». Повторная оплата откроет этот же заказ - второй счёт не создаётся.',
    close: 'Закрыть',
    stay: 'Остаться',
  };
}
export function checkoutError(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  if (code === 'CATALOG_UPGRADE_REQUIRED')
    return 'Обновите приложение, чтобы получить актуальное меню и цены ресторана.';
  if (code === 'RESTAURANT_CLOSED')
    return 'Ресторан сейчас закрыт. Попробуйте оформить заказ в часы работы.';
  if (code === 'KITCHEN_OFFLINE')
    return 'Кухня сейчас не на связи - заказ оформить нельзя. Попробуйте чуть позже.';
  if (code === 'ITEM_STOPPED')
    return 'Блюдо или выбранный вариант закончились. Вернитесь в корзину и измените заказ.';
  // NOT_READY on /payment: the restaurant refused to bill this order (audit 2.1).
  if (code === 'ORDER_NOT_ACCEPTED')
    return 'Ресторан не смог принять этот заказ. Счёт не отправлен, деньги не списаны. Проверьте корзину и оформите заказ снова.';
  if (code === 'GIFT_UNAVAILABLE')
    return 'Подарок сейчас недоступен. Вернитесь в корзину, обновите отметки или снимите галочку акции.';
  if (code === 'COMMENT_UNAVAILABLE')
    return 'Комментарий временно недоступен. Удалите его, чтобы оформить заказ.';
  if (code === 'CHECKOUT_STORAGE')
    return 'Не удалось сохранить оформление на устройстве. Счёт не отправлен. Освободите место и попробуйте снова.';
  if (['MENU_CHANGED', 'CONFLICT', 'QUOTE_EXPIRED'].includes(code))
    return 'Цены обновились. Проверьте итоговую сумму перед оплатой';
  if (code === 'INVALID_REQUEST') return 'Не удалось рассчитать заказ. Попробуйте ещё раз.';
  if (code === 'FORBIDDEN') return 'Оплата Kaspi ещё не открыта для вашего аккаунта.';

  if (code === 'UNAUTHORIZED') return 'Войдите в аккаунт снова, чтобы продолжить свой заказ.';
  // Connectivity and temporary restaurant readiness recover in the background.
  return '';
}

/** View adapter only: commercial orders never become synthetic TEST orders. */
export function commerceStatus(order: CustomerCommerceOrder): OrderStatusData {
  if (!paymentReceived(order.phase)) throw new Error('PAYMENT_NOT_CONFIRMED');
  return {
    order_id: order.orderId,
    number: order.displayNumber,
    branch_id: order.branchId,
    restaurant: order.restaurant,
    created_at: order.createdAt,
    updated_at: order.updatedAt,
    state:
      order.phase === 'handed_over'
        ? 'fulfilled'
        : order.phase === 'ready'
          ? 'ready'
          : order.phase === 'preparing'
            ? 'preparing'
            : 'paid',
    cancellation_reason: null,
    tasks: [{ station: 'prep', state: order.kitchenStage === 'assembly' ? 'done' : 'pending' }],
    snapshot: {
      service_mode: order.serviceMode,
      total_minor: order.totalMinor,
      lines: order.items.map((item, i) => ({
        id: item.productId,
        line_id: `${order.orderId}:${i}`,
        name: item.title,
        quantity: item.quantity,
        line_total_minor: item.totalMinor,
        selections: item.modifiers.map((option_label) => ({ option_label, quantity: 1 })),
      })),
    },
  };
}

/** The clock only changes presentation; the bank remains the payment authority. */
export function invoiceSecondsRemaining(expiresAt: string | null, now: number): number | null {
  if (!expiresAt) return null;
  const deadline = Date.parse(expiresAt);
  return Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;
}
