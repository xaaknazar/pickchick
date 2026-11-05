import { createHash } from 'node:crypto';
import { z } from 'zod';
import { digest, FulfillmentError, parse } from './model.js';
import type { Snapshot, TaskPlan } from './model.js';

/** KDS station functions; same values as KdsFunctionSchema in @pickchick/contracts (section 2.1). */
export type KdsFunction =
  'breading' | 'toasts' | 'assembly_hall' | 'assembly_delivery' | 'issue' | 'delivery_handover';
export type KdsStationSpec = {
  function: KdsFunction;
  kind: 'prep' | 'assembly';
  /** Screen title (contracts section 2.3); stored as fulfillment_stations.name. */
  name: string;
};
/** The six KDS stations of the restaurant, in the order of its kitchen flow (section 2.3). */
export const KDS_STATIONS: readonly Readonly<KdsStationSpec>[] = Object.freeze(
  (
    [
      { function: 'breading', kind: 'prep', name: 'Панировка (6)' },
      { function: 'toasts', kind: 'prep', name: 'Тосты и бургеры (5)' },
      { function: 'assembly_hall', kind: 'assembly', name: 'Сборка - зал (стол 1)' },
      { function: 'assembly_delivery', kind: 'assembly', name: 'Сборка - доставка (стол 2)' },
      { function: 'issue', kind: 'assembly', name: 'Выдача (2)' },
      { function: 'delivery_handover', kind: 'assembly', name: 'Выдача доставки (3)' },
    ] as const
  ).map((station) => Object.freeze({ ...station })),
);

const FunctionSchema = z.enum([
  'breading',
  'toasts',
  'assembly_hall',
  'assembly_delivery',
  'issue',
  'delivery_handover',
]);

/**
 * Deterministic edge station id of a KDS function:
 * localCatalogId(branchId, 'kds-station', fn) of @pickchick/menu-sync (availability.ts), the
 * same UUID-shaped SHA-256 identity as the installed local catalog. Recomputed here because this
 * package does not depend on menu-sync; a test pins both to the same value.
 */
