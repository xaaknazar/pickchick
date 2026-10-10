import {
  CustomerCommerceOrderSchema as BaseOrderSchema,
  CustomerQuoteSchema,
} from '@pickchick/contracts';
import { z } from 'zod';
const CustomerCommerceOrderSchema = BaseOrderSchema.extend({
  paymentMethod: z.enum(['kaspi_qr', 'kaspi_invoice']).nullable().optional(),
  payment: z
    .strictObject({
      kind: z.literal('kaspi_qr'),
      state: z.enum(['preparing', 'pending', 'checking', 'paid', 'failed']),
      qrPayload: z.string().min(1).max(4096).nullable(),
      expiresAt: z.iso.datetime().nullable(),
    })
    .optional(),
});
type CustomerCommerceOrder = z.infer<typeof CustomerCommerceOrderSchema>;
import { TestSelectionSchema } from '@pickchick/test-order-flow/contracts';
import { CatalogMediaMapSchema, CatalogPayloadSchema } from '@pickchick/catalog-admin/contracts';
import { KioskError } from './api.ts';
import type { KioskReadResult } from './commercial-api';
import { placeLine, selectedPriceMinor, validSelections, testLineId } from './cart.ts';
import { KIOSK_IDLE_MS, KIOSK_IDLE_GRACE_MS, type KioskIO } from './controller.ts';
import type { Locale } from './i18n';
import type {
  KioskCatalog,
  KioskMedia,
  KioskMode,
  KioskSelection,
  KioskErrorCode,
  KioskState,
  KioskStep,
  KioskPaymentMethod,
} from './model';

export const COMMERCIAL_SESSION_KEY = 'pickchick.kiosk.commercial-session.v1';
export const COMMERCIAL_FLOW_KEY = 'pickchick.kiosk.commercial-flow.v1';
export const KIOSK_DEVICE_KEY = 'pickchick.kiosk.device.v1';
export interface CommercialKioskIO extends KioskIO {
  readDevice(): Promise<string | null>;
  /**
   * GET with the storefront signal headers (photo map, availability long-poll). Optional:
   * without it the kiosk keeps bundled photos and plain availability reads.
   */
  read?(path: string, token: string, options?: { timeoutMs?: number }): Promise<KioskReadResult>;
}
/** Server long-poll window is 25 s; the client gives up a little later. */
export const AVAILABILITY_LONG_POLL_MS = 32000;
/** A failed photo map is retried at most this often; photos are optional for the menu. */
export const MEDIA_RETRY_MS = 60000;
/** One background availability cycle; see CommercialKioskController.watchAvailability. */
export type AvailabilityWatch =
  'idle' | 'unchanged' | 'changed' | 'reloaded' | 'unsupported' | 'failed';
type Session = {
  sessionId: string;
  token: string;
  expiresAt: string | null;
  branchId: string | null;
};
type Line = { productId: string; quantity: number; selections: KioskSelection[] };
type Intent = {
  guestId: string;
  quoteKey: string;
  orderKey: string;
  paymentKey: string;
  quoteId: string | null;
  orderId: string | null;
  method?: 'kaspi_qr' | 'kaspi_invoice';
  phone?: string;
  expectedTotalMinor: string;
  payload: {
    items: { productId: string; quantity: number; selections: KioskSelection[] }[];
    serviceMode: KioskMode;
    catalogVersion: number;
  };
};
type Flow = {
  version: 1;
  guestId: string | null;
  mode: KioskMode | null;
  cart: Line[];
  intent: Intent | null;
  order: CustomerCommerceOrder | null;
  lastActivityAt: number;
  resetPending: boolean;
};
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
export const invoicePhone = (value: string) => {
  const digits = value.replace(/\D/g, '');
  return /^(7|8)7\d{9}$/.test(digits) ? `+7${digits.slice(1)}` : null;
};
const paid = (o: CustomerCommerceOrder | null) =>
  !!o && ['paid', 'preparing', 'ready', 'handed_over'].includes(o.phase);
/**
 * A paid order is financially final even while its kitchen number has not arrived yet (edge or
 * bridge without WAN): the guest may leave and the kiosk may serve the next guest.
 */
const terminal = (o: CustomerCommerceOrder | null) => paid(o) || o?.phase === 'failed';
const definitive = (error: unknown, codes: string[]) =>
  error instanceof KioskError &&
  error.status >= 400 &&
  error.status < 500 &&
  codes.includes(error.code);
/**
 * Before a quote id is known no order can exist: every definitive refusal may drop the intent.
 * The earlier list (any status) is kept; session and expiry refusals require a 4xx answer.
 */
const QUOTE_DEFINITIVE = [
  'INVALID',
  'CONFLICT',
  'NOT_READY',
  'ITEM_STOPPED',
  'AVAILABILITY_STALE',
  'RESTAURANT_CLOSED',
  'CHECKOUT_DISABLED',
  'PRICE_CHANGED',
];
const QUOTE_SESSION_DEFINITIVE = ['FORBIDDEN', 'NOT_FOUND', 'EXPIRED'];
/**
 * POST /orders returns this guest's existing order before any check (createLocked), so these
 * answers mean no order exists for the saved keys. CONFLICT (another quote already has an order),
 * INVALID and FORBIDDEN (refused before that lookup: device or session unknown) keep recovery.
 */
const ORDER_DEFINITIVE = [
  'EXPIRED',
  'RESTAURANT_CLOSED',
  'NOT_READY',
  'NOT_FOUND',
  'ITEM_STOPPED',
  'AVAILABILITY_STALE',
];
/**
 * POST /orders/:id/payment returns an order that already has an attempt before any check
 * (payLocked), so these answers mean the order has no payment attempt and no money.
 */
const PAYMENT_DEFINITIVE = ['ITEM_STOPPED', 'AVAILABILITY_STALE', 'RESTAURANT_CLOSED', 'NOT_READY'];
/** Russian fallback text of every guest error code; the screen shows the guest's language. */
export const COMMERCIAL_ERROR_TEXT: Record<KioskErrorCode, string> = {
  PRICE_CHANGED: 'Сумма изменилась. Проверьте корзину и подтвердите оплату заново.',
  CART_CHANGED: 'Состав или цена изменились. Проверьте корзину и выберите доступные позиции.',
  NOT_ACCEPTING: 'Ресторан пока не принимает заказы. Обновите меню или пригласите сотрудника.',
  DEVICE: 'Киоск не настроен. Пригласите сотрудника.',
  PHONE: 'Введите номер Казахстана для счёта Kaspi.',
  CART_LIMIT_LINE: 'Одной позиции можно добавить не больше 20 штук.',
  CART_LIMIT_LINES: 'В корзине может быть не больше 11 разных позиций.',
  RETRY_PAYMENT: 'Оплата не началась, деньги не списаны. Нажмите «Перейти к оплате» ещё раз.',
  PAYMENT_UNKNOWN:
    'Не удалось проверить результат. Пригласите сотрудника, не оплачивайте повторно.',
  MENU_LOAD: 'Не удалось загрузить меню. Проверьте подключение и повторите попытку.',
  NETWORK: 'Не удалось выполнить действие. Проверьте подключение и повторите попытку.',
  CONNECTION: 'Связь с сервером прервалась. Проверяем снова, не оплачивайте повторно.',
  OFFLINE: 'Нет связи с сервером. Новый заказ можно начать, когда связь восстановится.',
};
function decode(raw: string): unknown {
  if (raw.length > 200000) throw new KioskError('RECOVERY_DATA_INVALID');
  try {
    return JSON.parse(raw);
  } catch {
    throw new KioskError('RECOVERY_DATA_INVALID');
  }
}
const exactKeys = (v: Record<string, unknown>, expected: string[]) =>
  Object.keys(v).sort().join(',') === expected.sort().join(',');
