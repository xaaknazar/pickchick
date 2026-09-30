/** Read-only display data shared by TEST and bank-paid orders. No payment authority. */
export interface OrderStatusData {
  order_id: string;
  number: string | null;
  branch_id: string;
  restaurant?: string;
  state: 'awaiting_test_payment' | 'paid' | 'preparing' | 'ready' | 'fulfilled' | 'cancelled';
  created_at: string;
  updated_at: string;
  cancellation_reason: string | null;
  tasks: { station: string; state: string }[];
  snapshot: {
    service_mode: 'takeaway' | 'dine_in';
    total_minor: string;
    lines: {
      id: string;
      line_id?: string;
      name: string;
      description?: string;
      serving_label?: string;
      quantity: number;
      line_total_minor: string;
      selections?: { option_label: string; quantity: number }[];
    }[];
  };
}

export function orderStage(order: OrderStatusData): string {
  if (
    order.state === 'preparing' &&
    order.tasks.length > 0 &&
    order.tasks.every((task) => task.station !== 'prep' || task.state === 'done')
  )
    return 'На сборке';
  return {
    awaiting_test_payment: 'Ждёт подтверждения',
    paid: 'Оплата получена',
    preparing: 'Готовится',
    ready: 'Можно забирать',
    fulfilled: 'Выдан',
    cancelled: 'Отменён',
  }[order.state];
}

/** Elapsed time, never an invented promise or a client-side order transition. */
export function orderTimeLabel(order: OrderStatusData, now: number): string {
  if (order.state === 'cancelled') return 'Заказ отменён';
  if (order.state === 'paid') return 'Передаём заказ кухне';
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

export type OrderScene = 'cooking' | 'assembly' | 'ready' | 'ready-takeaway';
export function orderScene(order: OrderStatusData): OrderScene {
  if (order.state === 'ready' || order.state === 'fulfilled')
    return order.snapshot.service_mode === 'takeaway' ? 'ready-takeaway' : 'ready';
  return orderStage(order) === 'На сборке' ? 'assembly' : 'cooking';
}
