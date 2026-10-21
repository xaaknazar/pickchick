import type { CustomerCommerceOrder } from '@pickchick/contracts';
import type { Product } from '../model';
import { commerceStatus } from '../commerce-presentation';
import { orderScene } from '../order-status';
import {
  commerceActiveKind,
  latestUnratedOrderId,
  progressStage,
  type OrderLineView,
} from '../orders-tab';
import {
  HistoryOrderRow,
  OrdersOverview,
  type ActiveOrderModel,
  type HistoryOrderModel,
} from './OrdersTab';

export type OrderHistoryCardProps = {
  order: CustomerCommerceOrder;
  products: Product[];
  onOpen(): void;
  onRate?: (initialStars?: number) => void;
  savedRating?: number | null;
  /** Shows «Как вам заказ?»; the list grants it to one order only. */
  askRating?: boolean;
};

const lines = (order: CustomerCommerceOrder): OrderLineView[] =>
  order.items.map((item) => ({
    productId: item.productId,
    title: item.title,
    quantity: item.quantity,
  }));

// Copy for unpaid orders, from the same facts the Kaspi payment screen shows.
const paymentNote: Partial<Record<CustomerCommerceOrder['phase'], string>> = {
  awaiting_restaurant: 'связываемся с рестораном',
  ready_to_pay: 'счёт ещё не отправлен',
  sending: 'отправляем счёт',
  awaiting_payment: 'счёт в Kaspi',
  checking: 'уточняем оплату',
};

/** «Сейчас» card of a bank-paid or unpaid order; null once it belongs to history. */
export function commerceActiveModel(
  order: CustomerCommerceOrder,
  onOpen: () => void,
): ActiveOrderModel | null {
  const kind = commerceActiveKind(order.phase);
  if (!kind) return null;
  const stage = progressStage(
    order.phase === 'paid' ? 'paid' : order.kitchenStage === 'assembly' ? 'assembly' : 'cooking',
  );
  return {
    id: order.orderId,
    kind,
    number: order.displayNumber,
    // Same scene mapping as the tracker; unpaid orders show their photos instead.
    scene: kind === 'payment' ? 'cooking' : orderScene(commerceStatus(order)),
    badge:
      kind === 'ready'
        ? 'Готов'
        : kind === 'payment'
          ? order.phase === 'checking'
            ? 'Уточняем оплату'
            : 'Ждём оплату'
          : stage.badge,
    bars: stage.bars,
    serviceMode: order.serviceMode,
    items: lines(order),
    totalMinor: order.totalMinor,
    place: `${order.restaurant} · Kaspi`,
    paymentMethod: 'Kaspi',
    paymentNote: paymentNote[order.phase],
    expiresAt: order.phase === 'awaiting_payment' ? order.expiresAt : null,
    testID: `order-history-${order.orderId}`,
    openTestID: `order-history-open-${order.orderId}`,
    onOpen,
    // The existing Kaspi continuation; an ambiguous bank result never offers payment again.
    onPay: kind === 'payment' && order.phase !== 'checking' ? onOpen : undefined,
    payTestID: `order-history-pay-${order.orderId}`,
  };
}

/** History row of a finished order: handed over, unpaid or under review by the restaurant. */
export function commerceHistoryModel({
  order,
  onOpen,
  onRate,
  savedRating,
  askRating,
}: Omit<OrderHistoryCardProps, 'products'>): HistoryOrderModel {
  const rating = savedRating && savedRating >= 1 && savedRating <= 5 ? savedRating : null;
  return {
    id: order.orderId,
    number: order.displayNumber,
    createdAt: order.createdAt,
    serviceMode: order.serviceMode,
    items: lines(order),
    totalMinor: order.totalMinor,
    // No refund state reaches the app: a refund or kitchen cancellation is shown as «attention».
    status: order.phase === 'failed' ? 'cancelled' : order.phase === 'attention' ? 'note' : 'done',
    statusText:
      order.phase === 'failed'
        ? 'Счёт не оплачен'
        : order.phase === 'attention'
          ? 'Проверяем заказ'
          : undefined,
    rating: order.phase === 'handed_over' ? rating : null,
    testID: `order-history-${order.orderId}`,
    openTestID: `order-history-open-${order.orderId}`,
    openLabel: 'Подробнее о заказе',
    onOpen,
    rate:
      askRating && onRate && order.phase === 'handed_over'
        ? {
            onRate: (stars) => onRate(stars),
            testID: (stars) => `order-history-rate-${order.orderId}-${stars}`,
          }
        : null,
  };
}

/** One history row of a commerce order. Historical facts stay separate from the menu. */
export function OrderHistoryCard({ products, ...props }: OrderHistoryCardProps) {
  return <HistoryOrderRow model={commerceHistoryModel(props)} products={products} first />;
}

/** The Kaspi orders list: «Сейчас» cards, then history grouped by Almaty day. */
export function CommerceOrderList({
  orders,
  products,
  ratings,
  onOpen,
  onRate,
}: {
  orders: CustomerCommerceOrder[];
  products: Product[];
  ratings: Record<string, { rating: number } | undefined>;
  onOpen(order: CustomerCommerceOrder): void;
  onRate(order: CustomerCommerceOrder, stars?: number): void;
}) {
  const active = orders.flatMap((order) => {
    const model = commerceActiveModel(order, () => onOpen(order));
    return model ? [model] : [];
  });
  const finished = orders.filter((order) => !commerceActiveKind(order.phase));
  const askId = latestUnratedOrderId(
    finished.map((order) => ({
      id: order.orderId,
      createdAt: order.createdAt,
      rateable: order.phase === 'handed_over',
      rated: !!ratings[order.orderId],
    })),
  );
  const history = finished.map((order) =>
    commerceHistoryModel({
      order,
      onOpen: () => onOpen(order),
      onRate: (stars) => onRate(order, stars),
      savedRating: ratings[order.orderId]?.rating,
      askRating: order.orderId === askId,
    }),
  );
  return <OrdersOverview active={active} history={history} products={products} />;
}
