import * as parse from './types.js';
import type {
  Approval,
  Cart,
  FiscalPendingItem,
  LocalOrder,
  MenuSnapshot,
  PosConfig,
  PosPaymentMethod,
  PosSale,
  Quote,
  RefundReason,
  SaleFiscal,
  SalesChannel,
  ShiftReport,
  StaffCredential,
  StaffSession,
  Stop,
  Ordering,
  CashShift,
  Item,
  Selection,
  EdgeCloudLink,
} from './types.js';
import {
  ApiError,
  passwordTransport,
  type PasswordTransport,
  type SaleErrorContext,
  type Transport,
} from './api.js';
export type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type Pending = {
  key: string;
  path: string;
  body: Record<string, unknown>;
  kind:
    | 'create'
    | 'cancel'
    | 'ordering'
    | 'stop'
    | 'shift_open'
    | 'shift_close'
    | 'shift_move'
    | 'sale'
    | 'fiscal_record'
    | 'void'
    | 'refund';
  at: string;
  /** fiscal_record: the order whose sale is read again once the receipt number is stored. */
  subject?: string;
};
/** The order being sold in the paid mode; kept in memory, so a restart asks again (KS8). */
export type SaleDraft = {
  channel: SalesChannel;
  /** The cashier tapped "В зале" or "С собой" for this order; never assumed by default. */
  serviceModeChosen: boolean;
  /** Aggregator order number typed from the aggregator tablet. */
  externalOrderRef: string;
  /** The quote the guest confirmed on "Повторите заказ гостю" and what it contained. */
  reviewed: { quote_id: string; signature: string } | null;
};
export type MixableMethod = (typeof parse.MIXABLE_METHODS)[number];
/** What the cashier chose on the payment screen; saleRequest turns it into POST pos/sales. */
export type SalePayment =
  | { method: 'cash'; tendered_minor: string }
  | { method: 'kaspi_terminal'; reference?: string }
  | { method: 'kaspi_manual'; reference?: string }
  | {
      method: 'mixed';
      parts: { method: MixableMethod; amount_minor: string; reference?: string }[];
      tendered_minor?: string;
    }
  | { method: 'chocofood'; external_order_ref: string }
  | { method: 'aggregator' }
  | { method: 'staff_meal'; beneficiary: string }
  | { method: 'marketing'; reason: string };
/** Approval actions the cashier asks for (contracts section 2.1, P0 subset). */
export type ApprovalAction =
  'staff_meal' | 'marketing' | 'void' | 'refund' | 'fiscal_correct' | 'shift_close_pending_fiscal';
/**
 * What one approval is for (POST staff/approvals `subject`). Built only by the helpers below, so
 * the key order is fixed and two subjects compare by their JSON.
 */
export type ApprovalSubject =
  | { quote_id: string; amount_minor: string }
  | { order_id: string; amount_minor: string }
  | { shift_id: string; amount_minor: string };
