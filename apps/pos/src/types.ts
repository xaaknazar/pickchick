import type {
  AggregatorChannel,
  Cart,
  CashShift as ContractCashShift,
  EdgeCloudLink,
  FiscalReceiptState,
  LocalOrder as ContractLocalOrder,
  MenuCategory,
  MenuSnapshot,
  PosPaymentConfirmation,
  PosPaymentMethod,
  PosServiceMode,
  Quote as ContractQuote,
  SalesChannel,
  StaffCredential,
  StaffSession,
} from '@pickchick/contracts';
export type {
  AggregatorChannel,
  EdgeCloudLink,
  Cart,
  MenuCategory,
  MenuSnapshot,
  PosPaymentMethod,
  PosServiceMode,
  SalesChannel,
  StaffCredential,
  StaffSession,
};
/**
 * Cutover 19.11 (contracts section 5.1): an aggregator quote echoes its sales_channel; a hall
 * quote never has the key, so quotes of the unpaid cashier stay byte-for-byte as before.
 */
export type Quote = ContractQuote & { sales_channel?: AggregatorChannel };
/** A paid sale (`pos_sale`) is an admitted order in state `paid` with a captured payment. */
export type LocalOrder = Omit<
  ContractLocalOrder,
  'state' | 'payment_state' | 'execution_mode' | 'snapshot'
> & {
  state: ContractLocalOrder['state'] | 'paid';
  payment_state: ContractLocalOrder['payment_state'] | 'captured';
  execution_mode?: NonNullable<ContractLocalOrder['execution_mode']> | 'pos_sale';
  snapshot: Quote;
};
/** Shifts opened in sales mode carry real cash totals; other shifts keep '0' and false. */
export type CashShift = Omit<
  ContractCashShift,
  'cash_received_minor' | 'cash_refunded_minor' | 'payment_processing_available'
> & {
  cash_received_minor: string;
  cash_refunded_minor: string;
  payment_processing_available: boolean;
};
/** Cutover enums (contracts section 2.1), repeated as values: the browser loads no zod. */
export const SALES_CHANNELS = ['hall', 'yandex_eda', 'glovo'] as const;
export const AGGREGATOR_CHANNELS = ['yandex_eda', 'glovo'] as const;
export const POS_SERVICE_MODES = ['payment_required', 'unpaid_service', 'pos_sale'] as const;
export const PAYMENT_METHODS = [
  'cash',
  'kaspi_terminal',
  'aggregator_yandex_eda',
  'aggregator_glovo',
  'staff_meal',
  'marketing',
  'kaspi_manual',
  'chocofood',
] as const;
/** Section 00 item 1: a mixed payment has exactly two parts of these, at most one in cash. */
export const MIXABLE_METHODS = ['cash', 'kaspi_terminal', 'kaspi_manual'] as const;
const CONFIRMATIONS = ['drawer', 'cashier_attested', 'aggregator_attested', 'manager_approved'];
/** ExternalOrderRefSchema (contracts section 2.1): typed from the aggregator tablet. */
export const EXTERNAL_ORDER_REF = /^[A-Za-z0-9-]{3,40}$/;
export const aggregatorMethod = (channel: AggregatorChannel) =>
  channel === 'yandex_eda' ? ('aggregator_yandex_eda' as const) : ('aggregator_glovo' as const);
export const isAggregator = (channel: unknown): channel is AggregatorChannel =>
  (AGGREGATOR_CHANNELS as readonly unknown[]).includes(channel);
export const CHANNEL_NAMES: Record<SalesChannel, string> = {
  hall: 'Зал',
  yandex_eda: 'Яндекс Еда',
  glovo: 'Glovo',
};
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
  pos_service_mode?: PosServiceMode;
};
export type Stop = { variant_id: string; stopped: boolean; version: number };
export type ModifierOption = ModifierGroup['options'][number];
/** Why an item cannot be sold now (combo stop rule, PM decision 1); null when it can. */
export type StopReason =
  { kind: 'item' } | { kind: 'component'; name: string | null } | { kind: 'group'; name: string };
export type ItemStopView = {
  available: boolean;
  reason: StopReason | null;
  /** Options that cannot be chosen: unavailable, stopped, or their product stopped. */
  stoppedOptions: Set<string>;
};
const isStopped = (stops: ReadonlyMap<string, Stop>, id: string | undefined) =>
  id !== undefined && stops.get(id)?.stopped === true;
/** An option cannot be chosen when unavailable, stopped, or the product it stands for is stopped. */
export function optionStopped(option: ModifierOption, stops: ReadonlyMap<string, Stop>): boolean {
  return (
    option.available === false ||
    isStopped(stops, option.id) ||
    isStopped(stops, option.linked_variant_id)
  );
}
/** Preselected choices of a new line: default options that can be chosen now, never a stopped one. */
export function defaultSelections(item: Item, stops: ReadonlyMap<string, Stop>): Selection[] {
  return (item.modifier_groups ?? []).flatMap((g) =>
    g.options
      .filter((o) => o.default_quantity && !optionStopped(o, stops))
      .map((o) => ({ group_id: g.id, option_id: o.id, quantity: o.default_quantity! })),
  );
}
/**
 * A stopped option cannot be added or increased, but it can always be reduced or removed: an
 * older cart line may still hold it, and a multi-choice group would otherwise stay stuck.
 */
