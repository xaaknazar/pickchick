import {
  TestCompleteCatalogSchema,
  TestCompleteCartSchema,
  TestCompleteQuoteSchema,
  TestOrderSchema,
  TestOrdersSchema,
  TestSessionSchema,
  TestPaymentSchema,
  TestCancellationSchema,
  testLineId,
} from '@pickchick/test-order-flow/contracts';
import type {
  TestCompleteCatalog,
  TestOrder,
  TestSession,
} from '@pickchick/test-order-flow/contracts';
import { KioskError } from './api.ts';
import { selectedPriceMinor, validSelections } from './cart.ts';
import type {
  KioskErrorCode,
  KioskMode,
  KioskPaymentMethod,
  KioskSelection,
  KioskState,
  KioskStep,
} from './model';

export const KIOSK_SESSION_KEY = 'pickchick.kiosk.guest-session.v1';
export const KIOSK_FLOW_KEY = 'pickchick.kiosk.guest-flow.v1';
export const KIOSK_IDLE_MS = 90000;
export const KIOSK_IDLE_GRACE_MS = 15000;
export interface KioskIO {
  readSession(): Promise<string | null>;
  writeSession(raw: string): Promise<void>;
  removeSession(): Promise<void>;
  readFlow(): Promise<string | null>;
  writeFlow(raw: string): Promise<void>;
  request(path: string, token?: string, body?: unknown, key?: string): Promise<unknown>;
  now(): number;
  uuid(): string;
}
type Payload = ReturnType<typeof TestCompleteCartSchema.parse>;
type StoredLine = { productId: string; quantity: number; selections: KioskSelection[] };
type CreateIntent = {
  kind: 'create';
  sessionId: string;
  payload: Payload;
  quoteKey: string;
  orderKey: string;
  quoteId: string | null;
};
type CommandIntent = {
  kind: 'command';
  sessionId: string;
  orderId: string;
  key: string;
  expectedVersion: number;
  action: 'simulated-payment' | 'cancel';
  value: { outcome: 'approved' | 'declined' | 'unknown' } | { reason: string };
};
interface StoredFlow {
  version: 1;
  guestId: string | null;
  resetPending: boolean;
  mode: KioskMode | null;
  cart: StoredLine[];
  paymentMethod: KioskPaymentMethod;
  order: TestOrder | null;
  pending: CreateIntent | CommandIntent | null;
  lastActivityAt: number;
}
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string) =>
  Object.keys(v).sort().join(',') === names.split(',').sort().join(',');
