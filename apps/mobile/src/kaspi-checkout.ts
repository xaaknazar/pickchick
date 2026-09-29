import type { CartLine, DiningMode } from './model';

/**
 * Mobile side of the commercial checkout paid by a Kaspi invoice. Pure core without
 * React Native imports: HTTP, token refresh and storage are injected.
 *
 * The server decides everything that matters: price (published menu), the phone
 * (verified account), whether an invoice exists and whether money was received.
 * The app only shows those facts; returning from Kaspi or a button press is never
 * treated as payment.
 */
export type KaspiStage =
  | 'accepting'
  | 'ready_to_pay'
  | 'sending_invoice'
  | 'invoice_sent'
  | 'checking'
  | 'invoice_closed'
  | 'unconfirmed'
  | 'paid'
  | 'attention';
export type KaspiClosedReason = 'expired' | 'cancelled' | 'rejected' | 'failed';
export interface KaspiCheckoutView {
  order_id: string;
  stage: KaspiStage;
  total_minor: string;
  service_mode: DiningMode;
  lines: { title: string; quantity: number; total_minor: string }[];
  invoice: { expires_at: string | null; closed_reason: KaspiClosedReason | null } | null;
  can_retry: boolean;
  kitchen_queued: boolean;
}
export interface KaspiCheckoutStatus {
  enabled: boolean;
  phoneMasked: string | null;
}
export interface KaspiCartItem {
  sku: string;
  quantity: number;
  selections: { group_id: string; option_id: string; quantity: number }[];
}
export interface KaspiCart {
  service_mode: DiningMode;
  items: KaspiCartItem[];
}

export class KaspiCheckoutError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.name = 'KaspiCheckoutError';
    this.status = status;
    this.code = code;
  }
}

/** Stages in which the server is still working; the app keeps polling. */
export const KASPI_ACTIVE_STAGES: readonly KaspiStage[] = [
  'accepting',
  'ready_to_pay',
  'sending_invoice',
  'invoice_sent',
  'checking',
];

const STAGES: readonly KaspiStage[] = [
  ...KASPI_ACTIVE_STAGES,
  'invoice_closed',
  'unconfirmed',
  'paid',
  'attention',
];
const REASONS: readonly KaspiClosedReason[] = ['expired', 'cancelled', 'rejected', 'failed'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MINOR = /^(0|[1-9][0-9]{0,15})$/;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new KaspiCheckoutError(502, 'INVALID_RESPONSE');
  return value as Record<string, unknown>;
}
function isoOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
    throw new KaspiCheckoutError(502, 'INVALID_RESPONSE');
  return value;
}

export function parseKaspiView(input: unknown): KaspiCheckoutView {
  const v = object(input);
  const fail = () => {
    throw new KaspiCheckoutError(502, 'INVALID_RESPONSE');
  };
  if (typeof v.order_id !== 'string' || !UUID.test(v.order_id)) fail();
  if (!STAGES.includes(v.stage as KaspiStage)) fail();
  if (typeof v.total_minor !== 'string' || !MINOR.test(v.total_minor)) fail();
  if (v.service_mode !== 'takeaway' && v.service_mode !== 'dine_in') fail();
  if (!Array.isArray(v.lines) || v.lines.length > 200) fail();
  const lines = (v.lines as unknown[]).map((raw) => {
    const line = object(raw);
    if (
      typeof line.title !== 'string' ||
      !Number.isInteger(line.quantity) ||
      typeof line.total_minor !== 'string' ||
      !MINOR.test(line.total_minor)
    )
      fail();
    return {
      title: line.title as string,
      quantity: line.quantity as number,
      total_minor: line.total_minor as string,
    };
  });
  let invoice: KaspiCheckoutView['invoice'] = null;
  if (v.invoice !== null) {
    const i = object(v.invoice);
    if (i.closed_reason !== null && !REASONS.includes(i.closed_reason as KaspiClosedReason)) fail();
    invoice = {
      expires_at: isoOrNull(i.expires_at),
      closed_reason: i.closed_reason as KaspiClosedReason | null,
    };
  }
  if (typeof v.can_retry !== 'boolean' || typeof v.kitchen_queued !== 'boolean') fail();
  return {
    order_id: v.order_id as string,
    stage: v.stage as KaspiStage,
    total_minor: v.total_minor as string,
    service_mode: v.service_mode as DiningMode,
    lines,
    invoice,
    can_retry: v.can_retry as boolean,
    kitchen_queued: v.kitchen_queued as boolean,
  };
}