export function optionChangeAllowed(
  option: ModifierOption,
  stops: ReadonlyMap<string, Stop>,
  current: number,
  count: number,
): boolean {
  return count <= current || !optionStopped(option, stops);
}
/**
 * The cloud combo stop rule on the POS screen, from the active menu and the edge stop list: the
 * item's own stop, a stopped fixed component, or a required group with no option left. A menu
 * without the optional fields has no components or links, so only own stops count. The edge
 * re-checks every quote and order; this view only explains and blocks early.
 */
export function itemStopView(
  m: MenuSnapshot,
  item: Item,
  stops: ReadonlyMap<string, Stop>,
): ItemStopView {
  const stoppedOptions = new Set(
    (item.modifier_groups ?? []).flatMap((g) =>
      g.options.filter((o) => optionStopped(o, stops)).map((o) => o.id),
    ),
  );
  const component = (item.combo_component_variant_ids ?? []).find((id) => isStopped(stops, id));
  const dead = (item.modifier_groups ?? []).find(
    (g) => g.min_selected > 0 && g.options.every((o) => stoppedOptions.has(o.id)),
  );
  const reason: StopReason | null = isStopped(stops, item.variant_id)
    ? { kind: 'item' }
    : component !== undefined
      ? {
          kind: 'component',
          name: m.items.find((i) => i.variant_id === component)?.name.ru ?? null,
        }
      : dead
        ? { kind: 'group', name: dead.name.ru }
        : null;
  return { available: reason === null, reason, stoppedOptions };
}
/** Short cashier message for an unavailable item; empty when it can be sold. */
export function stopReasonText(view: Pick<ItemStopView, 'reason'>): string {
  const reason = view.reason;
  if (!reason) return '';
  if (reason.kind === 'item') return 'Позиция в стоп-листе';
  if (reason.kind === 'component')
    return reason.name
      ? `Комбо недоступно: «${reason.name}» в стоп-листе`
      : 'Комбо недоступно: часть состава в стоп-листе';
  // A required choice can belong to a plain item too (sauce size), so the text names no combo.
  return `Недоступно: нет доступных вариантов в группе «${reason.name}»`;
}
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('INVALID_RESPONSE');
  return value;
}
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
        // Optional cashier combo stop field: kept only when well-formed, never trusted otherwise.
        ...(isUuid(o.linked_variant_id) ? { linked_variant_id: o.linked_variant_id } : {}),
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
    ...(s.name === undefined ? {} : { name: text(s.name, 100) }),
    expires_at: date(s.expires_at),
  };
}
export function credential(value: unknown): StaffCredential {
  const s = record(value);
  if (typeof s.token !== 'string' || !/^[a-f0-9]{64}$/.test(s.token))
    throw new Error('INVALID_CREDENTIAL');
  return { ...session(s), token: s.token };
}
const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const sortOrder = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100000
    ? value
    : undefined;
