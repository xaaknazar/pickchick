import { z } from 'zod';
import { CATALOG_ASSET_KEYS } from '@pickchick/catalog-admin/contracts';
/** Machine-readable detail for stop commands; the top-level code keeps the existing contract. */
export const BackofficeErrorReasonSchema = z.enum([
  'REMOTE_STOPS_DISABLED',
  'CATALOG_NOT_PUBLISHED',
  'CATALOG_ITEM_NOT_FOUND',
  'EDGE_STOPS_NOT_READY',
  'STOP_COMMAND_IN_PROGRESS',
]);
export type BackofficeErrorReason = z.infer<typeof BackofficeErrorReasonSchema>;
export class BackofficeError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_REQUEST'
      | 'UNAUTHORIZED'
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'SERVICE_UNAVAILABLE'
      | 'INSUFFICIENT_STOCK'
      | 'NOT_READY',
    public readonly reason?: BackofficeErrorReason,
  ) {
    super(code);
  }
}
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new BackofficeError('INVALID_REQUEST');
  return r.data;
}
const id = z.uuid(),
  text = z.string().trim().min(1).max(200),
  note = z.string().trim().max(2000);
export const Amount = z.string().regex(/^(0|[1-9][0-9]{0,14})$/);
const positive = Amount.refine((v) => BigInt(v) > 0n);
const revision = z.number().int().min(0).max(2147483646);
const localized = z.strictObject({ ru: text, kk: z.string().trim().max(200) });
const state = z.enum(['draft', 'active', 'archived']);
const window = z
  .strictObject({ starts_at: z.iso.datetime(), ends_at: z.iso.datetime() })
  .refine((v) => Date.parse(v.ends_at) > Date.parse(v.starts_at));
const channels = z
  .array(z.enum(['mobile', 'kiosk', 'display']))
  .min(1)
  .max(3)
  .refine((v) => new Set(v).size === v.length);
export const Ingredient = z.strictObject({
  name: text,
  unit: z.enum(['g', 'ml', 'pcs']),
  minimum: Amount,
  active: z.boolean(),
});
export const Recipe = z
  .strictObject({
    name: text,
    product_id: text,
    output_ingredient_id: id.nullable(),
    yield_quantity: positive,
    lines: z
      .array(z.strictObject({ ingredient_id: id, quantity: positive }))
      .min(1)
      .max(100),
  })
  .refine((v) => new Set(v.lines.map((l) => l.ingredient_id)).size === v.lines.length)
  .refine(
    (v) => v.output_ingredient_id !== null || v.yield_quantity === '1',
    'Menu recipes describe exactly one portion',
  );
export const Promo = z.strictObject({
  name: text,
  title: localized,
  body: z.strictObject({ ru: note, kk: note }),
  image_asset_key: z
    .string()
    .refine((v) => v === 'logo' || CATALOG_ASSET_KEYS.some((k) => k.replace(/\.jpg$/, '') === v)),
  channels,
  schedule: window,
  status: state,
});
export const Game = z
  .strictObject({
    name: text,
    template: z.enum(['pick-run', 'pick-man', 'pick-blocks']),
    enabled: z.boolean(),
    daily_attempts: z.number().int().min(1).max(100),
    reward_chiki: Amount,
    schedule: window,
  })
  .refine((v) => v.reward_chiki === '0', 'Rewards require the server reward validator');