const selectionsValid = (v: unknown) =>
  Array.isArray(v) &&
  v.length <= 40 &&
  v.every((s) => TestSelectionSchema.safeParse(s).success) &&
  new Set(v.map((s) => `${s.group_id}:${s.option_id}`)).size === v.length;
function session(value: unknown): Session {
  if (
    !isObject(value) ||
    !exactKeys(value, ['sessionId', 'token', 'expiresAt', 'branchId']) ||
    !id(value.sessionId) ||
    !(value.branchId === null || id(value.branchId)) ||
    typeof value.token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.token) ||
    !(
      value.expiresAt === null ||
      (typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt)))
    )
  )
    throw new KioskError('INVALID_RESPONSE');
  return value as unknown as Session;
}
/**
 * Authored text in the kiosk language. The catalog contract carries ru (required) and kk
 * (may be empty); `en` is read when a publication provides it. Missing or empty values fall
 * back to Russian (en -> ru, kk -> ru).
 */
export function localizedText(text: { ru: string; kk?: string; en?: string }, locale: Locale) {
  const value = locale === 'ru' ? text.ru : text[locale];
  return typeof value === 'string' && value.trim() ? value : text.ru;
}
export function publishedKioskCatalog(value: unknown, locale: Locale = 'ru'): KioskCatalog {
  if (
    !isObject(value) ||
    !isObject(value.branch) ||
    !id(value.branch.id) ||
    value.channel !== 'kiosk' ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1
  )
    throw new KioskError('INVALID_RESPONSE');
  const payload = CatalogPayloadSchema.parse(value.payload);
  return {
    branch_id: value.branch.id,
    catalog_version: String(value.version),
    currency: 'KZT',
    estimated_minutes: payload.estimated_minutes,
    upsell_product_ids: payload.upsell_product_ids,
    products: payload.products.map((p) => ({
      id: p.id,
      sku: p.sku,
      name: localizedText(p.name, locale),
      description: localizedText(p.description, locale),
      // The Russian category name is the menu's classifier key (components/categories.ts).
      category: payload.categories.find((c) => c.id === p.category_id)!.name.ru,
      price_minor: p.channel_prices_minor?.kiosk ?? p.price_minor,
      image_id: p.image_asset_key,
      available: p.available,
      prep_required: p.prep_required,
      prep_minutes: p.prep_minutes,
      serving_label: localizedText(p.serving_label, locale) || '-',
      ingredients: localizedText(p.ingredients, locale),
      allergens: p.allergens,
      nutrition: p.nutrition,
      nutrition_provenance: p.nutrition_status,
      modifier_groups: p.modifier_groups.map((g) => ({
        id: g.id,
        title: localizedText(g.title, locale),
        min: g.min,
        max: g.max,
        options: g.options.map((o) => ({
          id: o.id,
          label: localizedText(o.label, locale),
          available: o.available,
          price_delta_minor: o.price_delta_minor,
          default_quantity: o.default_quantity,
          max_quantity: o.max_quantity,
          ...(o.nutrition_multiplier === undefined
            ? {}
            : { nutrition_multiplier: o.nutrition_multiplier }),
        })),
      })),
    })),
  };
}
/**
 * Copies the authored texts of `source` (the same publication parsed for another language)
 * onto `target` by id, keeping availability, prices and photos of `target`.
 */
export function relabelCatalog(target: KioskCatalog, source: KioskCatalog): KioskCatalog {
  const products = new Map(source.products.map((p) => [p.id, p]));
  return {
    ...target,
    products: target.products.map((p) => {
      const text = products.get(p.id);
      if (!text) return p;
      const groups = new Map(text.modifier_groups.map((g) => [g.id, g]));
      return {
        ...p,
        name: text.name,
        description: text.description,
        serving_label: text.serving_label,
        ingredients: text.ingredients,
        modifier_groups: p.modifier_groups.map((g) => {
          const group = groups.get(g.id);
          if (!group) return g;
          const labels = new Map(group.options.map((o) => [o.id, o.label]));
          return {
            ...g,
            title: group.title,
            options: g.options.map((o) => ({ ...o, label: labels.get(o.id) ?? o.label })),
          };
        }),
      };
    }),
  };
}
/**
 * Applies an availability body to the published catalog without mutating it. `strict` keeps the
 * checkout rules of a full menu load (an unknown product is an invalid response, a missing one
 * makes availability stale). The background long-poll is lenient: it may still hold an older
 * publication, so unknown products are ignored and missing ones are shown as unavailable.
 */
