import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction, type DatabaseClient, type DatabasePool } from '@pickchick/database';
import { catalogHash } from '@pickchick/catalog-admin';
import {
  branchChannelOwner,
  cloudChannelAvailability,
  digest,
  KITCHEN_PRESENCE_SECONDS,
} from '@pickchick/commerce-core';
import { BackofficeError, StopCatalogRef, parse, type BackofficeErrorReason } from './model.js';
import {
  DURABLE_COMMAND_SQL,
  STOP_VERDICT_GRACE_SECONDS,
  edgeAvailability,
  latestCommands,
  pendingView,
  publishedCatalog,
  readable,
  resultView,
  type StopActor,
} from './stops.js';

/**
 * ADR-0014 S3: stops of the cloud channels (kiosk/mobile of a branch in mode 'cloud').
 * - Cloud stops (cloud055 cloud_channel_stops): owned by the back-office, versioned
 *   (expected_version), durations manual/hour, every change audited with a reason.
 * - Override of a stale cashier stop: only for the cloud channels, only while the cashier is
 *   stale, lapses on the next cashier observation. With include_cashier the cashier also gets
 *   a durable UNSTOP (delivery_policy 'until_reconnect'): it waits for the cashier instead of the
 *   120 s lapse, the edge applies it only at the same version, otherwise 'conflict' is shown.
 * Cashier stops stay edge-written; nothing here touches cloud_branch_availability.
 */