export const Campaign = z.strictObject({
  name: text,
  title: localized,
  body: z.strictObject({ ru: note, kk: note }),
  segment: z.enum(['all_consented', 'repeat', 'inactive_30d']),
  status: z.enum(['draft', 'ready', 'archived']),
  daily_limit: z.number().int().min(1).max(100000),
  schedule: window,
});
export const Ticket = z.strictObject({
  source: z.enum(['operator_recorded', 'mobile_test']).optional(),
  name: text,
  order_id: id.nullable(),
  category: z.enum(['question', 'complaint']),
  priority: z.enum(['normal', 'urgent']),
  assignee_id: id.nullable(),
  due_at: z.iso.datetime().nullable(),
  status: z.enum(['new', 'in_progress', 'resolved', 'closed']),
  description: note,
  resolution: note,
});
export const Review = z.strictObject({
  name: text,
  order_id: id,
  stars: z.number().int().min(1).max(5),
  text: note,
  source: z.enum(['operator_recorded', 'mobile_test']),
  status: z.enum(['new', 'reviewed']),
  internal_note: note,
});
export const Station = z.strictObject({
  name: text,
  role: z.enum(['prep', 'assembly', 'drinks', 'handoff']),
  device_id: id.nullable(),
  active: z.boolean(),
  product_ids: z.array(text).max(100),
  target_seconds: z.number().int().min(1).max(3600),
});
export const Employee = z.strictObject({
  name: text,
  role: z.enum(['manager', 'cashier', 'cook', 'assembler']),
  active: z.boolean(),
  note,
});
export const Shift = z.strictObject({
  name: text,
  employee_id: id,
  opened_at: z.iso.datetime(),
  closed_at: z.iso.datetime().nullable(),
  opening_cash_minor: Amount,
  closing_cash_minor: Amount.nullable(),
  note,
});
export const Schemas = {
  ingredient: Ingredient,
  recipe: Recipe,
  promo: Promo,
  game: Game,
  campaign: Campaign,
  ticket: Ticket,
  review: Review,
  station: Station,
  employee: Employee,
  shift: Shift,
};
export type Kind = keyof typeof Schemas;
export const KindSchema = z.enum([
  'ingredient',
  'recipe',
  'promo',
  'game',
  'campaign',
  'ticket',
  'review',
  'station',
  'employee',
  'shift',
]);
const line = z.strictObject({
  ingredient_id: id,
  quantity: Amount,
  value_minor: Amount,
  expected_revision: revision,
});
const lines = z
  .array(line)
  .min(1)
  .max(100)
  .refine((v) => new Set(v.map((l) => l.ingredient_id)).size === v.length);
export const Command = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('save'),
    kind: KindSchema,
    id,
    expected_revision: revision,
    payload: z.unknown(),
  }),
  z.strictObject({
    type: z.literal('publish'),
    kind: z.enum(['promo', 'game', 'station']),
    id,
    expected_revision: revision,
  }),
  z.strictObject({
    type: z.literal('stock'),
    kind: z.enum(['receipt', 'waste', 'count']),
    reference: text,
    lines,
  }),
  z.strictObject({
    type: z.literal('produce'),
    recipe_id: id,
    recipe_revision: revision,
    batches: z.number().int().min(1).max(10000),
    expected_balances: z.record(id, revision),
    reference: text,
  }),
  z.strictObject({
    type: z.literal('consume'),
    order_id: id,
    expected_balances: z.record(id, revision),
  }),
  z.strictObject({ type: z.literal('revoke_device'), id }),
  z.strictObject({
    type: z.literal('cancel_order'),
    id,
    expected_version: z.number().int().positive(),
  }),
  z.strictObject({ type: z.literal('refund'), id, capture_id: id, amount_minor: positive }),
]);
export const Request = z.strictObject({
  request_id: id,
  reason: z.string().trim().min(3).max(500),
  command: Command,
});
/** Slug identity in the published catalog; an option needs both its group and option slug. */
const catalogSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
export const StopCatalogRef = z
  .strictObject({
    product_id: catalogSlug,
    group_id: catalogSlug.optional(),
    option_id: catalogSlug.optional(),
  })
  .refine((v) => (v.group_id === undefined) === (v.option_id === undefined));
/**
 * Back-office stop/unstop intent for the cashier edge (POST .../stops). The edge applies it only
 * when expected_version still matches its own stop row; an unstop has no duration.
 */
export const StopRequest = z
  .strictObject({
    request_id: id,
    catalog_ref: StopCatalogRef,
    stopped: z.boolean(),
    duration: z.enum(['manual', 'hour', 'shift']).default('manual'),
    reason: z.string().trim().min(3).max(300),
    expected_version: z.number().int().min(0).max(2147483646),
  })
  .refine((v) => v.stopped || v.duration === 'manual');
