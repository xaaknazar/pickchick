import type { TestOrder } from '@pickchick/test-order-flow/contracts';

export function orderStage(order: TestOrder): string {
  if (
    order.state === 'preparing' &&
    order.tasks.length > 0 &&
    order.tasks.every((task) => task.station !== 'prep' || task.state === 'done')
  )
    return 'На сборке';
  return {
    awaiting_test_payment: 'Ждёт подтверждения',
    preparing: 'Готовится',
    ready: 'Можно забирать',
    fulfilled: 'Выдан',
    cancelled: 'Отменён',
  }[order.state];
}

/** Elapsed time, never an invented promise or a client-side order transition. */
export function orderTimeLabel(order: TestOrder, now: number): string {
  if (order.state === 'cancelled') return 'Заказ отменён';
  if (order.state === 'awaiting_test_payment') return 'Ожидаем подтверждения';
  if (order.state === 'ready' || order.state === 'fulfilled') {
    const time = new Date(order.updated_at).toLocaleTimeString('ru-RU', {
      timeZone: 'Asia/Almaty',
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${order.state === 'ready' ? 'Готов к выдаче' : 'Выдан'} в ${time}`;
  }
  const minutes = Math.max(0, Math.floor((now - Date.parse(order.created_at)) / 60_000));
  return minutes < 1 ? 'Заказ только что принят' : `С момента заказа: ${minutes} мин`;
}
