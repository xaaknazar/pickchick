import type { OrderStatusData } from './order-status';
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
    detail: 'Подождите немного. Можно закрыть этот экран - заказ сохранён.',
    step: 1,
  },
  awaiting_payment: {
    title: 'Счёт отправлен в Kaspi',
    detail: 'Откройте Kaspi.kz и оплатите счёт от PickChick. После оплаты вернитесь сюда.',
    step: 1,
  },
  checking: {
    title: 'Уточняем оплату',
    detail: 'Ответ банка задерживается. Не оплачивайте повторно - проверим этот же счёт.',
    step: 1,
  },
  failed: {
    title: 'Счёт не оплачен',
    detail:
      'Банк завершил эту попытку без оплаты. Корзина сохранена. Если деньги списались, обратитесь в ресторан.',
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
    detail: 'Нужна проверка ресторана. Заказ и платёж сохранены, повторно оплачивать не нужно.',
    step: 1,
  },
};
export const paymentReceived = (phase: CustomerCommerceOrder['phase']) =>
  ['paid', 'preparing', 'ready', 'handed_over'].includes(phase);
export function checkoutError(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  if (code === 'CATALOG_UPGRADE_REQUIRED')
    return 'Обновите приложение, чтобы получить актуальное меню и цены ресторана.';
  if (code === 'RESTAURANT_CLOSED')
    return 'Ресторан сейчас закрыт. Попробуйте оформить заказ в часы работы.';
  if (code === 'ITEM_STOPPED')
    return 'Блюдо или выбранный вариант закончились. Вернитесь в корзину и измените заказ.';
  if (code === 'AVAILABILITY_STALE')
    return 'Нет свежих данных от ресторана. Счёт не выставлен. Попробуйте чуть позже.';
  if (code === 'CHECKOUT_STORAGE')
    return 'Не удалось сохранить оформление на устройстве. Счёт не отправлен. Освободите место и попробуйте снова.';
  if (['CONFLICT', 'QUOTE_EXPIRED'].includes(code))
    return 'Меню или цена изменились. Вернитесь в корзину и проверьте заказ.';
  if (code === 'FORBIDDEN')
    return 'Оплата Kaspi ещё не открыта для вашего аккаунта. Корзина сохранена - можно вернуться к ней позже.';
  if (code === 'NOT_READY')
    return 'Ресторан пока не готов принимать оплату Kaspi. Корзина сохранена - попробуйте позже.';
  if (code === 'UNAUTHORIZED') return 'Войдите в аккаунт снова, чтобы продолжить свой заказ.';
  return 'Связь прервалась. Заказ сохранён - повторно оплачивать не нужно.';
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