export function parseKaspiStatus(input: unknown): KaspiCheckoutStatus {
  const v = object(input);
  if (v.enabled !== true) return { enabled: false, phoneMasked: null };
  if (v.payment_method !== 'kaspi') throw new KaspiCheckoutError(502, 'INVALID_RESPONSE');
  const masked =
    typeof v.phone_masked === 'string' && /^\+7 7[0-9]{2} ••• •• [0-9]{2}$/.test(v.phone_masked)
      ? v.phone_masked
      : null;
  return { enabled: true, phoneMasked: masked };
}

/** Cart lines to the server cart: SKU = catalog product id; prices are never sent. */
export function kaspiCart(lines: CartLine[], mode: DiningMode): KaspiCart {
  return {
    service_mode: mode,
    items: lines.map((line) => ({
      sku: line.product.id,
      quantity: line.quantity,
      selections: (line.selections ?? []).map((s) => ({
        group_id: s.group_id,
        option_id: s.option_id,
        quantity: s.quantity,
      })),
    })),
  };
}

export interface KaspiCheckoutIO {
  /** Authorized JSON request to /v1/customer/checkout{path}; POST when body is given. */
  request(path: string, body?: unknown, key?: string): Promise<unknown>;
  read(key: string): Promise<string | null>;
  write(key: string, raw: string): Promise<void>;
  remove(key: string): Promise<void>;
  uuid(): string;
}

export const KASPI_PENDING_KEY = 'pickchick.kaspi.pending-checkout.v1';
interface PendingCheckout {
  version: 1;
  cart: KaspiCart;
  quoteKey: string;
  orderKey: string;
  quoteId: string | null;
  orderId: string | null;
  payKey: string;
}