export function kdsStationId(branchId: string, fn: KdsFunction): string {
  parse(z.uuid(), branchId);
  parse(FunctionSchema, fn);
  const hash = createHash('sha256')
    .update(`pickchick-local-draft-v1:${branchId}:kds-station:${fn}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hash[12] = '8';
  hash[16] = (8 | (parseInt(hash[16]!, 16) & 3)).toString(16);
  const h = hash.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Edge station kind of every KDS function (contracts section 2.3). */
const FUNCTION_KIND: Readonly<Record<KdsFunction, 'prep' | 'assembly'>> = Object.freeze(
  Object.fromEntries(KDS_STATIONS.map((station) => [station.function, station.kind])) as Record<
    KdsFunction,
    'prep' | 'assembly'
  >,
);
export const kdsFunctionKind = (fn: KdsFunction) => FUNCTION_KIND[fn];
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const slugSchema = z.string().regex(SLUG);
const uuidSchema = z.uuid();
const TABLES: readonly KdsFunction[] = ['assembly_hall', 'assembly_delivery'];

/**
 * Structural mirror of KdsLayoutSchema (@pickchick/contracts kds.ts, which this package does not
 * depend on): the shape and the rules the plan relies on. kds-switch stores only layouts that
 * passed the full contract schema; a stored layout that fails this check is treated as no
 * layout (today's routing), never as a reason to refuse an order. A test pins both schemas.
 */
const LayoutSchema = z
  .strictObject({
    schema_version: z.literal(1),
    branch_id: uuidSchema,
    version: z.int().min(1).max(2147483647),
    stations: z
      .array(
        z.strictObject({
          edge_station_id: uuidSchema,
          function: FunctionSchema,
          terminal_ids: z.array(uuidSchema).max(10),
          product_ids: z.array(slugSchema).max(200),
          counts: z
            .array(
              z.strictObject({
                product_id: slugSchema,
                unit: z.enum(['finger', 'toast', 'burger']),
                count: z.int().min(1).max(100),
              }),
            )
            .max(200)
            .optional(),
        }),
      )
      .min(1)
      .max(6),
  })
  .refine(
    (layout) =>
      new Set(layout.stations.map((s) => s.function)).size === layout.stations.length &&
      new Set(layout.stations.map((s) => s.edge_station_id)).size === layout.stations.length &&
      layout.stations.some((s) => s.function === 'assembly_hall') &&
      layout.stations.some((s) => s.function === 'issue') &&
      layout.stations.every(
        (s) =>
          new Set(s.product_ids).size === s.product_ids.length &&
          new Set((s.counts ?? []).map((c) => c.product_id)).size === (s.counts ?? []).length &&
          (s.counts ?? []).every(
            (c) =>
              s.product_ids.includes(c.product_id) &&
              (s.function === 'breading'
                ? c.unit === 'finger'
                : s.function === 'toasts' && c.unit !== 'finger'),
          ),
      ),
  );
export type KdsLayoutData = z.infer<typeof LayoutSchema>;
/** The stored layout of this branch and version, or null when it cannot be used. */
export function parseKdsLayout(
  value: unknown,
  branchId: string,
  version: number,
): KdsLayoutData | null {
  const result = LayoutSchema.safeParse(value);
  return result.success && result.data.branch_id === branchId && result.data.version === version
    ? result.data
    : null;
}

/**
 * Catalog slugs of the products a task plan names. Cloud orders (mobile, kiosk) already name
 * slugs; a cashier line names the hashed menu product_id and its options the hashed option id.
 */
export interface KdsSlugs {
  /** Slug of a task product, or null when the product has none (shown as unmapped). */
  product(productId: string): string | null;
  /**
   * Product an option of a cashier line stands for: only an option with linked_variant_id
   * (menu feature combo_stops) links one (contracts section 5.4).
   */
  option(optionId: string): { slug: string; productId: string } | null;
}
/** Cloud orders: a product id is a slug; options are linked through linkedProductId instead. */
export const cloudKdsSlugs: KdsSlugs = Object.freeze({
  product: (productId: string) => (SLUG.test(productId) ? productId : null),
  option: () => null,
});
/** No menu readable: every hashed cashier product is unmapped, no option is linked. */
export const noKdsSlugs: KdsSlugs = Object.freeze({ product: () => null, option: () => null });

/** Slugs of a cashier menu snapshot (active_menu): product_id -> source_id, option -> linked. */
export function menuKdsSlugs(menu: unknown): KdsSlugs {
  const items = Array.isArray((menu as { items?: unknown } | null)?.items)
    ? ((menu as { items: unknown[] }).items as Record<string, unknown>[])
    : [];
  const products = new Map<string, string>(),
    variants = new Map<string, { slug: string; productId: string }>(),
    options = new Map<string, string>();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const slug =
      typeof item.source_id === 'string' && SLUG.test(item.source_id) ? item.source_id : null;
    if (typeof item.product_id === 'string' && slug) products.set(item.product_id, slug);
    if (typeof item.variant_id === 'string' && typeof item.product_id === 'string' && slug)
      variants.set(item.variant_id, { slug, productId: item.product_id });
    for (const group of Array.isArray(item.modifier_groups) ? item.modifier_groups : [])
      for (const option of Array.isArray(group?.options) ? group.options : [])
        if (typeof option?.id === 'string' && typeof option.linked_variant_id === 'string')
          options.set(option.id, option.linked_variant_id);
  }
  return Object.freeze({
    product: (productId: string) => products.get(productId) ?? null,
    option: (optionId: string) => {
      const variant = options.get(optionId);
      return variant === undefined ? null : (variants.get(variant) ?? null);
    },
  });
}

type Modifier = NonNullable<Snapshot['lines'][number]['selectedDetails']>['modifiers'][number];

/**
 * KDS task plan (contracts sections 2.2, 5.4, 9 q.16), a pure function of the legacy plan that
 * taskPlan(snapshot, routing) produced (it still decides ROUTING_MISSING), the snapshot, the
 * active layout and the product slugs. One task per legacy part:
 * - a product only on the issue counter (in issue.product_ids, on no table) - drinks and sauces -
 *   goes to issue (2), for delivery orders too;
 * - any other product goes to the order's table: assembly_delivery for an aggregator order
 *   (snapshot.delivery) when the layout has it, else assembly_hall; with fingers when breading
 *   counts it; unmapped when the layout places it nowhere ("Нет в раскладке");
 * - a product in toasts.product_ids also gets a task at station 5 with upstreamOf = the station
 *   of its main task (the table, whose complete_station closes it);
 * - a cashier option linked to an issue-only product (linked_variant_id) gets an issue task and
 *   is hidden on the table; a cloud option linked to one (linkedProductId, already expanded as
 *   a component) is hidden on the table only. Any other option stays visible.
 * The finishing station is delivery_handover (3) for an aggregator order when the layout has
 * it, else issue (2). component_key = legacy key + ':' + function. Returns null when the plan
 * would break the legacy bounds (2000 tasks, digest size); the caller then keeps the legacy plan:
 * the layout never makes the edge refuse an order.
 */
export function kdsTaskPlan(input: {
  snapshot: Snapshot;
  legacy: readonly TaskPlan[];
  layout: KdsLayoutData;
  slugs: KdsSlugs;
}): { plan: TaskPlan[]; assemblyStationId: string } | null {
  const { snapshot, layout, slugs } = input;
  const station = (fn: KdsFunction) => layout.stations.find((s) => s.function === fn);
  const delivery = snapshot.delivery !== undefined;
  const hall = station('assembly_hall')!,
    issue = station('issue')!;
  const table = (delivery ? station('assembly_delivery') : undefined) ?? hall;
  const finishing = (delivery ? station('delivery_handover') : undefined) ?? issue;
  const toasts = station('toasts'),
    breading = station('breading');
  const onTables = new Set(
    layout.stations.filter((s) => TABLES.includes(s.function)).flatMap((s) => s.product_ids),
  );
  const onIssue = new Set(issue.product_ids),
    onToasts = new Set(toasts?.product_ids ?? []);
  const issueOnly = (slug: string | null) =>
    slug !== null && onIssue.has(slug) && !onTables.has(slug);
  const count = (s: KdsLayoutData['stations'][number] | undefined, slug: string | null) =>
    slug === null ? undefined : s?.counts?.find((c) => c.product_id === slug);
  const bounded = (value: number) => {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000)
      throw new FulfillmentError('INVALID');
    return value;
  };
  const cashier = snapshot.channel === 'pos';
  const linked = (modifier: Modifier) =>
    cashier
      ? slugs.option(modifier.optionId)
      : modifier.linkedProductId && SLUG.test(modifier.linkedProductId)
        ? { slug: modifier.linkedProductId, productId: modifier.linkedProductId }
        : null;
  const lines = new Map(snapshot.lines.map((line) => [line.lineId, line]));
  const plan: TaskPlan[] = [];
  try {
    for (const part of input.legacy) {
      const line = lines.get(part.details.lineId);
      if (!line) throw new FulfillmentError('INVALID');
      const slug = slugs.product(part.details.productId);
      const modifiers = line.selectedDetails?.modifiers ?? [];
      const links = modifiers.map(linked);
      const visible = modifiers.filter((_, index) => !issueOnly(links[index]?.slug ?? null));
      let main: TaskPlan;
      if (issueOnly(slug)) {
        main = {
          componentKey: part.componentKey + ':issue',
          stationId: issue.edge_station_id,
          kind: 'assembly_item',
          details: { ...part.details, kds: { function: 'issue' } },
        };
      } else {
        const fingers = count(breading, slug);
        const unmapped = slug === null || (!onTables.has(slug) && !onIssue.has(slug));
        main = {
          componentKey: part.componentKey + ':' + table.function,
          stationId: table.edge_station_id,
          kind: 'assembly_item',
          details: {
            ...part.details,
            modifiers: visible,
            kds: {
              function: table.function,
              ...(fingers ? { fingers: bounded(part.details.quantity * fingers.count) } : {}),
              ...(unmapped ? { unmapped: true as const } : {}),
            },
          },
        };
      }
      plan.push(main);
      if (toasts && slug !== null && onToasts.has(slug)) {
        const units = count(toasts, slug);
        plan.push({
          componentKey: part.componentKey + ':toasts',
          stationId: toasts.edge_station_id,
          kind: 'prep',
          details: {
            ...main.details,
            kds: {
              function: 'toasts',
              upstreamOf: main.stationId,
              units: bounded(part.details.quantity * (units?.count ?? 1)),
              ...(units ? { unit: units.unit } : {}),
            },
          },
        });
      }
      // A cashier line has exactly one part (its parent): its linked issue-only options become
      // issue tasks. Cloud lines already carry the linked products as components.
      if (cashier && part.componentKey === line.lineId + ':parent')
        modifiers.forEach((modifier, index) => {
          const link = links[index];
          if (!link || !issueOnly(link.slug)) return;
          plan.push({
            componentKey: `${line.lineId}:modifier:${index}:issue`,
            stationId: issue.edge_station_id,
            kind: 'assembly_item',
            details: {
              lineId: line.lineId,
              productId: link.productId,
              title: modifier.label.ru,
              quantity: bounded(line.quantity * modifier.quantity),
              parentTitle: line.title,
              description: '',
              modifiers: [],
              kds: { function: 'issue' },
            },
          });
        });
    }
    if (!plan.length || plan.length > 2000) return null;
    digest(plan);
  } catch (error) {
    if (error instanceof FulfillmentError) return null;
    throw error;
  }
  return { plan, assemblyStationId: finishing.edge_station_id };
}
