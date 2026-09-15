import type {
  Cart,
  LocalOrder,
  MenuSnapshot,
  Quote,
  CashShift,
  StaffCredential,
  StaffSession,
} from '@pickchick/contracts';
export type { Cart, LocalOrder, MenuSnapshot, Quote, CashShift, StaffCredential, StaffSession };
export type FulfillmentState = NonNullable<LocalOrder['fulfillment']>['state'];
export type Item = MenuSnapshot['items'][number];
export type CartLine = Cart['items'][number];
export type Selection = NonNullable<CartLine['modifiers']>[number];
export type ModifierGroup = NonNullable<Item['modifier_groups']>[number];
export type QuoteModifier = NonNullable<Quote['lines'][number]['modifiers']>[number];
export const lineKey = (line: Pick<CartLine, 'variant_id' | 'modifiers'>) =>
  line.variant_id +
  (line.modifiers?.length
    ? ':' +
      [...line.modifiers]
        .map((s) => s.group_id + '.' + s.option_id + '.' + (s.quantity ?? 1))
        .sort()
        .join(',')
    : '');
export const sortedSelections = (selections: Selection[]) =>
  [...selections].sort(
    (a, b) => a.group_id.localeCompare(b.group_id) || a.option_id.localeCompare(b.option_id),
  );
