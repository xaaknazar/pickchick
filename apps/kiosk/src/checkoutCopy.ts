/**
 * Checkout strings from the approved iPad v3 design (prototype `T` table) that the
 * shared `i18n.ts` table does not carry yet: the Kaspi payment chip, the Kaspi QR
 * steps, the disabled card option and the cart's inline upsell. Kept apart so the
 * language work in `i18n.ts` can absorb them later without a conflicting copy;
 * an unknown locale falls back to Russian.
 */
const table = {
  ru: {
    payWithKaspi: 'Оплата через Kaspi QR',
    payment: 'Оплата',
    toPay: 'К оплате',
    kaspiSteps: ['Откройте приложение Kaspi.kz', 'Нажмите «Kaspi QR»', 'Наведите камеру на код'],
    card: 'Банковская карта',
    soon: 'Скоро',
    moreUp: 'С этим часто берут',
    added: 'Добавлен',
  },
  kk: {
    payWithKaspi: 'Төлем Kaspi QR',
    payment: 'Төлем',
    toPay: 'Төлеуге',
    kaspiSteps: ['Kaspi.kz қосымшасын ашыңыз', '«Kaspi QR» басыңыз', 'Камераны кодқа бағыттаңыз'],
    card: 'Банк картасы',
    soon: 'Жақында',
    moreUp: 'Мұны жиі бірге алады',
    added: 'Қосылды',
  },
  en: {
    payWithKaspi: 'Pay with Kaspi QR',
    payment: 'Payment',
    toPay: 'To pay',
    kaspiSteps: ['Open the Kaspi.kz app', 'Tap «Kaspi QR»', 'Point the camera at the code'],
    card: 'Bank card',
    soon: 'Soon',
    moreUp: 'Often ordered with this',
    added: 'Added',
  },
} as const;
export type CheckoutCopy = (typeof table)['ru'] | (typeof table)['kk'] | (typeof table)['en'];
export const checkoutCopy = (locale: string): CheckoutCopy =>
  (table as Record<string, CheckoutCopy>)[locale] ?? table.ru;