/** Fixed components of a combo (stage 2): unique UUIDs, never the item itself, else dropped. */
function componentIds(value: unknown, variantId: string): string[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 100) return undefined;
  if (!value.every(isUuid) || value.includes(variantId) || new Set(value).size !== value.length)
    return undefined;
  return value;
}
/** Unified-menu fields are optional extras: a malformed extra is dropped, never trusted. */
function optionalItemFields(i: Record<string, unknown>, imageUrl: string | undefined) {
  const result: Pick<
    Item,
    'source_id' | 'sort_order' | 'kind' | 'image' | 'combo_component_variant_ids'
  > = {};
  const components = componentIds(i.combo_component_variant_ids, String(i.variant_id));
  if (components) result.combo_component_variant_ids = components;
  if (typeof i.source_id === 'string' && SOURCE_ID.test(i.source_id))
    result.source_id = i.source_id;
  const order = sortOrder(i.sort_order);
  if (order !== undefined) result.sort_order = order;
  if (i.kind === 'item' || i.kind === 'combo' || i.kind === 'set') result.kind = i.kind;
  if (i.image && typeof i.image === 'object' && !Array.isArray(i.image)) {
    const image = i.image as Record<string, unknown>;
    if (
      typeof image.sha256 === 'string' &&
      SHA256.test(image.sha256) &&
      image.url === `/assets/menu/${image.sha256}.webp` &&
      imageUrl === image.url
    )
      result.image = { sha256: image.sha256, url: image.url };
  }
  return result;
}
function optionalCategories(value: unknown, items: Item[]): MenuCategory[] | undefined {
  if (!Array.isArray(value) || value.length > 200) return undefined;
  try {
    const categories = value.map((v) => {
      const c = record(v);
      const order = sortOrder(c.sort_order);
      if (typeof c.source_id !== 'string' || !SOURCE_ID.test(c.source_id) || order === undefined)
        throw new Error('INVALID_RESPONSE');
      return { id: uuid(c.id), source_id: c.source_id, name: names(c.name), sort_order: order };
    });
    const ids = new Set(categories.map((c) => c.id));
    if (ids.size !== categories.length || items.some((i) => !ids.has(i.category_id)))
      return undefined;
    return categories;
  } catch {
    return undefined;
  }
}
export function menu(value: unknown): MenuSnapshot {
  const m = record(value);
  if (m.schema_version !== 1 || !Array.isArray(m.items) || m.items.length > 10000)
    throw new Error('INVALID_RESPONSE');
  const items = m.items.map((input): Item => {
    const i = record(input);
    if (i.currency !== 'KZT') throw new Error('INVALID_RESPONSE');
    const imageUrl =
      i.image_url === undefined
        ? undefined
        : (() => {
            const image = text(i.image_url, 160);
            if (!/^\/assets\/menu\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp)$/.test(image))
              throw new Error('INVALID_RESPONSE');
            return image;
          })();
    return {
      product_id: uuid(i.product_id),
      variant_id: uuid(i.variant_id),
      category_id: uuid(i.category_id),
      name: names(i.name),
      currency: 'KZT',
      price_minor: minor(i.price_minor),
      ...(imageUrl === undefined ? {} : { image_url: imageUrl }),
      ...(i.modifier_groups === undefined
        ? {}
        : { modifier_groups: modifierGroups(i.modifier_groups) }),
      ...optionalItemFields(i, imageUrl),
    };
  });
  if (new Set(items.map((i) => i.variant_id)).size !== items.length)
    throw new Error('INVALID_RESPONSE');
  const categories = optionalCategories(m.categories, items);
  return {
    schema_version: 1,
    release_id: uuid(m.release_id),
    branch_id: uuid(m.branch_id),
    version: integer(m.version),
    published_at: date(m.published_at),
    items,
    ...(categories ? { categories } : {}),
  };
}
export type MenuVersion = { release_id: string; version: number };
export function menuVersion(value: unknown): MenuVersion {
  const v = record(value);
  return { release_id: uuid(v.release_id), version: integer(v.version) };
}
/** Category label: the publication name, then the operator config, then a neutral number. */
export function categoryLabels(
  m: MenuSnapshot | null | undefined,
  configured: Record<string, string> = {},
): Map<string, string> {
  const published = new Map((m?.categories ?? []).map((c) => [c.id, c.name.ru]));
  const labels = new Map<string, string>();
  for (const item of m ? sortedItems(m) : []) {
    if (labels.has(item.category_id)) continue;
    labels.set(
      item.category_id,
      published.get(item.category_id) ??
        (Object.hasOwn(configured, item.category_id) ? configured[item.category_id] : undefined) ??
        `Категория ${labels.size + 1}`,
    );
  }
  return labels;
}
/** Back-office order: category sort_order, then item sort_order, then snapshot order. */
export function sortedItems(m: MenuSnapshot): Item[] {
  const categories = new Map((m.categories ?? []).map((c) => [c.id, c.sort_order]));
  return m.items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        (categories.get(a.item.category_id) ?? Number.MAX_SAFE_INTEGER) -
          (categories.get(b.item.category_id) ?? Number.MAX_SAFE_INTEGER) ||
        (a.item.sort_order ?? a.index) - (b.item.sort_order ?? b.index) ||
        a.index - b.index,
    )
    .map(({ item }) => item);
}
function details(value: unknown) {
  const d = record(value);
  if (
    typeof d.display_name !== 'string' ||
    [...d.display_name].length > 14 ||
    typeof d.kitchen_comment !== 'string' ||
    d.kitchen_comment.length > 60
  )
    throw new Error('INVALID_RESPONSE');
  return { display_name: d.display_name.trim(), kitchen_comment: d.kitchen_comment.trim() };
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
    ...(c.details === undefined ? {} : { details: details(c.details) }),
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
  // Only an aggregator quote names its channel, and an aggregator order is always takeaway.
  if (
    q.sales_channel !== undefined &&
    (!(AGGREGATOR_CHANNELS as readonly unknown[]).includes(q.sales_channel) ||
      q.service_mode !== 'takeaway')
  )
    throw new Error('INVALID_RESPONSE');
  return {
    ...(q.sales_channel === undefined
      ? {}
      : { sales_channel: q.sales_channel as AggregatorChannel }),
    ...(q.details === undefined ? {} : { details: details(q.details) }),
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
  // A paid sale (cutover 19.11) is admitted at payment exactly like an unpaid service order.
  const sale = o.execution_mode === 'pos_sale';
  const admitted = o.execution_mode === 'unpaid_service' || sale;
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
    !(sale ? ['paid', 'cancelled'] : ['awaiting_payment', 'cancelled']).includes(String(o.state)) ||
    o.payment_state !== (sale ? 'captured' : 'not_started') ||
    o.fiscal_state !== 'not_requested' ||
    (!admitted && o.fulfillment_state !== 'blocked') ||
    o.next_action !== (admitted || o.state === 'cancelled' ? 'none' : 'payment_not_available') ||
    !(o.cancellation_reason === null || typeof o.cancellation_reason === 'string')
  )
    throw new Error('INVALID_RESPONSE');
  const snapshot = quote(o.snapshot);
  if (
    snapshot.quote_id !== o.quote_id ||
    snapshot.branch_id !== o.branch_id ||
    (!sale && snapshot.sales_channel !== undefined)
  )
    throw new Error('INVALID_RESPONSE');
  return {
    order_id: uuid(o.order_id),
    branch_id: uuid(o.branch_id),
    quote_id: uuid(o.quote_id),
    version: integer(o.version),
    state: o.state as LocalOrder['state'],
    payment_state: sale ? 'captured' : 'not_started',
    fiscal_state: 'not_requested',
    fulfillment_state: o.fulfillment_state as LocalOrder['fulfillment_state'],
    next_action: o.next_action as LocalOrder['next_action'],
    ...(fulfillment
      ? { execution_mode: sale ? ('pos_sale' as const) : ('unpaid_service' as const), fulfillment }
      : {}),
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
    !(POS_SERVICE_MODES as readonly unknown[]).includes(o.pos_service_mode)
  )
    throw new Error('INVALID_RESPONSE');
  return {
    branch_id: uuid(o.branch_id),
    ordering_enabled: o.ordering_enabled,
    version: integer(o.version),
    ...(o.pos_service_mode === undefined
      ? {}
      : { pos_service_mode: o.pos_service_mode as PosServiceMode }),
  };
}
export function stop(value: unknown): Stop {
  const s = record(value);
  if (typeof s.stopped !== 'boolean') throw new Error('INVALID_RESPONSE');
  return { variant_id: uuid(s.variant_id), stopped: s.stopped, version: integer(s.version, 0) };
}
export function cashShift(value: unknown): CashShift {
  const s = record(value);
  // Contracts section 5.1: in a sales-mode shift these become money and a boolean; every
  // other shift keeps '0', '0' and false exactly as before.
  if (
    !['open', 'closed'].includes(String(s.state)) ||
    s.currency !== 'KZT' ||
    typeof s.payment_processing_available !== 'boolean'
  )
    throw new Error('INVALID_RESPONSE');
  const cashReceived = minor(s.cash_received_minor),
    cashRefunded = minor(s.cash_refunded_minor);
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
    ...(s.cash_movements === undefined
      ? {}
      : {
          cash_movements: array(s.cash_movements, 1000).map((v) => {
            const m = record(v);
            if (!['in', 'out'].includes(String(m.direction))) throw new Error('INVALID_RESPONSE');
            return {
              id: uuid(m.id),
              staff_id: uuid(m.staff_id),
              direction: m.direction as 'in' | 'out',
              amount_minor: minor(m.amount_minor),
              reason: text(m.reason),
              created_at: date(m.created_at),
            };
          }),
        }),
    counted_cash_minor: s.counted_cash_minor === null ? null : minor(s.counted_cash_minor),
    discrepancy_minor: discrepancy,
    closing_reason: s.closing_reason === null ? null : text(s.closing_reason),
    currency: 'KZT',
    order_count: integer(s.order_count, 0),
    awaiting_payment_count: integer(s.awaiting_payment_count, 0),
    cancelled_count: integer(s.cancelled_count, 0),
    order_total_minor: minor(s.order_total_minor),
    unpaid_total_minor: minor(s.unpaid_total_minor),
    cash_received_minor: cashReceived,
    cash_refunded_minor: cashRefunded,
    payment_processing_available: s.payment_processing_available,
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
/** GET edge/v1/cloud-link (offline stand finding): the cashier's last cloud contact. */
export function cloudLink(value: unknown): EdgeCloudLink {
  const v = record(value);
  if (v.state !== 'online' && v.state !== 'offline' && v.state !== 'unknown')
    throw new Error('INVALID_RESPONSE');
  return {
    state: v.state,
    last_contact_at: v.last_contact_at === null ? null : date(v.last_contact_at),
    checked_at: date(v.checked_at),
  };
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

// ---- Cutover 19.11: paid sales (contracts section 5.1) -------------------------------------

export type FiscalPolicy = 'manual_webkassa' | 'not_required';
export type PosConfigMethod = {
  code: PosPaymentMethod;
  enabled: boolean;
  requires_approval: boolean;
  allow_in_mix: boolean;
  fiscal_policy: FiscalPolicy;
};
/** GET edge/v1/pos/config. An edge without the route (404) keeps today's unpaid cashier. */
export type PosConfig = {
  mode: PosServiceMode;
  methods: PosConfigMethod[];
  channels: { code: SalesChannel; enabled: boolean }[];
  fiscal_mode: 'manual_webkassa';
  approval_ttl_seconds: number;
  server_time: string;
  /** Number of this desk (1..99) set by the operator (edge 028, CR pos-7), or null. */
  desk_number: number | null;
};
export type SaleTender = {
  tender_id: string;
  method: PosPaymentMethod;
  amount_minor: string;
  confirmation: PosPaymentConfirmation;
  reference: string | null;
};
export type SaleRefund = {
  refund_id: string;
  kind: 'void' | 'refund';
  amount_minor: string;
  reason_code: string;
  approved_by_staff_id: string;
  created_at: string;
  tenders: { tender_id: string; amount_minor: string }[];
};
export type SaleFiscal = {
  receipt_id: string;
  kind: 'sale' | 'refund';
  state: FiscalReceiptState;
  receipt_number: string | null;
  version: number;
  amount_minor: string;
};
export type PosSale = {
  order_id: string;
  display_number: string;
  pickup: 'issue' | 'delivery_handover';
  sales_channel: SalesChannel;
  external_order_ref: string | null;
  service_mode: Cart['service_mode'];
  revenue_kind: 'revenue' | 'staff_meal' | 'marketing';
  total_minor: string;
  cash_tendered_minor: string | null;
  change_minor: string | null;
  tenders: SaleTender[];
  refunds: SaleRefund[];
  refundable_minor: string;
  fiscal: SaleFiscal[];
  shift_id: string;
  terminal_id: string;
  cashier_staff_id: string;
  created_at: string;
};
export type SaleResult = { order: LocalOrder; sale: PosSale };
export type Approval = {
  approval_id: string;
  token: string;
  expires_at: string;
  manager: { staff_id: string; name: string };
};
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T => {
  if (!(values as readonly unknown[]).includes(value)) throw new Error('INVALID_RESPONSE');
  return value as T;
};
const flag = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new Error('INVALID_RESPONSE');
  return value;
};
const optionalText = (value: unknown, max: number): string | null =>
  value === null ? null : text(value, max);
const positive = (value: unknown): string => {
  const amount = minor(value);
  if (amount === '0') throw new Error('INVALID_RESPONSE');
  return amount;
};
/**
 * The desk number of pos/config (CR client-5 section 3.2): an integer 1..99, else null. An edge
 * without 028 omits the key; a number is only shown, so a bad one is no number, never a refusal.
 */
export const deskNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 99 ? value : null;
/**
 * Unknown method or channel codes are skipped, never offered: a later edge may add one (P1)
 * without breaking this cashier. Known codes must be well-formed and unique.
 */
export function posConfig(value: unknown): PosConfig {
  const c = record(value);
  const methods = array(c.methods, 32)
    .map(record)
    .filter((m) => (PAYMENT_METHODS as readonly unknown[]).includes(m.code))
    .map((m) => ({
      code: m.code as PosPaymentMethod,
      enabled: flag(m.enabled),
      requires_approval: flag(m.requires_approval),
      allow_in_mix: flag(m.allow_in_mix),
      fiscal_policy: oneOf(m.fiscal_policy, ['manual_webkassa', 'not_required'] as const),
    }));
  const channels = array(c.channels, 16)
    .map(record)
    .filter((ch) => (SALES_CHANNELS as readonly unknown[]).includes(ch.code))
    .map((ch) => ({ code: ch.code as SalesChannel, enabled: flag(ch.enabled) }));
  if (
    new Set(methods.map((m) => m.code)).size !== methods.length ||
    new Set(channels.map((ch) => ch.code)).size !== channels.length ||
    c.fiscal_mode !== 'manual_webkassa'
  )
    throw new Error('INVALID_RESPONSE');
  return {
    mode: oneOf(c.mode, POS_SERVICE_MODES),
    methods,
    channels,
    fiscal_mode: 'manual_webkassa',
    approval_ttl_seconds: integer(c.approval_ttl_seconds, 1, 3600),
    server_time: date(c.server_time),
    desk_number: deskNumber(c.desk_number),
  };
}
/** The kitchen number is a positive integer; the edge may send it as a number or a string. */
function displayNumber(value: unknown): string {
  if (typeof value === 'number') return String(integer(value));
  return positive(value);
}
export function posSale(value: unknown): PosSale {
  const s = record(value);
  const total = minor(s.total_minor);
  const tenders = array(s.tenders, 2).map((v) => {
    const t = record(v);
    return {
      tender_id: uuid(t.tender_id),
      method: oneOf(t.method, PAYMENT_METHODS),
      amount_minor: positive(t.amount_minor),
      confirmation: oneOf(t.confirmation, CONFIRMATIONS) as PosPaymentConfirmation,
      reference: optionalText(t.reference, 40),
    };
  });
  const refunds = array(s.refunds, 100).map((v) => {
    const r = record(v);
    const parts = array(r.tenders, 2).map((x) => {
      const t = record(x);
      return { tender_id: uuid(t.tender_id), amount_minor: positive(t.amount_minor) };
    });
    const amount = positive(r.amount_minor);
    if (
      !parts.length ||
      new Set(parts.map((t) => t.tender_id)).size !== parts.length ||
      parts.reduce((sum, t) => sum + BigInt(t.amount_minor), 0n) !== BigInt(amount)
    )
      throw new Error('INVALID_RESPONSE');
    return {
      refund_id: uuid(r.refund_id),
      kind: oneOf(r.kind, ['void', 'refund'] as const),
      amount_minor: amount,
      reason_code: text(r.reason_code, 40),
      approved_by_staff_id: uuid(r.approved_by_staff_id),
      created_at: date(r.created_at),
      tenders: parts,
    };
  });
  const fiscal = array(s.fiscal, 101).map((v) => {
    const f = record(v);
    const state = oneOf(f.state, ['pending', 'recorded', 'not_required'] as const);
    return {
      receipt_id: uuid(f.receipt_id),
      kind: oneOf(f.kind, ['sale', 'refund'] as const),
      state,
      receipt_number:
        state === 'recorded' ? text(f.receipt_number, 40) : nullOnly(f.receipt_number),
      version: integer(f.version),
      amount_minor: minor(f.amount_minor),
    };
  });
  const channel = oneOf(s.sales_channel, SALES_CHANNELS);
  const pickup = oneOf(s.pickup, ['issue', 'delivery_handover'] as const);
  const serviceMode = oneOf(s.service_mode, ['dine_in', 'takeaway'] as const);
  const externalRef = optionalText(s.external_order_ref, 40);
  const tendered = s.cash_tendered_minor === null ? null : minor(s.cash_tendered_minor);
  const change = s.change_minor === null ? null : minor(s.change_minor);
  const cash = tenders.filter((t) => t.method === 'cash');
  const method = tenders.length === 1 ? tenders[0]!.method : null;
  const revenue = oneOf(s.revenue_kind, ['revenue', 'staff_meal', 'marketing'] as const);
  if (
    !tenders.length ||
    new Set(tenders.map((t) => t.tender_id)).size !== tenders.length ||
    tenders.reduce((sum, t) => sum + BigInt(t.amount_minor), 0n) !== BigInt(total) ||
    cash.length > 1 ||
    (cash.length === 0 && (tendered !== null || change !== null)) ||
    (cash.length === 1 &&
      (tendered === null
        ? change !== null && change !== '0'
        : BigInt(tendered) < BigInt(cash[0]!.amount_minor) ||
          change !== (BigInt(tendered) - BigInt(cash[0]!.amount_minor)).toString())) ||
    (isAggregator(channel)
      ? pickup !== 'delivery_handover' ||
        serviceMode !== 'takeaway' ||
        externalRef === null ||
        method !== aggregatorMethod(channel)
      : pickup !== 'issue') ||
    (method === 'chocofood' && externalRef === null) ||
    revenue !== (method === 'staff_meal' || method === 'marketing' ? method : 'revenue') ||
    refunds.reduce((sum, r) => sum + BigInt(r.amount_minor), 0n) > BigInt(total) ||
    // The refund screens compute limits from these numbers (contracts section 5.1, POS-3):
    // what is left to refund, and per tender never more than it paid.
    BigInt(minor(s.refundable_minor)) !==
      BigInt(total) - refunds.reduce((sum, r) => sum + BigInt(r.amount_minor), 0n) ||
    tenders.some(
      (t) =>
        refunds
          .flatMap((r) => r.tenders)
          .filter((x) => x.tender_id === t.tender_id)
          .reduce((sum, x) => sum + BigInt(x.amount_minor), 0n) > BigInt(t.amount_minor),
    ) ||
    refunds.some((r) => r.tenders.some((x) => !tenders.some((t) => t.tender_id === x.tender_id))) ||
    new Set(refunds.map((r) => r.refund_id)).size !== refunds.length ||
    new Set(fiscal.map((f) => f.receipt_id)).size !== fiscal.length
  )
    throw new Error('INVALID_RESPONSE');
  return {
    order_id: uuid(s.order_id),
    display_number: displayNumber(s.display_number),
    pickup,
    sales_channel: channel,
    external_order_ref: externalRef,
    service_mode: serviceMode,
    revenue_kind: revenue,
    total_minor: total,
    cash_tendered_minor: tendered,
    change_minor: change,
    tenders,
    refunds,
    refundable_minor: minor(s.refundable_minor),
    fiscal,
    shift_id: uuid(s.shift_id),
    terminal_id: uuid(s.terminal_id),
    cashier_staff_id: uuid(s.cashier_staff_id),
    created_at: date(s.created_at),
  };
}
function nullOnly(value: unknown): null {
  if (value !== null) throw new Error('INVALID_RESPONSE');
  return null;
}
/** 201 of POST edge/v1/pos/sales: the paid, admitted order and its sale must agree. */
export function saleResult(value: unknown): SaleResult {
  const r = record(value);
  const o = order(r.order),
    s = posSale(r.sale);
  if (
    o.execution_mode !== 'pos_sale' ||
    o.order_id !== s.order_id ||
    o.snapshot.total_minor !== s.total_minor ||
    o.snapshot.service_mode !== s.service_mode ||
    (o.snapshot.sales_channel ?? 'hall') !== s.sales_channel ||
    o.fulfillment?.display_number !== s.display_number
  )
    throw new Error('INVALID_RESPONSE');
  return { order: o, sale: s };
}
/** An approval token as the edge issues it; the journal keeps nothing else (pos-desktop too). */
export const APPROVAL_TOKEN = /^[A-Za-z0-9._~-]{16,256}$/;
export function approval(value: unknown): Approval {
  const a = record(value),
    m = record(a.manager);
  if (typeof a.token !== 'string' || !APPROVAL_TOKEN.test(a.token))
    throw new Error('INVALID_RESPONSE');
  return {
    approval_id: uuid(a.approval_id),
    token: a.token,
    expires_at: date(a.expires_at),
    manager: { staff_id: uuid(m.staff_id), name: text(m.name, 100) },
  };
}
/** The pickup line of the done screen and the order ticket (contracts section 5.8). */
export function pickupText(
  sale: Pick<PosSale, 'pickup' | 'sales_channel' | 'external_order_ref'>,
): string {
  if (sale.pickup === 'issue') return 'Забрать на выдаче';
  return (
    'Выдача доставки · ' +
    CHANNEL_NAMES[sale.sales_channel] +
    (sale.external_order_ref ? ' №' + sale.external_order_ref : '')
  );
}

// ---- Cutover 19.11: void, refunds, manual Webkassa, X/Z (contracts section 5.1, POS-3..5) --

export const REFUND_REASONS = [
  'guest_changed_mind',
  'wrong_order',
  'quality',
  'aggregator_cancelled',
  'cashier_error',
  'other',
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];
export const REFUND_REASON_NAMES: Record<RefundReason, string> = {
  guest_changed_mind: 'Гость передумал',
  wrong_order: 'Неверный заказ',
  quality: 'Качество блюда',
  aggregator_cancelled: 'Агрегатор отменил',
  cashier_error: 'Ошибка кассира',
  other: 'Другое',
};
/**
 * Tenders whose money the desk gives back itself. Aggregator and ChocoFood refunds are made in
 * their own cabinets (REFUND_NOT_SUPPORTED); staff meal and marketing carry no money.
 */
export const REFUNDABLE_METHODS = ['cash', 'kaspi_terminal', 'kaspi_manual'] as const;
/** What one tender of a sale can still return: paid minus its earlier refunds. */
export function tenderRefundable(sale: Pick<PosSale, 'tenders' | 'refunds'>, tenderId: string) {
  const tender = sale.tenders.find((t) => t.tender_id === tenderId);
  if (!tender) return 0n;
  const refunded = sale.refunds
    .flatMap((r) => r.tenders)
    .filter((t) => t.tender_id === tenderId)
    .reduce((sum, t) => sum + BigInt(t.amount_minor), 0n);
  return BigInt(tender.amount_minor) - refunded;
}
/** One receipt still to punch in the Webkassa cabinet (GET pos/fiscal-receipts/pending). */
export type FiscalPendingItem = {
  receipt_id: string;
  order_id: string;
  display_number: string;
  kind: 'sale' | 'refund';
  amount_minor: string;
  methods: PosPaymentMethod[];
  created_at: string;
  version: number;
};
export function fiscalPending(value: unknown): FiscalPendingItem[] {
  const v = record(value);
  const receipts = array(v.receipts, 1000).map((x) => {
    const r = record(x);
    const methods = array(r.methods, 2).map((m) => oneOf(m, PAYMENT_METHODS));
    if (!methods.length) throw new Error('INVALID_RESPONSE');
    return {
      receipt_id: uuid(r.receipt_id),
      order_id: uuid(r.order_id),
      display_number: displayNumber(r.display_number),
      kind: oneOf(r.kind, ['sale', 'refund'] as const),
      amount_minor: positive(r.amount_minor),
      methods,
      created_at: date(r.created_at),
      version: integer(r.version),
    };
  });
  if (new Set(receipts.map((r) => r.receipt_id)).size !== receipts.length)
    throw new Error('INVALID_RESPONSE');
  return receipts;
}
/** A signed amount of tiyn ("-1500", "0", "2500"); "-0" is not a number the edge writes. */
function signed(value: unknown): string {
  const result = text(value, 21);
  if (result === '-0') throw new Error('INVALID_RESPONSE');
  minor(result.replace(/^-/, ''));
  return result;
}
export type ShiftReportMethod = {
  method: PosPaymentMethod;
  sales_minor: string;
  refunds_minor: string;
  count: number;
};
/** X (any moment) or frozen Z (closed shift) PickChick report of one cash desk; not fiscal. */
export type ShiftReport = {
  kind: 'x' | 'z';
  shift_id: string;
  terminal_id: string;
  state: 'open' | 'closed';
  opened_at: string;
  closed_at: string | null;
  opening_cash_minor: string;
  cash_in_minor: string;
  cash_out_minor: string;
  cash_sales_minor: string;
  cash_refunds_minor: string;
  expected_cash_minor: string;
  counted_cash_minor: string | null;
  discrepancy_minor: string | null;
  methods: ShiftReportMethod[];
  channels: { sales_channel: SalesChannel; total_minor: string; count: number }[];
  terminal_reported_minor: string | null;
  terminal_discrepancy_minor: string | null;
  fiscal: { pending: number; recorded: number; not_required: number };
  orders: { count: number; voided_count: number };
  report_at: string;
};
/** Kaspi terminal money of a report: what the desk recorded, to compare with the terminal. */
export const terminalNetMinor = (report: Pick<ShiftReport, 'methods'>) =>
  report.methods
    .filter((m) => m.method === 'kaspi_terminal')
    .reduce((sum, m) => sum + BigInt(m.sales_minor) - BigInt(m.refunds_minor), 0n);
/**
 * GET cash-shifts/{id}/x-report and z-report. The arithmetic of contracts section 5.1 is checked
 * here, so a report that does not add up is never shown or printed.
 */
export function shiftReport(value: unknown): ShiftReport {
  const r = record(value);
  const count = (v: unknown) => integer(v, 0, Number.MAX_SAFE_INTEGER);
  const nullable = <T>(v: unknown, parse: (x: unknown) => T) => (v === null ? null : parse(v));
  const methods = array(r.methods, 8).map((x) => {
    const m = record(x);
    return {
      method: oneOf(m.method, PAYMENT_METHODS),
      sales_minor: minor(m.sales_minor),
      refunds_minor: minor(m.refunds_minor),
      count: count(m.count),
    };
  });
  const channels = array(r.channels, 3).map((x) => {
    const c = record(x);
    return {
      sales_channel: oneOf(c.sales_channel, SALES_CHANNELS),
      total_minor: minor(c.total_minor),
      count: count(c.count),
    };
  });
  const f = record(r.fiscal),
    o = record(r.orders);
  const report: ShiftReport = {
    kind: oneOf(r.kind, ['x', 'z'] as const),
    shift_id: uuid(r.shift_id),
    terminal_id: uuid(r.terminal_id),
    state: oneOf(r.state, ['open', 'closed'] as const),
    opened_at: date(r.opened_at),
    closed_at: nullable(r.closed_at, date),
    opening_cash_minor: minor(r.opening_cash_minor),
    cash_in_minor: minor(r.cash_in_minor),
    cash_out_minor: minor(r.cash_out_minor),
    cash_sales_minor: minor(r.cash_sales_minor),
    cash_refunds_minor: minor(r.cash_refunds_minor),
    expected_cash_minor: minor(r.expected_cash_minor),
    counted_cash_minor: nullable(r.counted_cash_minor, minor),
    discrepancy_minor: nullable(r.discrepancy_minor, signed),
    methods,
    channels,
    terminal_reported_minor: nullable(r.terminal_reported_minor, minor),
    terminal_discrepancy_minor: nullable(r.terminal_discrepancy_minor, signed),
    fiscal: {
      pending: count(f.pending),
      recorded: count(f.recorded),
      not_required: count(f.not_required),
    },
    orders: { count: count(o.count), voided_count: count(o.voided_count) },
    report_at: date(r.report_at),
  };
  const big = BigInt;
  const closed = report.state === 'closed';
  if (
    big(report.expected_cash_minor) !==
      big(report.opening_cash_minor) +
        big(report.cash_in_minor) -
        big(report.cash_out_minor) +
        big(report.cash_sales_minor) -
        big(report.cash_refunds_minor) ||
    (report.kind === 'z' && !closed) ||
    closed !== (report.closed_at !== null) ||
    closed !== (report.counted_cash_minor !== null) ||
    (report.counted_cash_minor === null
      ? report.discrepancy_minor !== null
      : report.discrepancy_minor === null ||
        big(report.discrepancy_minor) !==
          big(report.counted_cash_minor) - big(report.expected_cash_minor)) ||
    (report.terminal_reported_minor === null
      ? report.terminal_discrepancy_minor !== null
      : report.terminal_discrepancy_minor === null ||
        big(report.terminal_discrepancy_minor) !==
          big(report.terminal_reported_minor) - terminalNetMinor(report)) ||
    new Set(methods.map((m) => m.method)).size !== methods.length ||
    new Set(channels.map((c) => c.sales_channel)).size !== channels.length ||
    report.orders.voided_count > report.orders.count
  )
    throw new Error('INVALID_RESPONSE');
  return report;
}
