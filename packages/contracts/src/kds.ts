import { z } from 'zod';
import {
  AggregatorChannelSchema,
  CourierIncidentKindSchema,
  KdsFunctionSchema,
  KdsShiftModeSchema,
  KdsUnitSchema,
} from './cutover-enums.js';
import type { KdsFunction } from './cutover-enums.js';
import {
  FulfillmentDeliverySchema,
  FulfillmentKitchenOrderSchema,
  FulfillmentSummarySchema,
} from './fulfillment.js';

/**
 * Cutover 19.11.2026, lane kds (docs/architecture/cutover-2026-11-contracts.md, section 5.4).
 * The edge KDS layout and the kitchen HTTP views built on it. Everything here is new: installed
 * kitchen clients never receive these payloads, and the edge serves them only while
 * kds_settings.layout_enabled is true (GET fulfillment/layout answers {enabled:false} otherwise).
 */
const uuid = z.uuid();
const version = z.int().min(1).max(2147483647);
/** Catalog slug: the same rule as MenuSourceIdSchema (index.ts re-exports this module). */
const productId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const unitCount = z.int().min(1).max(1_000_000);

export const KDS_LAYOUT_SCHEMA_VERSION = 1;
/** Edge station kind of every KDS function (contracts section 2.3). */
export const KDS_FUNCTION_KIND = {
  breading: 'prep',
  toasts: 'prep',
  assembly_hall: 'assembly',
  assembly_delivery: 'assembly',
  issue: 'assembly',
  delivery_handover: 'assembly',
} as const satisfies Record<KdsFunction, 'prep' | 'assembly'>;
/** Units a layout may count per function: fingers are breaded, toasts and burgers made at 5. */
export const KDS_FUNCTION_UNITS = {
  breading: ['finger'],
  toasts: ['toast', 'burger'],
  assembly_hall: [],
  assembly_delivery: [],
  issue: [],
  delivery_handover: [],
} as const satisfies Record<KdsFunction, readonly z.infer<typeof KdsUnitSchema>[]>;

export const KdsLayoutCountSchema = z.strictObject({
  product_id: productId,
  unit: KdsUnitSchema,
  count: z.int().min(1).max(100),
});
export const KdsLayoutStationSchema = z.strictObject({
  /** Local kitchen station (fulfillment_stations.id) that does this function. */
  edge_station_id: uuid,
  function: KdsFunctionSchema,
  /** Kitchen screens (local_terminals.id) that open this station. */
  terminal_ids: z.array(uuid).max(10),
  product_ids: z.array(productId).max(200),
  counts: z.array(KdsLayoutCountSchema).max(200).optional(),
});
/**
 * One immutable layout version of a branch (edge kds_layouts.layout).
 * Rules beyond the shape:
 * - each function and each edge station at most once; assembly_hall and issue are required
 *   (the table every unmapped product falls back to, and the finishing station of hall orders);
 * - terminal and product ids are unique within a station; a terminal opens at most two stations
 *   (morning: table 1 and issue as tabs), and both of the same edge kind;
 * - counts name products of the same station, once each, with a unit of that function
 *   (breading: finger; toasts: toast or burger); other functions carry no counts.
 * A product on no table and not on issue is shown on the table as unmapped; the layout never
 * makes the edge refuse an order.
 */
export const KdsLayoutSchema = z
  .strictObject({
    schema_version: z.literal(KDS_LAYOUT_SCHEMA_VERSION),
    branch_id: uuid,
    version,
    stations: z.array(KdsLayoutStationSchema).min(1).max(6),
  })
  .superRefine((layout, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: 'custom', message, path });
    const functions = new Set<string>();
    const stationIds = new Set<string>();
    const terminals = new Map<string, Set<'prep' | 'assembly'>>();
    const terminalStations = new Map<string, number>();
    layout.stations.forEach((station, index) => {
      const path = ['stations', index];
      if (functions.has(station.function)) issue('Duplicate KDS function', [...path, 'function']);
      functions.add(station.function);
      if (stationIds.has(station.edge_station_id))
        issue('Duplicate edge station', [...path, 'edge_station_id']);
      stationIds.add(station.edge_station_id);
      if (new Set(station.terminal_ids).size !== station.terminal_ids.length)
        issue('Duplicate terminal', [...path, 'terminal_ids']);
      if (new Set(station.product_ids).size !== station.product_ids.length)
        issue('Duplicate product', [...path, 'product_ids']);
      const kind = KDS_FUNCTION_KIND[station.function];
      for (const terminal of new Set(station.terminal_ids)) {
        terminalStations.set(terminal, (terminalStations.get(terminal) ?? 0) + 1);
        terminals.set(terminal, (terminals.get(terminal) ?? new Set()).add(kind));
      }
      const products = new Set(station.product_ids);
      const counted = new Set<string>();
      const units: readonly string[] = KDS_FUNCTION_UNITS[station.function];
      (station.counts ?? []).forEach((count, position) => {
        const countPath = [...path, 'counts', position];
        if (!products.has(count.product_id))
          issue('Count of a product outside the station', [...countPath, 'product_id']);
        if (counted.has(count.product_id)) issue('Duplicate count', [...countPath, 'product_id']);
        counted.add(count.product_id);
        if (!units.includes(count.unit))
          issue('Unit not allowed for this function', [...countPath, 'unit']);
      });
    });
    for (const required of ['assembly_hall', 'issue'])
      if (!functions.has(required))
        issue('Missing required KDS function ' + required, ['stations']);
    for (const [terminal, count] of terminalStations)
      if (count > 2 || terminals.get(terminal)!.size > 1)
        issue('A terminal opens at most two stations of one kind: ' + terminal, ['stations']);
  });