function decoded(raw: string, limit = 200000): unknown {
  if (raw.length > limit) throw new KioskError('RECOVERY_DATA_INVALID');
  try {
    return JSON.parse(raw);
  } catch {
    throw new KioskError('RECOVERY_DATA_INVALID');
  }
}
function parseOrder(value: unknown): TestOrder {
  const result = TestOrderSchema.safeParse(value);
  if (
    !result.success ||
    result.data.snapshot.channel !== 'kiosk' ||
    result.data.snapshot.catalog_version !== 'mockup-v0.3'
  )
    throw new KioskError('INVALID_RESPONSE');
  return result.data;
}
function parseFlow(raw: string): StoredFlow {
  const v = decoded(raw);
  if (
    !obj(v) ||
    !keys(v, 'version,guestId,resetPending,mode,cart,paymentMethod,order,pending,lastActivityAt') ||
    v.version !== 1 ||
    !(v.guestId === null || uuid(v.guestId)) ||
    typeof v.resetPending !== 'boolean' ||
    ![null, 'takeaway', 'dine_in'].includes(v.mode as null) ||
    !['kaspi', 'card'].includes(String(v.paymentMethod)) ||
    !Array.isArray(v.cart) ||
    v.cart.length > 11 ||
    !Number.isSafeInteger(v.lastActivityAt) ||
    Number(v.lastActivityAt) < 1
  )
    throw new KioskError('RECOVERY_DATA_INVALID');
  if (v.cart.some((line) => !obj(line) || !keys(line, 'productId,quantity,selections')))
    throw new KioskError('RECOVERY_DATA_INVALID');
  if (
    v.cart.length &&
    !TestCompleteCartSchema.safeParse({
      catalog_version: 'mockup-v0.3',
      service_mode: v.mode ?? 'takeaway',
      payment_method: v.paymentMethod,
      items: v.cart.map((line) => ({
        product_id: line.productId,
        quantity: line.quantity,
        selections: line.selections,
      })),
    }).success
  )
    throw new KioskError('RECOVERY_DATA_INVALID');
  const order = v.order === null ? null : parseOrder(v.order);
  const p = v.pending;
  if (p !== null) {
    if (!obj(p) || !uuid(p.sessionId) || p.sessionId !== v.guestId)
      throw new KioskError('RECOVERY_DATA_INVALID');
    if (p.kind === 'create') {
      if (
        !keys(p, 'kind,sessionId,payload,quoteKey,orderKey,quoteId') ||
        !uuid(p.quoteKey) ||
        !uuid(p.orderKey) ||
        !(p.quoteId === null || uuid(p.quoteId)) ||
        !TestCompleteCartSchema.safeParse(p.payload).success ||
        order
      )
        throw new KioskError('RECOVERY_DATA_INVALID');
    } else if (p.kind === 'command') {
      if (
        !keys(p, 'kind,sessionId,orderId,key,expectedVersion,action,value') ||
        !uuid(p.key) ||
        !uuid(p.orderId) ||
        !order ||
        order.order_id !== p.orderId ||
        !obj(p.value) ||
        !keys(p.value, p.action === 'cancel' ? 'reason' : 'outcome') ||
        !['simulated-payment', 'cancel'].includes(String(p.action))
      )
        throw new KioskError('RECOVERY_DATA_INVALID');
      const schema = p.action === 'simulated-payment' ? TestPaymentSchema : TestCancellationSchema;
      if (!schema.safeParse({ expected_version: p.expectedVersion, ...p.value }).success)
        throw new KioskError('RECOVERY_DATA_INVALID');
    } else throw new KioskError('RECOVERY_DATA_INVALID');
  }
  if ((order || p) && !v.guestId) throw new KioskError('RECOVERY_DATA_INVALID');
  if (
    v.resetPending &&
    (p || (order && order.payment_state !== 'simulated_approved' && order.state !== 'cancelled'))
  )
    throw new KioskError('RECOVERY_DATA_INVALID');
  return { ...v, order } as unknown as StoredFlow;
}
function message(error: unknown): string {
  if (error instanceof KioskError) {
    if (error.code === 'RECOVERY_DATA_INVALID' || error.code === 'GUEST_IDENTITY_UNAVAILABLE')
      return 'Данные прежнего гостя требуют проверки сотрудником. Новый заказ пока недоступен.';
    if (error.code === 'RECOVERY_REQUIRED')
      return 'Сначала уточните результат прежнего заказа. Нового гостя пока не начинаем.';
    if (error.code === 'INVALID_CART' || error.code === 'INVALID_SELECTIONS')
      return 'Проверьте состав и количество выбранных позиций.';
    if (error.code === 'CART_LIMIT_LINE') return 'Одной позиции можно добавить не больше 20 штук.';
    if (error.code === 'CART_LIMIT_LINES')
      return 'В корзине может быть не больше 11 разных позиций.';
    if (error.status === 401)
      return 'Доступ киоска недоступен. Обратитесь к сотруднику; заказ сохраняется.';
    if (error.status === 429)
      return 'Временный лимит тестового контура. Заказ сохранён, попробуйте позже.';
  }
  return 'Не удалось получить или сохранить результат. Проверьте связь и восстановите заказ; повторно не оплачивайте.';
}

