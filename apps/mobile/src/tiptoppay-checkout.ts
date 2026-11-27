import type { CustomerTestPayment, CustomerTestPaymentSetup } from '@pickchick/contracts';
import type { PaymentMethodId } from './payment-method.ts';

/**
 * TipTopPay card / Apple Pay / Google Pay in the app (owner 18.11.2026, «Полностью нативно»).
 * Pure logic, free of Expo imports for Node tests; the screen wires it to the native module.
 *
 * Which methods the cart may offer is decided by three things together:
 * - the build: `EXPO_PUBLIC_TIPTOPPAY_TEST=1` (TestFlight build of the TipTopPay test). Without
 *   it no TipTopPay method is ever listed: the App Store build keeps Kaspi.kz alone (App Review
 *   2.1) even if the server offers a test terminal;
 * - the server (/config with the wallets profile: `paymentMethods`, `paymentEnvironment`);
 * - the phone: the native payments module, Apple Pay set up on this iPhone (with the merchant id
 *   of this build), Google Pay on Android.
 */
export const TIPTOPPAY_TEST_BUILD = process.env.EXPO_PUBLIC_TIPTOPPAY_TEST === '1';
/** Apple Pay merchant id of this build (same value the entitlement plugin used). */
export const APPLE_PAY_MERCHANT_ID = process.env.EXPO_PUBLIC_APPLE_PAY_MERCHANT_ID ?? '';

export type TipTopPayMethod = Exclude<PaymentMethodId, 'kaspi'>;
export const TIPTOPPAY_METHODS: readonly TipTopPayMethod[] = ['apple_pay', 'google_pay', 'card'];
export const isTipTopPayMethod = (method: PaymentMethodId): method is TipTopPayMethod =>
  method !== 'kaspi';

/** The wallets part of /config (pickchick.checkout-wallets-v1). */
type WalletsConfig = {
  paymentMethods?: readonly string[] | undefined;
  paymentEnvironment?: 'live' | 'test' | undefined;
};
export type PhoneWallets = {
  /** The native payments module is in this binary (card cryptogram). */
  module: boolean;
  /** iOS: Apple Pay can pay on this phone and the build carries a merchant id. */
  applePay: boolean;
  /** Android: Google Pay can be offered. */
  googlePay: boolean;
};

/** The TipTopPay methods this cart may offer now. */
export function connectedTipTopPayMethods(
  config: WalletsConfig | null | undefined,
  phone: PhoneWallets,
  testBuild: boolean = TIPTOPPAY_TEST_BUILD,
): TipTopPayMethod[] {
  if (!config?.paymentMethods || !phone.module) return [];
  // A test terminal reaches only the test build; a live one any build that knows the methods.
  if (config.paymentEnvironment !== 'live' && !(testBuild && config.paymentEnvironment === 'test'))
    return [];
  const server = new Set<string>(config.paymentMethods);
  return TIPTOPPAY_METHODS.filter(
    (method) =>
      server.has(method) &&
      (method === 'card' ||
        (method === 'apple_pay' && phone.applePay) ||
        (method === 'google_pay' && phone.googlePay)),
  );
}

/** Small shared store: the cart's /config read updates it, the method selector reads it. */
/** Where the last /config answer about TipTopPay methods is kept between launches. */
export const CONNECTED_METHODS_KEY = 'pickchick.payment.connected-methods.v1';

