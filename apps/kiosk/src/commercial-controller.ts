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
import { CatalogPayloadSchema } from '@pickchick/catalog-admin/contracts';
import { KioskError } from './api.ts';
import { selectedPriceMinor, validSelections, testLineId } from './cart.ts';
import { KIOSK_IDLE_MS, KIOSK_IDLE_GRACE_MS, type KioskIO } from './controller.ts';
import type {
  KioskCatalog,
  KioskMode,
  KioskSelection,
  KioskState,
  KioskStep,
  KioskPaymentMethod,
} from './model';

export const COMMERCIAL_SESSION_KEY = 'pickchick.kiosk.commercial-session.v1';
export const COMMERCIAL_FLOW_KEY = 'pickchick.kiosk.commercial-flow.v1';
export const KIOSK_DEVICE_KEY = 'pickchick.kiosk.device.v1';
export interface CommercialKioskIO extends KioskIO {
  readDevice(): Promise<string | null>;
}
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
const terminal = (o: CustomerCommerceOrder | null) => paid(o) || o?.phase === 'failed';
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
export function publishedKioskCatalog(value: unknown): KioskCatalog {
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
      name: p.name.ru,
      description: p.description.ru,
      category: payload.categories.find((c) => c.id === p.category_id)!.name.ru,
      price_minor: p.channel_prices_minor?.kiosk ?? p.price_minor,
      image_id: p.image_asset_key,
      available: p.available,
      prep_required: p.prep_required,
      prep_minutes: p.prep_minutes,
      serving_label: p.serving_label.ru || '-',
      ingredients: p.ingredients.ru,
      allergens: p.allergens,
      nutrition: p.nutrition,
      nutrition_provenance: p.nutrition_status,
      modifier_groups: p.modifier_groups.map((g) => ({
        id: g.id,
        title: g.title.ru,
        min: g.min,
        max: g.max,
        options: g.options.map((o) => ({
          id: o.id,
          label: o.label.ru,
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

/** Commercial guest flow has separate storage and cannot invoke simulated payments. */
export class CommercialKioskController {
  private current: Flow;
  private guest: Session | null = null;
  private menu: KioskCatalog | null = null;
  private checkoutReady = false;
  private paymentMethods: ('kaspi' | 'kaspi_invoice')[] = [];
  private selectedMethod: 'kaspi' | 'kaspi_invoice' = 'kaspi';
  private ready = false;
  private busy = false;
  private blocked = false;
  private initialized = false;
  private error: string | null = null;
  private step: KioskStep = 'start';
  private selectedId: string | null = null;
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
  private unsafe() {
    return (
      this.blocked ||
      !!this.current.intent ||
      this.current.resetPending ||
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
      commercial: true,
      checkoutReady: this.checkoutReady,
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
      recoveryRequired:
        this.blocked ||
        !!this.current.intent ||
        this.current.resetPending ||
        order?.phase === 'attention',
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
  private async run(fn: () => Promise<void>, unready = false) {
    if (this.busy || (!this.ready && !unready)) return false;
    this.busy = true;
    this.error = null;
    this.emit();
    try {
      await fn();
      return true;
    } catch (error) {
      this.error =
        error instanceof KioskError && error.code === 'PRICE_CHANGED'
          ? 'Сумма изменилась. Проверьте корзину и подтвердите оплату заново.'
          : error instanceof KioskError &&
              ['INVALID', 'CONFLICT', 'ITEM_STOPPED'].includes(error.code)
            ? 'Состав или цена изменились. Проверьте корзину и выберите доступные позиции.'
            : error instanceof KioskError &&
                [
                  'NOT_READY',
                  'AVAILABILITY_STALE',
                  'RESTAURANT_CLOSED',
                  'CHECKOUT_DISABLED',
                ].includes(error.code)
              ? 'Ресторан пока не принимает заказы. Обновите меню или пригласите сотрудника.'
              : error instanceof KioskError && error.code === 'DEVICE_NOT_PROVISIONED'
                ? 'Киоск не настроен. Пригласите сотрудника.'
                : error instanceof KioskError && error.code === 'INVALID_PHONE'
                  ? 'Введите номер Казахстана для счёта Kaspi.'
                  : this.blocked || this.current.intent || this.current.order
                    ? 'Не удалось проверить результат. Пригласите сотрудника, не оплачивайте повторно.'
                    : !this.menu
                      ? 'Не удалось загрузить меню. Проверьте подключение и повторите попытку.'
                      : 'Не удалось выполнить действие. Проверьте подключение и повторите попытку.';
      if (this.unsafe()) this.step = 'recovery';
      return false;
    } finally {
      this.busy = false;
      this.emit();
    }
  }
  private async device() {
    if (!(await this.io.readDevice())) throw new KioskError('DEVICE_NOT_PROVISIONED');
  }
  private async loadMenu() {
    this.checkoutReady = false;
    await this.device();
    const guest = await this.authenticate();
    const config = await this.io.request('/config', guest.token);
    if (
      !isObject(config) ||
      typeof config.enabled !== 'boolean' ||
      !['kaspi_qr', 'kaspi_invoice'].includes(String(config.paymentMethod)) ||
      !id(config.branchId)
    )
      throw new KioskError('CHECKOUT_DISABLED');
    const methods = config.paymentMethods ?? [config.paymentMethod];
    if (
      !Array.isArray(methods) ||
      methods.length > 2 ||
      new Set(methods).size !== methods.length ||
      methods.some((m) => !['kaspi_qr', 'kaspi_invoice'].includes(m))
    )
      throw new KioskError('INVALID_RESPONSE');
    this.paymentMethods = methods.map((m) => (m === 'kaspi_qr' ? 'kaspi' : 'kaspi_invoice'));
    if (
      !this.current.intent &&
      !this.current.order &&
      !this.paymentMethods.includes(this.selectedMethod)
    ) {
      this.selectedMethod = this.paymentMethods[0] ?? 'kaspi';
      this.phone = '';
    }
    const next = publishedKioskCatalog(await this.io.request('/catalog', guest.token));
    if (
      next.branch_id !== config.branchId ||
      (this.guest?.branchId && next.branch_id !== this.guest.branchId)
    )
      throw new KioskError('INVALID_RESPONSE');
    const availability = await this.io.request('/availability', guest.token);
    if (
      !isObject(availability) ||
      typeof availability.fresh !== 'boolean' ||
      !Array.isArray(availability.products) ||
      availability.products.length > 100
    )
      throw new KioskError('INVALID_RESPONSE');
    const observed = new Set<string>();
    for (const entry of availability.products) {
      if (
        !isObject(entry) ||
        typeof entry.productId !== 'string' ||
        typeof entry.available !== 'boolean' ||
        !Array.isArray(entry.stoppedOptions) ||
        entry.stoppedOptions.some(
          (o) => !isObject(o) || typeof o.group_id !== 'string' || typeof o.option_id !== 'string',
        ) ||
        observed.has(entry.productId)
      )
        throw new KioskError('INVALID_RESPONSE');
      const stoppedOptions = entry.stoppedOptions as { group_id: string; option_id: string }[];
      const product = next.products.find((p) => p.id === entry.productId);
      if (!product) throw new KioskError('INVALID_RESPONSE');
      observed.add(entry.productId);
      product.available = product.available !== false && entry.available && availability.fresh;
      product.modifier_groups = product.modifier_groups.map((g) => ({
        ...g,
        options: g.options.map((o) => ({
          ...o,
          available:
            o.available &&
            !stoppedOptions.some(
              (stop) =>
                (stop as { group_id: string; option_id: string }).group_id === g.id &&
                (stop as { group_id: string; option_id: string }).option_id === o.id,
            ),
        })),
      }));
    }
    if (next.products.some((p) => !observed.has(p.id))) throw new KioskError('AVAILABILITY_STALE');
    this.menu = next;
    if (!availability.fresh) throw new KioskError('AVAILABILITY_STALE');
    this.checkoutReady = config.enabled;
  }
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
        const ended = await this.io.request('/sessions/end', this.guest.token, {});
        if (!isObject(ended) || ended.ended !== true) throw new KioskError('INVALID_RESPONSE');
        // Detach before removing the credential: a crash can retry the old end,
        // or allocate the next session, without losing the unsubmitted draft.
        await this.save({ ...this.current, guestId: null });
        await this.io.removeSession();
        this.guest = null;
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
  private derive() {
    this.step =
      this.blocked || this.current.intent || this.current.resetPending
        ? 'recovery'
        : this.current.order
          ? terminal(this.current.order)
            ? 'order'
            : 'payment'
          : this.current.mode
            ? 'menu'
            : 'start';
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
        if (this.current.resetPending) await this.finishReset();
        else if (
          (this.guest && this.guest.sessionId !== this.current.guestId) ||
          ((this.current.order || this.current.intent) && !this.guest)
        )
          throw new KioskError('GUEST_IDENTITY_UNAVAILABLE');
        this.blocked = false;
        this.initialized = true;
        this.ready = true;
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
    this.selectedId = productId;
    this.navigate('product');
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
  addToCart = (productId: string, selections: KioskSelection[], quantity = 1) =>
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
      const old = this.current.cart.find(
        (p) => testLineId(p.productId, p.selections) === testLineId(productId, normalized),
      );
      const total = (old?.quantity ?? 0) + quantity;
      if (total > 20 || (!old && this.current.cart.length >= 11))
        throw new KioskError('INVALID_CART');
      const next = { productId, selections: normalized, quantity: total };
      await this.save({
        ...this.current,
        cart: old
          ? this.current.cart.map((p) => (p === old ? next : p))
          : [...this.current.cart, next],
        lastActivityAt: this.io.now(),
      });
      if (this.step !== 'upsell') this.step = 'menu';
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
      if (!state.cartValid || !state.cart.length || !this.current.mode)
        throw new KioskError('INVALID_CART');
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
        if (
          error instanceof KioskError &&
          [
            'INVALID',
            'CONFLICT',
            'NOT_READY',
            'ITEM_STOPPED',
            'AVAILABILITY_STALE',
            'RESTAURANT_CLOSED',
            'CHECKOUT_DISABLED',
            'PRICE_CHANGED',
          ].includes(error.code)
        ) {
          await this.save({ ...this.current, intent: null });
          this.phone = '';
          this.step = 'loyalty';
        }
        throw error;
      }
    }
    if (!intent.orderId) {
      const order = CustomerCommerceOrderSchema.parse(
        await this.io.request(
          '/orders',
          this.guest.token,
          { quoteId: intent.quoteId, key: intent.orderKey },
          intent.orderKey,
        ),
      );
      this.assertOrder(order);
      intent = { ...intent, orderId: order.orderId };
      await this.save({ ...this.current, intent, order });
    }
    const order = CustomerCommerceOrderSchema.parse(
      await this.io.request(
        `/orders/${intent.orderId}/payment`,
        this.guest.token,
        intent.method === 'kaspi_invoice'
          ? { method: 'kaspi_invoice', phone: intent.phone }
          : { method: 'kaspi_qr' },
        intent.paymentKey,
      ),
    );
    this.assertOrder(order);
    if (order.orderId !== intent.orderId) throw new KioskError('INVALID_RESPONSE');
    await this.save({ ...this.current, intent: null, order });
    this.phone = '';
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
  private refreshResult = () =>
    this.run(async () => {
      if (this.current.resetPending) {
        await this.finishReset();
        return;
      }
      if (this.current.intent) await this.resumeIntent();
      else if (this.current.order) await this.readOrder();
      else {
        await this.loadMenu();
      }
      this.derive();
    });
  refresh = async (): Promise<void> => {
    await this.refreshResult();
  };
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
      const ended = await this.io.request('/sessions/end', this.guest.token, {});
      if (!isObject(ended) || ended.ended !== true) throw new KioskError('INVALID_RESPONSE');
    }
    await this.io.removeSession();
    this.guest = null;
    await this.save(this.empty());
    this.phone = '';
    this.selectedMethod = 'kaspi';
    this.warning = null;
    this.step = 'start';
  }
  private async reset() {
    await this.save({ ...this.current, resetPending: true });
    await this.finishReset();
  }
  newGuest = () =>
    this.run(async () => {
      if (this.unsafe()) throw new KioskError('RECOVERY_REQUIRED');
      await this.reset();
    });
  touch = () => {
    if (!this.ready || this.unsafe() || this.current.order) return;
    this.current = { ...this.current, lastActivityAt: this.io.now() };
    this.warning = null;
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