/** Durable guest state; never sends a telephone, nickname or loyalty claim. */
export class KioskController {
  private io: KioskIO;
  private flow: StoredFlow;
  private session: TestSession | null = null;
  private catalog: TestCompleteCatalog | null = null;
  private catalogObservedAt = 0;
  private ready = false;
  private busy = false;
  private error: string | null = null;
  private errorCode: KioskErrorCode | null = null;
  private blocked = false;
  private restoreDone = false;
  private step: KioskStep = 'start';
  private selectedId: string | null = null;
  /** Where the product page was opened from; adding or closing returns there. */
  private returnStep: KioskStep = 'menu';
  private lastAdded: { lineId: string; serial: number } | null = null;
  private addSerial = 0;
  private idleWarningSeconds: number | null = null;
  private listeners = new Set<() => void>();
  private view: KioskState;
  constructor(io: KioskIO) {
    this.io = io;
    this.flow = this.empty();
    this.view = this.snapshot();
  }
  private empty(): StoredFlow {
    return {
      version: 1,
      guestId: null,
      resetPending: false,
      mode: null,
      cart: [],
      paymentMethod: 'kaspi',
      order: null,
      pending: null,
      lastActivityAt: this.io.now(),
    };
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.view;
  private unsafe(): boolean {
    return (
      this.blocked ||
      !!this.flow.pending ||
      this.flow.resetPending ||
      this.flow.order?.payment_state === 'simulated_unknown'
    );
  }
  private snapshot(): KioskState {
    const unavailableCartLines: KioskState['unavailableCartLines'] = [];
    const cart = this.flow.cart.flatMap((line) => {
      const product = this.catalog?.products.find((p) => p.id === line.productId);
      if (!product || !validSelections(product, line.selections)) {
        unavailableCartLines.push({
          lineId: testLineId(line.productId, line.selections),
          productId: line.productId,
          quantity: line.quantity,
        });
        return [];
      }
      const unitPriceMinor = selectedPriceMinor(product, line.selections);
      return [
        {
          ...line,
          product,
          lineId: testLineId(line.productId, line.selections),
          unitPriceMinor,
          lineTotalMinor: (BigInt(unitPriceMinor) * BigInt(line.quantity)).toString(),
        },
      ];
    });
    return {
      ready: this.ready,
      busy: this.busy,
      error: this.error,
      errorCode: this.errorCode,
      lastAdded: this.lastAdded,
      catalog: this.catalog,
      step: this.step,
      mode: this.flow.mode,
      cart,
      unavailableCartLines,
      cartValid: !!this.catalog && unavailableCartLines.length === 0,
      cartTotalMinor: cart.reduce((sum, line) => sum + BigInt(line.lineTotalMinor), 0n).toString(),
      selectedProduct: this.catalog?.products.find((p) => p.id === this.selectedId) ?? null,
      paymentMethod: this.flow.paymentMethod,
      order: this.flow.order,
      recoveryRequired: this.unsafe(),
      idleWarningSeconds: this.idleWarningSeconds,
    };
  }
  private emit() {
    this.view = this.snapshot();
    for (const listener of this.listeners) listener();
  }
  private async persist(next: StoredFlow) {
    await this.io.writeFlow(JSON.stringify(next));
    this.flow = next;
  }
  private async run(operation: () => Promise<void>, allowUnready = false): Promise<boolean> {
    if (this.busy || (!this.ready && !allowUnready)) return false;
    this.busy = true;
    this.error = null;
    this.errorCode = null;
    this.emit();
    try {
      await operation();
      return true;
    } catch (error) {
      this.error = message(error);
      this.errorCode =
        error instanceof KioskError &&
        (error.code === 'CART_LIMIT_LINE' || error.code === 'CART_LIMIT_LINES')
          ? error.code
          : null;
      if (this.unsafe()) this.step = 'recovery';
      return false;
    } finally {
      this.busy = false;
      this.emit();
    }
  }
  private assertEditable() {
    if (this.unsafe() || this.flow.order) throw new KioskError('RECOVERY_REQUIRED');
    if (!this.catalog) throw new KioskError('CATALOG_UNAVAILABLE');
  }
  /** The step the stored state requires; a browsing guest stays on their screen. */
  private deriveStep() {
    const shown = this.step;
    this.step = this.unsafe()
      ? 'recovery'
      : this.flow.order
        ? this.flow.order.state === 'awaiting_test_payment'
          ? 'payment'
          : 'order'
        : this.flow.mode
          ? (['menu', 'product', 'upsell', 'cart', 'loyalty'] as KioskStep[]).includes(shown)
            ? shown
            : 'menu'
          : shown === 'mode'
            ? 'mode'
            : 'start';
  }
  private async loadCatalog() {
    const cap = await this.io.request('/capabilities');
    if (
      !obj(cap) ||
      cap.schema_version !== 1 ||
      cap.environment !== 'staging' ||
      cap.data_mode !== 'synthetic' ||
      cap.ordering_enabled !== false ||
      !obj(cap.features) ||
      cap.features.test_order_flow !== true ||
      ['phone_auth', 'payments', 'fiscal', 'checkout', 'loyalty'].some(
        (key) => cap.features && (cap.features as Record<string, unknown>)[key] !== false,
      )
    )
      throw new KioskError('UNSUPPORTED_ENVIRONMENT');
    this.catalog = TestCompleteCatalogSchema.parse(await this.io.request('/catalog'));
    this.catalogObservedAt = this.io.now();
  }
  restore = async (): Promise<boolean> =>
    this.run(async () => {
      if (!this.restoreDone) {
        this.blocked = true;
        const [rawSession, rawFlow] = await Promise.all([
          this.io.readSession(),
          this.io.readFlow(),
        ]);
        const next = rawFlow ? parseFlow(rawFlow) : this.empty();
        const parsed = rawSession ? TestSessionSchema.safeParse(decoded(rawSession, 2000)) : null;
        if (parsed && (!parsed.success || parsed.data.channel !== 'kiosk'))
          throw new KioskError('GUEST_IDENTITY_UNAVAILABLE');
        const session = parsed?.success ? parsed.data : null;
        this.flow = next;
        this.session = session;
        if (next.resetPending) await this.finishReset();
        else if (
          (next.guestId && next.guestId !== session?.session_id) ||
          ((next.pending || next.order) && !session)
        )
          throw new KioskError('GUEST_IDENTITY_UNAVAILABLE');
        else if (session && !next.guestId)
          await this.persist({ ...next, guestId: session.session_id });
        this.blocked = !!this.session;
        this.restoreDone = true;
        this.ready = true;
        this.deriveStep();
      }
      // Catalog failure never erases the guest or a pending command.
      try {
        await this.loadCatalog();
      } catch (error) {
        this.error = message(error);
      }
      if (this.session) await this.observeRemote();
    }, true);
  private async authenticate(): Promise<TestSession> {
    if (this.session) {
      if (Date.parse(this.session.expires_at) <= this.io.now())
        throw new KioskError('SESSION_EXPIRED', 401);
      if (this.flow.guestId && this.flow.guestId !== this.session.session_id)
        throw new KioskError('GUEST_IDENTITY_UNAVAILABLE');
      if (!this.flow.guestId)
        await this.persist({ ...this.flow, guestId: this.session.session_id });
      return this.session;
    }
    if (this.flow.pending || this.flow.order || this.flow.guestId)
      throw new KioskError('GUEST_IDENTITY_UNAVAILABLE');
    const candidate = TestSessionSchema.parse(
      await this.io.request('/sessions', undefined, { channel: 'kiosk' }),
    );
    if (candidate.channel !== 'kiosk') throw new KioskError('INVALID_RESPONSE');
    await this.io.writeSession(JSON.stringify(candidate));
    this.session = candidate;
    await this.persist({ ...this.flow, guestId: candidate.session_id });
    return candidate;
  }
  touch = () => {
    if (!this.ready || this.busy || this.unsafe() || this.flow.order) return;
    this.flow = { ...this.flow, lastActivityAt: this.io.now() };
    if (this.idleWarningSeconds === null) return;
    this.idleWarningSeconds = null;
    this.emit();
  };
  stay = () => this.touch();
  tick = async (): Promise<void> => {
    if (!this.ready || this.busy || this.unsafe() || this.flow.order || this.step === 'start')
      return;
    const elapsed = this.io.now() - this.flow.lastActivityAt;
    if (elapsed >= KIOSK_IDLE_MS + KIOSK_IDLE_GRACE_MS) {
      await this.newGuest();
      return;
    }
    const seconds =
      elapsed >= KIOSK_IDLE_MS
        ? Math.ceil((KIOSK_IDLE_MS + KIOSK_IDLE_GRACE_MS - elapsed) / 1000)
        : null;
    if (seconds !== this.idleWarningSeconds) {
      this.idleWarningSeconds = seconds;
      this.emit();
    }
  };
  start = () =>
    this.run(async () => {
      this.assertEditable();
      await this.persist({ ...this.flow, lastActivityAt: this.io.now() });
      this.idleWarningSeconds = null;
      this.step = 'mode';
    });
  setMode = (mode: KioskMode) =>
    this.run(async () => {
      this.assertEditable();
      if (!['takeaway', 'dine_in'].includes(mode)) throw new KioskError('INVALID_CART');
      await this.persist({ ...this.flow, mode, lastActivityAt: this.io.now() });
      this.step = 'menu';
    });
  private navigate(step: KioskStep) {
    if (!this.ready || this.busy || this.unsafe() || this.flow.order) return;
    this.touch();
    this.step = step;
    this.emit();
  }
  goMode = () => this.navigate('mode');
  goMenu = () => this.navigate('menu');
  openCart = () => this.navigate('cart');
  openUpsell = () => this.navigate('upsell');
  goLoyalty = () => {
    if (this.flow.cart.length) this.navigate('loyalty');
  };
  openProduct = (id: string) => {
    if (!this.catalog?.products.some((p) => p.id === id)) return;
    if (!this.ready || this.busy || this.unsafe() || this.flow.order) return;
    if (this.step !== 'product')
      this.returnStep = this.step === 'upsell' || this.step === 'cart' ? this.step : 'menu';
    this.selectedId = id;
    this.navigate('product');
  };
  closeProduct = () => this.navigate(this.returnStep);
  setPaymentMethod = (method: KioskPaymentMethod) => {
    if (
      !this.ready ||
      !['kaspi', 'card'].includes(method) ||
      this.unsafe() ||
      this.flow.order ||
      this.busy
    )
      return;
    void this.run(async () => {
      await this.persist({ ...this.flow, paymentMethod: method, lastActivityAt: this.io.now() });
    });
  };
  addToCart = (productId: string, selections: KioskSelection[], quantity = 1) =>
    this.run(async () => {
      this.assertEditable();
      const product = this.catalog!.products.find((p) => p.id === productId);
      if (
        !product ||
        !validSelections(product, selections) ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 20
      )
        throw new KioskError('INVALID_SELECTIONS');
      const normalized = [...selections]
        .map((s) => ({ ...s }))
        .sort((a, b) =>
          `${a.group_id}:${a.option_id}`.localeCompare(`${b.group_id}:${b.option_id}`),
        );
      const lineId = testLineId(productId, normalized),
        old = this.flow.cart.find((line) => testLineId(line.productId, line.selections) === lineId);
      const nextQuantity = (old?.quantity ?? 0) + quantity;
      if (nextQuantity > 20) throw new KioskError('CART_LIMIT_LINE');
      if (!old && this.flow.cart.length >= 11) throw new KioskError('CART_LIMIT_LINES');
      const line = { productId, selections: normalized, quantity: nextQuantity };
      const cart = old
        ? this.flow.cart.map((entry) => (entry === old ? line : entry))
        : [...this.flow.cart, line];
      await this.persist({ ...this.flow, cart, lastActivityAt: this.io.now() });
      this.lastAdded = { lineId, serial: ++this.addSerial };
      // The product page returns where it was opened; upsell (its own step or the cart's
      // inline block) keeps the guest where they are.
      if (this.step === 'product') this.step = this.returnStep;
      else if (this.step !== 'upsell' && this.step !== 'cart') this.step = 'menu';
    });
  updateQuantity = (id: string, quantity: number) =>
    this.run(async () => {
      this.assertEditable();
      if (
        !Number.isInteger(quantity) ||
        quantity < 0 ||
        quantity > 20 ||
        !this.flow.cart.some((line) => testLineId(line.productId, line.selections) === id)
      )
        throw new KioskError('INVALID_CART');
      const cart = this.flow.cart.flatMap((line) =>
        testLineId(line.productId, line.selections) === id
          ? quantity
            ? [{ ...line, quantity }]
            : []
          : [line],
      );
      await this.persist({ ...this.flow, cart, lastActivityAt: this.io.now() });
    });
  private payload(method: KioskPaymentMethod): Payload {
    if (
      !this.flow.mode ||
      this.flow.cart.some((line) => {
        const product = this.catalog?.products.find((p) => p.id === line.productId);
        return !product || !validSelections(product, line.selections);
      })
    )
      throw new KioskError('INVALID_CART');
    return TestCompleteCartSchema.parse({
      catalog_version: 'mockup-v0.3',
      service_mode: this.flow.mode,
      payment_method: method,
      items: this.flow.cart
        .map((line) => ({
          product_id: line.productId,
          quantity: line.quantity,
          selections: line.selections,
        }))
        .sort((a, b) =>
          testLineId(a.product_id, a.selections).localeCompare(
            testLineId(b.product_id, b.selections),
          ),
        ),
    });
  }
  beginPayment = (method = this.flow.paymentMethod) =>
    this.run(async () => {
      this.assertEditable();
      await this.loadCatalog();
      const payload = this.payload(method);
      const session = await this.authenticate();
      const pending: CreateIntent = {
        kind: 'create',
        sessionId: session.session_id,
        payload,
        quoteKey: this.io.uuid(),
        orderKey: this.io.uuid(),
        quoteId: null,
      };
      await this.persist({ ...this.flow, paymentMethod: method, pending });
      await this.sendCreate(pending, session);
    });
  private async sendCreate(pending: CreateIntent, session: TestSession): Promise<void> {
    if (pending.sessionId !== session.session_id)
      throw new KioskError('GUEST_IDENTITY_UNAVAILABLE');
    if (!pending.quoteId) {
      let response: unknown;
      try {
        response = await this.io.request(
          '/quotes',
          session.token,
          pending.payload,
          pending.quoteKey,
        );
      } catch (error) {
        if (
          error instanceof KioskError &&
          error.status === 400 &&
          error.code === 'INVALID_REQUEST'
        ) {
          // No order request has occurred. A rejected quote can safely return to editing.
          await this.persist({ ...this.flow, pending: null });
          this.step = 'cart';
        }
        throw error;
      }
      const quote = TestCompleteQuoteSchema.parse(response);
      if (
        quote.channel !== 'kiosk' ||
        quote.service_mode !== pending.payload.service_mode ||
        quote.payment_method !== pending.payload.payment_method
      )
        throw new KioskError('INVALID_RESPONSE');
      pending = { ...pending, quoteId: quote.quote_id };
      await this.persist({ ...this.flow, pending });
    }
    let order: TestOrder;
    try {
      order = parseOrder(
        await this.io.request(
          '/orders',
          session.token,
          { quote_id: pending.quoteId },
          pending.orderKey,
        ),
      );
    } catch (error) {
      if (error instanceof KioskError && error.code === 'QUOTE_EXPIRED') {
        // This authoritative rejection means no order exists for the replayed key.
        await this.persist({
          ...this.flow,
          pending: {
            ...pending,
            quoteId: null,
            quoteKey: this.io.uuid(),
            orderKey: this.io.uuid(),
          },
        });
      }
      throw error;
    }
    if (order.snapshot.quote_id !== pending.quoteId) throw new KioskError('INVALID_RESPONSE');
    await this.persist({ ...this.flow, order, pending: null });
    this.deriveStep();
  }
  private async acceptObserved(order: TestOrder, clearPending = false) {
    const old = this.flow.order;
    if (old && old.order_id !== order.order_id) throw new KioskError('UNEXPECTED_ORDER');
    const selected = old && old.version > order.version ? old : order;
    await this.persist({
      ...this.flow,
      order: selected,
      pending: clearPending ? null : this.flow.pending,
    });
    this.deriveStep();
  }
  private async observeRemote() {
    if (!this.session) return;
    const session = await this.authenticate();
    const orders = TestOrdersSchema.parse(
      await this.io.request('/orders', session.token),
    ).orders.map(parseOrder);
    if (orders.length > 1) {
      this.blocked = true;
      throw new KioskError('GUEST_IDENTITY_UNAVAILABLE');
    }
    const pending = this.flow.pending;
    const order =
      orders.find(
        (o) =>
          o.order_id === this.flow.order?.order_id ||
          (pending?.kind === 'create' && o.snapshot.quote_id === pending.quoteId),
      ) ?? (!this.flow.order && !pending ? orders[0] : undefined);
    if (!order) {
      if (this.flow.order) throw new KioskError('ORDER_OBSERVATION_UNAVAILABLE');
      this.blocked = false;
      this.deriveStep();
      return;
    }
    const cleared =
      (pending?.kind === 'create' && order.snapshot.quote_id === pending.quoteId) ||
      (pending?.kind === 'command' &&
        order.order_id === pending.orderId &&
        order.version > pending.expectedVersion);
    await this.acceptObserved(order, !!cleared);
    this.blocked = false;
    this.deriveStep();
  }
  refresh = async (): Promise<void> => {
    await this.run(async () => {
      if (!this.restoreDone) throw new KioskError('GUEST_IDENTITY_UNAVAILABLE');
      if (!this.catalog || this.io.now() - this.catalogObservedAt >= 60000) {
        try {
          await this.loadCatalog();
        } catch (error) {
          if (!this.session) throw error;
          this.error = message(error);
        }
      }
      await this.observeRemote();
    });
  };
  private command(action: CommandIntent['action'], value: CommandIntent['value']) {
    return this.run(async () => {
      if (this.unsafe() || !this.flow.order) throw new KioskError('RECOVERY_REQUIRED');
      const order = this.flow.order;
      if (action === 'cancel' && ['cancelled', 'fulfilled'].includes(order.state))
        throw new KioskError('RECOVERY_REQUIRED');
      const schema = action === 'cancel' ? TestCancellationSchema : TestPaymentSchema;
      schema.parse({ expected_version: order.version, ...value });
      if (
        action === 'simulated-payment' &&
        (order.state !== 'awaiting_test_payment' ||
          !['not_started', 'simulated_declined'].includes(order.payment_state))
      )
        throw new KioskError('RECOVERY_REQUIRED');
      const session = await this.authenticate();
      const pending: CommandIntent = {
        kind: 'command',
        sessionId: session.session_id,
        orderId: order.order_id,
        key: this.io.uuid(),
        expectedVersion: order.version,
        action,
        value,
      };
      await this.persist({ ...this.flow, pending });
      await this.sendCommand(pending, session);
    });
  }
  pay = (outcome: 'approved' | 'declined' | 'unknown') =>
    this.command('simulated-payment', { outcome });
  cancelOrder = () => this.command('cancel', { reason: 'Гость отменил тестовый заказ на киоске' });
  private async sendCommand(pending: CommandIntent, session: TestSession) {
    if (pending.sessionId !== session.session_id)
      throw new KioskError('GUEST_IDENTITY_UNAVAILABLE');
    const order = parseOrder(
      await this.io.request(
        `/orders/${pending.orderId}/${pending.action}`,
        session.token,
        { expected_version: pending.expectedVersion, ...pending.value },
        pending.key,
      ),
    );
    if (order.order_id !== pending.orderId || order.version <= pending.expectedVersion)
      throw new KioskError('INVALID_RESPONSE');
    await this.acceptObserved(order, true);
  }
  recover = (): Promise<boolean> =>
    !this.restoreDone
      ? this.restore()
      : this.run(async () => {
          if (!this.restoreDone) throw new KioskError('GUEST_IDENTITY_UNAVAILABLE');
          if (this.flow.resetPending) {
            await this.finishReset();
            return;
          }
          if (!this.catalog) {
            try {
              await this.loadCatalog();
            } catch (error) {
              if (!this.session) throw error;
              this.error = message(error);
            }
          }
          if (!this.session && !this.flow.pending && !this.flow.order) {
            this.deriveStep();
            return;
          }
          const session = await this.authenticate();
          await this.observeRemote();
          const pending = this.flow.pending;
          if (pending?.kind === 'create') await this.sendCreate(pending, session);
          else if (pending?.kind === 'command') await this.sendCommand(pending, session);
          else if (this.flow.order?.payment_state === 'simulated_unknown')
            throw new KioskError('RECOVERY_REQUIRED');
        });
  private canReset() {
    return (
      !this.unsafe() &&
      (!this.flow.order ||
        this.flow.order.state === 'cancelled' ||
        this.flow.order.payment_state === 'simulated_approved')
    );
  }
  newGuest = () =>
    this.run(async () => {
      if (!this.canReset()) throw new KioskError('RECOVERY_REQUIRED');
      // Reset marker makes the two storage backends resumable after any crash.
      await this.persist({ ...this.flow, resetPending: true });
      await this.finishReset();
    });
  private async finishReset() {
    await this.io.removeSession();
    this.session = null;
    await this.persist(this.empty());
    this.selectedId = null;
    this.returnStep = 'menu';
    this.lastAdded = null;
    this.idleWarningSeconds = null;
    this.blocked = false;
    this.step = 'start';
  }
}
