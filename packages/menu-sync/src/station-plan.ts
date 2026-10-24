import {
  DeviceIdentitySchema,
  STATION_PLAN_SCHEMA_VERSION,
  StationPlanReceiptResultSchema,
  StationPlanReceiptSchema,
  StationPlanSchema,
  UuidSchema,
} from '@pickchick/contracts';
import type {
  DeviceIdentity,
  StationPlan,
  StationPlanPullRequest,
  StationPlanReceipt,
  StationPlanRejectReason,
} from '@pickchick/contracts';
import { transaction } from '@pickchick/database';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { hashJson, SyncError } from './common.js';
import { deviceRequest, localCloudOrigin } from './device-http.js';

/**
 * Edge side of station plan delivery (edge schema024, stage 2 lane cfg). The cloud owns plan
 * versions; this edge decides whether a plan fits its local kitchen. In one transaction it
 * stores the snapshot, moves the active plan forward and writes the receipt; an incompatible
 * plan commits only a rejected receipt and the previous plan stays active. Order admission and
 * kitchen routing do not read the plan: it is configuration confirmed by the edge.
 */
export const STATION_PLAN_MIGRATION = '024_edge_station_plans.sql';

type Db = Pick<DatabaseClient | DatabasePool, 'query'>;

class StationPlanRejection extends Error {
  constructor(
    readonly reason: StationPlanRejectReason,
    readonly stationId?: string,
  ) {
    super(reason);
    this.name = 'StationPlanRejection';
  }
}

interface DeliveredPlan {
  plan_id: string;
  version: number;
  checksum: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Integrity first: a malformed envelope is INVALID_REQUEST and a foreign or corrupt one is a
 * CONFLICT. Neither is answered with a receipt, so the cloud keeps offering the plan. A plan that
 * arrived intact but that this edge cannot use is answered (rejected) instead of retried forever.
 */
function deliveredPlan(branchId: string, input: unknown) {
  if (
    !isRecord(input) ||
    Object.keys(input).sort().join(',') !== 'checksum,plan' ||
    !isRecord(input.plan) ||
    typeof input.checksum !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.checksum)
  )
    throw new SyncError('INVALID_REQUEST');
  const raw = input.plan;
  const version = raw.version;
  if (
    !UuidSchema.safeParse(raw.plan_id).success ||
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > 2147483647
  )
    throw new SyncError('INVALID_REQUEST');
  const checksum = hashJson(raw);
  if (raw.branch_id !== branchId || checksum !== input.checksum) throw new SyncError('CONFLICT');
  return { raw, delivered: { plan_id: raw.plan_id as string, version, checksum } };
}

function receiptFor(
  branchId: string,
  delivered: DeliveredPlan,
  reason?: StationPlanRejectReason | null,
  stationId?: string | null,
): StationPlanReceipt {
  // Absent optional keys keep a replayed receipt byte-identical for the cloud's payload hash.
  return StationPlanReceiptSchema.parse({
    plan_id: delivered.plan_id,
    branch_id: branchId,
    version: delivered.version,
    checksum: delivered.checksum,
    result: reason ? 'rejected' : 'applied',
    ...(reason ? { reason } : {}),
    ...(stationId ? { station_id: stationId } : {}),
  });
}

interface ReceiptRow {
  plan_id: string;
  branch_id: string;
  version: number;
  checksum: string;
  reason: StationPlanRejectReason | null;
  station_id: string | null;
}
const receiptFromRow = (row: ReceiptRow) =>
  receiptFor(row.branch_id, row, row.reason, row.station_id);