/** staff_meal, marketing: the quote being sold and its total. */
export const quoteSubject = (q: Pick<Quote, 'quote_id' | 'total_minor'>): ApprovalSubject => ({
  quote_id: q.quote_id,
  amount_minor: q.total_minor,
});
/** void: the order and the money the void gives back (all that is left to refund). */
export const voidSubject = (
  sale: Pick<PosSale, 'order_id' | 'refundable_minor'>,
): ApprovalSubject => ({ order_id: sale.order_id, amount_minor: sale.refundable_minor });
/** refund: the order and the sum of the refunded tender amounts. */
export const refundSubject = (
  orderId: string,
  tenders: readonly { amount_minor: string }[],
): ApprovalSubject => ({
  order_id: orderId,
  amount_minor: tenders.reduce((sum, t) => sum + BigInt(t.amount_minor), 0n).toString(),
});
/** fiscal_correct: the order of the receipt and the receipt amount. */
export const fiscalSubject = (
  receipt: { order_id: string } & Pick<SaleFiscal, 'amount_minor'>,
): ApprovalSubject => ({ order_id: receipt.order_id, amount_minor: receipt.amount_minor });
/** shift_close_pending_fiscal: the shift and the total of its receipts still pending. */
export const closeSubject = (
  shiftId: string,
  pending: readonly { amount_minor: string }[],
): ApprovalSubject => ({
  shift_id: shiftId,
  amount_minor: pending.reduce((sum, r) => sum + BigInt(r.amount_minor), 0n).toString(),
});
/** One-time shift manager approval for one subject; never written to the journal with a PIN. */
export type HeldApproval = Approval & {
  action: ApprovalAction;
  subject: ApprovalSubject;
  /** Local receive time: expiry uses the edge TTL, not the two clocks. */
  received_at: number;
};
/** A typed paper number (Webkassa receipt): 1..40 characters, no control characters. */
const typedNumber = (value: string, code: string) => {
  const result = value.trim();
  if (
    !result ||
    result.length > 40 ||
    [...result].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new Error(code);
  return result;
};
const SALE_ACTIONS: readonly ApprovalAction[] = ['staff_meal', 'marketing'];
const PIN_FORMAT = /^(?:[0-9]{4}|[0-9]{6})$/;
export const blankSaleDraft = (): SaleDraft => ({
  channel: 'hall',
  serviceModeChosen: false,
  externalOrderRef: '',
  reviewed: null,
});
/** What the guest heard on the repeat screen: lines, quantities, prices, type and channel. */
export const quoteSignature = (q: Quote) =>
  JSON.stringify([
    q.release_id,
    q.service_mode,
    q.sales_channel ?? 'hall',
    q.total_minor,
    q.details ?? null,
    q.lines.map((l) => [parse.lineKey(l), l.quantity, l.total_minor]),
  ]);
const SALE_KEYS = [
  'quote_id',
  'service_mode_confirmed',
  'order_repeated',
  'external_order_ref',
  'tenders',
  'cash_tendered_minor',
  'beneficiary',
  'reason',
  'approval',
];
/** Definite edge answers to POST pos/sales: nothing was committed, the same key never succeeds. */
const SALE_REJECTIONS = new Set([
  'SERVICE_MODE_DISABLED',
  'METHOD_DISABLED',
  'TENDER_SUM_MISMATCH',
  'CASH_TENDERED_TOO_LOW',
  'TERMINAL_AMOUNT_NOT_WHOLE',
  'CHANNEL_PRICE_UNAVAILABLE',
  'EXTERNAL_REF_REQUIRED',
  'EXTERNAL_REF_DUPLICATE',
  'APPROVAL_REQUIRED',
  'APPROVAL_INVALID',
  'KITCHEN_UNAVAILABLE',
]);
/**
 * Definite answers to a void or refund (contracts section 5.1): the edge refused inside its
 * transaction, the same key never succeeds. The order is read again; nothing is retried.
 */
const OPERATION_REJECTIONS = new Set([
  'SERVICE_MODE_DISABLED',
  'METHOD_DISABLED',
  'TERMINAL_AMOUNT_NOT_WHOLE',
  'APPROVAL_REQUIRED',
  'APPROVAL_INVALID',
  'ORDER_IN_PRODUCTION',
  'REFUND_LIMIT',
  'REFUND_NOT_SUPPORTED',
  'DRAWER_INSUFFICIENT',
]);
/** Definite answers to closing a sales shift: pending receipts without a valid approval. */
const CLOSE_REJECTIONS = new Set(['FISCAL_PENDING', 'APPROVAL_REQUIRED', 'APPROVAL_INVALID']);
const VOID_KEYS = ['expected_version', 'reason_code', 'reason', 'fiscal_sale_issued', 'approval'];
const REFUND_KEYS = ['refund_id', 'tenders', 'reason_code', 'reason', 'approval'];
const CLOSE_KEYS = [
  'expected_version',
  'counted_cash_minor',
  'reason',
  'terminal_reported_minor',
  'approval',
];
const approvalKey = (code: string) => code === 'APPROVAL_REQUIRED' || code === 'APPROVAL_INVALID';
/** A paid-mode channel is offered when it and (for an aggregator) its method are switched on. */
export function saleChannelEnabled(config: PosConfig, channel: SalesChannel): boolean {
  const entry = config.channels.find((c) => c.code === channel);
  if (channel === 'hall') return entry?.enabled ?? true;
  return Boolean(entry?.enabled) && methodEnabled(config, parse.aggregatorMethod(channel));
}
export function methodEnabled(config: PosConfig, code: PosPaymentMethod): boolean {
  return config.methods.some((m) => m.code === code && m.enabled);
}
/** Methods that may form a mixed payment on this edge (owner decision, section 00 item 1). */
export function mixableMethods(config: PosConfig): MixableMethod[] {
  return parse.MIXABLE_METHODS.filter((code) =>
    config.methods.some((m) => m.code === code && m.enabled && m.allow_in_mix),
  );
}
/** The held approval covers exactly this action and subject and is not about to expire. */
export function approvalValid(
  approval: HeldApproval | null,
  action: ApprovalAction,
  subject: ApprovalSubject | null,
  now: number,
  ttlSeconds: number,
): approval is HeldApproval {
  return Boolean(
    approval &&
    subject &&
    approval.action === action &&
    JSON.stringify(approval.subject) === JSON.stringify(subject) &&
    now < approval.received_at + ttlSeconds * 1000 - APPROVAL_MARGIN_MS,
  );
}
/** The approval proof of a command body, or the error the cashier sees before anything is sent. */
function approvalProof(
  held: HeldApproval | null,
  action: ApprovalAction,
  subject: ApprovalSubject,
  now: number,
  ttlSeconds: number,
) {
  if (!held || held.action !== action) throw new Error('APPROVAL_REQUIRED');
  if (!approvalValid(held, action, subject, now, ttlSeconds)) throw new Error('APPROVAL_INVALID');
  return { approval_id: held.approval_id, token: held.token };
}
/** A journaled approval proof: exactly {approval_id, token}, as pos-desktop's journal keeps it. */
function parseProof(value: unknown) {
  const a = parse.record(value);
  if (
    Object.keys(a).length !== 2 ||
    typeof a.token !== 'string' ||
    !parse.APPROVAL_TOKEN.test(a.token)
  )
    throw new Error();
  parse.uuid(a.approval_id);
}
const refundReason = (code: unknown, text: unknown) => {
  if (!(parse.REFUND_REASONS as readonly unknown[]).includes(code))
    throw new Error('REFUND_REASON_REQUIRED');
  if (typeof text !== 'string' || text.trim().length < 3 || text.trim().length > 300)
    throw new Error('REASON_REQUIRED');
  return { reason_code: code as RefundReason, reason: text.trim() };
};
/** Spare seconds so an approval or quote is never sent just as the edge lets it expire. */
const APPROVAL_MARGIN_MS = 5000;
const QUOTE_MARGIN_MS = 15000;
/** Longest wait for an answer of the cashier transport (api.ts): the approval request itself. */
const REQUEST_MS = 12000;
/**
 * How long the quote of a staff meal or marketing approval must still live when the PIN is
 * asked: the approval TTL, the request and the margin sell() keeps. Paying while the approval
 * is valid then never re-quotes, which would change quote_id and void the approval (a second
 * PIN). Capped by what a fresh quote of this edge lives, so a short-lived quote is not asked
 * for again in vain.
 */
export function approvalQuoteSpare(quote: Quote, ttlSeconds: number) {
  const need = ttlSeconds * 1000 + QUOTE_MARGIN_MS + REQUEST_MS;
  const lifetime = Date.parse(quote.expires_at) - Date.parse(quote.created_at);
  return Number.isFinite(lifetime)
    ? Math.max(QUOTE_MARGIN_MS, Math.min(need, lifetime - QUOTE_MARGIN_MS))
    : need;
}
const text = (value: string, min: number, max: number, code: string) => {
  const result = value.trim();
  if (result.length < min || result.length > max) throw new Error(code);
  return result;
};
/**
 * Contracts section 2.2 and section 00, checked before anything is sent so the cashier sees
 * the problem at once. The edge applies the same rules again inside one transaction.
 */
export function saleRequest(input: {
  quote: Quote;
  config: PosConfig;
  draft: SaleDraft;
  payment: SalePayment;
  approval: HeldApproval | null;
  now: number;
}): Record<string, unknown> {
  const { quote, config, draft, payment } = input;
  if (config.mode !== 'pos_sale') throw new Error('SERVICE_MODE_DISABLED');
  if (!draft.serviceModeChosen) throw new Error('SERVICE_MODE_REQUIRED');
  if (draft.reviewed?.quote_id !== quote.quote_id) throw new Error('ORDER_REVIEW_REQUIRED');
  const channel = draft.channel;
  if ((quote.sales_channel ?? 'hall') !== channel || !saleChannelEnabled(config, channel))
    throw new Error('METHOD_DISABLED');
  const total = BigInt(quote.total_minor);
  // Hall-only methods never pay an aggregator order and the reverse (section 2.2).
  if (parse.isAggregator(channel) !== (payment.method === 'aggregator'))
    throw new Error('METHOD_DISABLED');
  const need = (code: PosPaymentMethod) => {
    if (!methodEnabled(config, code)) throw new Error('METHOD_DISABLED');
  };
  const reference = (value: string | undefined) =>
    value === undefined || !value.trim()
      ? {}
      : { reference: text(value, 1, 40, 'REFERENCE_INVALID') };
  const whole = (amount: bigint) => {
    if (amount % 100n !== 0n) throw new Error('TERMINAL_AMOUNT_NOT_WHOLE');
  };
  const tenders: Record<string, unknown>[] = [];
  let tendered: string | undefined,
    externalRef: string | undefined,
    beneficiary: string | undefined,
    reason: string | undefined,
    action: ApprovalAction | undefined;
  switch (payment.method) {
    case 'cash': {
      need('cash');
      tendered = parse.minor(payment.tendered_minor);
      if (BigInt(tendered) < total) throw new Error('CASH_TENDERED_TOO_LOW');
      tenders.push({ method: 'cash', amount_minor: quote.total_minor });
      break;
    }
    case 'kaspi_terminal':
    case 'kaspi_manual': {
      need(payment.method);
      if (payment.method === 'kaspi_terminal') whole(total);
      tenders.push({
        method: payment.method,
        amount_minor: quote.total_minor,
        ...reference(payment.reference),
      });
      break;
    }
    case 'mixed': {
      const allowed = mixableMethods(config);
      if (payment.parts.length !== 2) throw new Error('MIX_INVALID');
      for (const part of payment.parts) {
        need(part.method);
        if (!allowed.includes(part.method)) throw new Error('MIX_INVALID');
      }
      const cash = payment.parts.filter((p) => p.method === 'cash');
      if (cash.length > 1) throw new Error('MIX_INVALID');
      let sum = 0n;
      for (const part of payment.parts) {
        const amount = BigInt(parse.minor(part.amount_minor));
        if (amount <= 0n) throw new Error('TENDER_SUM_MISMATCH');
        if (part.method === 'kaspi_terminal') whole(amount);
        sum += amount;
        tenders.push({
          method: part.method,
          amount_minor: part.amount_minor,
          ...(part.method === 'cash' ? {} : reference(part.reference)),
        });
      }
      if (sum !== total) throw new Error('TENDER_SUM_MISMATCH');
      if (cash.length) {
        tendered = parse.minor(payment.tendered_minor ?? cash[0]!.amount_minor);
        if (BigInt(tendered) < BigInt(cash[0]!.amount_minor))
          throw new Error('CASH_TENDERED_TOO_LOW');
      } else if (payment.tendered_minor !== undefined) throw new Error('MIX_INVALID');
      break;
    }
    case 'chocofood': {
      need('chocofood');
      externalRef = payment.external_order_ref.trim().toUpperCase();
      if (!parse.EXTERNAL_ORDER_REF.test(externalRef)) throw new Error('EXTERNAL_REF_REQUIRED');
      tenders.push({ method: 'chocofood', amount_minor: quote.total_minor });
      break;
    }
    case 'aggregator': {
      if (!parse.isAggregator(channel) || quote.service_mode !== 'takeaway')
        throw new Error('METHOD_DISABLED');
      const method = parse.aggregatorMethod(channel);
      need(method);
      externalRef = draft.externalOrderRef.trim().toUpperCase();
      if (!parse.EXTERNAL_ORDER_REF.test(externalRef)) throw new Error('EXTERNAL_REF_REQUIRED');
      tenders.push({ method, amount_minor: quote.total_minor });
      break;
    }
    case 'staff_meal':
    case 'marketing': {
      need(payment.method);
      action = payment.method;
      if (payment.method === 'staff_meal')
        beneficiary = text(payment.beneficiary, 1, 100, 'BENEFICIARY_REQUIRED');
      else reason = text(payment.reason, 3, 300, 'REASON_REQUIRED');
      tenders.push({ method: payment.method, amount_minor: quote.total_minor });
      break;
    }
    default:
      throw new Error('METHOD_DISABLED');
  }
  let approval: { approval_id: string; token: string } | undefined;
  if (action) {
    const held = input.approval;
    if (!held) throw new Error('APPROVAL_REQUIRED');
    if (!approvalValid(held, action, quoteSubject(quote), input.now, config.approval_ttl_seconds))
      throw new Error('APPROVAL_INVALID');
    approval = { approval_id: held.approval_id, token: held.token };
  }
  return {
    quote_id: quote.quote_id,
    service_mode_confirmed: true,
    order_repeated: true,
    ...(externalRef === undefined ? {} : { external_order_ref: externalRef }),
    tenders,
    ...(tendered === undefined ? {} : { cash_tendered_minor: tendered }),
    ...(beneficiary === undefined ? {} : { beneficiary }),
    ...(reason === undefined ? {} : { reason }),
    ...(approval === undefined ? {} : { approval }),
  };
}
/** Error text context of a journaled sale: its first method and the channel of that method. */
export function saleContext(body: Record<string, unknown> | undefined): SaleErrorContext {
  const first = Array.isArray(body?.tenders) ? parse.record(body.tenders[0]).method : undefined;
  return {
    ...(first === 'aggregator_yandex_eda'
      ? { channel: 'yandex_eda' as const }
      : first === 'aggregator_glovo'
        ? { channel: 'glovo' as const }
        : {}),
    ...(typeof first === 'string' ? { method: first } : {}),
  };
}
type Journal = {
  version: 1;
  scope: string;
  draft: Cart | null;
  pending: Pending | null;
  known: string[];
  selected: string | null;
  held?: Cart[];
};
export type State = {
  actor: StaffSession | null;
  menu: MenuSnapshot | null;
  ordering: Ordering | null;
  stops: Map<string, Stop>;
  draft: Cart | null;
  quote: Quote | null;
  order: LocalOrder | null;
  known: string[];
  pending: Pending | null;
  busy: boolean;
  error: unknown;
  connectedAt: number | null;
  storageBlocked: boolean;
  shift: CashShift | null;
  shifts: CashShift[];
  orders: LocalOrder[];
  operationsAvailable: boolean;
  operationsAt: number | null;
  operationsError: unknown;
  /** Last menu replacement seen by this session; `id` grows so a view shows each notice once. */
  menuChange: MenuChange | null;
  /** The cashier edge's internet (cloud) link; null when unknown or not reported by the edge. */
  cloudLink: EdgeCloudLink | null;
  /** Last GET pos/config that succeeded; null before it or when the edge has no route. */
  posConfig: PosConfig | null;
  /** The edge answered 404 to pos/config: an older edge, today's unpaid cashier only. */
  posConfigMissing: boolean;
  /** The paid order the done screen shows, until the next order starts. */
  sale: PosSale | null;
  saleDraft: SaleDraft;
  approval: HeldApproval | null;
  /** "Чеки Webkassa": the last pending list read (this shift, or every shift). */
  fiscal: FiscalPending | null;
  /** Latest X report of this desk's open sales shift; null without one. */
  shiftReport: ShiftReport | null;
  /** Frozen Z report read after closing a sales shift. */
  zReport: ShiftReport | null;
  /**
   * Webkassa state of the sale receipt of each paid order read so far, by order id: the
   * "ЗАКАЗЫ" rows say оформлен / не оформлен / не нужен as the X report counts receipts.
   */
  saleReceipts: Record<string, SaleFiscal['state']>;
};
export type FiscalPending = {
  scope: 'shift' | 'all';
  shift_id: string | null;
  receipts: FiscalPendingItem[];
  at: number;
};
/** Every sale-mode field of a fresh state; they reset with the session and the paid mode. */
const blankOperations = () => ({
  fiscal: null,
  shiftReport: null,
  zReport: null,
  saleReceipts: {},
});
/** GET pos/sales/{id} reads for the receipt state of the "ЗАКАЗЫ" rows, at most per call. */
export const RECEIPT_READS = 10;
/** How often the header asks the edge about its cloud link (with the operations refresh). */
export const CLOUD_LINK_POLL_MS = 10000;
/** An edge that predates GET edge/v1/cloud-link (404) is asked again only after this pause. */
const CLOUD_LINK_MISSING_MS = 10 * 60000;
/** Sale methods are read again with the operations refresh at most this often. */
export const POS_CONFIG_POLL_MS = 30000;
/** An edge that predates GET edge/v1/pos/config (404) is asked again only after this pause. */
export const POS_CONFIG_MISSING_MS = 10 * 60000;
/**
 * Header connection line (offline stand finding, stage 2): staff tell "no connection to the
 * cashier server" (LAN, red) from "no internet" (WAN, yellow: selling and the kitchen go on).
 */
export function connectionLabel(
  s: Pick<State, 'actor' | 'operationsAvailable' | 'operationsError' | 'cloudLink'>,
): { label: string; tone: 'ok' | 'warn' | 'down' } {
  const local = s.operationsAvailable && !s.operationsError;
  if (!s.actor) return { label: 'Вход по личному PIN', tone: local ? 'ok' : 'down' };
  if (!local) return { label: 'Нет связи с кассой', tone: 'down' };
  if (s.cloudLink?.state === 'offline')
    return { label: 'Нет интернета · касса работает', tone: 'warn' };
  return { label: 'Локальная сеть', tone: 'ok' };
}
export type MenuChange = {
  id: number;
  release_id: string;
  version: number;
  previous_version: number | null;
  /** Russian names of draft lines dropped because the new menu no longer offers them. */
  removed: string[];
};
const AUTH_KEY = 'pickchick.pos.staff-session.v1';
export const scopeFor = (actor: StaffSession) =>
  `${actor.branch_id}.${actor.staff_id}.${actor.terminal_id}`;
const journalKey = (scope: string) => `pickchick.pos.journal.v1.${scope}`;
const unchanged = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** The edge's tenders are exactly the requested ones (method and amount, in any order). */
function sameTenders(actual: PosSale['tenders'], requested: unknown) {
  const key = (t: { method: unknown; amount_minor: unknown }) => `${t.method}:${t.amount_minor}`;
  if (!Array.isArray(requested) || requested.length !== actual.length) return false;
  const want = requested.map((t) => key(parse.record(t) as never)).sort();
  return unchanged(actual.map(key).sort(), want);
}
export class PosController {
  state: State = {
    actor: null,
    menu: null,
    ordering: null,
    stops: new Map(),
    draft: null,
    quote: null,
    order: null,
    known: [],
    pending: null,
    busy: false,
    error: null,
    connectedAt: null,
    storageBlocked: false,
    shift: null,
    shifts: [],
    orders: [],
    operationsAvailable: false,
    operationsAt: null,
    operationsError: null,
    menuChange: null,
    cloudLink: null,
    posConfig: null,
    posConfigMissing: false,
    sale: null,
    saleDraft: blankSaleDraft(),
    approval: null,
    ...blankOperations(),
  };
  private menuChanges = 0;
  private credential: StaffCredential | null = null;
  private journal: Journal | null = null;
  private listeners = new Set<() => void>();
  private generation = 0;
  private releaseLease: (() => void) | null = null;
  constructor(
    private api: Transport,
    private sessions: Store,
    private storage: Store,
    private newKey = () => crypto.randomUUID(),
    private lease?: (scope: string) => Promise<() => void>,
    private passwordApi: PasswordTransport = passwordTransport,
    private now: () => number = () => Date.now(),
  ) {}
  private cloudLinkAt = -Infinity;
  private cloudLinkMissingUntil = -Infinity;
  private posConfigAt = -Infinity;
  private posConfigMissingUntil = -Infinity;
  /** When each entry of state.saleReceipts was last read (or its read last failed). */
  private receiptReadAt = new Map<string, number>();
  /** The edge runs the paid mode (`pos_sale`); otherwise every screen is today's cashier. */
  get saleMode() {
    return this.state.posConfig?.mode === 'pos_sale';
  }
  /**
   * The edge sells (GET ordering says pos_sale) but this session has no answer to pos/config
   * yet: its first read failed and is asked again at the next operations refresh (review 07.11
   * R1). Nothing is sold, sent to the kitchen or closed meanwhile; the screens only must not
   * call this desk a test. Once pos/config answered (any mode, or 404) that answer decides: it
   * is read after GET ordering, so it is the newer one.
   */
  get awaitingSale() {
    return (
      !this.state.posConfig &&
      !this.state.posConfigMissing &&
      this.state.ordering?.pos_service_mode === 'pos_sale'
    );
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit() {
    for (const listener of this.listeners) listener();
  }
  private fail(error: unknown) {
    this.state.error = error;
    if (error instanceof ApiError && ['EDGE_UNREACHABLE', 'EDGE_TIMEOUT'].includes(error.code))
      this.state.connectedAt = null;
    if (error instanceof ApiError && error.code === 'UNAUTHORIZED') {
      this.credential = null;
      this.state.actor = null;
      this.releaseLease?.();
      this.releaseLease = null;
      try {
        this.sessions.removeItem(AUTH_KEY);
      } catch {
        /* No new writes follow a lost session. */
      }
    }
    this.emit();
  }
  private async run(action: () => Promise<void>) {
    if (this.state.busy) return;
    this.state.busy = true;
    this.state.error = null;
    this.emit();
    try {
      await action();
    } catch (error) {
      this.fail(error);
    } finally {
      this.state.busy = false;
      this.emit();
    }
  }
  private async request(path: string, options?: Parameters<Transport>[2]) {
    if (!this.credential) throw new ApiError('UNAUTHORIZED', 401);
    const result = await this.api(path, this.credential, options);
    this.state.connectedAt = Date.now();
    return result;
  }
  private save(next: Journal) {
    if (this.state.storageBlocked) throw new Error('STORAGE_UNAVAILABLE');
    const serialized = JSON.stringify(next);
    if (serialized.length > 100000) throw new Error('LIMIT');
    try {
      this.storage.setItem(journalKey(next.scope), serialized);
    } catch {
      this.state.storageBlocked = true;
      throw new Error('STORAGE_UNAVAILABLE');
    }
    this.journal = next;
    this.state.draft = next.draft;
    this.state.pending = next.pending;
    this.state.known = next.known;
  }
  private readJournal(actor: StaffSession): Journal {
    const scope = scopeFor(actor);
    let raw: string | null;
    try {
      raw = this.storage.getItem(journalKey(scope));
    } catch {
      throw new Error('STORAGE_UNAVAILABLE');
    }
    if (raw === null)
      return { version: 1, scope, draft: null, pending: null, known: [], selected: null };
    try {
      if (raw.length > 100000) throw new Error();
      const j = parse.record(JSON.parse(raw));
      if (
        j.version !== 1 ||
        j.scope !== scope ||
        !Array.isArray(j.known) ||
        j.known.length > 100 ||
        !(j.selected === null || parse.isUuid(j.selected))
      )
        throw new Error();
      const pending = j.pending === null ? null : this.parsePending(j.pending);
      return {
        version: 1,
        scope,
        ...(j.held === undefined
          ? {}
          : {
              held: (() => {
                if (!Array.isArray(j.held) || j.held.length > 10) throw new Error();
                return j.held.map(parse.cart);
              })(),
            }),
        draft: j.draft === null ? null : parse.cart(j.draft),
        pending,
        known: j.known.map(parse.uuid),
        selected: j.selected as string | null,
      };
    } catch {
      throw new Error('STORAGE_DAMAGED');
    }
  }
  private parsePending(value: unknown): Pending {
    const p = parse.record(value),
      body = parse.record(p.body),
      path = parse.text(p.path, 160);
    if (p.kind === 'create') {
      if (
        path !== 'orders' ||
        ![1, 2].includes(Object.keys(body).length) ||
        (Object.keys(body).length === 2 && body.kitchen_admission !== 'unpaid')
      )
        throw new Error();
      parse.uuid(body.quote_id);
    } else if (p.kind === 'cancel') {
      if (!/^orders\/[0-9a-f-]+\/cancel$/.test(path) || Object.keys(body).length !== 2)
        throw new Error();
      parse.uuid(path.split('/')[1]);
      parse.integer(body.expected_version);
      parse.text(body.reason);
    } else if (p.kind === 'ordering') {
      if (!['ordering/open', 'ordering/close'].includes(path) || Object.keys(body).length !== 1)
        throw new Error();
      parse.integer(body.expected_version);
    } else if (p.kind === 'stop') {
      if (
        path !== 'availability/stops' ||
        ![4, 5].includes(Object.keys(body).length) ||
        (body.duration !== undefined &&
          !['manual', 'hour', 'shift'].includes(String(body.duration))) ||
        typeof body.stopped !== 'boolean'
      )
        throw new Error();
      parse.uuid(body.variant_id);
      parse.integer(body.expected_version, 0);
      parse.text(body.reason);
    } else if (p.kind === 'shift_open') {
      if (path !== 'cash-shifts' || Object.keys(body).length !== 1) throw new Error();
      parse.minor(body.opening_cash_minor);
    } else if (p.kind === 'shift_move') {
      if (
        !/^cash-shifts\/[0-9a-f-]+\/movements$/.test(path) ||
        Object.keys(body).length !== 3 ||
        !['in', 'out'].includes(String(body.direction))
      )
        throw new Error();
      parse.uuid(path.split('/')[1]);
      parse.minor(body.amount_minor);
      parse.text(body.reason);
    } else if (p.kind === 'shift_close') {
      // Today's close has exactly three keys; a sales shift may add the Kaspi terminal total
      // and the shift_close_pending_fiscal approval (contracts section 5.1).
      const keys = Object.keys(body);
      if (
        !/^cash-shifts\/[0-9a-f-]+\/close$/.test(path) ||
        keys.some((k) => !CLOSE_KEYS.includes(k)) ||
        keys.length < 3
      )
        throw new Error();
      parse.uuid(path.split('/')[1]);
      parse.integer(body.expected_version);
      parse.minor(body.counted_cash_minor);
      parse.text(body.reason);
      if (body.terminal_reported_minor !== undefined) parse.minor(body.terminal_reported_minor);
      if (body.approval !== undefined) parseProof(body.approval);
    } else if (p.kind === 'sale') {
      this.parseSaleBody(path, body);
    } else if (p.kind === 'fiscal_record') {
      const keys = Object.keys(body);
      if (
        !/^pos\/fiscal-receipts\/[0-9a-f-]+\/record$/.test(path) ||
        keys.some((k) => !['expected_version', 'receipt_number', 'approval'].includes(k)) ||
        keys.length < 2
      )
        throw new Error();
      parse.uuid(path.split('/')[2]);
      parse.integer(body.expected_version);
      parse.text(body.receipt_number, 40);
      if (body.approval !== undefined) parseProof(body.approval);
      parse.uuid(p.subject);
    } else if (p.kind === 'void') {
      if (
        !/^pos\/sales\/[0-9a-f-]+\/void$/.test(path) ||
        Object.keys(body).length !== VOID_KEYS.length ||
        Object.keys(body).some((k) => !VOID_KEYS.includes(k)) ||
        typeof body.fiscal_sale_issued !== 'boolean'
      )
        throw new Error();
      parse.uuid(path.split('/')[2]);
      parse.integer(body.expected_version);
      refundReason(body.reason_code, body.reason);
      parseProof(body.approval);
    } else if (p.kind === 'refund') {
      if (
        !/^pos\/sales\/[0-9a-f-]+\/refunds$/.test(path) ||
        Object.keys(body).length !== REFUND_KEYS.length ||
        Object.keys(body).some((k) => !REFUND_KEYS.includes(k)) ||
        !Array.isArray(body.tenders) ||
        !body.tenders.length ||
        body.tenders.length > 2
      )
        throw new Error();
      parse.uuid(path.split('/')[2]);
      parse.uuid(body.refund_id);
      const ids = body.tenders.map((value) => {
        const t = parse.record(value);
        if (Object.keys(t).length !== 2 || parse.minor(t.amount_minor) === '0') throw new Error();
        return parse.uuid(t.tender_id);
      });
      if (new Set(ids).size !== ids.length) throw new Error();
      refundReason(body.reason_code, body.reason);
      parseProof(body.approval);
    } else throw new Error();
    return {
      key: parse.uuid(p.key),
      path,
      body,
      kind: p.kind as Pending['kind'],
      at: parse.text(p.at, 40),
      ...(p.kind === 'fiscal_record' ? { subject: parse.uuid(p.subject) } : {}),
    };
  }
  /** A journaled POST pos/sales body: exactly what saleRequest can produce, nothing else. */
  private parseSaleBody(path: string, body: Record<string, unknown>) {
    if (
      path !== 'pos/sales' ||
      Object.keys(body).some((k) => !SALE_KEYS.includes(k)) ||
      body.service_mode_confirmed !== true ||
      body.order_repeated !== true ||
      !Array.isArray(body.tenders) ||
      !body.tenders.length ||
      body.tenders.length > 2
    )
      throw new Error();
    parse.uuid(body.quote_id);
    for (const value of body.tenders) {
      const t = parse.record(value);
      if (
        Object.keys(t).some((k) => !['method', 'amount_minor', 'reference'].includes(k)) ||
        !(parse.PAYMENT_METHODS as readonly unknown[]).includes(t.method) ||
        parse.minor(t.amount_minor) === '0'
      )
        throw new Error();
      if (t.reference !== undefined) parse.text(t.reference, 40);
    }
    if (
      body.external_order_ref !== undefined &&
      !parse.EXTERNAL_ORDER_REF.test(parse.text(body.external_order_ref, 40))
    )
      throw new Error();
    if (body.cash_tendered_minor !== undefined) parse.minor(body.cash_tendered_minor);
    if (body.beneficiary !== undefined) parse.text(body.beneficiary, 100);
    if (body.reason !== undefined && parse.text(body.reason).trim().length < 3) throw new Error();
    if (body.approval !== undefined) parseProof(body.approval);
  }
  async boot() {
    let stored: string | null;
    try {
      stored = this.sessions.getItem(AUTH_KEY);
    } catch {
      this.fail(new Error('STORAGE_UNAVAILABLE'));
      return;
    }
    if (stored) await this.login(stored);
  }
  async login(raw: string) {
    await this.run(async () => {
      if (raw.length > 10000) throw new Error('INVALID_CREDENTIAL');
      let candidate: StaffCredential;
      try {
        candidate = parse.credential(JSON.parse(raw));
      } catch {
        throw new Error('INVALID_CREDENTIAL');
      }
      await this.establishSession(candidate);
    });
  }
  retryLoginAt = 0;
  async signIn(login: string, password: string, terminalId: string | undefined) {
    await this.run(async () => {
      if (!parse.isUuid(terminalId)) throw new Error('TERMINAL_NOT_CONFIGURED');
      if (Date.now() < this.retryLoginAt) throw new ApiError('AUTH_RATE_LIMITED', 429);
      const account = login.trim().toLowerCase();
      if (
        !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(account) ||
        password.length < 12 ||
        password.length > 128
      )
        throw new Error('INVALID_LOGIN');
      let candidate: StaffCredential;
      try {
        candidate = parse.credential(
          await this.passwordApi({ login: account, password, terminal_id: terminalId }),
        );
      } catch (error) {
        if (error instanceof ApiError && error.code === 'AUTH_RATE_LIMITED')
          this.retryLoginAt = Date.now() + (error.retryAfterSeconds || 60) * 1000;
        throw error;
      }
      if (candidate.terminal_id !== terminalId) throw new Error('WRONG_BRANCH');
      await this.establishSession(candidate);
      this.retryLoginAt = 0;
    });
  }
  private async establishSession(candidate: StaffCredential) {
    const actor = parse.session(await this.api('session', candidate));
    if (actor.session_id !== candidate.session_id || scopeFor(actor) !== scopeFor(candidate))
      throw new Error('WRONG_BRANCH');
    if (actor.role === 'kitchen') throw new ApiError('FORBIDDEN', 403);
    const saved = { ...actor, token: candidate.token };
    if (!this.releaseLease && this.lease)
      this.releaseLease = await this.lease(`${actor.branch_id}.${actor.terminal_id}`);
    let journal: Journal;
    try {
      journal = this.readJournal(actor);
    } catch (error) {
      this.state.storageBlocked = true;
      this.releaseLease?.();
      this.releaseLease = null;
      throw error;
    }
    try {
      this.sessions.setItem(AUTH_KEY, JSON.stringify(saved));
    } catch {
      this.releaseLease?.();
      this.releaseLease = null;
      throw new Error('STORAGE_UNAVAILABLE');
    }
    this.generation++;
    this.credential = saved;
    this.journal = journal;
    this.state = {
      ...this.state,
      actor,
      menu: null,
      ordering: null,
      stops: new Map(),
      quote: null,
      order: null,
      error: null,
      connectedAt: Date.now(),
      draft: journal.draft,
      known: journal.known,
      pending: journal.pending,
      storageBlocked: false,
      shift: null,
      shifts: [],
      orders: [],
      operationsAvailable: false,
      operationsAt: null,
      operationsError: null,
      menuChange: null,
      cloudLink: null,
      posConfig: null,
      posConfigMissing: false,
      sale: null,
      saleDraft: blankSaleDraft(),
      approval: null,
      ...blankOperations(),
    };
    this.posConfigAt = -Infinity;
    this.operationsSaleAt = -Infinity;
    this.posConfigMissingUntil = -Infinity;
    this.receiptReadAt.clear();
    await this.refreshData();
    await this.readOperations();
    if (journal.selected) await this.readOrder(journal.selected);
    // Asked after every request of today's cashier, which stay as they were. The paid mode is
    // decided by the edge; a 404 or any failure keeps today's unpaid cashier.
    await this.refreshPosConfig(true);
  }
  logout() {
    if (this.state.busy) return;
    const credential = this.credential;
    try {
      this.sessions.removeItem(AUTH_KEY);
    } catch {
      this.fail(new Error('STORAGE_UNAVAILABLE'));
      return;
    }
    this.generation++;
    this.credential = null;
    if (credential) void this.api('staff/logout', credential, { method: 'POST' }).catch(() => {});
    this.journal = null;
    this.releaseLease?.();
    this.releaseLease = null;
    this.receiptReadAt.clear();
    this.state = {
      actor: null,
      menu: null,
      ordering: null,
      stops: new Map(),
      draft: null,
      quote: null,
      order: null,
      known: [],
      pending: null,
      busy: false,
      error: null,
      connectedAt: null,
      storageBlocked: false,
      shift: null,
      shifts: [],
      orders: [],
      operationsAvailable: false,
      operationsAt: null,
      operationsError: null,
      menuChange: null,
      cloudLink: null,
      posConfig: null,
      posConfigMissing: false,
      sale: null,
      saleDraft: blankSaleDraft(),
      approval: null,
      ...blankOperations(),
    };
    this.emit();
  }
  /** Moves unsent carts to the new release. Lines whose variant or chosen options are gone are
   *  dropped; kept lines are repriced by the next quote. Orders and pending commands are never
   *  touched: a pending create only references its quote, which the edge re-checks. */
  private reconcileDrafts(previous: MenuSnapshot | null, next: MenuSnapshot): string[] {
    const journal = this.journal;
    if (!journal) return [];
    const removed: string[] = [];
    const move = (cart: Cart): Cart => {
      if (cart.release_id === next.release_id) return cart;
      const items = cart.items.filter((line) => {
        const item = next.items.find((i) => i.variant_id === line.variant_id);
        try {
          if (!item) throw new Error('ITEM_REMOVED');
          parse.validateSelections(item, line.modifiers ?? []);
          return true;
        } catch {
          removed.push(
            (previous?.items.find((i) => i.variant_id === line.variant_id) ?? item)?.name.ru ??
              'из прошлого меню',
          );
          return false;
        }
      });
      return { ...cart, release_id: next.release_id, items };
    };
    const draft = journal.draft && move(journal.draft);
    const held = journal.held?.map(move);
    if (draft !== journal.draft || held?.some((cart, n) => cart !== journal.held![n]))
      this.save({ ...journal, draft, ...(held ? { held } : {}) });
    return removed;
  }
  private async refreshData() {
    const [m, o] = await Promise.all([
      this.request('menu').then(parse.menu),
      this.request('ordering').then(parse.ordering),
    ]);
    if (m.branch_id !== this.state.actor?.branch_id || o.branch_id !== m.branch_id)
      throw new Error('WRONG_BRANCH');
    const previous = this.state.menu;
    this.state.menu = m;
    this.state.ordering = o;
    this.state.stops = new Map();
    if (this.state.quote && this.state.quote.release_id !== m.release_id) this.state.quote = null;
    const removed = this.reconcileDrafts(previous, m);
    if ((previous && previous.release_id !== m.release_id) || removed.length)
      this.state.menuChange = {
        id: ++this.menuChanges,
        release_id: m.release_id,
        version: m.version,
        previous_version: previous?.version ?? null,
        removed,
      };
    if (this.journal && !this.journal.draft)
      this.save({
        ...this.journal,
        draft: { release_id: m.release_id, service_mode: 'takeaway', items: [] },
      });
    await this.loadStops([
      ...new Set([
        ...m.items.slice(0, 36).map((i) => i.variant_id),
        ...(this.state.draft?.items.map((i) => i.variant_id) ?? []),
      ]),
    ]);
  }
  async refresh() {
    await this.run(async () => {
      await this.refreshData();
      await this.readOperations();
    });
  }
  /** Cheap live-menu check for the stop poll. A changed release reloads the menu and moves the
   *  unsent draft; a quote that was already shown is recalculated once on the new menu. */
  async syncMenu(): Promise<MenuChange | null> {
    const epoch = this.generation,
      current = this.state.menu;
    if (!this.state.actor || !current || this.state.busy || this.journal?.pending) return null;
    let latest: parse.MenuVersion;
    try {
      latest = parse.menuVersion(await this.request('menu/version'));
    } catch (error) {
      // An edge without this route (404) or a transient failure keeps the loaded menu.
      if (epoch === this.generation && error instanceof ApiError && error.code === 'UNAUTHORIZED')
        this.fail(error);
      return null;
    }
    if (
      epoch !== this.generation ||
      latest.release_id === current.release_id ||
      this.state.menu !== current ||
      this.state.busy ||
      this.journal?.pending
    )
      return null;
    const requote = Boolean(this.state.quote && !this.state.order);
    const before = this.state.menuChange;
    await this.run(async () => {
      await this.refreshData();
      if (requote && this.journal?.draft?.items.length) await this.quoteWithRetry();
    });
    return this.state.menuChange !== before ? this.state.menuChange : null;
  }
  private operationsRead = 0;
  private async readOperations() {
    const read = ++this.operationsRead,
      epoch = this.generation,
      actor = this.state.actor;
    if (!actor) return;
    try {
      const selectedId = this.state.order?.order_id;
      const [shift, orders, shifts, selectedOrder] = await Promise.all([
        this.request('cash-shifts/current').then(parse.currentShift),
        this.request('orders').then(parse.orderFeed),
        this.request('cash-shifts').then(parse.shiftHistory),
        selectedId ? this.request(`orders/${selectedId}`).then(parse.order) : null,
      ]);
      if (epoch !== this.generation || read !== this.operationsRead) return;
      const own = (value: CashShift) =>
        value.branch_id === actor.branch_id &&
        (actor.role === 'shift_manager' || value.terminal_id === actor.terminal_id);
      if (
        (shift &&
          (shift.state !== 'open' || !own(shift) || shift.terminal_id !== actor.terminal_id)) ||
        shifts.some((s) => !own(s)) ||
        orders.some((o) => o.branch_id !== actor.branch_id) ||
        (selectedOrder &&
          (selectedOrder.branch_id !== actor.branch_id || selectedOrder.order_id !== selectedId))
      )
        throw new Error('WRONG_BRANCH');
      this.state.shift = shift;
      this.state.shifts = shifts;
      this.state.orders = orders;
      if (selectedOrder && this.state.order?.order_id === selectedId)
        this.state.order = selectedOrder;
      this.state.operationsAvailable = true;
      this.state.operationsAt = Date.now();
      this.state.operationsError = null;
    } catch (error) {
      if (epoch !== this.generation || read !== this.operationsRead) return;
      this.state.operationsError = error;
      if (error instanceof ApiError && error.code === 'UNAUTHORIZED') this.fail(error);
    }
    this.emit();
  }
  async refreshOperations() {
    if (this.state.busy || this.state.pending || !this.state.actor) return;
    await this.readOperations();
    await this.refreshCloudLink();
    await this.refreshPosConfig();
    await this.refreshSaleOperations();
  }
  private operationsSaleAt = -Infinity;
  /**
   * Paid mode only: pending Webkassa receipts and the X report of this desk, at most every
   * POS_CONFIG_POLL_MS (or at once with force). Nothing here is ever asked in the unpaid mode.
   */
  async refreshSaleOperations(force = false) {
    const now = this.now();
    if (!this.saleMode || !this.credential) return;
    if (!force && now - this.operationsSaleAt < POS_CONFIG_POLL_MS) return;
    this.operationsSaleAt = now;
    await this.refreshFiscal();
    await this.refreshShiftReport();
  }
  /**
   * GET pos/config (contracts section 5.1). A 404 is an edge without paid sales: today's
   * unpaid cashier, asked again after POS_CONFIG_MISSING_MS. A failed read keeps the last
   * answer, so a short LAN loss never flips the screens; only the edge's own answer does.
   * A session without any answer yet does not know whether its desk sells, so a failed read
   * then is asked again at the next operations refresh, not after POS_CONFIG_POLL_MS.
   */
  async refreshPosConfig(force = false) {
    const now = this.now(),
      credential = this.credential,
      epoch = this.generation;
    if (!credential) return;
    if (!force && (now - this.posConfigAt < POS_CONFIG_POLL_MS || now < this.posConfigMissingUntil))
      return;
    this.posConfigAt = now;
    let config: PosConfig | null = this.state.posConfig,
      missing = this.state.posConfigMissing;
    try {
      config = parse.posConfig(await this.api('pos/config', credential));
      missing = false;
    } catch (error) {
      if (epoch !== this.generation) return;
      if (error instanceof ApiError && error.status === 404) {
        config = null;
        missing = true;
        this.posConfigMissingUntil = now + POS_CONFIG_MISSING_MS;
      } else if (error instanceof ApiError && error.code === 'UNAUTHORIZED') {
        this.fail(error);
        return;
      } else if (!this.state.posConfig && !this.state.posConfigMissing) {
        // No answer yet in this session (review 07.11 R1): the poll window is not used up.
        this.posConfigAt = -Infinity;
      }
    }
    if (epoch !== this.generation) return;
    if (!unchanged(this.state.posConfig, config) || this.state.posConfigMissing !== missing) {
      const wasSale = this.saleMode;
      this.state.posConfig = config;
      this.state.posConfigMissing = missing;
      // Leaving the paid mode drops what only it shows; the cart itself stays.
      if (wasSale && !this.saleMode) {
        this.state.saleDraft = blankSaleDraft();
        this.state.approval = null;
        Object.assign(this.state, blankOperations());
        this.receiptReadAt.clear();
      }
      this.emit();
    }
  }
  /** Asked at most every CLOUD_LINK_POLL_MS; never blocks the operations view or selling. */
  async refreshCloudLink() {
    const now = this.now(),
      credential = this.credential,
      epoch = this.generation;
    if (!credential || now - this.cloudLinkAt < CLOUD_LINK_POLL_MS) return;
    if (now < this.cloudLinkMissingUntil) return;
    this.cloudLinkAt = now;
    let link: EdgeCloudLink | null = null;
    try {
      link = parse.cloudLink(await this.api('cloud-link', credential));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404)
        this.cloudLinkMissingUntil = now + CLOUD_LINK_MISSING_MS;
    }
    if (epoch !== this.generation) return;
    if (!unchanged(this.state.cloudLink, link)) {
      this.state.cloudLink = link;
      this.emit();
    }
  }
  async refreshStops() {
    const epoch = this.generation;
    try {
      const value = parse.record(await this.request('availability/stops'));
      if (!Array.isArray(value.stops) || value.stops.length > 10000)
        throw new Error('INVALID_RESPONSE');
      const stops = value.stops.map(parse.stop);
      if (epoch !== this.generation) return;
      this.state.stops = new Map(stops.map((s) => [s.variant_id, s]));
      this.emit();
    } catch (error) {
      if (epoch === this.generation) this.fail(error);
    }
  }
  async loadStops(ids: string[]) {
    const epoch = this.generation;
    try {
      for (let i = 0; i < ids.length; i += 6) {
        const batch = await Promise.all(
          ids.slice(i, i + 6).map(async (id) => {
            parse.uuid(id);
            const s = parse.stop(await this.request(`availability/stops/${id}`));
            if (s.variant_id !== id) throw new Error('INVALID_RESPONSE');
            return s;
          }),
        );
        if (epoch !== this.generation) return;
        for (const s of batch) this.state.stops.set(s.variant_id, s);
      }
      this.emit();
    } catch (error) {
      if (epoch === this.generation) this.fail(error);
    }
  }
  private editable() {
    if (
      !this.journal ||
      !this.state.actor ||
      this.state.busy ||
      this.state.storageBlocked ||
      this.state.order
    )
      return false;
    if (this.journal.pending) {
      this.fail(new Error('PENDING'));
      return false;
    }
    return true;
  }
  /** Combo stop rule before a line is added or grows; the edge re-checks quote and order. */
  private assertComboOnSale(item: Item) {
    const view = parse.itemStopView(this.state.menu!, item, this.state.stops);
    if (view.reason?.kind === 'component') throw new Error('COMBO_STOPPED');
    // Also a plain item with a required choice (sauce size), so not worded as a combo.
    if (view.reason?.kind === 'group') throw new Error('CHOICE_STOPPED');
  }
  private assertOptionsOnSale(item: Item, selected: readonly Selection[]) {
    const view = parse.itemStopView(this.state.menu!, item, this.state.stops);
    if (selected.some((s) => view.stoppedOptions.has(s.option_id)))
      throw new Error('OPTION_STOPPED');
  }
  quantity(id: string, count: number) {
    if (!this.editable() || !this.journal?.draft || !this.state.menu) return;
    try {
      if (!Number.isInteger(count) || count < 0 || count > 99) throw new Error('LIMIT');
      const existing = this.journal.draft.items.find((i) => parse.lineKey(i) === id);
      const variant = existing?.variant_id ?? id;
      const item = this.state.menu.items.find((i) => i.variant_id === variant);
      const old = existing?.quantity ?? 0;
      if (count > old && (!item || this.state.stops.get(variant)?.stopped !== false))
        throw new Error('ITEM_STOPPED');
      if (count > old && item) this.assertComboOnSale(item);
      if (count && item) parse.validateSelections(item, existing?.modifiers ?? []);
      if (count > old && item) this.assertOptionsOnSale(item, existing?.modifiers ?? []);
      const items = this.journal.draft.items.flatMap((i) =>
        parse.lineKey(i) === id ? (count ? [{ ...i, quantity: count }] : []) : [i],
      );
      if (count && !existing) items.push({ variant_id: variant, quantity: count });
      if (items.length > 50) throw new Error('LIMIT');
      this.save({
        ...this.journal,
        draft: { ...this.journal.draft, release_id: this.state.menu.release_id, items },
      });
      this.state.quote = null;
      this.state.error = null;
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }
  configure(variantId: string, modifiers: Selection[], quantity: number, previousKey?: string) {
    if (!this.editable() || !this.journal?.draft || !this.state.menu) return;
    try {
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new Error('LIMIT');
      const item = this.state.menu.items.find((i) => i.variant_id === variantId);
      if (!item || this.state.stops.get(variantId)?.stopped !== false)
        throw new Error('ITEM_STOPPED');
      this.assertComboOnSale(item);
      const selected = parse.validateSelections(item, modifiers);
      this.assertOptionsOnSale(item, selected);
      const next = {
        variant_id: variantId,
        quantity,
        ...(selected.length ? { modifiers: selected } : {}),
      };
      const key = parse.lineKey(next);
      if (previousKey && !this.journal.draft.items.some((i) => parse.lineKey(i) === previousKey))
        throw new Error('INVALID_REQUEST');
      const remaining = this.journal.draft.items.filter((i) => parse.lineKey(i) !== previousKey);
      const matching = remaining.find((i) => parse.lineKey(i) === key);
      if (matching) next.quantity += matching.quantity;
      if (next.quantity > 99) throw new Error('LIMIT');
      const items = remaining.filter((i) => parse.lineKey(i) !== key);
      items.push(next);
      if (items.length > 50) throw new Error('LIMIT');
      this.save({
        ...this.journal,
        draft: { ...this.journal.draft, release_id: this.state.menu.release_id, items },
      });
      this.state.quote = null;
      this.state.error = null;
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }
  mode(mode: Cart['service_mode']) {
    if (!this.editable() || !this.journal?.draft) return;
    try {
      this.save({ ...this.journal, draft: { ...this.journal.draft, service_mode: mode } });
      this.state.quote = null;
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }
  replaceDraft(value: Cart) {
    if (!this.editable() || !this.journal) return;
    try {
      const draft = parse.cart(value);
      if (draft.release_id !== this.state.menu?.release_id) throw new Error('MENU_CHANGED');
      this.save({ ...this.journal, draft });
      this.state.quote = null;
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }
  get heldDrafts() {
    return this.journal?.held ?? [];
  }
  holdDraft() {
    if (!this.editable() || !this.journal?.draft?.items.length) return;
    try {
      if (this.heldDrafts.length >= 10) throw new Error('LIMIT');
      this.save({
        ...this.journal,
        held: [...this.heldDrafts, this.journal.draft],
        draft: { release_id: this.journal.draft.release_id, service_mode: 'takeaway', items: [] },
      });
      this.state.quote = null;
      this.state.saleDraft = blankSaleDraft();
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }
  restoreDraft(index = 0) {
    if (!this.editable() || !this.journal) return;
    try {
      const held = [...this.heldDrafts],
        draft = held.splice(index, 1)[0];
      if (!draft) throw new Error('NOT_FOUND');
      if (this.journal.draft?.items.length) held.push(this.journal.draft);
      this.save({ ...this.journal, held, draft });
      this.state.quote = null;
      this.state.saleDraft = blankSaleDraft();
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }
  async calculate() {
    if (!this.editable()) return;
    await this.run(async () => {
      if (!this.journal?.draft?.items.length) throw new Error('INVALID_REQUEST');
      // The paid mode checks its methods and channels again before every quote.
      if (this.saleMode) await this.refreshPosConfig(true);
      await this.refreshData();
      await this.quoteWithRetry();
    });
  }
  /** MENU_CHANGED means a publication landed between the menu read and the quote. The draft is
   *  moved to the new release and quoted exactly once more; a second change is shown to staff. */
  private async quoteWithRetry() {
    try {
      await this.quoteDraft();
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'MENU_CHANGED')) throw error;
      await this.refreshData();
      await this.quoteDraft();
    }
  }
  private async quoteDraft() {
    if (!this.journal?.draft?.items.length) throw new Error('MENU_CHANGED');
    const draft = { ...this.journal.draft!, release_id: this.state.menu!.release_id };
    // Paid mode, aggregator channel (contracts section 2.2): channel prices, always takeaway.
    // Every other quote request is the draft exactly as before.
    const channel = this.saleMode ? this.state.saleDraft.channel : 'hall';
    if (parse.isAggregator(channel)) draft.service_mode = 'takeaway';
    this.save({ ...this.journal, draft });
    this.state.quote = null;
    const q = parse.quote(
      await this.request('checkout/quotes', {
        method: 'POST',
        body: parse.isAggregator(channel) ? { ...draft, sales_channel: channel } : draft,
      }),
    );
    const actual = q.lines
      .map((l) => ({ key: parse.lineKey(l), quantity: l.quantity }))
      .sort((a, b) => a.key.localeCompare(b.key));
    if (
      q.branch_id !== this.state.actor?.branch_id ||
      q.release_id !== draft.release_id ||
      q.service_mode !== draft.service_mode ||
      (q.sales_channel ?? 'hall') !== channel ||
      !unchanged(
        actual,
        draft.items
          .map((l) => ({ key: parse.lineKey(l), quantity: l.quantity }))
          .sort((a, b) => a.key.localeCompare(b.key)),
      )
    )
      throw new Error('INVALID_RESPONSE');
    this.state.quote = q;
  }
  private async begin(
    kind: Pending['kind'],
    path: string,
    body: Record<string, unknown>,
    subject?: string,
  ) {
    if (!this.journal || this.state.storageBlocked || this.journal.pending)
      throw new Error('PENDING');
    const pending = {
      kind,
      path,
      body,
      key: this.newKey(),
      at: new Date().toISOString(),
      ...(subject === undefined ? {} : { subject }),
    };
    this.save({ ...this.journal, pending });
    this.emit();
    await this.replay();
  }
  get hasConfirmedOpenShift() {
    const { actor, shift, operationsAvailable, operationsError } = this.state;
    return Boolean(
      actor &&
      operationsAvailable &&
      !operationsError &&
      shift?.state === 'open' &&
      shift.branch_id === actor.branch_id &&
      shift.terminal_id === actor.terminal_id,
    );
  }
  async create(kitchenAdmission = false) {
    if (!this.editable()) return;
    await this.run(async () => {
      if (!this.state.operationsAvailable || this.state.operationsError)
        throw new Error('CASH_SHIFT_STATUS_UNKNOWN');
      if (!this.hasConfirmedOpenShift) throw new Error('CASH_SHIFT_REQUIRED');
      const q = this.state.quote;
      if (!q || Date.parse(q.expires_at) <= Date.now()) throw new Error('QUOTE_EXPIRED');
      // The paid mode sells through POST pos/sales; POST orders there is always refused.
      if (this.saleMode) throw new Error('SERVICE_MODE_DISABLED');
      if (kitchenAdmission && this.state.ordering?.pos_service_mode !== 'unpaid_service')
        throw new Error('SERVICE_MODE_DISABLED');
      await this.begin('create', 'orders', {
        quote_id: q.quote_id,
        ...(kitchenAdmission ? { kitchen_admission: 'unpaid' } : {}),
      });
    });
  }
  async recover() {
    await this.run(() => this.replay());
  }
  private async replay() {
    const j = this.journal,
      p = j?.pending;
    if (!j || !p) return;
    let value: unknown;
    try {
      value = await this.request(p.path, { method: 'POST', body: p.body, key: p.key });
    } catch (error) {
      const admissionRejected =
        error instanceof ApiError &&
        error.status === 409 &&
        ((p.kind === 'create' &&
          ['SERVICE_MODE_DISABLED', 'KITCHEN_UNAVAILABLE'].includes(error.code)) ||
          (p.kind === 'cancel' && error.code === 'ORDER_IN_PRODUCTION'));
      if (admissionRejected) {
        this.save({ ...j, pending: null });
        this.state.quote = null;
        if (p.kind === 'cancel') await this.readOrder(p.path.split('/')[1]!);
        await this.refreshData();
        await this.readOperations();
      }
      // Paid sale rules (contracts section 5.1): the edge refused inside its transaction and
      // committed nothing, so this key can never succeed. The quote stays usable unless the
      // refusal is about the quote itself; the cashier fixes the payment and sends a new key.
      if (
        (p.kind === 'sale' || p.kind === 'fiscal_record') &&
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        (p.kind === 'sale' ? SALE_REJECTIONS.has(error.code) : approvalKey(error.code))
      ) {
        this.save({ ...j, pending: null });
        if (approvalKey(error.code)) this.state.approval = null;
        if (['CHANNEL_PRICE_UNAVAILABLE', 'SERVICE_MODE_DISABLED'].includes(error.code))
          this.state.quote = null;
        if (error.code === 'SERVICE_MODE_DISABLED') await this.refreshPosConfig(true);
        if (p.kind === 'fiscal_record' && p.subject) await this.refreshSale(p.subject);
        throw error;
      }
      // Void, refund and closing a sales shift (contracts section 5.1, POS-3/4): a definite
      // refusal ends the command; the approval it carried is spent or invalid either way.
      if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        (((p.kind === 'void' || p.kind === 'refund') && OPERATION_REJECTIONS.has(error.code)) ||
          (p.kind === 'shift_close' && CLOSE_REJECTIONS.has(error.code)))
      ) {
        this.save({ ...j, pending: null });
        this.state.approval = null;
        if (p.kind === 'shift_close') await this.refreshFiscal();
        else await this.reloadSaleOrder(p.path.split('/')[2]!);
        if (error.code === 'SERVICE_MODE_DISABLED') await this.refreshPosConfig(true);
        throw error;
      }
      if (error instanceof ApiError && error.code === 'CONFLICT' && error.status === 409) {
        // The edge stores a command result only when it commits, and a committed same-key
        // replay returns that result. A 409 CONFLICT for this key is therefore a final
        // rejection (stale version, consumed quote, changed shift) that a retry repeats forever.
        // Persist resolution before reading the new state; uncertain responses remain pending.
        this.save({ ...j, pending: null });
        this.state.quote = null;
        // A create is rejected when its quote is already an order (made on this terminal with
        // another key): show that order instead of leaving the same cart to be sold twice.
        if ((p.kind === 'create' || p.kind === 'sale') && (await this.adoptQuotedOrder(p))) {
          if (p.kind === 'sale' && this.state.order)
            await this.refreshSale(this.state.order.order_id);
          return;
        }
        await this.reconcileRejected(p);
      }
      if (
        error instanceof ApiError &&
        [
          'QUOTE_EXPIRED',
          'MENU_CHANGED',
          'ITEM_STOPPED',
          'BRANCH_UNAVAILABLE',
          'INVALID_REQUEST',
          'NOT_FOUND',
          'FORBIDDEN',
          'CASH_SHIFT_REQUIRED',
        ].includes(error.code)
      ) {
        this.save({ ...j, pending: null });
        this.state.quote = null;
      }
      throw error;
    }
    if (p.kind === 'sale') {
      const result = parse.saleResult(value);
      if (
        result.order.branch_id !== this.state.actor?.branch_id ||
        result.order.quote_id !== p.body.quote_id ||
        !sameTenders(result.sale.tenders, p.body.tenders)
      )
        throw new Error('INVALID_RESPONSE');
      const id = result.order.order_id;
      this.save({
        ...j,
        pending: null,
        selected: id,
        known: [id, ...j.known.filter((v) => v !== id)].slice(0, 100),
        draft: null,
      });
      this.state.order = result.order;
      this.state.sale = result.sale;
      this.state.quote = null;
      this.state.approval = null;
      this.state.saleDraft = blankSaleDraft();
      // The POST replays its historical result; GET is the authoritative current sale.
      await this.refreshSale(id);
      await this.readOperations();
      await this.refreshSaleOperations(true);
      return;
    }
    if (p.kind === 'fiscal_record') {
      const r = parse.record(value);
      if (
        (r.receipt_id !== undefined && r.receipt_id !== p.path.split('/')[2]) ||
        (r.receipt_number !== undefined && r.receipt_number !== p.body.receipt_number)
      )
        throw new Error('INVALID_RESPONSE');
      this.save({ ...j, pending: null });
      this.state.approval = null;
      if (p.subject) await this.refreshSale(p.subject);
      await this.refreshFiscal();
      return;
    }
    if (p.kind === 'void') {
      // 200 {order, sale}: the order is cancelled and its sale carries the void.
      const result = parse.saleResult(value);
      const id = p.path.split('/')[2];
      if (
        result.order.order_id !== id ||
        result.order.branch_id !== this.state.actor?.branch_id ||
        result.order.state !== 'cancelled' ||
        !result.sale.refunds.some((r) => r.kind === 'void')
      )
        throw new Error('INVALID_RESPONSE');
      this.save({ ...j, pending: null });
      this.state.approval = null;
      if (!this.state.order || this.state.order.order_id === id) this.state.order = result.order;
      if (!this.state.sale || this.state.sale.order_id === id) this.state.sale = result.sale;
      await this.reloadSaleOrder(id!);
      await this.readOperations();
      await this.refreshSaleOperations(true);
      return;
    }
    if (p.kind === 'refund') {
      // PosSale: this refund is in it, on exactly the requested tenders.
      const sale = parse.posSale(value);
      const id = p.path.split('/')[2];
      const refund = sale.refunds.find((r) => r.refund_id === p.body.refund_id);
      const key = (t: { tender_id: unknown; amount_minor: unknown }) =>
        `${t.tender_id}:${t.amount_minor}`;
      if (
        sale.order_id !== id ||
        !refund ||
        refund.kind !== 'refund' ||
        !unchanged(
          refund.tenders.map(key).sort(),
          (p.body.tenders as Record<string, unknown>[]).map((t) => key(t as never)).sort(),
        )
      )
        throw new Error('INVALID_RESPONSE');
      this.save({ ...j, pending: null });
      this.state.approval = null;
      if (!this.state.sale || this.state.sale.order_id === id) this.state.sale = sale;
      await this.reloadSaleOrder(id!);
      await this.readOperations();
      await this.refreshSaleOperations(true);
      return;
    }
    if (p.kind === 'create' || p.kind === 'cancel') {
      const created = parse.order(value);
      if (
        created.branch_id !== this.state.actor?.branch_id ||
        (p.kind === 'create' &&
          (created.quote_id !== p.body.quote_id ||
            (p.body.kitchen_admission === 'unpaid' &&
              created.execution_mode !== 'unpaid_service'))) ||
        (p.kind === 'cancel' && p.path !== `orders/${created.order_id}/cancel`)
      )
        throw new Error('INVALID_RESPONSE');
      const known = [created.order_id, ...j.known.filter((id) => id !== created.order_id)].slice(
        0,
        100,
      );
      this.save({
        ...j,
        pending: null,
        selected: created.order_id,
        known,
        draft: p.kind === 'create' ? null : j.draft,
      });
      this.state.order = created;
      this.state.quote = null;
      // Idempotent POST replays its historical result; GET is the authoritative current state.
      await this.readOrder(created.order_id);
      await this.readOperations();
    } else {
      if (p.kind === 'ordering') this.state.ordering = parse.ordering(value);
      if (p.kind === 'stop') {
        const s = parse.stop(value);
        this.state.stops.set(s.variant_id, s);
      }
      if (p.kind === 'shift_move') {
        const shift = parse.cashShift(value),
          move = shift.cash_movements?.find((m) => m.id === p.key);
        if (
          shift.branch_id !== this.state.actor?.branch_id ||
          p.path !== `cash-shifts/${shift.shift_id}/movements` ||
          !move ||
          move.amount_minor !== p.body.amount_minor ||
          move.direction !== p.body.direction ||
          move.reason !== p.body.reason
        )
          throw new Error('INVALID_RESPONSE');
      }
      if (p.kind === 'shift_open' || p.kind === 'shift_close') {
        const shift = parse.cashShift(value),
          actor = this.state.actor!;
        if (
          shift.branch_id !== actor.branch_id ||
          (p.kind === 'shift_open' &&
            (shift.staff_id !== actor.staff_id ||
              shift.terminal_id !== actor.terminal_id ||
              shift.opening_cash_minor !== p.body.opening_cash_minor ||
              shift.state !== 'open')) ||
          (p.kind === 'shift_close' &&
            (p.path !== `cash-shifts/${shift.shift_id}/close` ||
              shift.state !== 'closed' ||
              shift.counted_cash_minor !== p.body.counted_cash_minor))
        )
          throw new Error('INVALID_RESPONSE');
      }
      this.save({ ...j, pending: null });
      this.state.quote = null;
      // A sales shift closed with its approval (if any): it is spent, never shown again.
      if (p.kind === 'shift_close') this.state.approval = null;
      await this.refreshData();
      await this.readOperations();
    }
  }
  /** Selects the order a rejected create's quote already became; false if there is none. */
  private async adoptQuotedOrder(p: Pending) {
    await this.readOperations();
    const found = this.state.orders.find((o) => o.quote_id === p.body.quote_id),
      j = this.journal;
    if (!found || !j || found.branch_id !== this.state.actor?.branch_id) return false;
    this.save({
      ...j,
      selected: found.order_id,
      known: [found.order_id, ...j.known.filter((id) => id !== found.order_id)].slice(0, 100),
      draft: null,
    });
    this.state.order = found;
    return true;
  }
  /** Best-effort re-read of whatever a rejected command targeted; the CONFLICT stays visible. */
  private async reconcileRejected(p: Pending) {
    if (p.kind === 'shift_open' || p.kind === 'shift_close' || p.kind === 'shift_move') {
      this.state.operationsAvailable = false;
      this.state.shift = null;
    }
    if (p.kind === 'void' || p.kind === 'refund' || p.kind === 'fiscal_record')
      this.state.approval = null;
    try {
      if (p.kind === 'cancel') await this.readOrder(p.path.split('/')[1]!);
      if (p.kind === 'fiscal_record' && p.subject) await this.readSale(p.subject);
      if (p.kind === 'void' || p.kind === 'refund')
        await this.reloadSaleOrder(p.path.split('/')[2]!);
      if (p.kind === 'stop') {
        const id = parse.uuid(p.body.variant_id);
        const s = parse.stop(await this.request(`availability/stops/${id}`));
        if (s.variant_id !== id) throw new Error('INVALID_RESPONSE');
        this.state.stops.set(id, s);
      }
      if (p.kind === 'ordering') {
        const o = parse.ordering(await this.request('ordering'));
        if (o.branch_id !== this.state.actor?.branch_id) throw new Error('WRONG_BRANCH');
        this.state.ordering = o;
      }
    } catch {
      // A failed refresh leaves the previous view; the next poll or manual refresh corrects it.
    }
    await this.readOperations();
  }
  private async readOrder(id: string) {
    const o = parse.order(await this.request(`orders/${parse.uuid(id)}`));
    if (o.order_id !== id || o.branch_id !== this.state.actor?.branch_id)
      throw new Error('INVALID_RESPONSE');
    this.state.order = o;
  }
  async openOrder(id: string) {
    await this.run(async () => {
      if (!this.journal || this.journal.pending) throw new Error('PENDING');
      await this.readOrder(id);
      this.save({
        ...this.journal,
        selected: id,
        known: [id, ...this.journal.known.filter((v) => v !== id)].slice(0, 100),
      });
    });
  }
  newDraft() {
    if (!this.journal || !this.state.menu || this.state.busy) return;
    try {
      if (this.journal.pending) throw new Error('PENDING');
      this.save({
        ...this.journal,
        selected: null,
        draft: this.journal.draft ?? {
          release_id: this.state.menu.release_id,
          service_mode: 'takeaway',
          items: [],
        },
      });
      this.state.order = null;
      this.state.quote = null;
      this.state.error = null;
      this.state.sale = null;
      this.state.approval = null;
      this.state.saleDraft = blankSaleDraft();
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }
  // ---- Paid mode (cutover 19.11, contracts section 5.1) ------------------------------------
  /** Hall or an aggregator. An aggregator order is always takeaway at channel prices. */
  setChannel(channel: SalesChannel) {
    if (!this.editable() || !this.journal?.draft) return;
    try {
      const config = this.state.posConfig;
      if (!config || !this.saleMode || !saleChannelEnabled(config, channel))
        throw new Error('METHOD_DISABLED');
      const aggregator = parse.isAggregator(channel),
        previous = this.state.saleDraft;
      if (aggregator && this.journal.draft.service_mode !== 'takeaway')
        this.save({ ...this.journal, draft: { ...this.journal.draft, service_mode: 'takeaway' } });
      this.state.saleDraft = {
        channel,
        serviceModeChosen: aggregator,
        externalOrderRef: previous.channel === channel ? previous.externalOrderRef : '',
        reviewed: null,
      };
      this.state.quote = null;
      this.state.approval = null;
      this.state.error = null;
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }
  /** KS8: the cashier must tap "В зале" or "С собой" for every paid order. */
  chooseServiceMode(mode: Cart['service_mode']) {
    if (!this.editable() || !this.journal?.draft) return;
    try {
      if (parse.isAggregator(this.state.saleDraft.channel) && mode !== 'takeaway')
        throw new Error('AGGREGATOR_TAKEAWAY_ONLY');
      this.save({ ...this.journal, draft: { ...this.journal.draft, service_mode: mode } });
      this.state.saleDraft = { ...this.state.saleDraft, serviceModeChosen: true, reviewed: null };
      this.state.quote = null;
      this.state.error = null;
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }
  setExternalOrderRef(value: string) {
    if (!this.editable()) return;
    this.state.saleDraft = {
      ...this.state.saleDraft,
      externalOrderRef: value.trim().toUpperCase().slice(0, 40),
      reviewed: null,
    };
    this.emit();
  }
  /** "Гость подтвердил - к оплате": binds the repeat screen to this exact quote. */
  confirmReview() {
    const q = this.state.quote;
    try {
      if (!this.saleMode || !q || this.state.order) throw new Error('ORDER_REVIEW_REQUIRED');
      if (!this.state.saleDraft.serviceModeChosen) throw new Error('SERVICE_MODE_REQUIRED');
      this.state.saleDraft = {
        ...this.state.saleDraft,
        reviewed: { quote_id: q.quote_id, signature: quoteSignature(q) },
      };
      this.state.error = null;
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }
  /** True while the shown quote is the one the guest confirmed on the repeat screen. */
  get reviewed() {
    return Boolean(
      this.state.quote && this.state.saleDraft.reviewed?.quote_id === this.state.quote.quote_id,
    );
  }
  /** The held approval for this action and subject (a sale action: the shown quote), or null. */
  approvalFor(action: ApprovalAction, subject?: ApprovalSubject) {
    const ttl = this.state.posConfig?.approval_ttl_seconds ?? 0;
    const target =
      subject ??
      (SALE_ACTIONS.includes(action) && this.state.quote ? quoteSubject(this.state.quote) : null);
    return approvalValid(this.state.approval, action, target, this.now(), ttl)
      ? this.state.approval
      : null;
  }
  /**
   * A quote close to expiry is quoted again before money moves. Same lines, prices, type and
   * channel keep the guest's confirmation; anything else must be repeated to the guest.
   */
  private async freshQuote(minRemainingMs = QUOTE_MARGIN_MS): Promise<Quote> {
    const current = this.state.quote;
    if (current && Date.parse(current.expires_at) - this.now() > minRemainingMs) return current;
    const reviewed = this.state.saleDraft.reviewed;
    await this.refreshData();
    await this.quoteWithRetry();
    const q = this.state.quote!;
    this.state.saleDraft = {
      ...this.state.saleDraft,
      reviewed:
        reviewed && reviewed.signature === quoteSignature(q)
          ? { quote_id: q.quote_id, signature: reviewed.signature }
          : null,
    };
    return q;
  }
  /**
   * After a 401 of staff/approvals: did this desk's own session end? One ordinary read, GET
   * cash-shifts/current, answers it. Not GET session: pos-desktop takes the journal away on every
   * GET session and gives it back only on its 200, so a lost answer there would block the
   * journal. Only the edge's own 401 says the session ended; a lost answer or any other refusal
   * keeps the cashier logged in and the PIN refused.
   */
  private async sessionEnded() {
    try {
      await this.request('cash-shifts/current');
      return false;
    } catch (error) {
      return error instanceof ApiError && (error.status === 401 || error.code === 'UNAUTHORIZED');
    }
  }
  /**
   * POST staff/approvals with the shift manager's PIN (contracts section 5.1, R13). Not
   * journaled: a lost answer only leaves an unused approval that expires; the PIN is asked
   * again. A refused PIN never ends the cashier's own session; an ended session still does.
   */
  async requestApproval(pin: string, action: ApprovalAction, subject?: ApprovalSubject) {
    if (!this.journal || !this.state.actor || this.state.busy || this.state.storageBlocked) return;
    if (this.journal.pending) {
      this.fail(new Error('PENDING'));
      return;
    }
    await this.run(async () => {
      const actor = this.state.actor;
      const sale = SALE_ACTIONS.includes(action);
      if (!actor || !this.saleMode) throw new Error('INVALID_REQUEST');
      // A sale action is for the quote on screen; every other action names its own subject.
      if (sale ? !this.state.quote || this.state.order || subject : !subject)
        throw new Error('INVALID_REQUEST');
      if (!PIN_FORMAT.test(pin)) throw new Error('APPROVAL_PIN_REJECTED');
      this.state.approval = null;
      // The quote must outlive the approval: a re-quote at payment would change quote_id.
      const target = sale
        ? quoteSubject(
            await this.freshQuote(
              approvalQuoteSpare(
                this.state.quote!,
                this.state.posConfig?.approval_ttl_seconds ?? 0,
              ),
            ),
          )
        : subject!;
      let value: unknown;
      try {
        value = await this.request('staff/approvals', {
          method: 'POST',
          key: this.newKey(),
          body: { staff_id: actor.staff_id, pin, action, subject: target },
        });
      } catch (error) {
        // A refused manager PIN (401/403, any code) is not the cashier's session ending. A 401
        // is also what the edge answers when this desk's own session ended (CR pos-2 section
        // 1.2), so the session is asked once: only its own 401 logs the desk out.
        if (
          error instanceof ApiError &&
          (error.status === 401 ||
            error.status === 403 ||
            ['UNAUTHORIZED', 'FORBIDDEN'].includes(error.code))
        ) {
          if (
            (error.status === 401 || error.code === 'UNAUTHORIZED') &&
            (await this.sessionEnded())
          )
            throw new ApiError('UNAUTHORIZED', 401);
          throw new ApiError('APPROVAL_PIN_REJECTED', error.status);
        }
        throw error;
      }
      const approval = parse.approval(value);
      this.state.approval = { ...approval, action, subject: target, received_at: this.now() };
    });
  }
  /** Pays the confirmed quote: one journaled POST pos/sales, replayed only with its own key. */
  async sell(payment: SalePayment) {
    if (!this.editable()) return;
    await this.run(async () => {
      if (!this.state.operationsAvailable || this.state.operationsError)
        throw new Error('CASH_SHIFT_STATUS_UNKNOWN');
      if (!this.hasConfirmedOpenShift) throw new Error('CASH_SHIFT_REQUIRED');
      const config = this.state.posConfig;
      if (!config) throw new Error('POS_CONFIG_UNAVAILABLE');
      if (!this.state.quote) throw new Error('ORDER_REVIEW_REQUIRED');
      const quote = await this.freshQuote();
      const body = saleRequest({
        quote,
        config,
        draft: this.state.saleDraft,
        payment,
        approval: this.state.approval,
        now: this.now(),
      });
      await this.begin('sale', 'pos/sales', body);
    });
  }
  /** Webkassa receipt number typed after the receipt was punched (Ч3, manual fiscal mode). */
  async recordReceipt(receiptNumber: string) {
    const sale = this.state.sale,
      receipt = sale?.fiscal.find((f) => f.kind === 'sale' && f.state === 'pending');
    if (!sale || !receipt) {
      this.fail(new Error('RECEIPT_NOT_PENDING'));
      return;
    }
    await this.recordFiscal({ ...receipt, order_id: sale.order_id }, receiptNumber);
  }
  /**
   * POST pos/fiscal-receipts/{id}/record: a pending receipt gets its number; a recorded one is
   * corrected only with a fiscal_correct approval of the shift manager (contracts section 5.1).
   * Journaled like every command, and read again with GET pos/sales/{order} afterwards.
   */
  async recordFiscal(
    receipt: {
      receipt_id: string;
      order_id: string;
      version: number;
      amount_minor: string;
      state: SaleFiscal['state'];
      receipt_number?: string | null;
    },
    receiptNumber: string,
  ) {
    await this.run(async () => {
      if (!this.saleMode) throw new Error('SERVICE_MODE_DISABLED');
      if (receipt.state === 'not_required') throw new Error('RECEIPT_NOT_PENDING');
      const number = typedNumber(receiptNumber, 'RECEIPT_NUMBER_INVALID');
      const correction = receipt.state === 'recorded';
      if (correction && number === receipt.receipt_number) throw new Error('RECEIPT_NUMBER_SAME');
      const approval = correction
        ? approvalProof(
            this.state.approval,
            'fiscal_correct',
            fiscalSubject(receipt),
            this.now(),
            this.state.posConfig?.approval_ttl_seconds ?? 0,
          )
        : undefined;
      await this.begin(
        'fiscal_record',
        `pos/fiscal-receipts/${parse.uuid(receipt.receipt_id)}/record`,
        {
          expected_version: receipt.version,
          receipt_number: number,
          ...(approval ? { approval } : {}),
        },
        parse.uuid(receipt.order_id),
      );
    });
  }
  private async readSale(orderId: string) {
    const sale = parse.posSale(await this.request(`pos/sales/${parse.uuid(orderId)}`));
    if (sale.order_id !== orderId) throw new Error('INVALID_RESPONSE');
    if (!this.state.sale || this.state.sale.order_id === orderId) this.state.sale = sale;
    this.noteSaleReceipt(sale);
  }
  /** Keeps the sale receipt state of a sale just read; true when it changed. */
  private noteSaleReceipt(sale: PosSale) {
    const receipt = sale.fiscal.find((f) => f.kind === 'sale');
    if (!receipt) return false;
    this.receiptReadAt.set(sale.order_id, this.now());
    if (this.state.saleReceipts[sale.order_id] === receipt.state) return false;
    this.state.saleReceipts = { ...this.state.saleReceipts, [sale.order_id]: receipt.state };
    return true;
  }
  /**
   * "ЗАКАЗЫ" in the paid mode (CR client-5): the Webkassa state of the sale receipt of each
   * listed paid order, as the X report counts receipts. GET pos/sales/{id} for an order not
   * read yet, and again for a pending one at most every POS_CONFIG_POLL_MS (a recorded or not
   * required receipt stays so); at most RECEIPT_READS reads per call, in the order given.
   * Best effort: never while a command is busy or pending, and nothing in the unpaid mode.
   */
  async refreshSaleReceipts(orderIds: readonly string[]) {
    if (!this.saleMode || !this.credential || this.state.busy || this.state.pending) return;
    const epoch = this.generation,
      now = this.now();
    const paid = new Set(
      this.state.orders.filter((o) => o.execution_mode === 'pos_sale').map((o) => o.order_id),
    );
    const due = orderIds
      .filter((id) => {
        const state = this.state.saleReceipts[id];
        return (
          paid.has(id) &&
          state !== 'recorded' &&
          state !== 'not_required' &&
          now - (this.receiptReadAt.get(id) ?? -Infinity) >= POS_CONFIG_POLL_MS
        );
      })
      .slice(0, RECEIPT_READS);
    let changed = false;
    for (const id of due) {
      try {
        const sale = parse.posSale(await this.request(`pos/sales/${parse.uuid(id)}`));
        if (epoch !== this.generation) return;
        if (sale.order_id === id) changed = this.noteSaleReceipt(sale) || changed;
      } catch (error) {
        if (epoch !== this.generation) return;
        if (error instanceof ApiError && error.code === 'UNAUTHORIZED') {
          this.fail(error);
          return;
        }
        // Asked again after the pause; the row keeps "-" or its last state meanwhile.
        this.receiptReadAt.set(id, now);
      }
    }
    if (changed) this.emit();
  }
  /** Best effort: the historical command result stays on screen when the read fails. */
  private async refreshSale(orderId: string) {
    try {
      await this.readSale(orderId);
    } catch {
      /* The next done-screen action reads it again. */
    }
  }
  /** Best effort after a void or refund: the order (kitchen state, version) and its sale. */
  private async reloadSaleOrder(orderId: string) {
    try {
      if (this.state.order?.order_id === orderId) await this.readOrder(orderId);
    } catch {
      /* The order card reads it again when it is opened. */
    }
    await this.refreshSale(orderId);
  }
  /**
   * The paid order shown in the order card: GET orders/{id} and GET pos/sales/{id}. Its sale
   * replaces any other one on screen; the done screen of a new order clears it again.
   */
  async openSale(orderId: string) {
    await this.run(async () => {
      if (!this.journal || this.journal.pending) throw new Error('PENDING');
      if (!this.saleMode) throw new Error('SERVICE_MODE_DISABLED');
      await this.readOrder(orderId);
      if (this.state.order?.execution_mode !== 'pos_sale') throw new Error('INVALID_REQUEST');
      this.state.sale = null;
      this.state.approval = null;
      await this.readSale(orderId);
      this.save({
        ...this.journal,
        selected: orderId,
        known: [orderId, ...this.journal.known.filter((v) => v !== orderId)].slice(0, 100),
      });
    });
  }
  /** The selected paid order and its sale, both read for the same order. */
  private saleTarget() {
    // Voids and refunds are booked to this desk's open sales shift (edge schema026 guard).
    if (!this.hasConfirmedOpenShift) throw new Error('CASH_SHIFT_REQUIRED');
    const order = this.state.order,
      sale = this.state.sale;
    if (!order || !sale || order.execution_mode !== 'pos_sale' || sale.order_id !== order.order_id)
      throw new Error('INVALID_REQUEST');
    if (order.state !== 'paid' || sale.refundable_minor === '0') throw new Error('SALE_NOT_ACTIVE');
    return { order, sale };
  }
  /**
   * POST pos/sales/{id}/void (contracts section 5.1): only before the kitchen starts, with a void
   * approval of the shift manager for {order_id, refundable}. fiscal_sale_issued says whether the
   * sale receipt is already in Webkassa: known for recorded and not required receipts, asked
   * from the cashier for a pending one.
   */
  async voidSale(input: {
    reason_code: RefundReason;
    reason: string;
    fiscal_sale_issued?: boolean;
  }) {
    await this.run(async () => {
      if (!this.saleMode) throw new Error('SERVICE_MODE_DISABLED');
      const { order, sale } = this.saleTarget();
      if (order.fulfillment_state !== 'accepted') throw new Error('ORDER_IN_PRODUCTION');
      const reason = refundReason(input.reason_code, input.reason);
      const receipt = sale.fiscal.find((f) => f.kind === 'sale');
      const issued =
        receipt?.state === 'recorded'
          ? true
          : receipt?.state === 'pending'
            ? input.fiscal_sale_issued
            : false;
      if (typeof issued !== 'boolean') throw new Error('FISCAL_SALE_ANSWER_REQUIRED');
      const approval = approvalProof(
        this.state.approval,
        'void',
        voidSubject(sale),
        this.now(),
        this.state.posConfig?.approval_ttl_seconds ?? 0,
      );
      await this.begin('void', `pos/sales/${order.order_id}/void`, {
        expected_version: order.version,
        ...reason,
        fiscal_sale_issued: issued,
        approval,
      });
    });
  }
  /**
   * POST pos/sales/{id}/refunds (contracts section 5.1): back to the tenders it was paid with,
   * each at most what it still holds, with a refund approval for {order_id, sum}. Cash comes
   * out of this desk's drawer; a Kaspi terminal refund is made on the terminal first.
   */
  async refund(input: {
    tenders: readonly { tender_id: string; amount_minor: string }[];
    reason_code: RefundReason;
    reason: string;
  }) {
    await this.run(async () => {
      if (!this.saleMode) throw new Error('SERVICE_MODE_DISABLED');
      const { order, sale } = this.saleTarget();
      if (!input.tenders.length || input.tenders.length > 2)
        throw new Error('REFUND_AMOUNT_INVALID');
      const tenders = input.tenders.map((t) => {
        const paid = sale.tenders.find((x) => x.tender_id === t.tender_id);
        if (!paid) throw new Error('REFUND_AMOUNT_INVALID');
        if (!(parse.REFUNDABLE_METHODS as readonly string[]).includes(paid.method))
          throw new Error('REFUND_NOT_SUPPORTED');
        let amount: bigint;
        try {
          amount = BigInt(parse.minor(t.amount_minor));
        } catch {
          throw new Error('REFUND_AMOUNT_INVALID');
        }
        if (amount <= 0n) throw new Error('REFUND_AMOUNT_INVALID');
        if (paid.method === 'kaspi_terminal' && amount % 100n !== 0n)
          throw new Error('TERMINAL_AMOUNT_NOT_WHOLE');
        if (amount > parse.tenderRefundable(sale, paid.tender_id)) throw new Error('REFUND_LIMIT');
        return { tender_id: paid.tender_id, amount_minor: amount.toString() };
      });
      if (new Set(tenders.map((t) => t.tender_id)).size !== tenders.length)
        throw new Error('REFUND_AMOUNT_INVALID');
      const reason = refundReason(input.reason_code, input.reason);
      const subject = refundSubject(order.order_id, tenders);
      if (BigInt(subject.amount_minor) > BigInt(sale.refundable_minor))
        throw new Error('REFUND_LIMIT');
      const approval = approvalProof(
        this.state.approval,
        'refund',
        subject,
        this.now(),
        this.state.posConfig?.approval_ttl_seconds ?? 0,
      );
      await this.begin('refund', `pos/sales/${order.order_id}/refunds`, {
        refund_id: this.newKey(),
        tenders,
        ...reason,
        approval,
      });
    });
  }
  /** GET pos/fiscal-receipts/pending: this desk's open shift, or every shift of the branch. */
  private async readFiscal(scope: FiscalPending['scope']) {
    const shift = this.state.shift?.state === 'open' ? this.state.shift.shift_id : null;
    const own = scope === 'shift' && shift;
    const receipts = parse.fiscalPending(
      await this.request(`pos/fiscal-receipts/pending${own ? `?shift_id=${shift}` : ''}`),
    );
    this.state.fiscal = {
      scope: own ? 'shift' : 'all',
      shift_id: own ? shift : null,
      receipts,
      at: this.now(),
    };
    // Every sale receipt on the list is pending now; "ЗАКАЗЫ" needs no read for it.
    const sales = receipts.filter((r) => r.kind === 'sale');
    if (sales.length) {
      const now = this.now();
      const next = { ...this.state.saleReceipts };
      for (const r of sales) {
        next[r.order_id] = 'pending';
        this.receiptReadAt.set(r.order_id, now);
      }
      this.state.saleReceipts = next;
    }
    return receipts;
  }
  /** Best effort for the badge and the tab; a failed read keeps the last list. */
  async refreshFiscal(scope: FiscalPending['scope'] = this.state.fiscal?.scope ?? 'shift') {
    if (!this.saleMode || !this.credential) return;
    const epoch = this.generation;
    try {
      await this.readFiscal(scope);
    } catch (error) {
      if (epoch === this.generation && error instanceof ApiError && error.code === 'UNAUTHORIZED')
        this.fail(error);
      return;
    }
    if (epoch === this.generation) this.emit();
  }
  /** The X report of this desk's open shift, kept for the shift tab (best effort). */
  async refreshShiftReport() {
    const shift = this.state.shift;
    if (!this.saleMode || !this.credential || shift?.state !== 'open') {
      this.state.shiftReport = null;
      return;
    }
    const epoch = this.generation;
    try {
      const report = await this.readReport('x', shift.shift_id);
      if (epoch === this.generation) this.state.shiftReport = report;
    } catch {
      return;
    }
    if (epoch === this.generation) this.emit();
  }
  private async readReport(kind: 'x' | 'z', shiftId: string) {
    const report = parse.shiftReport(
      await this.request(`cash-shifts/${parse.uuid(shiftId)}/${kind}-report`),
    );
    if (report.kind !== kind || report.shift_id !== shiftId) throw new Error('INVALID_RESPONSE');
    return report;
  }
  /** "X-отчёт": a fresh snapshot of the open shift; nothing changes on the edge. */
  async xReport() {
    await this.run(async () => {
      const shift = this.state.shift;
      if (!this.saleMode || shift?.state !== 'open') throw new Error('CASH_SHIFT_REQUIRED');
      this.state.shiftReport = await this.readReport('x', shift.shift_id);
    });
  }
  /** The frozen Z report of a closed sales shift (GET cash-shifts/{id}/z-report). */
  async zReport(shiftId: string) {
    await this.run(async () => {
      if (!this.saleMode) throw new Error('SERVICE_MODE_DISABLED');
      this.state.zReport = await this.readReport('z', shiftId);
    });
  }
  /** Pending receipts of one shift, for the close wizard (the closing manager's session). */
  async pendingForClose(shiftId: string) {
    let result: FiscalPendingItem[] | null = null;
    await this.run(async () => {
      if (!this.saleMode) throw new Error('SERVICE_MODE_DISABLED');
      if (this.state.shift?.shift_id !== shiftId) throw new Error('CASH_SHIFT_REQUIRED');
      result = await this.readFiscal('shift');
    });
    return result as FiscalPendingItem[] | null;
  }
  /**
   * Closes a sales shift (contracts section 5.1): today's body plus the Kaspi terminal total
   * and, while receipts are pending, a shift_close_pending_fiscal approval for {shift, pending
   * total}. The pending list is read again right before, so the approval matches what is left.
   */
  async closeSaleShift(
    shiftId: string,
    input: { counted_cash_minor: string; terminal_reported_minor?: string; reason: string },
  ) {
    await this.run(async () => {
      if (!this.saleMode) throw new Error('SERVICE_MODE_DISABLED');
      const shift = parse.cashShift(await this.request(`cash-shifts/${parse.uuid(shiftId)}`));
      if (shift.branch_id !== this.state.actor?.branch_id || shift.state !== 'open')
        throw new Error('CONFLICT');
      parse.minor(input.counted_cash_minor);
      if (input.terminal_reported_minor !== undefined) parse.minor(input.terminal_reported_minor);
      const reason = input.reason.trim();
      if (!reason || reason.length > 300) throw new Error('INVALID_REQUEST');
      const pending = parse.fiscalPending(
        await this.request(`pos/fiscal-receipts/pending?shift_id=${shiftId}`),
      );
      // Without an approval the edge refuses the same way (FISCAL_PENDING); say it before.
      if (pending.length && this.state.approval?.action !== 'shift_close_pending_fiscal')
        throw new Error('FISCAL_PENDING');
      const approval = pending.length
        ? approvalProof(
            this.state.approval,
            'shift_close_pending_fiscal',
            closeSubject(shiftId, pending),
            this.now(),
            this.state.posConfig?.approval_ttl_seconds ?? 0,
          )
        : undefined;
      await this.begin('shift_close', `cash-shifts/${shiftId}/close`, {
        expected_version: shift.version,
        counted_cash_minor: input.counted_cash_minor,
        reason,
        ...(input.terminal_reported_minor === undefined
          ? {}
          : { terminal_reported_minor: input.terminal_reported_minor }),
        ...(approval ? { approval } : {}),
      });
    });
  }
  async cancel(reason: string) {
    await this.run(async () => {
      const o = this.state.order;
      if (!o || o.state !== 'awaiting_payment' || !reason.trim() || reason.trim().length > 300)
        throw new Error('INVALID_REQUEST');
      await this.begin('cancel', `orders/${o.order_id}/cancel`, {
        expected_version: o.version,
        reason: reason.trim(),
      });
    });
  }
  async setOrdering(enabled: boolean) {
    await this.run(async () => {
      if (this.state.actor?.role !== 'shift_manager' || !this.state.ordering)
        throw new ApiError('FORBIDDEN', 403);
      await this.begin('ordering', `ordering/${enabled ? 'open' : 'close'}`, {
        expected_version: this.state.ordering.version,
      });
    });
  }
  async moveCash(direction: 'in' | 'out', amountMinor: string, reason: string) {
    await this.run(async () => {
      if (!this.state.shift || this.state.actor?.role !== 'shift_manager')
        throw new Error('FORBIDDEN');
      await this.begin('shift_move', `cash-shifts/${this.state.shift.shift_id}/movements`, {
        direction,
        amount_minor: parse.minor(amountMinor),
        reason: parse.text(reason.trim()),
      });
    });
  }
  async openShift(openingCashMinor: string) {
    await this.run(async () => {
      parse.minor(openingCashMinor);
      await this.begin('shift_open', 'cash-shifts', { opening_cash_minor: openingCashMinor });
    });
  }
  async closeShift(shiftId: string, countedCashMinor: string, reason: string) {
    await this.run(async () => {
      const shift = parse.cashShift(await this.request(`cash-shifts/${parse.uuid(shiftId)}`));
      if (shift.branch_id !== this.state.actor?.branch_id || shift.state !== 'open')
        throw new Error('CONFLICT');
      parse.minor(countedCashMinor);
      if (!reason.trim() || reason.trim().length > 300) throw new Error('INVALID_REQUEST');
      await this.begin('shift_close', `cash-shifts/${shiftId}/close`, {
        expected_version: shift.version,
        counted_cash_minor: countedCashMinor,
        reason: reason.trim(),
      });
    });
  }
  async setStop(
    id: string,
    stopped: boolean,
    reason: string,
    duration?: 'manual' | 'hour' | 'shift',
  ) {
    await this.run(async () => {
      if (!this.state.actor || !['cashier', 'shift_manager'].includes(this.state.actor.role))
        throw new ApiError('FORBIDDEN', 403);
      const s = parse.stop(await this.request(`availability/stops/${parse.uuid(id)}`));
      if (!reason.trim() || reason.trim().length > 300) throw new Error('INVALID_REQUEST');
      await this.begin('stop', 'availability/stops', {
        variant_id: id,
        ...(duration ? { duration } : {}),
        stopped,
        expected_version: s.version,
        reason: reason.trim(),
      });
    });
  }
}