export type Ordering = {
  branch_id: string;
  ordering_enabled: boolean;
  version: number;
  pos_service_mode?: 'payment_required' | 'unpaid_service';
};
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
export function selections(value: unknown): Selection[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('INVALID_RESPONSE');
  const result = value.map((v) => {
    const s = record(v);
    return {
      group_id: uuid(s.group_id),
      option_id: uuid(s.option_id),
      ...(s.quantity === undefined ? {} : { quantity: integer(s.quantity, 1, 99) }),
    };
  });
  if (new Set(result.map((s) => s.group_id + '.' + s.option_id)).size !== result.length)
    throw new Error('INVALID_RESPONSE');
  return sortedSelections(result);
}
function modifierGroups(value: unknown): ModifierGroup[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('INVALID_RESPONSE');
  const groups = value.map((v) => {
    const g = record(v);
    if (!Array.isArray(g.options) || !g.options.length || g.options.length > 20)
      throw new Error('INVALID_RESPONSE');
    const options = g.options.map((v) => {
      const o = record(v);
      if (o.available !== undefined && typeof o.available !== 'boolean')
        throw new Error('INVALID_RESPONSE');
      const max = o.max_quantity === undefined ? 1 : integer(o.max_quantity, 1, 99);
      return {
        id: uuid(o.id),
        name: names(o.name),
        price_minor: minor(o.price_minor),
        ...(o.max_quantity === undefined ? {} : { max_quantity: max }),
        ...(o.default_quantity === undefined
          ? {}
          : { default_quantity: integer(o.default_quantity, 0, max) }),
        ...(o.available === undefined ? {} : { available: o.available }),
      };
    });
    const min_selected = integer(g.min_selected, 0, 99),
      max_selected = integer(g.max_selected, 1, 99);
    if (
      min_selected > max_selected ||
      max_selected > options.reduce((sum, o) => sum + (o.max_quantity ?? 1), 0) ||
      new Set(options.map((o) => o.id)).size !== options.length
    )
      throw new Error('INVALID_RESPONSE');
    return { id: uuid(g.id), name: names(g.name), min_selected, max_selected, options };
  });
  if (new Set(groups.map((g) => g.id)).size !== groups.length) throw new Error('INVALID_RESPONSE');
  return groups;
}
export function validateSelections(item: Item, selected: Selection[]): Selection[] {
  const result = selections(selected),
    groups = item.modifier_groups ?? [];
  for (const selection of result) {
    if (
      !groups.some(
        (g) =>
          g.id === selection.group_id &&
          g.options.some(
            (o) =>
              o.id === selection.option_id &&
              o.available !== false &&
              (selection.quantity ?? 1) <= (o.max_quantity ?? 1),
          ),
      )
    )
      throw new Error('INVALID_MODIFIERS');
  }
  for (const group of groups) {
    const count = result
      .filter((s) => s.group_id === group.id)
      .reduce((sum, s) => sum + (s.quantity ?? 1), 0);
    if (count < group.min_selected || count > group.max_selected)
      throw new Error('INVALID_MODIFIERS');
  }
  return result;
}
export function linePrice(item: Item, selected: Selection[] = []): bigint {
  let price = BigInt(item.price_minor);
  for (const selection of validateSelections(item, selected)) {
    const option = item
      .modifier_groups!.find((g) => g.id === selection.group_id)!
      .options.find((o) => o.id === selection.option_id)!;
    price += BigInt(option.price_minor) * BigInt(selection.quantity ?? 1);
  }
  if (price > 9223372036854775807n) throw new Error('LIMIT');
  return price;
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
      ...(i.image_url === undefined
        ? {}
        : {
            image_url: (() => {
              const image = text(i.image_url, 160);
              if (!/^\/assets\/menu\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp)$/.test(image))
                throw new Error('INVALID_RESPONSE');
              return image;
            })(),
          }),
      ...(i.modifier_groups === undefined
        ? {}
        : { modifier_groups: modifierGroups(i.modifier_groups) }),
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
    return {
      variant_id: uuid(i.variant_id),
      quantity: integer(i.quantity, 1, 99),
      ...(i.modifiers === undefined ? {} : { modifiers: selections(i.modifiers) }),
    };
  });
  if (new Set(items.map(lineKey)).size !== items.length) throw new Error('INVALID_RESPONSE');
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
      ...(l.modifiers === undefined
        ? {}
        : {
            modifiers: (() => {
              const ids = selections(l.modifiers);
              return ids.map((id) => {
                const value = (l.modifiers as unknown[])
                  .map(record)
                  .find((m) => m.group_id === id.group_id && m.option_id === id.option_id)!;
                return {
                  ...id,
                  group_name: names(value.group_name),
                  name: names(value.name),
                  price_minor: minor(value.price_minor),
                };
              });
            })(),
          }),
    };
  });
  const total = minor(q.total_minor);
  if (
    new Set(lines.map(lineKey)).size !== lines.length ||
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
  const admitted = o.execution_mode === 'unpaid_service';
  let fulfillment: LocalOrder['fulfillment'];
  if (admitted) {
    const f = record(o.fulfillment);
    if (
      ![
        'accepted',
        'in_production',
        'ready',
        'handed_over',
        'cancel_requested',
        'cancelled',
      ].includes(String(f.state)) ||
      f.state !== o.fulfillment_state ||
      minor(f.display_number) === '0'
    )
      throw new Error('INVALID_RESPONSE');
    fulfillment = {
      version: integer(f.version),
      display_number: minor(f.display_number),
      state: f.state as FulfillmentState,
    };
  } else if (o.execution_mode !== undefined || o.fulfillment !== undefined)
    throw new Error('INVALID_RESPONSE');
  if (
    !['awaiting_payment', 'cancelled'].includes(String(o.state)) ||
    o.payment_state !== 'not_started' ||
    o.fiscal_state !== 'not_requested' ||
    (!admitted && o.fulfillment_state !== 'blocked') ||
    o.next_action !== (admitted || o.state === 'cancelled' ? 'none' : 'payment_not_available') ||
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
    fulfillment_state: o.fulfillment_state as LocalOrder['fulfillment_state'],
    next_action: o.next_action as LocalOrder['next_action'],
    ...(fulfillment ? { execution_mode: 'unpaid_service' as const, fulfillment } : {}),
    snapshot,
    created_at: date(o.created_at),
    cancellation_reason: o.cancellation_reason as string | null,
    ...(o.cash_shift_id === undefined
      ? {}
      : { cash_shift_id: o.cash_shift_id === null ? null : uuid(o.cash_shift_id) }),
  };
}
export function ordering(value: unknown): Ordering {
  const o = record(value);
  if (typeof o.ordering_enabled !== 'boolean') throw new Error('INVALID_RESPONSE');
  if (
    o.pos_service_mode !== undefined &&
    !['payment_required', 'unpaid_service'].includes(String(o.pos_service_mode))
  )
    throw new Error('INVALID_RESPONSE');
  return {
    branch_id: uuid(o.branch_id),
    ordering_enabled: o.ordering_enabled,
    version: integer(o.version),
    ...(o.pos_service_mode === undefined
      ? {}
      : { pos_service_mode: o.pos_service_mode as 'payment_required' | 'unpaid_service' }),
  };
}
export function stop(value: unknown): Stop {
  const s = record(value);
  if (typeof s.stopped !== 'boolean') throw new Error('INVALID_RESPONSE');
  return { variant_id: uuid(s.variant_id), stopped: s.stopped, version: integer(s.version, 0) };
}
export function cashShift(value: unknown): CashShift {
  const s = record(value);
  if (
    !['open', 'closed'].includes(String(s.state)) ||
    s.currency !== 'KZT' ||
    s.cash_received_minor !== '0' ||
    s.cash_refunded_minor !== '0' ||
    s.payment_processing_available !== false
  )
    throw new Error('INVALID_RESPONSE');
  const discrepancy = s.discrepancy_minor === null ? null : text(s.discrepancy_minor, 21);
  if (discrepancy !== null) {
    if (discrepancy === '-0') throw new Error('INVALID_RESPONSE');
    minor(discrepancy.replace(/^-/, ''));
  }
  const result: CashShift = {
    shift_id: uuid(s.shift_id),
    branch_id: uuid(s.branch_id),
    terminal_id: uuid(s.terminal_id),
    staff_id: uuid(s.staff_id),
    version: integer(s.version),
    state: s.state as CashShift['state'],
    opened_at: date(s.opened_at),
    closed_at: s.closed_at === null ? null : date(s.closed_at),
    closed_by_staff_id: s.closed_by_staff_id === null ? null : uuid(s.closed_by_staff_id),
    opening_cash_minor: minor(s.opening_cash_minor),
    expected_cash_minor: minor(s.expected_cash_minor),
    counted_cash_minor: s.counted_cash_minor === null ? null : minor(s.counted_cash_minor),
    discrepancy_minor: discrepancy,
    closing_reason: s.closing_reason === null ? null : text(s.closing_reason),
    currency: 'KZT',
    order_count: integer(s.order_count, 0),
    awaiting_payment_count: integer(s.awaiting_payment_count, 0),
    cancelled_count: integer(s.cancelled_count, 0),
    order_total_minor: minor(s.order_total_minor),
    unpaid_total_minor: minor(s.unpaid_total_minor),
    cash_received_minor: '0',
    cash_refunded_minor: '0',
    payment_processing_available: false,
    report_at: date(s.report_at),
  };
  if (result.state === 'open') {
    if (
      [
        result.closed_at,
        result.closed_by_staff_id,
        result.counted_cash_minor,
        result.discrepancy_minor,
        result.closing_reason,
      ].some((v) => v !== null)
    )
      throw new Error('INVALID_RESPONSE');
  } else if (
    [
      result.closed_at,
      result.closed_by_staff_id,
      result.counted_cash_minor,
      result.discrepancy_minor,
      result.closing_reason,
    ].some((v) => v === null)
  )
    throw new Error('INVALID_RESPONSE');
  return result;
}
export function orderFeed(value: unknown): LocalOrder[] {
  const feed = record(value);
  date(feed.server_time);
  if (!Array.isArray(feed.orders) || feed.orders.length > 100) throw new Error('INVALID_RESPONSE');
  const orders = feed.orders.map(order);
  if (new Set(orders.map((o) => o.order_id)).size !== orders.length)
    throw new Error('INVALID_RESPONSE');
  return orders;
}
export function shiftHistory(value: unknown): CashShift[] {
  const result = record(value);
  date(result.server_time);
  if (!Array.isArray(result.shifts) || result.shifts.length > 50)
    throw new Error('INVALID_RESPONSE');
  return result.shifts.map(cashShift);
}
export function currentShift(value: unknown): CashShift | null {
  const result = record(value);
  date(result.server_time);
  return result.shift === null ? null : cashShift(result.shift);
}
export function inputMoney(value: string): string {
  if (!/^\d{1,16}(?:[.,]\d{1,2})?$/.test(value.trim())) throw new Error('INVALID_CASH_AMOUNT');
  const [whole, fraction = ''] = value.trim().replace(',', '.').split('.');
  return minor((BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'))).toString());
}
