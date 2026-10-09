import { copy, type Locale } from './i18n';
/**
 * Checkout strings from the approved iPad v3 design (prototype `T` table).
 * Wording that the shared `i18n.ts` table already carries (Kaspi chip, Kaspi QR
 * steps, "to pay", bank card) is taken from it, so there is one source per
 * string; only the design-specific extras (short payment title, "soon", the
 * cart's inline upsell) live here. An unknown locale falls back to Russian.
 */
const table = {
  ru: {
    payment: 'Оплата',
    soon: 'Скоро',
    moreUp: 'С этим часто берут',
    added: 'Добавлен',
  },
  kk: {
    payment: 'Төлем',
    soon: 'Жақында',
    moreUp: 'Мұны жиі бірге алады',
    added: 'Қосылды',
  },
  en: {
    payment: 'Payment',
    soon: 'Soon',
    moreUp: 'Often ordered with this',
    added: 'Added',
  },
} as const;
type Extras = (typeof table)['ru'] | (typeof table)['kk'] | (typeof table)['en'];
export type CheckoutCopy = Extras & {
  payWithKaspi: string;
  toPay: string;
  kaspiSteps: readonly [string, string, string];
  card: string;
};
export const checkoutCopy = (locale: string): CheckoutCopy => {
  const known: Locale = locale === 'kk' || locale === 'en' ? locale : 'ru';
  const t = copy(known);
  return {
    ...table[known],
    payWithKaspi: t.payKaspiQR,
    toPay: t.toPay,
    kaspiSteps: [t.qrStep1, t.qrStep2, t.qrStep3],
    card: t.card,
  };
};
