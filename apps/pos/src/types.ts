import type {
  Cart,
  LocalOrder,
  MenuSnapshot,
  Quote,
  StaffCredential,
  StaffSession,
} from '@pickchick/contracts';
export type { Cart, LocalOrder, MenuSnapshot, Quote, StaffCredential, StaffSession };
export type Item = MenuSnapshot['items'][number];
export type Ordering = { branch_id: string; ordering_enabled: boolean; version: number };
export type Stop = { variant_id: string; stopped: boolean; version: number };
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_RESPONSE');
  return value as Record<string, unknown>;
}
export function integer(value: unknown, min = 1, max = 2147483647): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new Error('INVALID_RESPONSE');
  return value;
}
export function text(value: unknown, max = 300): string {
  if (typeof value !== 'string' || !value.length || value.length > max)
    throw new Error('INVALID_RESPONSE');
  return value;
}
export function uuid(value: unknown): string {
  if (!isUuid(value)) throw new Error('INVALID_RESPONSE');
  return value;
}
export function minor(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,18})$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw new Error('INVALID_RESPONSE');
  return value;
}
export function money(value: string): string {
  const amount = BigInt(minor(value));
  const whole = (amount / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${whole}${amount % 100n ? `,${(amount % 100n).toString().padStart(2, '0')}` : ''} ₸`;
}
function date(value: unknown): string {
  const result = text(value, 40);
  if (!/^\d{4}-\d\d-\d\dT/.test(result) || !Number.isFinite(Date.parse(result)))
    throw new Error('INVALID_RESPONSE');
  return result;
}
function names(value: unknown) {
  const n = record(value);
  return { ru: text(n.ru), kk: text(n.kk) };
}
export function session(value: unknown): StaffSession {
  const s = record(value);
  if (!['cashier', 'shift_manager', 'kitchen'].includes(String(s.role)))
    throw new Error('INVALID_RESPONSE');
  return {
    session_id: uuid(s.session_id),
    staff_id: uuid(s.staff_id),
    terminal_id: uuid(s.terminal_id),
    branch_id: uuid(s.branch_id),
    role: s.role as StaffSession['role'],
    expires_at: date(s.expires_at),
  };
}
export function credential(value: unknown): StaffCredential {
  const s = record(value);
  if (typeof s.token !== 'string' || !/^[a-f0-9]{64}$/.test(s.token))
    throw new Error('INVALID_CREDENTIAL');
  return { ...session(s), token: s.token };
}
export function menu(value: unknown): MenuSnapshot {
  const m = record(value);
  if (m.schema_version !== 1 || !Array.isArray(m.items) || m.items.length > 10000)
    throw new Error('INVALID_RESPONSE');
  const items = m.items.map((input): Item => {
    const i = record(input);
    if (i.currency !== 'KZT') throw new Error('INVALID_RESPONSE');
    return {
      product_id: uuid(i.product_id),
      variant_id: uuid(i.variant_id),
      category_id: uuid(i.category_id),
      name: names(i.name),
      currency: 'KZT',
      price_minor: minor(i.price_minor),
    };
  });
  if (new Set(items.map((i) => i.variant_id)).size !== items.length)
    throw new Error('INVALID_RESPONSE');
  return {
    schema_version: 1,
    release_id: uuid(m.release_id),
    branch_id: uuid(m.branch_id),
    version: integer(m.version),
    published_at: date(m.published_at),
    items,
  };
}
export function cart(value: unknown): Cart {
  const c = record(value);
  if (
    !['takeaway', 'dine_in'].includes(String(c.service_mode)) ||
    !Array.isArray(c.items) ||
    c.items.length > 50
  )
    throw new Error('INVALID_RESPONSE');
  const items = c.items.map((input) => {
    const i = record(input);
    return { variant_id: uuid(i.variant_id), quantity: integer(i.quantity, 1, 99) };
  });
  if (new Set(items.map((i) => i.variant_id)).size !== items.length)
    throw new Error('INVALID_RESPONSE');
  return {
    release_id: uuid(c.release_id),
    service_mode: c.service_mode as Cart['service_mode'],
    items,
  };
}
export function quote(value: unknown): Quote {
  const q = record(value);
  if (
    q.channel !== 'pos' ||
    q.currency !== 'KZT' ||
    q.discount_minor !== '0' ||
    !['dine_in', 'takeaway'].includes(String(q.service_mode)) ||
    !Array.isArray(q.lines) ||
    !q.lines.length ||
    q.lines.length > 50
  )
    throw new Error('INVALID_RESPONSE');
  const lines = q.lines.map((input) => {
    const l = record(input),
      quantity = integer(l.quantity, 1, 99),
      unit = minor(l.unit_price_minor),
      total = minor(l.total_minor);
    if (BigInt(unit) * BigInt(quantity) !== BigInt(total)) throw new Error('INVALID_RESPONSE');
    return {
      product_id: uuid(l.product_id),
      variant_id: uuid(l.variant_id),
      name: names(l.name),
      quantity,
      unit_price_minor: unit,
      total_minor: total,
    };
  });
  const total = minor(q.total_minor);
  if (
    new Set(lines.map((l) => l.variant_id)).size !== lines.length ||
    lines.reduce((sum, l) => sum + BigInt(l.total_minor), 0n) !== BigInt(total) ||
    q.subtotal_minor !== total
  )
    throw new Error('INVALID_RESPONSE');
  return {
    quote_id: uuid(q.quote_id),
    branch_id: uuid(q.branch_id),
    release_id: uuid(q.release_id),
    menu_version: integer(q.menu_version),
    service_mode: q.service_mode as Quote['service_mode'],
    channel: 'pos',
    lines,
    currency: 'KZT',
    subtotal_minor: total,
    discount_minor: '0',
    total_minor: total,
    created_at: date(q.created_at),
    expires_at: date(q.expires_at),
  };
}
export function order(value: unknown): LocalOrder {
  const o = record(value);
  if (
    !['awaiting_payment', 'cancelled'].includes(String(o.state)) ||
    o.payment_state !== 'not_started' ||
    o.fiscal_state !== 'not_requested' ||
    o.fulfillment_state !== 'blocked' ||
    o.next_action !== (o.state === 'cancelled' ? 'none' : 'payment_not_available') ||
    !(o.cancellation_reason === null || typeof o.cancellation_reason === 'string')
  )
    throw new Error('INVALID_RESPONSE');
  const snapshot = quote(o.snapshot);
  if (snapshot.quote_id !== o.quote_id || snapshot.branch_id !== o.branch_id)
    throw new Error('INVALID_RESPONSE');
  return {
    order_id: uuid(o.order_id),
    branch_id: uuid(o.branch_id),
    quote_id: uuid(o.quote_id),
    version: integer(o.version),
    state: o.state as LocalOrder['state'],
    payment_state: 'not_started',
    fiscal_state: 'not_requested',
    fulfillment_state: 'blocked',
    next_action: o.next_action as LocalOrder['next_action'],
    snapshot,
    created_at: date(o.created_at),
    cancellation_reason: o.cancellation_reason as string | null,
  };
}
export function ordering(value: unknown): Ordering {
  const o = record(value);
  if (typeof o.ordering_enabled !== 'boolean') throw new Error('INVALID_RESPONSE');
  return {
    branch_id: uuid(o.branch_id),
    ordering_enabled: o.ordering_enabled,
    version: integer(o.version),
  };
}
export function stop(value: unknown): Stop {
  const s = record(value);
  if (typeof s.stopped !== 'boolean') throw new Error('INVALID_RESPONSE');
  return { variant_id: uuid(s.variant_id), stopped: s.stopped, version: integer(s.version, 0) };
}