/** GET /edge/v1/fulfillment/layout. 404 on an older edge; {enabled:false} = old kitchen screen. */
export const FulfillmentLayoutStationSchema = z.strictObject({
  id: uuid,
  function: KdsFunctionSchema,
  name: z.string().min(1).max(100),
  kind: z.enum(['prep', 'assembly']),
});
export const FulfillmentLayoutSchema = z.union([
  z.strictObject({ enabled: z.literal(false) }),
  z
    .strictObject({
      enabled: z.literal(true),
      layoutVersion: version,
      mode: KdsShiftModeSchema,
      stations: z.array(FulfillmentLayoutStationSchema).min(1).max(6),
      /** Stations of the requesting terminal, at most two (tabs); empty when it opens none. */
      screens: z.array(uuid).max(2),
    })
    .refine(
      (layout) =>
        new Set(layout.screens).size === layout.screens.length &&
        layout.screens.every((id) => layout.stations.some((station) => station.id === id)),
      'Screens must be distinct layout stations',
    ),
]);

/** GET /edge/v1/fulfillment/kds/breading?limit=1..100 (station 6 view, no tasks of its own). */
export const KdsBreadingLineSchema = z.strictObject({
  title: z.string().min(1).max(250),
  quantity: unitCount,
  fingers: unitCount.optional(),
});
export const KdsBreadingOrderSchema = z.strictObject({
  orderId: uuid,
  displayNumber: FulfillmentSummarySchema.shape.displayNumber,
  serviceMode: FulfillmentKitchenOrderSchema.shape.serviceMode,
  delivery: FulfillmentDeliverySchema.optional(),
  lines: z.array(KdsBreadingLineSchema).min(1).max(2000),
  fingers: z.int().min(1).max(100_000_000).optional(),
});
export const KdsBreadingSchema = z.strictObject({
  orders: z.array(KdsBreadingOrderSchema).max(100),
  totalFingers: z.int().min(0).max(10_000_000_000).optional(),
});

/** Courier protocol refusals (Аг9/Аг10). The client sends incident_id as Idempotency-Key. */
export const CourierIncidentProviderSchema = z.enum([...AggregatorChannelSchema.options, 'other']);
/**
 * A Kazakhstan/Russian phone number (+7 or 8 and ten digits, with any spacing). The incident
 * journal stores no personal data: such a number in the request is refused (400). Aggregator
 * order numbers do not start this way. Same rule as the kitchen form (apps/kitchen courier.ts).
 */
const looksLikePhone = (text: string) =>
  /(?:\+\s*7|(?<![\p{L}\p{N}-])8)(?:[\s()-]*\d){10}(?!\d)/u.test(text);
const noPhone = (text: string) => !looksLikePhone(text);
const claimedNumber = z.string().regex(/^[A-Za-z0-9-]{1,40}$/);
const description = z.string().trim().min(3).max(500);
export const CourierIncidentRequestSchema = z.strictObject({
  orderId: uuid.optional(),
  provider: CourierIncidentProviderSchema,
  claimedNumber: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{1,40}$/)
    .refine(noPhone, 'A phone number is not an order number')
    .optional(),
  kind: CourierIncidentKindSchema,
  /** Free text without phone numbers or names of guests (UI hint "Не вводите телефоны"). */
  description: description.refine(noPhone, 'No phone numbers in the description'),
});
/** POST /edge/v1/fulfillment/incidents result and one row of the incident list. */
export const CourierIncidentSchema = z.strictObject({
  incidentId: uuid,
  provider: CourierIncidentProviderSchema,
  claimedNumber: claimedNumber.nullable(),
  kind: CourierIncidentKindSchema,
  description: z.string().min(3).max(500),
  recordedAt: z.iso.datetime(),
  displayNumber: FulfillmentSummarySchema.shape.displayNumber.unwrap().optional(),
});
export const CourierIncidentListQuerySchema = z.strictObject({ scope: z.enum(['open', 'today']) });
export const CourierIncidentListSchema = z.strictObject({
  items: z.array(CourierIncidentSchema).max(200),
});

export type KdsLayout = z.infer<typeof KdsLayoutSchema>;
export type KdsLayoutStation = z.infer<typeof KdsLayoutStationSchema>;
export type FulfillmentLayout = z.infer<typeof FulfillmentLayoutSchema>;
export type KdsBreading = z.infer<typeof KdsBreadingSchema>;
export type CourierIncidentRequest = z.infer<typeof CourierIncidentRequestSchema>;
export type CourierIncident = z.infer<typeof CourierIncidentSchema>;
export type CourierIncidentList = z.infer<typeof CourierIncidentListSchema>;