function samecart(a: KaspiCart, b: KaspiCart) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class KaspiCheckoutCore {
  private flight: Promise<KaspiCheckoutView> | null = null;
  private readonly io: KaspiCheckoutIO;
  constructor(io: KaspiCheckoutIO) {
    this.io = io;
  }

  async status(): Promise<KaspiCheckoutStatus> {
    return parseKaspiStatus(await this.io.request(''));
  }

  private async pending(): Promise<PendingCheckout | null> {
    const raw = await this.io.read(KASPI_PENDING_KEY);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as PendingCheckout;
      if (value?.version === 1 && typeof value.quoteKey === 'string') return value;
    } catch {
      // A damaged draft is dropped; the server keeps every created order.
    }
    await this.io.remove(KASPI_PENDING_KEY);
    return null;
  }
  private save(value: PendingCheckout) {
    return this.io.write(KASPI_PENDING_KEY, JSON.stringify(value));
  }

  /** The order this device is paying for, if any (survives app restarts). */
  async currentOrderId(): Promise<string | null> {
    return (await this.pending())?.orderId ?? null;
  }

  /**
   * Creates the server-priced order for this cart (once, even after a crash or a lost
   * response) and requests the invoice. An unfinished order for another cart blocks a
   * new one until it is paid or closed.
   */
  checkout(cart: KaspiCart): Promise<KaspiCheckoutView> {
    this.flight ??= this.run(cart).finally(() => {
      this.flight = null;
    });
    return this.flight;
  }
  private async run(cart: KaspiCart): Promise<KaspiCheckoutView> {
    let pending = await this.pending();
    if (pending?.orderId) {
      const view = await this.read(pending.orderId);
      const same = samecart(pending.cart, cart);
      // One open invoice at a time: an order still in progress blocks a different cart.
      if (KASPI_ACTIVE_STAGES.includes(view.stage)) {
        if (!same) throw new KaspiCheckoutError(409, 'PREVIOUS_ORDER_PENDING');
        return view.stage === 'ready_to_pay' ? this.pay(view.order_id) : view;
      }
      if (same && view.stage === 'invoice_closed') return this.pay(view.order_id, true);
      if (same && (view.stage === 'unconfirmed' || view.stage === 'attention')) return view;
      // Paid, or a different cart after a final outcome: a new order.
      pending = null;
    }
    if (pending && !samecart(pending.cart, cart)) pending = null;
    pending ??= {
      version: 1,
      cart,
      quoteKey: this.io.uuid(),
      orderKey: this.io.uuid(),
      quoteId: null,
      orderId: null,
      payKey: this.io.uuid(),
    };
    await this.save(pending);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!pending.quoteId) {
        const quote = object(await this.io.request('/quotes', cart, pending.quoteKey));
        if (typeof quote.quote_id !== 'string' || !UUID.test(quote.quote_id))
          throw new KaspiCheckoutError(502, 'INVALID_RESPONSE');
        pending = { ...pending, quoteId: quote.quote_id };
        await this.save(pending);
      }
      try {
        const view = parseKaspiView(
          await this.io.request('/orders', { quote_id: pending.quoteId }, pending.orderKey),
        );
        pending = { ...pending, orderId: view.order_id };
        await this.save(pending);
        return this.pay(view.order_id);
      } catch (error) {
        // Only a definitive expiry allows new keys; a lost response replays the same ones.
        if (
          !(error instanceof KaspiCheckoutError) ||
          error.code !== 'QUOTE_EXPIRED' ||
          attempt !== 0
        )
          throw error;
        pending = { ...pending, quoteKey: this.io.uuid(), orderKey: this.io.uuid(), quoteId: null };
        await this.save(pending);
      }
    }
    throw new KaspiCheckoutError(409, 'QUOTE_EXPIRED');
  }

  /**
   * Asks for an invoice. The same key is replayed until the server has an attempt;
   * `fresh` (only after a closed invoice) starts a new one.
   */
  async pay(orderId: string, fresh = false): Promise<KaspiCheckoutView> {
    let pending = await this.pending();
    if (!pending || pending.orderId !== orderId)
      pending = {
        version: 1,
        cart: pending?.cart ?? { service_mode: 'takeaway', items: [] },
        quoteKey: this.io.uuid(),
        orderKey: this.io.uuid(),
        quoteId: null,
        orderId,
        payKey: this.io.uuid(),
      };
    if (fresh) pending = { ...pending, payKey: this.io.uuid() };
    await this.save(pending);
    return parseKaspiView(
      await this.io.request(`/orders/${orderId}/kaspi-payment`, {}, pending.payKey),
    );
  }

  async read(orderId: string): Promise<KaspiCheckoutView> {
    if (!UUID.test(orderId)) throw new KaspiCheckoutError(400, 'INVALID_ORDER');
    return parseKaspiView(await this.io.request(`/orders/${orderId}`));
  }

  /** Forget the local draft after a final outcome; the order stays on the server. */
  async finish(view: KaspiCheckoutView): Promise<void> {
    if (view.stage !== 'paid' && view.stage !== 'invoice_closed') return;
    const pending = await this.pending();
    if (pending?.orderId === view.order_id) await this.io.remove(KASPI_PENDING_KEY);
  }
}

export interface KaspiStageCopy {
  title: string;
  body: string;
  tone: 'progress' | 'success' | 'warning';
}

