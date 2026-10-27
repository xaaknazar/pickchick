/**
 * The customer's payment method for the cart bar handle and the cart's «Способ оплаты» (owner
 * 27.10.2026, item 6b). The handle is not always Kaspi: it shows the customer's last used method
 * and the slide pays with it; the cart's selector opens preselected with the same method.
 *
 * - One value per account, kept locally (`lastPaymentMethod`, keyed by the customer id). It holds
 *   the method id only - never card numbers, tokens or any other payment data.
 * - It is set when a payment is sent (the method of that payment) and when the customer chooses a
 *   method in «Способ оплаты». The later of the two wins, so the handle always shows the method
 *   the customer used or picked last.
 * - A method this build cannot pay with right now falls back to the first available one. Today
 *   only Kaspi.kz pays; Apple Pay / Google Pay and bank cards are «скоро», so everyone sees Kaspi
 *   until they are connected. A new customer (or a guest) starts with Kaspi.
 *
 * Pure module: the app wires it to AsyncStorage (usePaymentMethod.ts); Node tests use memory.
 */
export type PaymentMethodId = 'kaspi' | 'apple_pay' | 'google_pay' | 'card';
export const PAYMENT_METHOD_IDS: readonly PaymentMethodId[] = [
  'kaspi',
  'apple_pay',
  'google_pay',
  'card',
];
/** New customers and every fallback without an available method. */
export const DEFAULT_PAYMENT_METHOD: PaymentMethodId = 'kaspi';

export type PaymentMethodOption = {
  id: PaymentMethodId;
  /** Brand names stay as is; «Банковская карта» goes through t(). */
  label: string;
  available: boolean;
};

/** «Способ оплаты» in its order. Only Kaspi.kz pays today; the rest are «скоро». */
export function paymentMethods(platform: string): PaymentMethodOption[] {
  return [
    { id: 'kaspi', label: paymentMethodLabel('kaspi'), available: true },
    platform === 'android'
      ? { id: 'google_pay', label: paymentMethodLabel('google_pay'), available: false }
      : { id: 'apple_pay', label: paymentMethodLabel('apple_pay'), available: false },
    { id: 'card', label: paymentMethodLabel('card'), available: false },
  ];
}

export function paymentMethodLabel(method: PaymentMethodId): string {
  return {
    kaspi: 'Kaspi.kz',
    apple_pay: 'Apple Pay',
    google_pay: 'Google Pay',
    card: 'Банковская карта',
  }[method];
}

/** Accessible name of the cart bar handle: the action names the method it pays with. */
export function paymentHandleLabel(method: PaymentMethodId): string {
  return {
    kaspi: 'Оплатить через Kaspi',
    apple_pay: 'Оплатить через Apple Pay',
    google_pay: 'Оплатить через Google Pay',
    card: 'Оплатить банковской картой',
  }[method];
}

/**
 * The cart's pay button. The method's mark and name stand in the {p0} slot, so every language
 * keeps its own word order: «Оплатить с [Kaspi] Kaspi.kz», «[Kaspi] Kaspi.kz арқылы төлеу». A
 * bank card is not a brand name: «Оплатить [card] картой», never «Оплатить с Банковская карта».
 */
export function paymentPayAction(method: PaymentMethodId): { template: string; name: string } {
  return method === 'card'
    ? { template: 'Оплатить {p0}', name: 'картой' }
    : { template: 'Оплатить с {p0}', name: paymentMethodLabel(method) };
}

/**
 * The Kaspi cart has one payment flow: the Kaspi invoice. Another method that becomes available
 * in `paymentMethods` before its own flow exists pays nothing; the cart then shows this instead
 * of a silent pay button or slide (nothing is created or sent).
 */
export const PAYMENT_METHOD_NOT_CONNECTED =
  'Этот способ оплаты пока не подключён. Заказ не оформлен, деньги не списаны. Выберите Kaspi.kz в «Способе оплаты».';

export function isPaymentMethodId(value: unknown): value is PaymentMethodId {
  return typeof value === 'string' && (PAYMENT_METHOD_IDS as readonly string[]).includes(value);
}

/** Where the saved method came from: a payment that was sent, or a choice in «Способ оплаты». */
export type LastPaymentSource = 'payment' | 'choice';
export type LastPaymentMethod = { method: PaymentMethodId; source: LastPaymentSource; at: number };

export const LAST_PAYMENT_METHOD_PREFIX = 'pickchick.payment.last-method.v1:';

/** Storage key of one account. A guest has none: nothing is persisted without an account. */
export function lastPaymentMethodKey(customerId: string | null | undefined): string | null {
  return typeof customerId === 'string' && customerId.length > 0 && customerId.length <= 100
    ? LAST_PAYMENT_METHOD_PREFIX + customerId
    : null;
}

const SAVED_FIELDS = ['at', 'method', 'source'];