/** Serializes station plan effects of this edge and replays a stored verdict. */
async function admit(db: DatabaseClient, branchId: string, delivered: DeliveredPlan) {
  const binding = await db.query('SELECT id FROM branch_config WHERE id = $1 FOR UPDATE', [
    branchId,
  ]);
  if (!binding.rowCount) throw new SyncError('CONFLICT');
  const existing = (
    await db.query<ReceiptRow>(
      `SELECT plan_id, branch_id, version, checksum, reason, station_id
       FROM station_plan_receipts WHERE plan_id = $1`,
      [delivered.plan_id],
    )
  ).rows[0];
  if (!existing) return null;
  if (
    existing.branch_id !== branchId ||
    existing.version !== delivered.version ||
    existing.checksum !== delivered.checksum
  )
    throw new SyncError('CONFLICT');
  return receiptFromRow(existing);
}

/** Plan content this edge understands; the schema version is checked before anything else. */
function checkedPlan(raw: Record<string, unknown>): StationPlan {
  if (raw.schema_version !== STATION_PLAN_SCHEMA_VERSION)
    throw new StationPlanRejection('SCHEMA_UNSUPPORTED');
  const parsed = StationPlanSchema.safeParse(raw);
  if (
    !parsed.success ||
    new Set(parsed.data.stations.map((station) => station.id)).size !== parsed.data.stations.length
  )
    throw new StationPlanRejection('INVALID_PLAN');
  return parsed.data;
}

/**
 * Every active plan station bound to a local kitchen station must name an existing station of
 * the same kind, and no two active plan stations may share one kitchen station.
 */
async function checkStations(db: DatabaseClient, branchId: string, plan: StationPlan) {
  const local = new Map(
    (
      await db.query<{ id: string; kind: string }>(
        'SELECT id, kind FROM fulfillment_stations WHERE branch_id = $1',
        [branchId],
      )
    ).rows.map((row) => [row.id, row.kind]),
  );
  const bound = plan.stations.filter((station) => station.active && station.edge_station_id);
  for (const station of bound) {
    const kind = local.get(station.edge_station_id!);
    if (!kind) throw new StationPlanRejection('UNKNOWN_STATION', station.id);
    if (kind !== station.role) throw new StationPlanRejection('STATION_KIND_MISMATCH', station.id);
  }
  if (new Set(bound.map((station) => station.edge_station_id)).size !== bound.length)
    throw new StationPlanRejection('INVALID_PLAN');
}

async function insertReceipt(db: DatabaseClient, receipt: StationPlanReceipt) {
  await db.query(
    `INSERT INTO station_plan_receipts(plan_id, branch_id, version, checksum, result, reason, station_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      receipt.plan_id,
      receipt.branch_id,
      receipt.version,
      receipt.checksum,
      receipt.result,
      receipt.reason ?? null,
      receipt.station_id ?? null,
    ],
  );
}

/**
 * Applies one delivered plan: replay check, schema, version, local station compatibility,
 * snapshot, active plan and receipt in one transaction. A deterministic incompatibility
 * (SCHEMA_UNSUPPORTED, INVALID_PLAN, VERSION_NOT_NEWER, UNKNOWN_STATION, STATION_KIND_MISMATCH)
 * rolls that back and commits only the rejected receipt.
 */
export async function applyStationPlan(
  pool: DatabasePool,
  branchId: string,
  input: unknown,
): Promise<StationPlanReceipt> {
  const { raw, delivered } = deliveredPlan(branchId, input);
  try {
    return await transaction(pool, async (db) => {
      const replay = await admit(db, branchId, delivered);
      if (replay) return replay;
      const plan = checkedPlan(raw);
      const active = (
        await db.query<{ version: number }>(
          'SELECT version FROM station_plan_active WHERE branch_id = $1',
          [branchId],
        )
      ).rows[0];
      if (active && active.version >= plan.version)
        throw new StationPlanRejection('VERSION_NOT_NEWER');
      await checkStations(db, branchId, plan);
      await db.query(
        `INSERT INTO station_plan_snapshots(plan_id, branch_id, version, schema_version, payload, checksum)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [plan.plan_id, branchId, plan.version, plan.schema_version, plan, delivered.checksum],
      );
      await db.query(
        `INSERT INTO station_plan_active(branch_id, plan_id, version) VALUES ($1,$2,$3)
         ON CONFLICT(branch_id) DO UPDATE SET plan_id = EXCLUDED.plan_id,
           version = EXCLUDED.version, activated_at = clock_timestamp()`,
        [branchId, plan.plan_id, plan.version],
      );
      const receipt = receiptFor(branchId, delivered);
      await insertReceipt(db, receipt);
      return receipt;
    });
  } catch (error) {
    if (!(error instanceof StationPlanRejection)) throw error;
    return transaction(pool, async (db) => {
      const replay = await admit(db, branchId, delivered);
      if (replay) return replay;
      const receipt = receiptFor(branchId, delivered, error.reason, error.stationId);
      await insertReceipt(db, receipt);
      return receipt;
    });
  }
}