export function createConnectedMethodsStore(storage?: {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}) {
  let methods: TipTopPayMethod[] = [];
  let environment: 'live' | 'test' | null = null;
  let version = 0;
  // Owner 23.11.2026: on launch the quick pay handle showed Kaspi for a few seconds before
  // switching to Apple Pay, because the methods were known only after the cart's /config read.
  // The last answer is kept and read back at launch; until then the handle shows no mark.
  let restored = !storage;
  let fresh = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    version += 1;
    for (const listener of listeners) listener();
  };
  const store = {
    methods: () => methods,
    environment: () => environment,
    version: () => version,
    /** True once the saved answer was read (or there is none to read). */
    restored: () => restored,
    /** True once this app run had a /config answer (the restored list may be out of date). */
    fresh: () => fresh,
    set(next: TipTopPayMethod[], env: 'live' | 'test' | null) {
      const wasFresh = fresh;
      fresh = true;
      const wasRestored = restored;
      restored = true;
      if (storage)
        void storage
          .setItem(CONNECTED_METHODS_KEY, JSON.stringify({ methods: next, environment: env }))
          .catch(() => undefined);
      if (next.join() === methods.join() && env === environment) {
        // The first answer of this app run is news even with the same list: until it, the handle
        // may show a saved method the list lacks (launchPaymentMethod), and subscribers read
        // `fresh` only when the version moves.
        if (!wasRestored || !wasFresh) notify();
        return;
      }
      methods = next;
      environment = env;
      notify();
    },
    /** Reads the saved answer once; a fresh /config answer that came first wins. */
    restore(): Promise<void> {
      if (!storage || restored) return Promise.resolve();
      return storage
        .getItem(CONNECTED_METHODS_KEY)
        .then(
          (raw) => {
            if (fresh || !raw) return;
            const value = JSON.parse(raw) as { methods?: unknown; environment?: unknown };
            const saved = Array.isArray(value.methods)
              ? value.methods.filter((m): m is TipTopPayMethod =>
                  TIPTOPPAY_METHODS.includes(m as TipTopPayMethod),
                )
              : [];
            methods = saved;
            environment =
              value.environment === 'live' || value.environment === 'test'
                ? value.environment
                : null;
          },
          () => undefined,
        )
        .catch(() => undefined)
        .then(() => {
          if (restored) return;
          restored = true;
          notify();
        });
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return store;
}

/**
 * A press with a TipTopPay method: may this cart pay with it? Before the first /config answer of
 * this app run the handle shows the customer's last method on the phone's word alone
 * (launchPaymentMethod), and the list is the one of an earlier run or empty: the server is asked
 * first, so the press is not refused as «не подключён» a moment after the handle offered it. A
 * read that fails decides with the last known list, as before. Only decides; never pays.
 */
export async function confirmConnectedMethod(
  store: { fresh(): boolean; methods(): readonly TipTopPayMethod[] },
  method: TipTopPayMethod,
  readConfig: () => Promise<void>,
): Promise<boolean> {
  if (!store.fresh())
    try {
      await readConfig();
    } catch {
      // No answer: the last known list decides.
    }
  return store.methods().includes(method);
}

/** "1250.00" for the wallet sheets from integer minor units. */
export function walletAmount(totalMinor: string): string {
  if (!/^[1-9][0-9]{0,13}$/.test(totalMinor)) throw new Error('INVALID_AMOUNT');
  const minor = BigInt(totalMinor);
  return `${minor / 100n}.${(minor % 100n).toString().padStart(2, '0')}`;
}

/** Card number as typed: digits only, grouped by four (Amex-style grouping is not needed in KZ). */
export function formatCardNumber(value: string): string {
  return value
    .replace(/\D/g, '')
    .slice(0, 19)
    .replace(/(\d{4})(?=\d)/g, '$1 ');
}
export function formatExpiry(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 4);
  return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
}
export function luhnValid(number: string): boolean {
  const digits = number.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export type CardFields = { number: string; expiry: string; cvv: string };
export type CardProblem = 'number' | 'expiry' | 'cvv';
/** Which field is wrong, or null when the card can be encrypted. `now` for expiry. */
export function cardProblem(card: CardFields, now: Date): CardProblem | null {
  if (!luhnValid(card.number)) return 'number';
  const match = /^(\d{2})\/(\d{2})$/.exec(card.expiry);
  if (!match) return 'expiry';
  const month = Number(match[1]),
    year = 2000 + Number(match[2]);
  if (month < 1 || month > 12) return 'expiry';
  const end = new Date(Date.UTC(year, month, 1));
  if (end.getTime() <= now.getTime() || year > now.getUTCFullYear() + 20) return 'expiry';
  if (!/^\d{3,4}$/.test(card.cvv)) return 'cvv';
  return null;
}
export function cardInput(card: CardFields, setup: CustomerTestPaymentSetup) {
  const [expMonth, expYear] = card.expiry.split('/') as [string, string];
  return {
    number: card.number.replace(/\D/g, ''),
    expMonth,
    expYear,
    cvv: card.cvv,
    publicId: setup.publicId,
    publicKeyPem: setup.publicKey.pem,
    keyVersion: setup.publicKey.version,
  };
}

export const CARD_PROBLEM_TEXT: Record<CardProblem, string> = {
  number: 'Проверьте номер карты',
  expiry: 'Проверьте срок действия',
  cvv: 'Проверьте CVV: три цифры на обороте карты',
};

/** The result sheet's copy for a TipTopPay payment state. */
export function tipTopPayResultCopy(
  payment: Pick<CustomerTestPayment, 'state' | 'message'> | { state: 'checking' },
  test: boolean,
): { title: string; detail: string; tone: 'success' | 'danger' | 'pending' } {
  if (payment.state === 'paid')
    return {
      title: 'Оплата прошла',
      detail: test
        ? 'Это тестовая оплата: деньги не списаны, заказ на кухню не отправлен.'
        : 'Заказ оплачен.',
      tone: 'success',
    };
  if (payment.state === 'failed')
    return {
      title: 'Оплата не прошла',
      detail:
        ('message' in payment && payment.message) ||
        'Банк не подтвердил оплату. Деньги не списаны. Попробуйте ещё раз или выберите другой способ.',
      tone: 'danger',
    };
  if (payment.state === 'expired')
    return {
      title: 'Время оплаты вышло',
      detail: 'Деньги не списаны. Нажмите «Оплатить» ещё раз.',
      tone: 'danger',
    };
  return {
    title: 'Проверяем оплату',
    detail: 'Ждём ответ банка. Не оплачивайте заново: результат появится здесь.',
    tone: 'pending',
  };
}
