/**
 * Cart footer payment methods (owner 27.10.2026, Drinkit-style «Способ оплаты»).
 * Only Kaspi.kz pays today. Apple Pay / Google Pay and bank cards are shown as «скоро»: they
 * cannot be selected and never collect card data.
 */
export type CartPaymentMethodId = 'kaspi' | 'apple_pay' | 'google_pay' | 'card';
export type CartPaymentMethod = {
  id: CartPaymentMethodId;
  /** Brand names stay as is; «Банковская карта» goes through t(). */
  label: string;
  available: boolean;
};

export function cartPaymentMethods(platform: string): CartPaymentMethod[] {
  return [
    { id: 'kaspi', label: 'Kaspi.kz', available: true },
    platform === 'android'
      ? { id: 'google_pay', label: 'Google Pay', available: false }
      : { id: 'apple_pay', label: 'Apple Pay', available: false },
    { id: 'card', label: 'Банковская карта', available: false },
  ];
}

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