/** The plan this edge follows now, or null before the first applied plan. */
export async function readActiveStationPlan(db: Db, branchId: string) {
  const row = (
    await db.query<{ plan_id: string; version: number; activated_at: Date; payload: StationPlan }>(
      `SELECT a.plan_id, a.version, a.activated_at, s.payload FROM station_plan_active a
       JOIN station_plan_snapshots s ON s.plan_id = a.plan_id AND s.branch_id = a.branch_id
       WHERE a.branch_id = $1`,
      [branchId],
    )
  ).rows[0];
  return row
    ? {
        plan_id: row.plan_id,
        version: row.version,
        activated_at: row.activated_at.toISOString(),
        plan: row.payload,
      }
    : null;
}

/** What the edge reports on every pull: its active plan and its local kitchen stations. */
export async function stationPlanReport(
  db: Db,
  branchId: string,
): Promise<Omit<StationPlanPullRequest, 'report_only'>> {
  const active = (
    await db.query<{ plan_id: string; version: number }>(
      'SELECT plan_id, version FROM station_plan_active WHERE branch_id = $1',
      [branchId],
    )
  ).rows[0];
  const stations = (
    await db.query<{ id: string; kind: 'prep' | 'assembly'; name: string }>(
      'SELECT id, kind, name FROM fulfillment_stations WHERE branch_id = $1 ORDER BY id LIMIT 50',
      [branchId],
    )
  ).rows;
  return {
    active: active ? { plan_id: active.plan_id, version: active.version } : null,
    stations: stations.map((s) => ({ id: s.id, kind: s.kind, name: s.name })),
  };
}

export type StationPlanReadiness = 'ready' | 'schema_missing' | 'grants_missing';
/** Edge schema024 present and writable by the current role (the menu-sync worker role). */
export async function stationPlanReadiness(db: Db): Promise<StationPlanReadiness> {
  const migrated = await db.query(
    "SELECT 1 FROM schema_migrations WHERE scope = 'edge' AND version = $1",
    [STATION_PLAN_MIGRATION],
  );
  if (!migrated.rowCount) return 'schema_missing';
  const rights = (
    await db.query<{ ok: boolean }>(
      `SELECT has_table_privilege(current_user, 'station_plan_snapshots', 'INSERT')
        AND has_table_privilege(current_user, 'station_plan_active', 'INSERT')
        AND has_column_privilege(current_user, 'station_plan_active', 'version', 'UPDATE')
        AND has_table_privilege(current_user, 'station_plan_receipts', 'INSERT')
        AND has_column_privilege(current_user, 'station_plan_receipts', 'reported_at', 'UPDATE')
        AND has_table_privilege(current_user, 'fulfillment_stations', 'SELECT') AS ok`,
    )
  ).rows[0];
  return rights?.ok ? 'ready' : 'grants_missing';
}

export type StationPlanSyncResult =
  | { state: 'idle' | 'unavailable' | 'schema_missing' | 'grants_missing' }
  | { state: 'reported' | 'applied'; version: number }
  | { state: 'rejected'; version: number; reason: StationPlanRejectReason };