export function applyAvailability(
  base: KioskCatalog,
  availability: unknown,
  strict: boolean,
): { menu: KioskCatalog; fresh: boolean } {
  if (
    !isObject(availability) ||
    typeof availability.fresh !== 'boolean' ||
    !Array.isArray(availability.products) ||
    availability.products.length > 100
  )
    throw new KioskError('INVALID_RESPONSE');
  const fresh = availability.fresh;
  const entries = new Map<string, { available: boolean; stopped: Set<string> }>();
  for (const entry of availability.products) {
    if (
      !isObject(entry) ||
      typeof entry.productId !== 'string' ||
      typeof entry.available !== 'boolean' ||
      !Array.isArray(entry.stoppedOptions) ||
      entry.stoppedOptions.some(
        (o) => !isObject(o) || typeof o.group_id !== 'string' || typeof o.option_id !== 'string',
      ) ||
      entries.has(entry.productId)
    )
      throw new KioskError('INVALID_RESPONSE');
    if (strict && !base.products.some((p) => p.id === entry.productId))
      throw new KioskError('INVALID_RESPONSE');
    const stoppedOptions = entry.stoppedOptions as { group_id: string; option_id: string }[];
    entries.set(entry.productId, {
      available: entry.available,
      stopped: new Set(stoppedOptions.map((o) => `${o.group_id}\u0000${o.option_id}`)),
    });
  }
  if (strict && base.products.some((p) => !entries.has(p.id)))
    throw new KioskError('AVAILABILITY_STALE');
  return {
    fresh,
    menu: {
      ...base,
      products: base.products.map((product) => {
        const entry = entries.get(product.id);
        return {
          ...product,
          available: product.available !== false && !!entry?.available && fresh,
          modifier_groups: product.modifier_groups.map((g) => ({
            ...g,
            options: g.options.map((o) => ({
              ...o,
              available: o.available && !entry?.stopped.has(`${g.id}\u0000${o.id}`),
            })),
          })),
        };
      }),
    },
  };
}
function flow(value: unknown): Flow {
  if (
    !isObject(value) ||
    !exactKeys(value, [
      'version',
      'guestId',
      'mode',
      'cart',
      'intent',
      'order',
      'lastActivityAt',
      'resetPending',
    ]) ||
    value.version !== 1 ||
    !(value.guestId === null || id(value.guestId)) ||
    ![null, 'takeaway', 'dine_in'].includes(value.mode as null) ||
    !Array.isArray(value.cart) ||
    value.cart.length > 11 ||
    !Number.isSafeInteger(value.lastActivityAt) ||
    typeof value.resetPending !== 'boolean'
  )
    throw new KioskError('RECOVERY_DATA_INVALID');
  for (const line of value.cart)
    if (
      !isObject(line) ||
      typeof line.productId !== 'string' ||
      !Number.isInteger(line.quantity) ||
      Number(line.quantity) < 1 ||
      Number(line.quantity) > 20 ||
      !exactKeys(line, ['productId', 'quantity', 'selections']) ||
      !selectionsValid(line.selections)
    )
      throw new KioskError('RECOVERY_DATA_INVALID');
  const order = value.order === null ? null : CustomerCommerceOrderSchema.parse(value.order);
  const p = value.intent;
  if (
    p !== null &&
    (!isObject(p) ||
      !exactKeys(p, [
        'guestId',
        'quoteKey',
        'orderKey',
        'paymentKey',
        'quoteId',
        'orderId',
        ...(p.method === 'kaspi_qr'
          ? ['method']
          : p.method === 'kaspi_invoice'
            ? ['method', 'phone']
            : ['phone']),
        'expectedTotalMinor',
        'payload',
      ]) ||
      !id(p.guestId) ||
      p.guestId !== value.guestId ||
      !id(p.quoteKey) ||
      !id(p.orderKey) ||
      !id(p.paymentKey) ||
      !(p.quoteId === null || id(p.quoteId)) ||
      !(p.orderId === null || id(p.orderId)) ||
      !(
        p.method === 'kaspi_qr' ||
        ((p.method === undefined || p.method === 'kaspi_invoice') &&
          typeof p.phone === 'string' &&
          invoicePhone(p.phone))
      ) ||
      typeof p.expectedTotalMinor !== 'string' ||
      !/^(0|[1-9][0-9]{0,15})$/.test(p.expectedTotalMinor) ||
      !isObject(p.payload) ||
      !exactKeys(p.payload, ['items', 'serviceMode', 'catalogVersion']) ||
      !Array.isArray(p.payload.items) ||
      p.payload.items.length < 1 ||
      p.payload.items.length > 11 ||
      p.payload.items.some(
        (item) =>
          !isObject(item) ||
          !exactKeys(item, ['productId', 'quantity', 'selections']) ||
          typeof item.productId !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(item.productId) ||
          !Number.isInteger(item.quantity) ||
          Number(item.quantity) < 1 ||
          Number(item.quantity) > 20 ||
          !selectionsValid(item.selections),
      ) ||
      !['takeaway', 'dine_in'].includes(String(p.payload.serviceMode)) ||
      !Number.isSafeInteger(p.payload.catalogVersion) ||
      Number(p.payload.catalogVersion) < 1 ||
      (p.orderId !== null && (!order || order.orderId !== p.orderId)))
  )
    throw new KioskError('RECOVERY_DATA_INVALID');
  if (
    ((order || p) && !value.guestId) ||
    (value.resetPending && (p || (order && !terminal(order))))
  )
    throw new KioskError('RECOVERY_DATA_INVALID');
  return { ...value, order } as unknown as Flow;
}

/** Navigation steps a background reload keeps (the guest is browsing, nothing is pending). */
const BROWSING: KioskStep[] = ['menu', 'product', 'upsell', 'cart', 'loyalty'];
/** A read that may simply be retried: the network, a timeout or a server outage. */
const transient = (error: unknown) =>
  !(error instanceof KioskError) ||
  error.code === 'NETWORK_UNCERTAIN' ||
  error.code === 'API_UNAVAILABLE' ||
  error.status >= 500;

