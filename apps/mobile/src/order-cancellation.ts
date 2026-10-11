type CancellableOrder = { state: string; payment_state: string };

/**
 * Owner decision 2026-10-11: the customer cannot cancel a paid order.
 * Only an unpaid, unfinished order with a known payment result offers cancellation;
 * the server enforces the same rule.
 */
export const customerCanCancel = (order: CancellableOrder) =>
  !['fulfilled', 'cancelled'].includes(order.state) &&
  !['simulated_approved', 'simulated_unknown'].includes(order.payment_state);

export const PAID_CANCEL_NOTICE =
  'Оплаченный заказ нельзя отменить в приложении. Если что-то не так, напишите в поддержку.';
