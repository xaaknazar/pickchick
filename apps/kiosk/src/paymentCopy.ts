import { copy, type Locale } from './i18n.ts';
/**
 * Kaspi QR payment screen of the kiosk redesign 2026-10-13 (docs/design/kiosk-redesign-2026-10-13/
 * product-and-payment.md §4) and the owner's «Начать заново» decision of the same day. Only the
 * new strings live here; wording the shared table already carries (К оплате, QR действует,
 * Позвать сотрудника, Вернуться к оплате, С собой / В зале, the QR waiting texts) is taken from
 * it, so there is one source per string (the module stays importable by the node tests, hence
 * the short title is repeated from checkoutCopy). An unknown locale falls back to Russian. Plain hyphen
 * only (owner rule).
 */
const table = {
  ru: {
    title: 'Оплата',
    /** «Заказ № 42» in the header; `{n}` is the order number. */
    orderNo: 'Заказ № {n}',
    /** The three glass tiles under the QR: a bold line over a caption. */
    steps: [
      ['Приложение банка', 'откройте на телефоне'],
      ['Оплата по QR', 'выберите сканер'],
      ['Наведите камеру', 'на код выше'],
    ],
    waiting: 'Ждём оплату - экран обновится сам',
    startOver: 'Начать заново',
    startOverTitle: 'Начать заново?',
    startOverBody:
      'Заказ не будет оплачен, корзина очистится. Если вы уже оплатили - не нажимайте, позовите сотрудника.',
  },
  kk: {
    title: 'Төлем',
    orderNo: 'Тапсырыс № {n}',
    steps: [
      ['Банк қосымшасы', 'телефоныңызда ашыңыз'],
      ['QR арқылы төлеу', 'сканерді таңдаңыз'],
      ['Камераны бағыттаңыз', 'жоғарыдағы кодқа'],
    ],
    waiting: 'Төлемді күтеміз - экран өзі жаңарады',
    startOver: 'Басынан бастау',
    startOverTitle: 'Басынан бастаймыз ба?',
    startOverBody:
      'Тапсырыс төленбейді, себет тазаланады. Егер төлеп қойсаңыз - баспаңыз, қызметкерді шақырыңыз.',
  },
  en: {
    title: 'Payment',
    orderNo: 'Order #{n}',
    steps: [
      ['Your banking app', 'open it on your phone'],
      ['Pay by QR', 'choose the scanner'],
      ['Point the camera', 'at the code above'],
    ],
    waiting: 'Waiting for payment - the screen updates itself',
    startOver: 'Start over',
    startOverTitle: 'Start over?',
    startOverBody:
      'The order will not be paid and the cart will be cleared. If you have already paid - do not press this, call a team member.',
  },
} as const;
type Own = (typeof table)['ru'] | (typeof table)['kk'] | (typeof table)['en'];
export type PaymentCopy = Own & {
  toPay: string;
  qrValid: string;
  callStaff: string;
  backToPayment: string;
  checking: string;
  takeaway: string;
  dineIn: string;
  qrPreparing: string;
  qrExpired: string;
};
/** The new strings per locale, for the copy tests. */
export const paymentCopyForTest = table;
const cache = new Map<Locale, PaymentCopy>();
export const paymentCopy = (locale: string): PaymentCopy => {
  const known: Locale = locale === 'kk' || locale === 'en' ? locale : 'ru';
  const hit = cache.get(known);
  if (hit) return hit;
  const t = copy(known);
  const value: PaymentCopy = {
    ...table[known],
    toPay: t.toPay,
    qrValid: t.qrValid,
    callStaff: t.callStaff,
    backToPayment: t.backToPayment,
    checking: t.checkingPayment,
    takeaway: t.togo,
    dineIn: t.here,
    qrPreparing: t.qrPreparing,
    qrExpired: t.qrExpired,
  };
  cache.set(known, value);
  return value;
};