export interface CloudStopOptions {
  /** BACKOFFICE_ENABLED: the back-office API itself. */
  enabled?: boolean;
  /** BACKOFFICE_CLOUD_STOPS_ENABLED: managers may change cloud stops and overrides. */
  cloudStopsEnabled?: boolean;
  /** BACKOFFICE_REMOTE_STOPS_ENABLED: managers may queue commands for the cashier. */
  remoteStopsEnabled?: boolean;
}
export function cloudStopOptions(
  env: Record<string, string | undefined> = process.env,
): Required<CloudStopOptions> {
  const flag = (name: string) => {
    const value = env[name] ?? 'false';
    if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false`);
    return value === 'true';
  };
  return {
    enabled: flag('BACKOFFICE_ENABLED'),
    cloudStopsEnabled: flag('BACKOFFICE_CLOUD_STOPS_ENABLED'),
    remoteStopsEnabled: flag('BACKOFFICE_REMOTE_STOPS_ENABLED'),
  };
}
export type CloudStopReason =
  | 'CLOUD_STOPS_DISABLED'
  | 'VERSION_MISMATCH'
  | 'CASHIER_ONLINE'
  | 'CASHIER_STOP_NOT_FOUND'
  | 'CASHIER_VERSION_MISMATCH'
  | 'OVERRIDE_ACTIVE'
  | 'CASHIER_OBSERVATION_CHANGED';
/** BackofficeError with a cloud-stop reason (BackofficeErrorReason is a shared contract). */
export class CloudStopError extends BackofficeError {
  constructor(
    code: ConstructorParameters<typeof BackofficeError>[0],
    readonly detail: CloudStopReason | BackofficeErrorReason,
  ) {
    super(code);
  }
}
const reject = (
  code: ConstructorParameters<typeof BackofficeError>[0],
  detail: CloudStopReason | BackofficeErrorReason,
): never => {
  throw new CloudStopError(code, detail);
};
const reason = z.string().trim().min(3).max(300);
const version = z.number().int().min(0).max(2147483646);
export const CloudStopRequest = z
  .strictObject({
    request_id: z.uuid(),
    catalog_ref: StopCatalogRef,
    stopped: z.boolean(),
    duration: z.enum(['manual', 'hour']).default('manual'),
    reason,
    expected_version: version,
  })
  .refine((v) => v.stopped || v.duration === 'manual');
export type CloudStopRequestInput = z.infer<typeof CloudStopRequest>;
export const CashierStopOverrideRequest = z.strictObject({
  request_id: z.uuid(),
  catalog_ref: StopCatalogRef,
  /** Version of the cashier stop the manager saw (stop list v2 / cloud stop list). */
  expected_version: version.min(1),
  reason,
  /** Also lift the stop on the cashier: durable UNSTOP delivered on reconnect. */
  include_cashier: z.boolean().default(false),
});
export type CashierStopOverrideInput = z.infer<typeof CashierStopOverrideRequest>;
type Db = Pick<DatabaseClient, 'query'>;
type Entry = NonNullable<Awaited<ReturnType<typeof publishedCatalog>>>['entries'][number];

async function catalogEntry(db: Db, branchId: string, ref: CloudStopRequestInput['catalog_ref']) {
  const catalog = await publishedCatalog(db, branchId);
  if (!catalog) return reject('NOT_READY', 'CATALOG_NOT_PUBLISHED');
  const entry = catalog.entries.find(
    (e) =>
      e.catalog_ref.product_id === ref.product_id &&
      e.catalog_ref.group_id === ref.group_id &&
      e.catalog_ref.option_id === ref.option_id,
  );
  return entry ?? reject('NOT_FOUND', 'CATALOG_ITEM_NOT_FOUND');
}
const catalogRefText = (entry: Entry) =>
  [entry.catalog_ref.product_id, entry.catalog_ref.group_id, entry.catalog_ref.option_id]
    .filter(Boolean)
    .join(':');
/** Per-actor request idempotency, as the other back-office commands (bo_commands). */
async function replay(db: Db, actor: StopActor, requestId: string, hash: string) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'bo:actor:' + actor.id + ':' + requestId,
  ]);
  const previous = (
    await db.query<{ digest: string; result: unknown }>(
      'SELECT digest,result FROM bo_commands WHERE actor_id=$1 AND request_id=$2',
      [actor.id, requestId],
    )
  ).rows[0];
  if (!previous) return undefined;
  // Same request id with another body: plain CONFLICT, as the other back-office commands.
  if (previous.digest !== hash) throw new BackofficeError('CONFLICT');
  return previous.result;
}
async function actorLabel(db: Db, actor: StopActor) {
  return (
    await db.query<{ name: string }>('SELECT name FROM catalog_managers WHERE id=$1', [actor.id])
  ).rows[0]!.name;
}
async function audit(
  db: Db,
  actor: StopActor,
  branchId: string,
  requestId: string,
  action: string,
  entityId: string,
  why: string,
  before: unknown,
  after: unknown,
) {
  await db.query(
    'INSERT INTO bo_audit(id,branch_id,organization_id,actor_id,request_id,action,entity_id,reason,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      randomUUID(),
      branchId,
      actor.organization_id,
      actor.id,
      requestId,
      action,
      entityId,
      why,
      before,
      after,
    ],
  );
}
const iso = (value: Date | null) => (value ? value.toISOString() : null);
interface CloudStopRow {
  variant_id: string;
  catalog_ref: string;
  stopped: boolean;
  duration: 'manual' | 'hour';
  expires_at: Date | null;
  reason: string;
  version: number;
  actor_label: string;
  updated_at: Date;
  effective: boolean;
}
const cloudStopView = (row: CloudStopRow) => ({
  stopped: row.stopped,
  effective: row.effective,
  duration: row.duration,
  expires_at: iso(row.expires_at),
  version: row.version,
  reason: row.reason,
  actor_label: row.actor_label,
  updated_at: iso(row.updated_at),
});
const CLOUD_STOP_COLUMNS = `variant_id,catalog_ref,stopped,duration,expires_at,reason,version,actor_label,updated_at,
  (stopped AND (expires_at IS NULL OR expires_at>clock_timestamp())) effective`;

/**
 * Sets the cloud stop of one product/option inside the caller's transaction (manager scope
 * already checked). expected_version is the version the manager saw (0: never stopped);
 * a concurrent change makes it CONFLICT/VERSION_MISMATCH, never last-write-wins.
 */
export async function setCloudStopInTransaction(
  db: Db,
  actor: StopActor,
  branchId: string,
  request: CloudStopRequestInput,
  options: CloudStopOptions,
) {
  if (options.cloudStopsEnabled !== true) reject('SERVICE_UNAVAILABLE', 'CLOUD_STOPS_DISABLED');
  if (actor.role !== 'manager') throw new BackofficeError('FORBIDDEN');
  const hash = digest({ branch: branchId, type: 'cloud_stop', ...request });
  const previous = await replay(db, actor, request.request_id, hash);
  if (previous !== undefined) return previous;
  const entry = await catalogEntry(db, branchId, request.catalog_ref);
  const before = (
    await db.query<CloudStopRow>(
      `SELECT ${CLOUD_STOP_COLUMNS} FROM cloud_channel_stops WHERE branch_id=$1 AND variant_id=$2`,
      [branchId, entry.variant_id],
    )
  ).rows[0];
  const label = await actorLabel(db, actor);
  // One statement: a new row only at expected 0, an update only at the expected version. A
  // concurrent writer is serialized by the row/PK lock and then fails the version predicate.
  const saved = (
    await db.query<CloudStopRow>(
      `INSERT INTO cloud_channel_stops AS s(organization_id,branch_id,variant_id,catalog_ref,stopped,duration,reason,version,actor_id,actor_label)
      SELECT $1,$2,$3,$4,$5,$6,$7,1,$8,$9 WHERE $10::int=0
      ON CONFLICT(branch_id,variant_id) DO UPDATE SET stopped=EXCLUDED.stopped,duration=EXCLUDED.duration,
        reason=EXCLUDED.reason,version=s.version+1,actor_id=EXCLUDED.actor_id,actor_label=EXCLUDED.actor_label
      WHERE s.version=$10::int
      RETURNING ${CLOUD_STOP_COLUMNS}`,
      [
        actor.organization_id,
        branchId,
        entry.variant_id,
        catalogRefText(entry),
        request.stopped,
        request.duration,
        request.reason,
        actor.id,
        label,
        request.expected_version,
      ],
    )
  ).rows[0];
  let row = saved;
  if (!row && request.expected_version > 0)
    // INSERT ... SELECT with no row never reaches ON CONFLICT: update at the version directly.
    row = (
      await db.query<CloudStopRow>(
        `UPDATE cloud_channel_stops SET stopped=$3,duration=$4,reason=$5,version=version+1,actor_id=$6,actor_label=$7
        WHERE branch_id=$1 AND variant_id=$2 AND version=$8 RETURNING ${CLOUD_STOP_COLUMNS}`,
        [
          branchId,
          entry.variant_id,
          request.stopped,
          request.duration,
          request.reason,
          actor.id,
          label,
          request.expected_version,
        ],
      )
    ).rows[0];
  if (!row) return reject('CONFLICT', 'VERSION_MISMATCH');
  const result = {
    branch_id: branchId,
    variant_id: entry.variant_id,
    catalog_ref: entry.catalog_ref,
    ...cloudStopView(row),
  };
  await audit(
    db,
    actor,
    branchId,
    request.request_id,
    request.stopped ? 'cloud_stop:stop' : 'cloud_stop:unstop',
    entry.variant_id,
    request.reason,
    before ? cloudStopView(before) : null,
    result,
  );
  await db.query(
    'INSERT INTO bo_commands(actor_id,request_id,branch_id,digest,result) VALUES($1,$2,$3,$4,$5)',
    [actor.id, request.request_id, branchId, hash, result],
  );
  return result;
}

/** Active override of a cashier stop: it answers the current cashier observation. */
async function activeOverrides(db: Db, branchId: string) {
  const rows = (
    await db.query<{
      id: string;
      variant_id: string;
      edge_version: number;
      reason: string;
      actor_label: string;
      created_at: Date;
      command_id: string | null;
    }>(
      `SELECT o.id,o.variant_id,o.edge_version,o.reason,o.actor_label,o.created_at,o.command_id
      FROM cloud_stale_stop_overrides o JOIN cloud_branch_availability a ON a.branch_id=o.branch_id
      AND a.device_id=o.edge_device_id AND o.edge_observed_at>=a.observed_at WHERE o.branch_id=$1`,
      [branchId],
    )
  ).rows;
  return new Map(rows.map((r) => [r.variant_id, r]));
}

/**
 * Lifts a last-known cashier stop for the cloud channels (and optionally on the cashier).
 * Allowed only while the cashier is stale and still reports the stop at expected_version.
 */
export async function overrideCashierStopInTransaction(
  db: Db,
  actor: StopActor,
  branchId: string,
  request: CashierStopOverrideInput,
  options: CloudStopOptions,
) {
  if (options.cloudStopsEnabled !== true) reject('SERVICE_UNAVAILABLE', 'CLOUD_STOPS_DISABLED');
  if (request.include_cashier && options.remoteStopsEnabled !== true)
    reject('SERVICE_UNAVAILABLE', 'REMOTE_STOPS_DISABLED');
  if (actor.role !== 'manager') throw new BackofficeError('FORBIDDEN');
  const hash = digest({ branch: branchId, type: 'cashier_stop_override', ...request });
  const previous = await replay(db, actor, request.request_id, hash);
  if (previous !== undefined) return previous;
  const entry = await catalogEntry(db, branchId, request.catalog_ref);
  if (!(await readable(db, 'cloud_stop_commands'))) reject('NOT_READY', 'EDGE_STOPS_NOT_READY');
  // Same per-variant lock as the cashier stop commands, so neither can interleave.
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'bo:stop:' + branchId + ':' + entry.variant_id,
  ]);
  const edge = await edgeAvailability(db, branchId);
  if (!edge.device_id || !edge.states || !edge.observed_at)
    return reject('NOT_READY', 'EDGE_STOPS_NOT_READY');
  if (edge.fresh) return reject('CONFLICT', 'CASHIER_ONLINE');
  if (!edge.stopped_ids.includes(entry.variant_id))
    return reject('NOT_FOUND', 'CASHIER_STOP_NOT_FOUND');
  const state = edge.states.get(entry.variant_id);
  if (!state || state.version !== request.expected_version)
    return reject('CONFLICT', 'CASHIER_VERSION_MISMATCH');
  if ((await activeOverrides(db, branchId)).has(entry.variant_id))
    return reject('CONFLICT', 'OVERRIDE_ACTIVE');
  const label = await actorLabel(db, actor);
  let command: { id: string; created_at: Date } | undefined;
  if (request.include_cashier) {
    // Close a lapsed TTL command first, exactly like requestStopInTransaction.
    await db.query(
      `UPDATE cloud_stop_commands SET state='expired',resolved_at=clock_timestamp()
      WHERE branch_id=$1 AND variant_id=$2 AND ((state='pending' AND expires_at<=clock_timestamp())
        OR (state='delivered' AND expires_at+$3*interval '1 second'<=clock_timestamp()))
        AND NOT ${DURABLE_COMMAND_SQL}`,
      [branchId, entry.variant_id, STOP_VERDICT_GRACE_SECONDS],
    );
    if (
      (
        await db.query(
          "SELECT 1 FROM cloud_stop_commands WHERE branch_id=$1 AND variant_id=$2 AND state IN ('pending','delivered')",
          [branchId, entry.variant_id],
        )
      ).rowCount
    )
      return reject('CONFLICT', 'STOP_COMMAND_IN_PROGRESS');
    command = (
      await db.query<{ id: string; created_at: Date }>(
        `INSERT INTO cloud_stop_commands(id,organization_id,branch_id,variant_id,catalog_ref,stopped,duration,reason,expected_version,actor_id,actor_label,expires_at,delivery_policy)
        VALUES($1,$2,$3,$4,$5,false,'manual',$6,$7,$8,$9,clock_timestamp()+interval '120 seconds','until_reconnect')
        RETURNING id,created_at`,
        [
          randomUUID(),
          actor.organization_id,
          branchId,
          entry.variant_id,
          catalogRefText(entry),
          request.reason,
          request.expected_version,
          actor.id,
          label,
        ],
      )
    ).rows[0]!;
  }
  const override = (
    await db.query<{ id: string; created_at: Date }>(
      // observed_at is read in SQL (microseconds; a JS Date would round it). The guard re-checks
      // that this observation is still stale and still reports the stop at edge_version.
      `INSERT INTO cloud_stale_stop_overrides(id,organization_id,branch_id,variant_id,catalog_ref,edge_device_id,edge_version,edge_observed_at,reason,actor_id,actor_label,command_id)
      SELECT $1,$2,$3,$4,$5,$6,$7,a.observed_at,$8,$9,$10,$11 FROM cloud_branch_availability a
      WHERE a.branch_id=$3 AND a.device_id=$6 RETURNING id,created_at`,
      [
        randomUUID(),
        actor.organization_id,
        branchId,
        entry.variant_id,
        catalogRefText(entry),
        edge.device_id,
        request.expected_version,
        request.reason,
        actor.id,
        label,
        command?.id ?? null,
      ],
    )
  ).rows[0];
  if (!override) return reject('CONFLICT', 'CASHIER_OBSERVATION_CHANGED');
  const result = {
    override_id: override.id,
    branch_id: branchId,
    variant_id: entry.variant_id,
    catalog_ref: entry.catalog_ref,
    edge_version: request.expected_version,
    edge_observed_at: edge.observed_at.toISOString(),
    created_at: override.created_at.toISOString(),
    cashier_command: command
      ? {
          command_id: command.id,
          stopped: false as const,
          expected_version: request.expected_version,
          state: 'pending' as const,
          awaits_reconnect: true as const,
          created_at: command.created_at.toISOString(),
        }
      : null,
  };
  const before = { ...state, effective: true, observed_at: edge.observed_at.toISOString() };
  await audit(
    db,
    actor,
    branchId,
    request.request_id,
    'cloud_stop:override_cashier',
    override.id,
    request.reason,
    before,
    result,
  );
  if (command)
    await audit(
      db,
      actor,
      branchId,
      request.request_id,
      'remote_stop:unstop',
      command.id,
      request.reason,
      before,
      result.cashier_command,
    );
  await db.query(
    'INSERT INTO bo_commands(actor_id,request_id,branch_id,digest,result) VALUES($1,$2,$3,$4,$5)',
    [actor.id, request.request_id, branchId, hash, result],
  );
  return result;
}

/**
 * Cloud stop list: per published product/option the cloud stop, the last known cashier stop,
 * an active override, the cashier command (pending/durable, last verdict incl. conflict) and
 * the effective cloud-channel verdict, computed by the same code as the sales gate.
 */
export async function readCloudStops(
  db: Db,
  actor: StopActor,
  branchId: string,
  options: CloudStopOptions,
) {
  const catalog = await publishedCatalog(db, branchId);
  const ready = await readable(db, 'cloud_channel_stops');
  const mode = await branchChannelOwner(db as Pick<DatabasePool, 'query'>, branchId);
  const channel = await cloudChannelAvailability(db as Pick<DatabasePool, 'query'>, branchId);
  const blocked = new Set(channel.stoppedIds);
  const edge = await edgeAvailability(db, branchId);
  const cloud = ready
    ? new Map(
        (
          await db.query<CloudStopRow>(
            `SELECT ${CLOUD_STOP_COLUMNS} FROM cloud_channel_stops WHERE branch_id=$1`,
            [branchId],
          )
        ).rows.map((r) => [r.variant_id, r]),
      )
    : new Map<string, CloudStopRow>();
  const overrides = ready ? await activeOverrides(db, branchId) : new Map();
  const commands = await latestCommands(db, branchId);
  const cashierStopped = new Set(edge.stopped_ids);
  return {
    schema_version: 1 as const,
    branch_id: branchId,
    role: actor.role,
    as_of: new Date().toISOString(),
    mode,
    cloud_stops: {
      enabled: options.cloudStopsEnabled === true,
      writable:
        options.cloudStopsEnabled === true && actor.role === 'manager' && ready && catalog !== null,
    },
    kitchen: { online: channel.fresh, presence_seconds: KITCHEN_PRESENCE_SECONDS },
    cashier: {
      device_id: edge.device_id,
      observed_at: iso(edge.observed_at),
      fresh: edge.fresh,
      states_reported: edge.states !== null,
    },
    catalog: catalog
      ? { version: catalog.version, published_at: catalog.published_at.toISOString() }
      : null,
    items: (catalog?.entries ?? []).map((entry) => {
      const stop = cloud.get(entry.variant_id);
      const state = edge.states?.get(entry.variant_id);
      const override = overrides.get(entry.variant_id);
      const open = commands?.open.get(entry.variant_id);
      const last = commands?.resolved.get(entry.variant_id);
      return {
        catalog_ref: entry.catalog_ref,
        variant_id: entry.variant_id,
        kind: entry.kind,
        name_ru: entry.name_ru,
        product_name_ru: entry.product_name_ru,
        group_name_ru: entry.group_name_ru,
        listed: entry.listed,
        cloud_stop: stop ? cloudStopView(stop) : null,
        // Expected version of the next cloud stop change.
        cloud_version: stop?.version ?? 0,
        cashier_stop: {
          stopped: cashierStopped.has(entry.variant_id),
          version: state?.version ?? null,
          source: state?.source ?? null,
        },
        override: override
          ? {
              override_id: override.id,
              edge_version: override.edge_version,
              reason: override.reason,
              actor_label: override.actor_label,
              created_at: iso(override.created_at),
              command_id: override.command_id,
            }
          : null,
        cashier_command: {
          pending: open ? pendingView(open) : null,
          last_result: last ? resultView(last) : null,
        },
        cloud_sales_blocked: blocked.has(entry.variant_id),
      };
    }),
  };
}

/**
 * Standalone service for the cloud stop endpoints (same token/grant scope as Backoffice),
 * so it can be registered without changing the shared Backoffice class.
 */
export class CloudChannelStops {
  constructor(
    private readonly pool: DatabasePool,
    private readonly options: CloudStopOptions,
  ) {}
  private async scope(db: DatabaseClient, token: string, branch: string, write = false) {
    if (this.options.enabled !== true) throw new BackofficeError('SERVICE_UNAVAILABLE');
    parse(z.uuid(), branch);
    if (!/^[a-f0-9]{64}$/.test(token)) throw new BackofficeError('UNAUTHORIZED');
    const actor = (
      await db.query<{ id: string; organization_id: string }>(
        'SELECT id,organization_id FROM catalog_managers WHERE token_hash=$1 AND revoked_at IS NULL FOR SHARE',
        [catalogHash(token)],
      )
    ).rows[0];
    if (!actor) throw new BackofficeError('UNAUTHORIZED');
    const grant = (
      await db.query<{ role: StopActor['role'] }>(
        'SELECT g.role FROM bo_access_grants g JOIN catalog_manager_branches s ON s.actor_id=g.actor_id AND s.branch_id=g.branch_id WHERE g.actor_id=$1 AND g.branch_id=$2 AND s.organization_id=$3 FOR SHARE OF g,s',
        [actor.id, branch, actor.organization_id],
      )
    ).rows[0];
    if (!grant || (write && grant.role !== 'manager')) throw new BackofficeError('FORBIDDEN');
    return { ...actor, role: grant.role } satisfies StopActor;
  }
  async read(token: string, branch: string) {
    return transaction(this.pool, async (db) => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return readCloudStops(db, await this.scope(db, token, branch), branch, this.options);
    });
  }
  async setStop(token: string, branch: string, input: unknown) {
    const request = parse(CloudStopRequest, input);
    return this.write(token, branch, (db, actor) =>
      setCloudStopInTransaction(db, actor, branch, request, this.options),
    );
  }
  async overrideCashierStop(token: string, branch: string, input: unknown) {
    const request = parse(CashierStopOverrideRequest, input);
    return this.write(token, branch, (db, actor) =>
      overrideCashierStopInTransaction(db, actor, branch, request, this.options),
    );
  }
  private async write<T>(
    token: string,
    branch: string,
    run: (db: DatabaseClient, actor: StopActor) => Promise<T>,
  ) {
    try {
      return await transaction(this.pool, async (db) =>
        run(db, await this.scope(db, token, branch, true)),
      );
    } catch (error) {
      if (error instanceof BackofficeError) throw error;
      if (error && typeof error === 'object' && 'code' in error) {
        if (error.code === '23505')
          throw new CloudStopError(
            'CONFLICT',
            'constraint' in error && error.constraint === 'cloud_stop_commands_open_idx'
              ? 'STOP_COMMAND_IN_PROGRESS'
              : 'VERSION_MISMATCH',
          );
        // The override guard re-checks the cashier observation at insert time.
        if (String(error.code) === '23514')
          throw new CloudStopError('CONFLICT', 'CASHIER_OBSERVATION_CHANGED');
        if (String(error.code) === '23503') throw new BackofficeError('INVALID_REQUEST');
        if (['40001', '40P01'].includes(String(error.code)))
          throw new BackofficeError('SERVICE_UNAVAILABLE');
      }
      throw error;
    }
  }
}