/**
 * A saved value from storage. Anything unexpected - another shape, extra fields (no payment data
 * is ever stored next to the method), an unknown method - is ignored, never trusted.
 */
export function parseLastPaymentMethod(raw: string | null | undefined): LastPaymentMethod | null {
  if (typeof raw !== 'string' || !raw || raw.length > 200) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const saved = value as Record<string, unknown>;
  if (Object.keys(saved).sort().join() !== SAVED_FIELDS.join()) return null;
  if (!isPaymentMethodId(saved.method)) return null;
  if (saved.source !== 'payment' && saved.source !== 'choice') return null;
  if (!Number.isSafeInteger(saved.at) || (saved.at as number) <= 0) return null;
  return { method: saved.method, source: saved.source, at: saved.at as number };
}

export function serializeLastPaymentMethod(value: LastPaymentMethod): string {
  return JSON.stringify({ method: value.method, source: value.source, at: value.at });
}

/** A payment sent or a choice made now: the later event wins. */
export function noteLastPaymentMethod(
  method: PaymentMethodId,
  source: LastPaymentSource,
  now: number,
): LastPaymentMethod {
  return { method, source, at: Math.max(1, Math.trunc(now)) };
}

/**
 * The method the handle shows and the slide pays with: the saved one while this build can pay
 * with it, otherwise the first available method (Kaspi today), and Kaspi for a new customer.
 */
export function activePaymentMethod(
  saved: LastPaymentMethod | null | undefined,
  methods: readonly PaymentMethodOption[],
): PaymentMethodId {
  const available = methods.filter((method) => method.available);
  if (saved && available.some((method) => method.id === saved.method)) return saved.method;
  return available[0]?.id ?? DEFAULT_PAYMENT_METHOD;
}

/** Only a method this build can pay with now can be chosen or remembered. */
export function paymentMethodAvailable(
  method: PaymentMethodId,
  methods: readonly PaymentMethodOption[],
): boolean {
  return methods.some((option) => option.id === method && option.available);
}

export interface PaymentMethodStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface PaymentMethodStore {
  /** The saved value of an account (null for a guest or before it is read). */
  saved(customerId: string | null | undefined): LastPaymentMethod | null;
  /** True once the account's value was read (guests are always ready). */
  ready(customerId: string | null | undefined): boolean;
  /** Reads the account's value once; later calls reuse it. */
  load(customerId: string | null | undefined): Promise<void>;
  /** The active method of an account for these methods. */
  active(
    customerId: string | null | undefined,
    methods: readonly PaymentMethodOption[],
  ): PaymentMethodId;
  /**
   * Remembers a payment sent with `method` or a choice in «Способ оплаты». A method this build
   * cannot pay with is ignored. A guest's choice lives only in memory for this app run.
   */
  record(
    customerId: string | null | undefined,
    method: PaymentMethodId,
    source: LastPaymentSource,
    methods: readonly PaymentMethodOption[],
  ): boolean;
  subscribe(listener: () => void): () => void;
  /** Changes whenever a value is read or recorded (for useSyncExternalStore). */
  version(): number;
}

const GUEST = '\u0000guest';

export function createPaymentMethodStore(options: {
  storage: PaymentMethodStorage;
  now: () => number;
}): PaymentMethodStore {
  const values = new Map<string, LastPaymentMethod | null>();
  const reads = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  let version = 0;
  const notify = () => {
    version += 1;
    for (const listener of listeners) listener();
  };
  const slot = (customerId: string | null | undefined) => lastPaymentMethodKey(customerId) ?? GUEST;
  const store: PaymentMethodStore = {
    saved: (customerId) => values.get(slot(customerId)) ?? null,
    ready: (customerId) => {
      const key = lastPaymentMethodKey(customerId);
      return !key || values.has(key);
    },
    load(customerId) {
      const key = lastPaymentMethodKey(customerId);
      if (!key || values.has(key)) return Promise.resolve();
      const running = reads.get(key);
      if (running) return running;
      const read = options.storage
        .getItem(key)
        .then(
          (raw) => parseLastPaymentMethod(raw),
          () => null,
        )
        .then((value) => {
          // A choice or payment recorded while the value was being read is newer: it stays.
          if (!values.has(key)) values.set(key, value);
          reads.delete(key);
          notify();
        });
      reads.set(key, read);
      return read;
    },
    active: (customerId, methods) => activePaymentMethod(store.saved(customerId), methods),
    record(customerId, method, source, methods) {
      if (!paymentMethodAvailable(method, methods)) return false;
      const value = noteLastPaymentMethod(method, source, options.now());
      const key = lastPaymentMethodKey(customerId);
      values.set(key ?? GUEST, value);
      notify();
      if (key)
        void options.storage.setItem(key, serializeLastPaymentMethod(value)).catch(() => undefined);
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version,
  };
  return store;
}