function time(iso: string | null) {
  if (!iso) return null;
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  // Almaty local time (UTC+5) regardless of the device time zone.
  const local = new Date(date.getTime() + 5 * 3600_000);
  return `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

/** Customer wording per stage. Plain hyphens only, per the owner's text rule. */
export function kaspiStageCopy(
  view: KaspiCheckoutView,
  phoneMasked: string | null,
): KaspiStageCopy {
  // Non-breaking spaces keep the masked number on one line.
  const phone = phoneMasked
    ? ` на номер ${phoneMasked.replace(/ /g, '\u00a0')}`
    : ' на номер из вашего профиля';
  switch (view.stage) {
    case 'accepting':
      return {
        title: 'Ресторан принимает заказ',
        body: 'Как только ресторан подтвердит заказ, счёт придёт в Kaspi' + phone + '.',
        tone: 'progress',
      };
    case 'ready_to_pay':
    case 'sending_invoice':
      return {
        title: 'Отправляем счёт в Kaspi',
        body: 'Счёт придёт' + phone + '. Это займёт несколько секунд.',
        tone: 'progress',
      };
    case 'invoice_sent': {
      const until = time(view.invoice?.expires_at ?? null);
      return {
        title: 'Счёт отправлен в Kaspi',
        body:
          'Откройте Kaspi.kz и оплатите счёт' +
          phone +
          '.' +
          (until ? ` Счёт действует до ${until}.` : '') +
          ' Статус обновится здесь сам.',
        tone: 'progress',
      };
    }
    case 'checking':
      return {
        title: 'Проверяем оплату',
        body: 'Ждём подтверждение от Kaspi. Не оплачивайте повторно и не создавайте новый счёт.',
        tone: 'progress',
      };
    case 'paid':
      return {
        title: 'Оплачено',
        body: view.kitchen_queued
          ? 'Заказ передан на кухню.'
          : 'Оплата получена. Передаём заказ на кухню.',
        tone: 'success',
      };
    case 'invoice_closed': {
      const reason = view.invoice?.closed_reason ?? 'failed';
      const title = {
        expired: 'Срок счёта истёк',
        cancelled: 'Счёт отменён',
        rejected: 'Счёт отклонён в Kaspi',
        failed: 'Не удалось выставить счёт',
      }[reason];
      return {
        title,
        body: 'Оплата по этому счёту не поступила. Можно отправить новый счёт.',
        tone: 'warning',
      };
    }
    case 'unconfirmed':
      return {
        title: 'Не удалось подтвердить результат',
        body: 'Не оплачивайте повторно. Платёж проверяется вручную, статус обновится здесь.',
        tone: 'warning',
      };
    case 'attention':
      return {
        title: 'Нужна проверка сотрудника',
        body: 'Обратитесь к сотруднику ресторана. Повторно не оплачивайте.',
        tone: 'warning',
      };
  }
}

/** Server error codes to short customer messages. */
export function kaspiErrorMessage(error: unknown): string {
  const code = error instanceof KaspiCheckoutError ? error.code : 'NETWORK';
  switch (code) {
    case 'MENU_CHANGED':
      return 'Меню обновилось. Проверьте корзину и повторите.';
    case 'ITEM_STOPPED':
      return 'Часть позиций сейчас недоступна. Уберите их из корзины.';
    case 'BRANCH_UNAVAILABLE':
      return 'Ресторан сейчас не принимает заказы.';
    case 'QUOTE_EXPIRED':
      return 'Цена устарела. Повторите оформление.';
    case 'PREVIOUS_ORDER_PENDING':
      return 'Сначала завершите оплату предыдущего заказа.';
    case 'UNAUTHORIZED':
      return 'Войдите в аккаунт, чтобы оплатить заказ.';
    case 'SERVICE_UNAVAILABLE':
      return 'Оплата через Kaspi временно недоступна.';
    default:
      return 'Не удалось связаться с сервером. Проверьте интернет и повторите.';
  }
}
