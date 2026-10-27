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

/** A method marked «скоро» (or unknown) never replaces the selected one. */
export function chooseCartPaymentMethod(
  current: CartPaymentMethodId,
  next: string,
  platform: string,
): CartPaymentMethodId {
  const method = cartPaymentMethods(platform).find((item) => item.id === next);
  return method?.available ? method.id : current;
}

/** Main footer action text. A gift-only order (total 0) keeps its existing wording. */
export function cartPayTitle({ busy, totalMinor }: { busy: boolean; totalMinor: string }) {
  if (busy) return 'Оформляем заказ…';
  return totalMinor === '0' ? 'Заказать подарок' : 'Оплатить с';
}
