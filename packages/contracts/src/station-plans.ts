import { z } from 'zod';

/**
 * Station plans: back-office kitchen station configuration delivered to the cashier edge
 * (stage 2, lane cfg). The cloud owns the plan and its versions; the edge decides whether it
 * can apply a plan and answers with a durable receipt. The edge kitchen routing of orders is
 * not derived from the plan (it still follows the menu publication and local provisioning).
 */
const uuid = z.uuid();
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().min(1).max(2147483647);

/** The only plan schema this edge understands; anything else is rejected SCHEMA_UNSUPPORTED. */
export const STATION_PLAN_SCHEMA_VERSION = 1;
export const StationPlanRoleSchema = z.enum(['prep', 'assembly', 'drinks', 'handoff']);
export const StationPlanStationSchema = z.strictObject({
  /** Back-office station record id. */
  id: uuid,
  /** Published revision of that record. */
  revision: version,
  name: z.string().min(1).max(200),
  role: StationPlanRoleSchema,
  active: z.boolean(),
  /** Kitchen or display screen (cloud devices.id) assigned in the cabinet. */
  device_id: uuid.nullable(),
  /** Local kitchen station of the cashier edge (fulfillment_stations.id) this station is. */
  edge_station_id: uuid.nullable(),
  product_ids: z.array(z.string().min(1).max(200)).max(100),
  target_seconds: z.number().int().min(1).max(3600),
});
export const StationPlanSchema = z.strictObject({
  schema_version: z.literal(STATION_PLAN_SCHEMA_VERSION),
  plan_id: uuid,
  branch_id: uuid,
  version,
  published_at: z.iso.datetime(),
  stations: z.array(StationPlanStationSchema).min(1).max(100),
});
/** checksum: SHA-256 of the canonical JSON of `plan` (menu-sync protocol v1 canonicalisation). */
export const StationPlanDeliverySchema = z.strictObject({ plan: StationPlanSchema, checksum });
export const StationPlanPullResponseSchema = z.strictObject({
  delivery: StationPlanDeliverySchema.nullable(),
});

/** A local kitchen station of the edge, reported so the cabinet can bind plan stations to it. */
export const EdgeKitchenStationSchema = z.strictObject({
  id: uuid,
  kind: z.enum(['prep', 'assembly']),
  name: z.string().min(1).max(100),
});
export const StationPlanPullRequestSchema = z.strictObject({
  /** Plan the edge is serving now, or null before the first one. */
  active: z.strictObject({ plan_id: uuid, version }).nullable(),
  stations: z.array(EdgeKitchenStationSchema).max(50),
  /** Report mode: record the edge state only, never hand out a plan. */
  report_only: z.literal(true).optional(),
});

/** Reasons this edge emits. The cloud accepts any upper-case code from a newer edge. */
export const StationPlanRejectReasonSchema = z.enum([
  'SCHEMA_UNSUPPORTED',
  'INVALID_PLAN',
  'VERSION_NOT_NEWER',
  'UNKNOWN_STATION',
  'STATION_KIND_MISMATCH',
]);
export const StationPlanReceiptSchema = z
  .strictObject({
    plan_id: uuid,
    branch_id: uuid,
    version,
    checksum,
    result: z.enum(['applied', 'rejected']),
    reason: z
      .string()
      .regex(/^[A-Z][A-Z_]{0,63}$/)
      .optional(),
    /** Plan station that made the plan incompatible (UNKNOWN_STATION, STATION_KIND_MISMATCH). */
    station_id: uuid.optional(),
  })
  .refine(
    (receipt) => (receipt.result === 'rejected') === (receipt.reason !== undefined),
    'A rejected plan needs a reason; an applied plan must not carry one',
  )
  .refine(
    (receipt) => receipt.station_id === undefined || receipt.result === 'rejected',
    'Only a rejection names a station',
  );
export const StationPlanReceiptResultSchema = z.strictObject({
  plan_id: uuid,
  recorded: z.literal(true),
});

export type StationPlan = z.infer<typeof StationPlanSchema>;
export type StationPlanStation = z.infer<typeof StationPlanStationSchema>;
export type StationPlanDelivery = z.infer<typeof StationPlanDeliverySchema>;
export type StationPlanPullRequest = z.infer<typeof StationPlanPullRequestSchema>;
export type StationPlanReceipt = z.infer<typeof StationPlanReceiptSchema>;
export type StationPlanRejectReason = z.infer<typeof StationPlanRejectReasonSchema>;
export type EdgeKitchenStation = z.infer<typeof EdgeKitchenStationSchema>;
