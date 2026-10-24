import { randomUUID } from 'node:crypto';
import { transaction, type DatabaseClient, type DatabasePool } from '@pickchick/database';
import {
  STATION_PLAN_SCHEMA_VERSION,
  StationPlanPullRequestSchema,
  StationPlanReceiptSchema,
  StationPlanSchema,
  type StationPlanPullRequest,
  type StationPlanStation,
} from '@pickchick/contracts';
import {
  authenticateDevice,
  canonicalJson,
  hashJson,
  SyncError,
  type DeviceAuth,
} from '@pickchick/menu-sync';
import { BackofficeError, parse, Station } from './model.js';

/**
 * Cloud side of station plan delivery (cloud070, stage 2 lane cfg). A plan is the branch's
 * published stations at one moment, under a version that only grows. The edge pulls the newest
 * plan over the private device transport, applies it in one local transaction or rejects it
 * with a reason, and reports a receipt. Pull and receipt are idempotent and never let an older
 * plan or an older receipt replace a newer state.
 */
type Db = Pick<DatabaseClient, 'query'>;

/** Serializes plan versions, deliveries and receipts of one branch. */
async function lockPlans(db: Db, branch: string) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'bo:station-plan:' + branch,
  ]);
}

/** Latest published revision of every station record of the branch, ordered by id. */
async function publishedStations(db: Db, branch: string): Promise<StationPlanStation[]> {
  const rows = (
    await db.query<{ record_id: string; revision: number; payload: unknown }>(
      `SELECT DISTINCT ON(record_id) record_id,revision,payload FROM bo_publications
       WHERE branch_id=$1 AND kind='station' ORDER BY record_id,revision DESC`,
      [branch],
    )
  ).rows;
  return rows
    .map((row) => {
      const station = parse(Station, row.payload);
      return {
        id: row.record_id,
        revision: row.revision,
        name: station.name,
        role: station.role,
        active: station.active,
        device_id: station.device_id,
        edge_station_id: station.edge_station_id ?? null,
        product_ids: station.product_ids,
        target_seconds: station.target_seconds,
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface StationPlanCreated {
  id: string;
  version: number;
  created: boolean;
}

/**
 * Builds the next plan version from the published stations inside the caller's back-office
 * command transaction. With `reuse`, the newest plan is returned unchanged when it already has
 * exactly these stations, the edge did not reject it and the edge did not report another plan
 * after confirming it (a repeated "send again" is a no-op). An edge whose database was restored
 * from a backup, or a replaced cashier, reports an older plan or none after the receipt: then a
 * new version is the only way to deliver the plan again, because pull never re-offers a plan
 * that already has a receipt.
 * The version is above every cloud plan and above the version the edge reports as active.
 */
export async function createStationPlanInTransaction(
  db: Db,
  input: {
    branch: string;
    organization: string;
    actor: string;
    publication: string | null;
    reuse: boolean;
  },
): Promise<StationPlanCreated> {
  await lockPlans(db, input.branch);
  const stations = await publishedStations(db, input.branch);
  if (!stations.length) throw new BackofficeError('NOT_READY', 'STATION_PLAN_EMPTY');
  const latest = (
    await db.query<{
      id: string;
      version: number;
      stations: unknown;
      result: string | null;
      answered_at: Date | null;
    }>(
      `SELECT p.id,p.version,p.payload->'stations' AS stations,r.result,r.recorded_at AS answered_at
       FROM bo_station_plans p LEFT JOIN bo_station_plan_receipts r ON r.plan_id=p.id
       WHERE p.branch_id=$1 ORDER BY p.version DESC LIMIT 1`,
      [input.branch],
    )
  ).rows[0];
  const edge = (
    await db.query<{
      active_plan_id: string | null;
      active_version: number | null;
      observed_at: Date;
    }>(
      'SELECT active_plan_id,active_version,observed_at FROM bo_station_plan_edge_state WHERE branch_id=$1',
      [input.branch],
    )
  ).rows[0];
  const edgeLostLatest =
    latest?.result === 'applied' &&
    latest.answered_at !== null &&
    edge !== undefined &&
    edge.observed_at.getTime() > latest.answered_at.getTime() &&
    edge.active_plan_id !== latest.id;
  if (
    input.reuse &&
    latest &&
    latest.result !== 'rejected' &&
    !edgeLostLatest &&
    canonicalJson(latest.stations) === canonicalJson(stations)
  )
    return { id: latest.id, version: latest.version, created: false };
  const floor = edge?.active_version ?? 0;
  const version = Math.max(latest?.version ?? 0, floor) + 1;
  if (version > 2147483647) throw new BackofficeError('CONFLICT');
  const now = (await db.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
  const plan = StationPlanSchema.parse({
    schema_version: STATION_PLAN_SCHEMA_VERSION,
    plan_id: randomUUID(),
    branch_id: input.branch,
    version,
    published_at: now.toISOString(),
    stations,
  });
  await db.query(
    `INSERT INTO bo_station_plans(id,branch_id,organization_id,version,schema_version,payload,checksum,publication_id,actor_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      plan.plan_id,
      input.branch,
      input.organization,
      version,
      STATION_PLAN_SCHEMA_VERSION,
      plan,
      hashJson(plan),
      input.publication,
      input.actor,
    ],
  );
  return { id: plan.plan_id, version, created: true };
}

/**
 * Edge-reported state: an observation, never a command, and the latest report is what the edge
 * serves now. Only the active edge of the branch can authenticate (a report from another device
 * means the edge was replaced), its worker sends one request at a time and pulls are serialized
 * by the branch plan lock, so reports are recorded in the order the edge made them. A lower or
 * missing version is recorded as reported: an edge database restored from a backup or a new
 * cashier must not be shown with a plan it no longer has, nor with a frozen contact time and
 * station list.
 */
async function recordEdgeState(
  db: Db,
  branch: string,
  device: string,
  request: StationPlanPullRequest,
) {
  await db.query(
    `INSERT INTO bo_station_plan_edge_state AS s(branch_id,device_id,active_plan_id,active_version,stations,observed_at)
     VALUES($1,$2,$3,$4,$5,clock_timestamp())
     ON CONFLICT(branch_id) DO UPDATE SET device_id=EXCLUDED.device_id,
       active_plan_id=EXCLUDED.active_plan_id,active_version=EXCLUDED.active_version,
       stations=EXCLUDED.stations,observed_at=greatest(s.observed_at,EXCLUDED.observed_at)`,
    [
      branch,
      device,
      request.active?.plan_id ?? null,
      request.active?.version ?? null,
      JSON.stringify(request.stations),
    ],
  );
}

/**
 * The newest plan of the device's branch, unless the edge already answered for it. Older plans
 * are never offered: each plan is the complete station set, so the newest one supersedes them.
 */
export async function pullStationPlan(pool: DatabasePool, auth: DeviceAuth, input: unknown) {
  const parsed = StationPlanPullRequestSchema.safeParse(input);
  if (
    !parsed.success ||
    new Set(parsed.data.stations.map((station) => station.id)).size !== parsed.data.stations.length
  )
    throw new SyncError('INVALID_REQUEST');
  const request = parsed.data;
  return transaction(pool, async (db) => {
    const branch = await authenticateDevice(db, auth);
    await lockPlans(db, branch);
    await recordEdgeState(db, branch, auth.deviceId, request);
    if (request.report_only) return { delivery: null };
    const latest = (
      await db.query<{ id: string; payload: unknown; checksum: string; answered: boolean }>(
        `SELECT p.id,p.payload,p.checksum,r.plan_id IS NOT NULL AS answered FROM bo_station_plans p
         LEFT JOIN bo_station_plan_receipts r ON r.plan_id=p.id
         WHERE p.branch_id=$1 ORDER BY p.version DESC LIMIT 1`,
        [branch],
      )
    ).rows[0];
    if (!latest || latest.answered) return { delivery: null };
    await db.query(
      `INSERT INTO bo_station_plan_deliveries AS d(plan_id,branch_id,device_id) VALUES($1,$2,$3)
       ON CONFLICT(plan_id) DO UPDATE SET device_id=EXCLUDED.device_id,
         last_delivered_at=greatest(d.last_delivered_at,clock_timestamp()),
         deliveries=least(d.deliveries+1,2147483647)`,
      [latest.id, branch, auth.deviceId],
    );
    return { delivery: { plan: latest.payload, checksum: latest.checksum } };
  });
}

/**
 * Stores the edge verdict once. The receipt must match the plan's version and checksum; an
 * identical repeat returns the same answer, a different verdict for the same plan conflicts.
 */
export async function recordStationPlanReceipt(
  pool: DatabasePool,
  auth: DeviceAuth,
  input: unknown,
) {
  const parsed = StationPlanReceiptSchema.safeParse(input);
  if (!parsed.success) throw new SyncError('INVALID_REQUEST');
  const receipt = parsed.data;
  return transaction(pool, async (db) => {
    const branch = await authenticateDevice(db, auth);
    if (receipt.branch_id !== branch) throw new SyncError('NOT_FOUND');
    await lockPlans(db, branch);
    const plan = (
      await db.query<{
        version: number;
        checksum: string;
        payload: { stations: { id: string }[] };
      }>('SELECT version,checksum,payload FROM bo_station_plans WHERE id=$1 AND branch_id=$2', [
        receipt.plan_id,
        branch,
      ])
    ).rows[0];
    if (!plan) throw new SyncError('NOT_FOUND');
    if (
      plan.version !== receipt.version ||
      plan.checksum !== receipt.checksum ||
      (receipt.station_id !== undefined &&
        !plan.payload.stations.some((station) => station.id === receipt.station_id))
    )
      throw new SyncError('CONFLICT');
    const payloadHash = hashJson(receipt);
    const result = { plan_id: receipt.plan_id, recorded: true as const };
    const previous = (
      await db.query<{ payload_hash: string }>(
        'SELECT payload_hash FROM bo_station_plan_receipts WHERE plan_id=$1',
        [receipt.plan_id],
      )
    ).rows[0];
    if (previous) {
      if (previous.payload_hash !== payloadHash) throw new SyncError('CONFLICT');
      return result;
    }
    await db.query(
      `INSERT INTO bo_station_plan_receipts(plan_id,branch_id,device_id,version,checksum,result,reason,station_id,payload_hash)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        receipt.plan_id,
        branch,
        auth.deviceId,
        receipt.version,
        receipt.checksum,
        receipt.result,
        receipt.reason ?? null,
        receipt.station_id ?? null,
        payloadHash,
      ],
    );
    return result;
  });
}

export type StationPlanState = 'published' | 'delivered' | 'applied' | 'rejected' | 'superseded';
export interface StationPlanVersionView {
  id: string;
  version: number;
  published_at: string;
  stations: number;
  state: StationPlanState;
  delivered_at: string | null;
  deliveries: number;
  reason: string | null;
  station_id: string | null;
  station_name: string | null;
  answered_at: string | null;
}
export interface StationPlanStatus {
  schema_version: 1;
  /** BACKOFFICE_STATION_PLAN_DELIVERY_ENABLED. */
  enabled: boolean;
  /** cloud070 is installed and readable by this role. */
  available: boolean;
  latest: StationPlanVersionView | null;
  /** Newest plan the edge confirmed as applied. */
  applied: { id: string; version: number; applied_at: string } | null;
  /** Last edge report: the plan it serves and its local kitchen stations. */
  edge: {
    device_id: string;
    active_plan_id: string | null;
    active_version: number | null;
    stations: { id: string; kind: string; name: string }[];
    observed_at: string;
  } | null;
  plans: StationPlanVersionView[];
}
const iso = (value: Date | null) => (value ? value.toISOString() : null);

/** Cabinet view; a cloud without cloud070 (or without the grants) reports available=false. */
export async function readStationPlanStatus(
  db: Db,
  branch: string,
  enabled: boolean,
): Promise<StationPlanStatus> {
  const empty: StationPlanStatus = {
    schema_version: 1,
    enabled,
    available: false,
    latest: null,
    applied: null,
    edge: null,
    plans: [],
  };
  const installed = (
    await db.query<{ installed: boolean }>(
      "SELECT to_regclass('bo_station_plan_edge_state') IS NOT NULL AS installed",
    )
  ).rows[0]?.installed;
  if (!installed) return empty;
  const readable = (
    await db.query<{ readable: boolean }>(
      `SELECT bool_and(has_table_privilege(current_user,t,'SELECT')) AS readable FROM unnest(
        ARRAY['bo_station_plans','bo_station_plan_deliveries','bo_station_plan_receipts','bo_station_plan_edge_state']) t`,
    )
  ).rows[0]?.readable;
  if (!readable) return empty;
  const rows = (
    await db.query<{
      id: string;
      version: number;
      published_at: Date;
      stations: { id: string; name: string }[];
      delivered_at: Date | null;
      deliveries: number | null;
      result: 'applied' | 'rejected' | null;
      reason: string | null;
      station_id: string | null;
      answered_at: Date | null;
      newest: number;
    }>(
      `SELECT p.id,p.version,p.created_at AS published_at,p.payload->'stations' AS stations,
        d.first_delivered_at AS delivered_at,d.deliveries,r.result,r.reason,r.station_id,
        r.recorded_at AS answered_at,
        (SELECT max(x.version) FROM bo_station_plans x WHERE x.branch_id=p.branch_id) AS newest
       FROM bo_station_plans p
       LEFT JOIN bo_station_plan_deliveries d ON d.plan_id=p.id
       LEFT JOIN bo_station_plan_receipts r ON r.plan_id=p.id
       WHERE p.branch_id=$1 ORDER BY p.version DESC LIMIT 10`,
      [branch],
    )
  ).rows;
  const plans = rows.map((row): StationPlanVersionView => ({
    id: row.id,
    version: row.version,
    published_at: row.published_at.toISOString(),
    stations: row.stations.length,
    state:
      row.result ??
      (row.version < row.newest ? 'superseded' : row.delivered_at ? 'delivered' : 'published'),
    delivered_at: iso(row.delivered_at),
    deliveries: row.deliveries ?? 0,
    reason: row.reason,
    station_id: row.station_id,
    station_name: row.stations.find((station) => station.id === row.station_id)?.name ?? null,
    answered_at: iso(row.answered_at),
  }));
  const applied = (
    await db.query<{ plan_id: string; version: number; recorded_at: Date }>(
      `SELECT plan_id,version,recorded_at FROM bo_station_plan_receipts
       WHERE branch_id=$1 AND result='applied' ORDER BY version DESC LIMIT 1`,
      [branch],
    )
  ).rows[0];
  const edge = (
    await db.query<{
      device_id: string;
      active_plan_id: string | null;
      active_version: number | null;
      stations: { id: string; kind: string; name: string }[];
      observed_at: Date;
    }>(
      'SELECT device_id,active_plan_id,active_version,stations,observed_at FROM bo_station_plan_edge_state WHERE branch_id=$1',
      [branch],
    )
  ).rows[0];
  return {
    schema_version: 1,
    enabled,
    available: true,
    latest: plans[0] ?? null,
    applied: applied
      ? {
          id: applied.plan_id,
          version: applied.version,
          applied_at: applied.recorded_at.toISOString(),
        }
      : null,
    edge: edge ? { ...edge, observed_at: edge.observed_at.toISOString() } : null,
    plans,
  };
}