export interface SyncStationPlanOptions {
  /** apply (default) applies plans; report only reports the edge state and sends receipts. */
  mode?: 'apply' | 'report';
  /**
   * Receipts the cloud refused (404/409) in this process: they stay unreported in the database
   * but no longer block pulling newer plans. A restart retries them.
   */
  refused?: Set<string>;
}
const processRefused = new Set<string>();
const httpStatus = (error: unknown) =>
  error instanceof Error ? Number(/^Sync HTTP (\d{3})$/.exec(error.message)?.[1] ?? 0) : 0;

async function requestJson(origin: string, path: string, identity: DeviceIdentity, body: unknown) {
  const bytes = await deviceRequest(origin, path, identity, { body, maxBytes: 1_000_000 });
  return JSON.parse(bytes.toString('utf8')) as unknown;
}

async function sendReceipt(
  pool: DatabasePool,
  origin: string,
  identity: DeviceIdentity,
  receipt: StationPlanReceipt,
) {
  const answer = StationPlanReceiptResultSchema.parse(
    await requestJson(origin, '/internal/v1/edge/station-plans/receipt', identity, receipt),
  );
  if (answer.plan_id !== receipt.plan_id) throw new SyncError('CONFLICT');
  await pool.query(
    'UPDATE station_plan_receipts SET reported_at = clock_timestamp() WHERE plan_id = $1 AND reported_at IS NULL',
    [receipt.plan_id],
  );
}

/**
 * One worker cycle: report the oldest unreported receipt, otherwise report the edge state and
 * pull the newest plan, apply it and report the receipt at once. The cloud answers 404 while
 * BACKOFFICE_STATION_PLAN_DELIVERY_ENABLED is off (or before cloud070): 'unavailable'.
 * Network sends never hold a database transaction open.
 */
export async function syncStationPlanOnce(
  pool: DatabasePool,
  branchId: string,
  originInput: string,
  identityInput: unknown,
  options: SyncStationPlanOptions = {},
): Promise<StationPlanSyncResult> {
  const origin = localCloudOrigin(originInput);
  const identity = DeviceIdentitySchema.parse(identityInput);
  if (identity.branch_id !== branchId) throw new SyncError('CONFLICT');
  const readiness = await stationPlanReadiness(pool);
  if (readiness !== 'ready') return { state: readiness };
  const refused = options.refused ?? processRefused;
  try {
    const pending = (
      await pool.query<ReceiptRow>(
        `SELECT plan_id, branch_id, version, checksum, reason, station_id FROM station_plan_receipts
         WHERE branch_id = $1 AND reported_at IS NULL AND NOT (plan_id = ANY($2::uuid[]))
         ORDER BY recorded_at, plan_id LIMIT 1`,
        [branchId, [...refused]],
      )
    ).rows[0];
    if (pending) {
      try {
        await sendReceipt(pool, origin, identity, receiptFromRow(pending));
        return { state: 'reported', version: pending.version };
      } catch (error) {
        if (![404, 409].includes(httpStatus(error))) throw error;
        if (refused.size >= 100) refused.clear();
        refused.add(pending.plan_id);
      }
    }
    const report = await stationPlanReport(pool, branchId);
    const body = await requestJson(
      origin,
      '/internal/v1/edge/station-plans/pull',
      identity,
      options.mode === 'report' ? { ...report, report_only: true } : report,
    );
    if (!isRecord(body) || Object.keys(body).join(',') !== 'delivery')
      throw new SyncError('INVALID_REQUEST');
    if (body.delivery === null || options.mode === 'report') return { state: 'idle' };
    const receipt = await applyStationPlan(pool, branchId, body.delivery);
    try {
      await sendReceipt(pool, origin, identity, receipt);
      refused.delete(receipt.plan_id);
    } catch {
      // The receipt is durable; the next cycle reports it.
    }
    return receipt.result === 'applied'
      ? { state: 'applied', version: receipt.version }
      : {
          state: 'rejected',
          version: receipt.version,
          reason: receipt.reason as StationPlanRejectReason,
        };
  } catch (error) {
    if (httpStatus(error) === 404) return { state: 'unavailable' };
    throw error;
  }
}
