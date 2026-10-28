import type { CustomerCommerceOrder } from '@pickchick/contracts';
import { draftCanAutoSend, draftIsFinal } from './checkout-resume.ts';
import { pendingPaymentClosed, type PendingPayment } from './payment-recovery.ts';

/**
 * Owner 28.10.2026 (TestFlight 26): «закрыли оплату, закрыли приложение, обратно заходим - сразу
 * выходит окно "Отправляется счёт"». The app always opens on the menu. A payment saved by an
 * earlier run never takes over the screen; this decides what the start does with it instead:
 * remove it when nothing is left for it to do, or offer a small banner on the menu while the
 * bank may still act and the customer did not close it.
 */
type Order = Pick<CustomerCommerceOrder, 'phase' | 'createdAt' | 'updatedAt' | 'expiresAt'> & {
  orderId: string;
};

/** The banner's wording follows the order (never «Отправляем счёт» at start). */
export type PaymentResumeKind = 'kaspi' | 'checking' | 'unfinished';

export const PAYMENT_RESUME_TITLE: Record<PaymentResumeKind, string> = {
  kaspi: 'Заказ ждёт оплаты в Kaspi',
  checking: 'Проверяем оплату заказа',
  unfinished: 'Оплата заказа не завершена',
};

export type PaymentLaunch = {
  /** Nothing is left for the saved intent: paid, failed, attention, an old unbilled order. */
  remove: boolean;
  /** The banner on the menu, or null (closed, final, not read yet). */
  banner: PaymentResumeKind | null;
  /** The intent's order needs a read (GET) before anything can be decided. */
  read: boolean;
};

const nothing: PaymentLaunch = { remove: false, banner: null, read: false };

/**
 * `order`: the intent's order as just read (GET, read only), undefined when it has none or the
 * read failed. An unread order keeps the intent as it is and shows nothing: the next start, the
 * next return to the app or the next pay tap reads it again.
 */
export function paymentLaunch(
  draft: PendingPayment | null,
  order: Order | undefined,
  now: number,
): PaymentLaunch {
  if (!draft) return nothing;
  if (!draft.orderId) {
    // The create command never answered: nothing was billed. An old (or closed) one is dropped,
    // as the cart and the checkout drop it; a fresh one (a tap a few minutes ago) is offered.
    if (!draftCanAutoSend(draft, now)) return { remove: true, banner: null, read: false };
    return { ...nothing, banner: pendingPaymentClosed(draft) ? null : 'unfinished' };
  }
  if (!order || order.orderId !== draft.orderId) return { ...nothing, read: true };
  if (draftIsFinal(order, draft, now)) return { remove: true, banner: null, read: false };
  if (pendingPaymentClosed(draft)) return nothing;
  return {
    ...nothing,
    banner:
      order.phase === 'awaiting_payment'
        ? 'kaspi'
        : order.phase === 'sending' || order.phase === 'checking'
          ? 'checking'
          : 'unfinished',
  };
}