export type StopRequestInput = z.infer<typeof StopRequest>;
const calendarDate = z.iso.date().refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return (
    value >= '2000-01-01' &&
    value <= '2099-12-31' &&
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
});
export const Query = z
  .strictObject({
    period: z
      .enum(['day', 'today', 'yesterday', 'week', 'month', 'quarter', 'year', 'custom'])
      .default('day'),
    start_date: calendarDate.optional(),
    end_date: calendarDate.optional(),
    shift_id: id.optional(),
  })
  .refine((q) =>
    q.period === 'custom'
      ? q.start_date !== undefined &&
        q.end_date !== undefined &&
        q.start_date <= q.end_date &&
        Date.parse(q.end_date) - Date.parse(q.start_date) <= 365 * 86400000
      : q.start_date === undefined && q.end_date === undefined,
  );
// Use the IANA zone, including Kazakhstan's March 2024 offset transition.
function calendarInstant(local: Date): Date {
  const sample = new Date(local.getTime() + 12 * 3600000);
  const offset = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Almaty',
    timeZoneName: 'longOffset',
  })
    .formatToParts(sample)
    .find((part) => part.type === 'timeZoneName')!.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offset)!;
  const minutes = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '+' ? 1 : -1);
  return new Date(local.getTime() - minutes * 60000);
}
function localCalendar(now: Date): Date {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Almaty',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return new Date(Date.UTC(part('year'), part('month') - 1, part('day')));
}
export function periodWindow(query: z.infer<typeof Query>, now: Date) {
  if (query.period === 'custom') {
    return {
      start: calendarInstant(new Date(`${query.start_date}T00:00:00Z`)),
      end: calendarInstant(new Date(Date.parse(`${query.end_date}T00:00:00Z`) + 86400000)),
    };
  }
  const start = periodStart(query.period, now);
  const end = localCalendar(start);
  if (query.period === 'week') end.setUTCDate(end.getUTCDate() + 7);
  else if (query.period === 'month') end.setUTCMonth(end.getUTCMonth() + 1);
  else if (query.period === 'quarter') end.setUTCMonth(end.getUTCMonth() + 3);
  else if (query.period === 'year') end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCDate(end.getUTCDate() + 1);
  return { start, end: calendarInstant(end) };
}
export type RecordView = {
  id: string;
  kind: Kind;
  revision: number;
  payload: Record<string, unknown>;
  updated_at: string;
};
export function periodStart(period: string, now: Date): Date {
  const local = localCalendar(now);
  local.setUTCHours(0, 0, 0, 0);
  if (period === 'yesterday') local.setUTCDate(local.getUTCDate() - 1);
  if (period === 'year') {
    local.setUTCMonth(0, 1);
  }
  if (period === 'week') local.setUTCDate(local.getUTCDate() - ((local.getUTCDay() + 6) % 7));
  if (period === 'month') local.setUTCDate(1);
  if (period === 'quarter') {
    local.setUTCDate(1);
    local.setUTCMonth(Math.floor(local.getUTCMonth() / 3) * 3);
  }
  return calendarInstant(local);
}
export function stockEffect(
  kind: 'receipt' | 'waste' | 'count',
  balance: { quantity: string; value_minor: string },
  line: { quantity: string; value_minor: string },
) {
  const q = BigInt(balance.quantity),
    v = BigInt(balance.value_minor),
    amount = BigInt(line.quantity),
    value = BigInt(line.value_minor);
  const delta = kind === 'receipt' ? amount : kind === 'waste' ? -amount : amount - q;
  if (q + delta < 0n) throw new BackofficeError('INSUFFICIENT_STOCK');
  if (kind !== 'count' && amount === 0n) throw new BackofficeError('INVALID_REQUEST');
  let dv: bigint;
  if (delta > 0n) {
    if (kind === 'count' && q > 0n) dv = (v * delta) / q;
    else dv = value;
  } else if (delta < 0n) dv = delta === -q ? -v : (v * delta) / q;
  else dv = 0n;
  if (q + delta > 999999999999999n || v + dv > 999999999999999n)
    throw new BackofficeError('INVALID_REQUEST');
  return {
    quantity_delta: delta.toString(),
    value_delta_minor: dv.toString(),
    quantity: (q + delta).toString(),
    value_minor: (v + dv).toString(),
  };
}