/** Commercial guest flow has separate storage and cannot invoke simulated payments. */
export class CommercialKioskController {
  private current: Flow;
  private guest: Session | null = null;
  private menu: KioskCatalog | null = null;
  /** Published catalog (with photos) before availability is applied. */
  private base: KioskCatalog | null = null;
  /** Raw `/catalog` response of `base`, kept to re-read its texts in another language. */
  private published: unknown = null;
  private locale: Locale = 'ru';
  /** Last X-Availability-Signature; the next long-poll waits for a different one. */
  private signature: string | null = null;
  private media: { version: string; products: Record<string, KioskMedia> } | null = null;
  private mediaRetryAt = 0;
  private checkoutReady = false;
  /** Last `/config` enabled value; a fresh long-poll restores checkout after a stale one. */
  private configEnabled = false;
  /** The last availability was not fresh: every product is shown unavailable. */
  private stale = false;
  private paymentMethods: ('kaspi' | 'kaspi_invoice')[] = [];
  private selectedMethod: 'kaspi' | 'kaspi_invoice' = 'kaspi';
  private ready = false;
  private busy = false;
  /** A background reload in flight; it never marks the kiosk busy (see run). */
  private backgroundTask: Promise<boolean> | null = null;
  private blocked = false;
  private initialized = false;
  private error: string | null = null;
  private errorCode: KioskErrorCode | null = null;
  private step: KioskStep = 'start';
  private selectedId: string | null = null;
  /** Where the product page was opened from; adding or closing returns there. */
  private returnStep: KioskStep = 'menu';
  private lastAdded: { lineId: string; serial: number } | null = null;
  private editing: KioskState['editingLine'] = null;
  private addSerial = 0;
  private phone = '';
  private warning: number | null = null;
  private listeners = new Set<() => void>();
  private view: KioskState;
  private io: CommercialKioskIO;
  constructor(io: CommercialKioskIO) {
    this.io = io;
    this.current = this.empty();
    this.view = this.snapshot();
  }
  private empty(): Flow {
    return {
      version: 1,
      guestId: null,
      mode: null,
      cart: [],
      intent: null,
      order: null,
      lastActivityAt: this.io.now(),
      resetPending: false,
    };
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.view;
  /** Editing is closed: a payment may exist, or a finished guest is still being ended. */
  private unsafe() {
    return this.current.resetPending || this.pending();
  }
  /** A payment may exist whose result is not final: only the recovery path may continue. */
  private pending() {
    return (
      this.blocked ||
      !!this.current.intent ||
      (!!this.current.order && !terminal(this.current.order))
    );
  }
  private snapshot(): KioskState {
    const unavailableCartLines: KioskState['unavailableCartLines'] = [];
    const cart = this.current.cart.flatMap((line) => {
      const product = this.menu?.products.find((p) => p.id === line.productId);
      const lineId = testLineId(line.productId, line.selections);
      if (!product || product.available === false || !validSelections(product, line.selections)) {
        unavailableCartLines.push({ lineId, productId: line.productId, quantity: line.quantity });
        return [];
      }
      const unitPriceMinor = selectedPriceMinor(product, line.selections);
      return [
        {
          ...line,
          lineId,
          product,
          unitPriceMinor,
          lineTotalMinor: (BigInt(unitPriceMinor) * BigInt(line.quantity)).toString(),
        },
      ];
    });
    const order = this.current.order;
    return {
      ready: this.ready,
      busy: this.busy,
      error: this.error,
      errorCode: this.errorCode,
      commercial: true,
      checkoutReady: this.checkoutReady,
      menuUpdating: !!this.menu && this.stale,
      syncPending: this.current.resetPending,
      lastAdded: this.lastAdded,
      editingLine: this.editing,
      commercialPaymentMethods: this.paymentMethods,
      invoicePhone: this.phone,
      phoneValid: !!invoicePhone(this.phone),
      qrPayment: order?.payment?.kind === 'kaspi_qr' ? order.payment : null,
      paymentPhase: order?.phase,
      receiptState: order?.receipt,
      catalog: this.menu,
      step: this.step,
      mode: this.current.mode,
      cart,
      unavailableCartLines,
      cartValid: !!this.menu && !unavailableCartLines.length,
      cartTotalMinor: cart.reduce((sum, line) => sum + BigInt(line.lineTotalMinor), 0n).toString(),
      selectedProduct: this.menu?.products.find((p) => p.id === this.selectedId) ?? null,
      paymentMethod:
        order?.paymentMethod === 'kaspi_invoice' || this.current.intent?.method === 'kaspi_invoice'
          ? 'kaspi_invoice'
          : order?.payment?.kind === 'kaspi_qr' || this.current.intent?.method === 'kaspi_qr'
            ? 'kaspi'
            : this.selectedMethod,
      order: order
        ? {
            order_id: order.orderId,
            number: order.displayNumber ?? '-',
            state:
              order.phase === 'handed_over'
                ? 'fulfilled'
                : order.phase === 'failed'
                  ? 'failed'
                  : order.phase,
            payment_state: paid(order)
              ? 'paid'
              : order.phase === 'failed'
                ? 'declined'
                : ['checking', 'attention'].includes(order.phase)
                  ? 'unknown'
                  : 'pending',
            snapshot: { total_minor: order.totalMinor },
          }
        : null,
      // A paid order waiting for its kitchen number is final: it no longer blocks the kiosk.
      recoveryRequired: this.blocked || !!this.current.intent || order?.phase === 'attention',
      idleWarningSeconds: this.warning,
    };
  }
  private emit() {
    this.view = this.snapshot();
    for (const fn of this.listeners) fn();
  }
  private async save(next: Flow) {
    await this.io.writeFlow(JSON.stringify(next));
    this.current = next;
  }
  private setError(code: KioskErrorCode | null) {
    this.errorCode = code;
    this.error = code ? COMMERCIAL_ERROR_TEXT[code] : null;
  }
  private codeOf(error: unknown): KioskErrorCode {
    const code = error instanceof KioskError ? error.code : '';
    if (code === 'PRICE_CHANGED') return 'PRICE_CHANGED';
    if (['INVALID', 'CONFLICT', 'ITEM_STOPPED'].includes(code)) return 'CART_CHANGED';
    if (
      ['NOT_READY', 'AVAILABILITY_STALE', 'RESTAURANT_CLOSED', 'CHECKOUT_DISABLED'].includes(code)
    )
      return 'NOT_ACCEPTING';
    if (code === 'DEVICE_NOT_PROVISIONED') return 'DEVICE';
    if (code === 'INVALID_PHONE') return 'PHONE';
    if (code === 'CART_LIMIT_LINE' || code === 'CART_LIMIT_LINES') return code;
    if (code === 'CONNECTION_SOFT') return 'CONNECTION';
    if (code === 'RETRY_PAYMENT') return 'RETRY_PAYMENT';
    if (this.current.resetPending && !this.pending() && transient(error)) return 'OFFLINE';
    if (this.blocked || this.current.intent || this.current.order) return 'PAYMENT_UNKNOWN';
    return !this.menu ? 'MENU_LOAD' : 'NETWORK';
  }
  /**
   * Runs one operation. A guest command marks the kiosk busy (buttons show progress) and waits for
   * a background reload in flight instead of being dropped. A background reload (polling) never
   * marks the kiosk busy, and a transient failure of it stays silent: the poll simply retries.
   */
  private async run(fn: () => Promise<void>, unready = false, background = false) {
    if (this.busy || (!this.ready && !unready) || (background && this.backgroundTask)) return false;
    if (!background) {
      this.busy = true;
      this.setError(null);
      this.emit();
      if (this.backgroundTask) await this.backgroundTask;
    }
    const task = (async () => {
      try {
        await fn();
        if (
          background &&
          this.errorCode &&
          [
            'CONNECTION',
            'OFFLINE',
            'NETWORK',
            'MENU_LOAD',
            'NOT_ACCEPTING',
            'PAYMENT_UNKNOWN',
          ].includes(this.errorCode)
        )
          this.setError(null);
        return true;
      } catch (error) {
        const soft = error instanceof KioskError && error.code === 'CONNECTION_SOFT';
        const quiet =
          (error instanceof KioskError && error.code === 'QUIET') ||
          (background && !this.pending() && !!this.menu && transient(error));
        if (!quiet) this.setError(this.codeOf(error));
        if (soft || quiet) return false;
        if (this.pending()) this.step = 'recovery';
        else if (this.current.resetPending) this.step = 'start';
        return false;
      } finally {
        if (!background) this.busy = false;
        this.emit();
      }
    })();
    if (background) {
      this.backgroundTask = task;
      void task.then(() => {
        if (this.backgroundTask === task) this.backgroundTask = null;
      });
    }
    return task;
  }
  private async device() {
    if (!(await this.io.readDevice())) throw new KioskError('DEVICE_NOT_PROVISIONED');
  }
  /**
   * Forgets the guest identity locally while keeping the unsubmitted draft; the next request
   * allocates another session. Only valid when no order or intent can belong to it.
   */
  private async detachGuest() {
    await this.save({ ...this.current, guestId: null });
    await this.io.removeSession();
    this.guest = null;
  }
  private async loadMenu() {
    await this.device();
    let guest = await this.authenticate();
    let config: unknown;
    try {
      config = await this.io.request('/config', guest.token);
    } catch (error) {
      // The server no longer knows this guest (restored database, removed row): without an
      // order or intent nothing belongs to it, so allocate another one instead of looping.
      if (
        !(error instanceof KioskError && error.code === 'FORBIDDEN') ||
        this.current.intent ||
        this.current.order
      )
        throw error;
      await this.detachGuest();
      guest = await this.authenticate();
      config = await this.io.request('/config', guest.token);
    }
    if (
      !isObject(config) ||
      typeof config.enabled !== 'boolean' ||
      !['kaspi_qr', 'kaspi_invoice'].includes(String(config.paymentMethod)) ||
      !id(config.branchId)
    ) {
      this.checkoutReady = false;
      throw new KioskError('CHECKOUT_DISABLED');
    }
    const methods = config.paymentMethods ?? [config.paymentMethod];
    if (
      !Array.isArray(methods) ||
      methods.length > 2 ||
      new Set(methods).size !== methods.length ||
      methods.some((m) => !['kaspi_qr', 'kaspi_invoice'].includes(m))
    ) {
      this.checkoutReady = false;
      throw new KioskError('INVALID_RESPONSE');
    }
    const published = await this.io.request('/catalog', guest.token);
    const textLocale = this.locale;
    const next = publishedKioskCatalog(published, textLocale);
    if (
      next.branch_id !== config.branchId ||
      (this.guest?.branchId && next.branch_id !== this.guest.branchId)
    )
      throw new KioskError('INVALID_RESPONSE');
    this.attachMedia(next, await this.catalogMedia(next.catalog_version, guest.token));
    const availability = await this.readAvailability('/availability', guest.token);
    const applied = applyAvailability(next, availability.data, true);
    // Everything is loaded: apply it at once, so a failed reload keeps the previous state.
    this.paymentMethods = methods.map((m) => (m === 'kaspi_qr' ? 'kaspi' : 'kaspi_invoice'));
    if (
      !this.current.intent &&
      !this.current.order &&
      !this.paymentMethods.includes(this.selectedMethod)
    ) {
      this.selectedMethod = this.paymentMethods[0] ?? 'kaspi';
      this.phone = '';
    }
    this.base = next;
    this.published = published;
    this.menu = applied.menu;
    if (textLocale !== this.locale) {
      // The language changed while the publication was loading.
      const texts = publishedKioskCatalog(published, this.locale);
      this.base = relabelCatalog(this.base, texts);
      this.menu = relabelCatalog(this.menu, texts);
    }
    this.signature = availability.signature;
    this.configEnabled = config.enabled;
    this.stale = !applied.fresh;
    this.checkoutReady = applied.fresh && config.enabled;
    if (!applied.fresh) throw new KioskError('AVAILABILITY_STALE');
  }
  private async readAvailability(path: string, token: string): Promise<KioskReadResult> {
    return this.io.read
      ? this.io.read(path, token)
      : { data: await this.io.request(path, token), catalogVersion: null, signature: null };
  }
  /**
   * Photo map of the loaded publication (WP-K). Photos are optional: any failure keeps the
   * bundled photos and is retried at most once a minute; a version's map is fetched once.
   */
  private async catalogMedia(version: string, token: string) {
    if (!this.io.read) return null;
    if (this.media?.version === version) return this.media.products;
    if (this.io.now() < this.mediaRetryAt) return null;
    try {
      const response = await this.io.read(`/catalog/media?version=${version}`, token);
      const map = CatalogMediaMapSchema.parse(response.data);
      if (String(map.version) !== version) throw new KioskError('INVALID_RESPONSE');
      this.media = { version, products: map.products };
      this.mediaRetryAt = 0;
      return map.products;
    } catch {
      this.mediaRetryAt = this.io.now() + MEDIA_RETRY_MS;
      return null;
    }
  }
  private attachMedia(catalog: KioskCatalog, media: Record<string, KioskMedia> | null) {
    if (!media) return;
    catalog.products = catalog.products.map((p) => {
      const entry = Object.hasOwn(media, p.id) ? media[p.id] : undefined;
      return entry ? { ...p, media: { ...entry } } : p;
    });
  }
  /**
   * Shows the catalog texts in the guest's language (fallback en -> ru, kk -> ru). Only labels
   * change: cart, availability, prices and the payment state are untouched.
   */
  setLocale = (locale: Locale) => {
    if (locale === this.locale) return;
    this.locale = locale;
    if (!this.published || !this.base || !this.menu) return;
    const texts = publishedKioskCatalog(this.published, locale);
    this.base = relabelCatalog(this.base, texts);
    this.menu = relabelCatalog(this.menu, texts);
    this.emit();
  };
  /** The attract screen with no guest activity: a new publication can replace the menu at once. */
  private idleStart() {
    return (
      this.step === 'start' &&
      !this.unsafe() &&
      !this.current.order &&
      !this.current.cart.length &&
      !this.current.mode
    );
  }
  /**
   * One background availability cycle that never marks the kiosk busy. With a known signature it
   * long-polls `?after=` until stops, freshness or the catalog version change (at most 25 s).
   * - Same publication: the new stops are applied to the menu at once (also on the start screen).
   * - Newer publication (X-Catalog-Version): on the idle start screen the catalog is reloaded at
   *   once; mid-session the loaded publication is kept and the quote CONFLICT path decides.
   * AVAILABILITY_STALE semantics are unchanged: a stale body makes every product unavailable.
   * A fresh body after a stale one gives checkout back at once (the last `/config` decides).
   */
  watchAvailability = async (): Promise<AvailabilityWatch> => {
    if (!this.io.read) return 'unsupported';
    if (
      !this.ready ||
      this.busy ||
      this.backgroundTask ||
      !this.menu ||
      !this.base ||
      this.unsafe() ||
      this.current.order
    )
      return 'idle';
    const guest = this.guest;
    if (
      !guest?.branchId ||
      guest.sessionId !== this.current.guestId ||
      (guest.expiresAt && Date.parse(guest.expiresAt) <= this.io.now())
    ) {
      // A finished guest leaves no session; the start screen allocates the next one in the
      // normal refresh path (the same as a kiosk restart), so the poll can continue.
      if (!this.idleStart()) return 'idle';
      return (await this.refreshResult(true)) ? 'reloaded' : 'failed';
    }
    const after = this.signature;
    let response: KioskReadResult;
    try {
      response = await this.io.read(
        after ? `/availability?after=${after}` : '/availability',
        guest.token,
        { timeoutMs: AVAILABILITY_LONG_POLL_MS },
      );
    } catch {
      return 'failed';
    }
    // The guest may have acted while the request was waiting; a foreground load then wins.
    if (
      this.guest !== guest ||
      this.busy ||
      this.backgroundTask ||
      !this.menu ||
      !this.base ||
      this.unsafe() ||
      this.current.order ||
      this.signature !== after
    )
      return 'idle';
    const loaded = Number(this.base.catalog_version);
    if (response.catalogVersion !== null && response.catalogVersion > loaded && this.idleStart())
      return (await this.refreshResult(true)) ? 'reloaded' : 'failed';
    let applied: { menu: KioskCatalog; fresh: boolean };
    try {
      applied = applyAvailability(this.base, response.data, false);
    } catch {
      return 'failed';
    }
    this.menu = applied.menu;
    this.signature = response.signature;
    if (!applied.fresh) {
      this.stale = true;
      this.checkoutReady = false;
    } else if (this.stale) {
      this.stale = false;
      this.checkoutReady = this.configEnabled;
      if (this.errorCode === 'NOT_ACCEPTING') this.setError(null);
    }
    this.emit();
    if (!response.signature) return 'unsupported';
    return response.signature === after ? 'unchanged' : 'changed';
  };
  private async authenticate() {
    if (this.guest) {
      if (!this.current.guestId && !this.current.order && !this.current.intent)
        await this.save({ ...this.current, guestId: this.guest.sessionId });
      if (!this.guest.branchId) return this.resumeSession(this.guest);
      if (this.guest.sessionId !== this.current.guestId)
        throw new KioskError('GUEST_IDENTITY_UNAVAILABLE');
      if (
        this.guest.expiresAt &&
        Date.parse(this.guest.expiresAt) <= this.io.now() &&
        !this.unsafe() &&
        !this.current.order
      ) {
        try {
          const ended = await this.io.request('/sessions/end', this.guest.token, {});
          if (!isObject(ended) || ended.ended !== true) throw new KioskError('INVALID_RESPONSE');
        } catch (error) {
          // A guest the server no longer knows cannot be ended; nothing belongs to it.
          if (!(error instanceof KioskError && error.code === 'FORBIDDEN')) throw error;
        }
        // Detach before removing the credential: a crash can retry the old end,
        // or allocate the next session, without losing the unsubmitted draft.
        await this.detachGuest();
      } else return this.guest;
    }
    if (this.current.guestId || this.current.intent || this.current.order)
      throw new KioskError('GUEST_IDENTITY_UNAVAILABLE');
    const candidate: Session = {
      sessionId: this.io.uuid(),
      token: `${this.io.uuid()}${this.io.uuid()}`.replace(/-/g, ''),
      expiresAt: null,
      branchId: null,
    };
    await this.io.writeSession(JSON.stringify(candidate));
    this.guest = candidate;
    await this.save({ ...this.current, guestId: candidate.sessionId });
    return this.resumeSession(candidate);
  }
  private async resumeSession(candidate: Session) {
    await this.device();
    const response = await this.io.request(
      '/sessions',
      undefined,
      { sessionId: candidate.sessionId, token: candidate.token },
      candidate.sessionId,
    );
    if (
      !isObject(response) ||
      response.sessionId !== candidate.sessionId ||
      !id(response.branchId) ||
      typeof response.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(response.expiresAt)) ||
      (this.menu && response.branchId !== this.menu.branch_id)
    )
      throw new KioskError('INVALID_RESPONSE');
    const next = { ...candidate, branchId: response.branchId, expiresAt: response.expiresAt };
    await this.io.writeSession(JSON.stringify(next));
    this.guest = next;
    return next;
  }
  /**
   * The step the stored state requires. A guest who is browsing stays on their screen: a
   * background reload must not send them back to the menu or the start screen.
   */
  private derive() {
    const shown = this.step;
    this.step =
      this.blocked || this.current.intent
        ? 'recovery'
        : this.current.order
          ? paid(this.current.order) || this.current.order.phase === 'failed'
            ? 'order'
            : 'payment'
          : this.current.resetPending
            ? 'start'
            : !this.current.mode
              ? shown === 'mode'
                ? 'mode'
                : 'start'
              : BROWSING.includes(shown)
                ? shown
                : 'menu';
  }
  restore = () =>
    this.run(async () => {
      if (!this.initialized) {
        this.blocked = true;
        const [raw, guestRaw] = await Promise.all([this.io.readFlow(), this.io.readSession()]);
        this.current = raw ? flow(decode(raw)) : this.empty();
        this.guest = guestRaw ? session(decode(guestRaw)) : null;
        if (this.guest && !this.current.guestId && !this.current.intent && !this.current.order)
          await this.save({ ...this.current, guestId: this.guest.sessionId });
        if (
          !this.current.resetPending &&
          ((this.guest && this.guest.sessionId !== this.current.guestId) ||
            ((this.current.order || this.current.intent) && !this.guest))
        )
          throw new KioskError('GUEST_IDENTITY_UNAVAILABLE');
        this.blocked = false;
        this.initialized = true;
        // Ready before the network: a finished guest whose end fails offline leaves the start
        // screen usable, and polling finishes the reset when the network returns.
        this.ready = true;
        if (this.current.resetPending) await this.finishReset();
      }
      try {
        await this.loadMenu();
      } catch (e) {
        if (!this.current.order && !this.current.intent) throw e;
      }
      if (this.guest && !this.guest.branchId) await this.resumeSession(this.guest);
      if (this.current.intent) await this.resumeIntent();
      else if (this.current.order) await this.readOrder();
      this.derive();
    }, true);
  private editable() {
    if (this.unsafe() || this.current.order) throw new KioskError('RECOVERY_REQUIRED');
    if (!this.menu) throw new KioskError('CATALOG_UNAVAILABLE');
  }
  private navigate(step: KioskStep) {
    if (!this.ready || this.busy || this.unsafe() || this.current.order) return;
    this.touch();
    this.step = step;
    this.emit();
  }
  start = () =>
    this.run(async () => {
      // The previous guest could not be ended offline; end it before the next one starts.
      if (this.current.resetPending && !this.pending()) await this.finishReset();
      this.editable();
      this.step = 'mode';
      this.touch();
    });
  setMode = (mode: KioskMode) =>
    this.run(async () => {
      this.editable();
      if (!['takeaway', 'dine_in'].includes(mode)) throw new KioskError('INVALID_CART');
      await this.save({ ...this.current, mode, lastActivityAt: this.io.now() });
      this.step = 'menu';
    });
  goMode = () => this.navigate('mode');
  goMenu = () => this.navigate('menu');
  openCart = () => this.navigate('cart');
  openUpsell = () => this.navigate('upsell');
  goLoyalty = () => this.navigate('loyalty');
  openProduct = (productId: string) => {
    if (!this.menu?.products.some((p) => p.id === productId)) return;
    if (!this.ready || this.busy || this.unsafe() || this.current.order) return;
    if (this.step !== 'product')
      this.returnStep = this.step === 'upsell' || this.step === 'cart' ? this.step : 'menu';
    this.selectedId = productId;
    this.editing = null;
    this.navigate('product');
  };
  editLine = (lineId: string) => {
    const line = this.current.cart.find((l) => testLineId(l.productId, l.selections) === lineId);
    const product = line && this.menu?.products.find((p) => p.id === line.productId);
    if (!line || !product || product.available === false) return;
    if (!this.ready || this.busy || this.unsafe() || this.current.order) return;
    if (this.step !== 'product')
      this.returnStep = this.step === 'upsell' || this.step === 'cart' ? this.step : 'menu';
    this.selectedId = line.productId;
    this.editing = {
      lineId,
      productId: line.productId,
      selections: line.selections.map((s) => ({ ...s })),
      quantity: line.quantity,
    };
    this.navigate('product');
  };
  closeProduct = () => {
    if (!this.ready || this.busy || this.unsafe() || this.current.order) return;
    this.editing = null;
    this.navigate(this.returnStep);
  };
  setPaymentMethod = (method: KioskPaymentMethod) => {
    if (
      this.busy ||
      this.unsafe() ||
      this.current.order ||
      method === 'card' ||
      !this.paymentMethods.includes(method)
    )
      return;
    if (method !== this.selectedMethod) this.phone = '';
    this.selectedMethod = method;
    this.touch();
    this.emit();
  };
  setInvoicePhone = (value: string) => {
    if (this.busy || this.unsafe() || this.current.order) return;
    this.phone = value.replace(/[^+\d ()-]/g, '').slice(0, 20);
    this.touch();
    this.emit();
  };
  addToCart = (
    productId: string,
    selections: KioskSelection[],
    quantity = 1,
    replaceLineId?: string,
  ) =>
    this.run(async () => {
      this.editable();
      const product = this.menu!.products.find((p) => p.id === productId);
      if (
        !product ||
        product.available === false ||
        !validSelections(product, selections) ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 20
      )
        throw new KioskError('INVALID_CART');
      const normalized = selections
        .map((s) => ({ ...s }))
        .sort((a, b) =>
          `${a.group_id}:${a.option_id}`.localeCompare(`${b.group_id}:${b.option_id}`),
        );
      const placed = placeLine(this.current.cart, productId, normalized, quantity, replaceLineId);
      if ('error' in placed) throw new KioskError(placed.error);
      await this.save({ ...this.current, cart: placed.cart, lastActivityAt: this.io.now() });
      // An edited line is not a new add: the menu shows no "added" toast for it.
      if (replaceLineId === undefined)
        this.lastAdded = { lineId: placed.lineId, serial: ++this.addSerial };
      this.editing = null;
      // The product page returns where it was opened; upsell (its own step or the cart's
      // inline block) keeps the guest where they are.
      if (this.step === 'product') this.step = this.returnStep;
      else if (this.step !== 'upsell' && this.step !== 'cart') this.step = 'menu';
    });
  updateQuantity = (lineId: string, quantity: number) =>
    this.run(async () => {
      this.editable();
      if (
        !Number.isInteger(quantity) ||
        quantity < 0 ||
        quantity > 20 ||
        !this.current.cart.some((p) => testLineId(p.productId, p.selections) === lineId)
      )
        throw new KioskError('INVALID_CART');
      await this.save({
        ...this.current,
        cart: this.current.cart.flatMap((p) =>
          testLineId(p.productId, p.selections) !== lineId
            ? [p]
            : quantity
              ? [{ ...p, quantity }]
              : [],
        ),
        lastActivityAt: this.io.now(),
      });
    });
  beginPayment = () =>
    this.run(async () => {
      this.editable();
      const displayedTotalMinor = this.snapshot().cartTotalMinor;
      const selected = this.selectedMethod;
      await this.loadMenu();
      if (!this.checkoutReady || !this.paymentMethods.includes(selected))
        throw new KioskError('CHECKOUT_DISABLED');
      const phone = selected === 'kaspi_invoice' ? invoicePhone(this.phone) : null;
      if (selected === 'kaspi_invoice' && !phone) throw new KioskError('INVALID_PHONE');
      const state = this.snapshot();
      if (!this.current.cart.length || !this.current.mode) throw new KioskError('INVALID_CART');
      if (!state.cartValid) {
        // A line was stopped since the review was shown: the cart shows it with a remove action.
        this.step = 'cart';
        throw new KioskError('ITEM_STOPPED');
      }
      const guest = await this.authenticate();
      const intent: Intent = {
        guestId: guest.sessionId,
        quoteKey: this.io.uuid(),
        orderKey: this.io.uuid(),
        paymentKey: this.io.uuid(),
        quoteId: null,
        orderId: null,
        ...(selected === 'kaspi_invoice'
          ? { method: 'kaspi_invoice' as const, phone: phone! }
          : { method: 'kaspi_qr' as const }),
        expectedTotalMinor: displayedTotalMinor,
        payload: {
          items: this.current.cart.map((p) => ({
            quantity: p.quantity,
            selections: p.selections,
            productId: this.menu!.products.find((product) => product.id === p.productId)!.sku!,
          })),
          serviceMode: this.current.mode,
          catalogVersion: Number(this.menu!.catalog_version),
        },
      };
      await this.save({ ...this.current, intent });
      this.phone = '';
      await this.resumeIntent();
      this.derive();
    });
  /** The saved intent can no longer create anything: the guest returns to the review. */
  private async dropIntent(detach: boolean) {
    await this.save({ ...this.current, intent: null });
    this.phone = '';
    if (detach) await this.detachGuest();
    this.step = 'loyalty';
  }
  private async resumeIntent() {
    let intent = this.current.intent;
    if (!intent || !this.guest || intent.guestId !== this.guest.sessionId)
      throw new KioskError('GUEST_IDENTITY_UNAVAILABLE');
    // A previous phone invoice is recovered by reading its order only.
    // Never create another invoice or reinterpret an existing operation as QR.
    if (!intent.method) {
      if (intent.orderId && this.current.order) {
        await this.readOrder();
        await this.save({ ...this.current, intent: null });
        return;
      }
      throw new KioskError('RECOVERY_REQUIRED');
    }
    if (!intent.quoteId) {
      try {
        await this.loadMenu();
        if (!this.checkoutReady) throw new KioskError('CHECKOUT_DISABLED');
        if (!this.snapshot().cartValid) throw new KioskError('ITEM_STOPPED');
        const quote = CustomerQuoteSchema.parse(
          await this.io.request(
            '/quotes',
            this.guest.token,
            {
              key: intent.quoteKey,
              branchId: this.guest.branchId,
              catalog_version: intent.payload.catalogVersion,
              serviceMode: intent.payload.serviceMode,
              items: intent.payload.items,
            },
            intent.quoteKey,
          ),
        );
        if (
          quote.totalMinor !== intent.expectedTotalMinor ||
          quote.serviceMode !== intent.payload.serviceMode
        )
          throw new KioskError('PRICE_CHANGED');
        intent = { ...intent, quoteId: quote.quoteId };
        await this.save({ ...this.current, intent });
      } catch (error) {
        // No quote id was ever saved, so no order can exist for this intent.
        if (error instanceof KioskError && QUOTE_DEFINITIVE.includes(error.code))
          await this.dropIntent(false);
        else if (definitive(error, QUOTE_SESSION_DEFINITIVE)) {
          // The server refuses this guest (expired or unknown session): start another one.
          await this.dropIntent(error instanceof KioskError && error.code === 'FORBIDDEN');
          throw new KioskError('RETRY_PAYMENT');
        }
        throw error;
      }
    }
    if (!intent.orderId) {
      let created: CustomerCommerceOrder;
      try {
        created = CustomerCommerceOrderSchema.parse(
          await this.io.request(
            '/orders',
            this.guest.token,
            { quoteId: intent.quoteId, key: intent.orderKey },
            intent.orderKey,
          ),
        );
      } catch (error) {
        if (definitive(error, ORDER_DEFINITIVE)) {
          await this.dropIntent(false);
          if (definitive(error, ['EXPIRED', 'NOT_FOUND'])) throw new KioskError('RETRY_PAYMENT');
        }
        throw error;
      }
      this.assertOrder(created);
      intent = { ...intent, orderId: created.orderId };
      await this.save({ ...this.current, intent, order: created });
    }
    let order: CustomerCommerceOrder;
    try {
      order = CustomerCommerceOrderSchema.parse(
        await this.io.request(
          `/orders/${intent.orderId}/payment`,
          this.guest.token,
          intent.method === 'kaspi_invoice'
            ? { method: 'kaspi_invoice', phone: intent.phone }
            : { method: 'kaspi_qr' },
          intent.paymentKey,
        ),
      );
    } catch (error) {
      if (definitive(error, PAYMENT_DEFINITIVE)) await this.abandonUnpaidOrder();
      throw error;
    }
    this.assertOrder(order);
    if (order.orderId !== intent.orderId) throw new KioskError('INVALID_RESPONSE');
    await this.save({ ...this.current, intent: null, order });
    this.phone = '';
  }
  /**
   * The server refused to start the first payment attempt (stop, closing time, checkout off).
   * The order has no attempt, so no money can move for it; it stays unpaid on the server and its
   * guest session is left to expire (the server keeps such a session open until then). The guest
   * keeps the cart under a new session and sees why.
   */
  private async abandonUnpaidOrder() {
    await this.save({ ...this.current, intent: null, order: null });
    this.phone = '';
    await this.detachGuest();
    this.step = 'cart';
  }
  private assertOrder(order: CustomerCommerceOrder) {
    if (
      !this.guest ||
      order.branchId !== this.guest.branchId ||
      (this.current.order &&
        (this.current.order.orderId !== order.orderId ||
          (paid(this.current.order) && !paid(order))))
    )
      throw new KioskError('INVALID_RESPONSE');
  }
  private async readOrder() {
    const orderId = this.current.order?.orderId;
    if (!orderId || !this.guest) throw new KioskError('GUEST_IDENTITY_UNAVAILABLE');
    const order = CustomerCommerceOrderSchema.parse(
      await this.io.request(`/orders/${orderId}`, this.guest.token),
    );
    this.assertOrder(order);
    if (order.orderId !== orderId) throw new KioskError('INVALID_RESPONSE');
    await this.save({ ...this.current, order });
  }
  private refreshResult = (background = false) =>
    this.run(
      async () => {
        if (this.current.resetPending) await this.finishReset();
        if (this.current.intent) await this.resumeIntent();
        else if (this.current.order) {
          try {
            await this.readOrder();
          } catch (error) {
            // A missed status read keeps the payment screen (its QR runs on a local clock) or the
            // order screen; only a stored intent or an inconsistent answer needs recovery.
            if (this.blocked || !transient(error)) throw error;
            throw new KioskError(
              background && terminal(this.current.order) ? 'QUIET' : 'CONNECTION_SOFT',
            );
          }
        } else await this.loadMenu();
        this.derive();
      },
      false,
      background,
    );
  /** Background poll; resolves false when nothing was refreshed (the poll backs off). */
  refresh = (): Promise<boolean> => this.refreshResult(true);
  recover = () => (this.initialized ? this.refreshResult() : this.restore());
  pay = async () => false;
  cancelOrder = () =>
    this.run(async () => {
      if ((this.current.order && !terminal(this.current.order)) || this.current.intent)
        throw new KioskError('RECOVERY_REQUIRED');
      await this.reset();
    });
  private async finishReset() {
    if (this.guest) {
      try {
        const ended = await this.io.request('/sessions/end', this.guest.token, {});
        if (!isObject(ended) || ended.ended !== true) throw new KioskError('INVALID_RESPONSE');
      } catch (error) {
        // The server no longer knows this guest (restored database, deleted row, disabled
        // device): there is nothing left to end, so unbind it locally instead of keeping the
        // kiosk stuck on a reset that can never complete.
        if (!(error instanceof KioskError && error.code === 'FORBIDDEN')) throw error;
      }
    }
    await this.io.removeSession();
    this.guest = null;
    await this.save(this.empty());
    this.phone = '';
    this.selectedMethod = 'kaspi';
    this.warning = null;
    this.lastAdded = null;
    this.selectedId = null;
    this.editing = null;
    this.returnStep = 'menu';
    this.step = 'start';
  }
  /**
   * The finished guest is cleared locally first (cart, mode, final order), so a kiosk without
   * WAN shows the start screen instead of keeping the previous guest's draft; ending the server
   * session is retried in the background (resetPending).
   */
  private async reset() {
    await this.save({
      ...this.empty(),
      guestId: this.current.guestId,
      resetPending: true,
    });
    this.warning = null;
    this.lastAdded = null;
    this.phone = '';
    await this.finishReset();
  }
  newGuest = () =>
    this.run(async () => {
      if (this.pending()) throw new KioskError('RECOVERY_REQUIRED');
      if (this.current.resetPending) await this.finishReset();
      else await this.reset();
    });
  touch = () => {
    if (!this.ready || this.unsafe() || this.current.order) return;
    const warned = this.warning !== null;
    this.current = { ...this.current, lastActivityAt: this.io.now() };
    this.warning = null;
    // The countdown dialog closes on any touch, not only on "Continue".
    if (warned) this.emit();
  };
  stay = () => {
    this.touch();
    this.emit();
  };
  tick = async () => {
    if (!this.ready || this.busy || this.step === 'start') return;
    const elapsed = this.io.now() - this.current.lastActivityAt;
    if (this.unsafe() || this.current.order) {
      if (this.current.order?.payment?.kind === 'kaspi_qr') this.emit();
      if (elapsed >= KIOSK_IDLE_MS && this.phone) {
        this.phone = '';
        this.emit();
      }
      return;
    }
    if (elapsed >= KIOSK_IDLE_MS + KIOSK_IDLE_GRACE_MS) {
      await this.newGuest();
      return;
    }
    const warning =
      elapsed >= KIOSK_IDLE_MS
        ? Math.ceil((KIOSK_IDLE_MS + KIOSK_IDLE_GRACE_MS - elapsed) / 1000)
        : null;
    if (warning !== this.warning) {
      this.warning = warning;
      this.emit();
    }
  };
}
