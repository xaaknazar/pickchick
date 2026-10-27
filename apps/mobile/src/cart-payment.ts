/**
 * Cart footer payment methods (owner 27.10.2026, Drinkit-style «Способ оплаты»). The list, the
 * customer's last used method and its fallback live in payment-method.ts (item 6b).
 */
export {
  paymentMethods as cartPaymentMethods,
  type PaymentMethodId as CartPaymentMethodId,
  type PaymentMethodOption as CartPaymentMethod,
} from './payment-method.ts';

/**
 * The Kaspi pay action. {p0} marks where the Kaspi.kz mark and name stand, so each language keeps
 * its own word order: «Оплатить с [Kaspi.kz]», «[Kaspi.kz] арқылы төлеу», «Pay with [Kaspi.kz]».
 */
export const KASPI_PAY = 'Оплатить с {p0}';

/** Main footer action text. A gift-only order (total 0) keeps its existing wording. */
export function cartPayTitle({ busy, totalMinor }: { busy: boolean; totalMinor: string }) {
  if (busy) return 'Оформляем заказ…';
  return totalMinor === '0' ? 'Заказать подарок' : KASPI_PAY;
}

/** Text before and after the brand slot of a translated KASPI_PAY template. */
export function brandSlotParts(template: string): { before: string; after: string } {
  const at = template.indexOf('{p0}');
  if (at < 0) return { before: template.trim(), after: '' };
  return { before: template.slice(0, at).trim(), after: template.slice(at + 4).trim() };
}

/**
 * Kaspi cart edits (+/-, «В зале / С собой»), 27.10.2026: the passive session re-read (saved
 * intent in storage, GET /config) waits until the customer stops tapping, so a burst of taps reads
 * once. Opening the cart, returning to it, the checkout route and «Заказы» read at once as before.
 */
export const CART_EDIT_SETTLE_MS = 400;
export function cartEditSettleMs(screenId: string, previous: string | null, next: string): number {
  return screenId === 'M09' && previous !== null && previous !== next ? CART_EDIT_SETTLE_MS : 0;
}
