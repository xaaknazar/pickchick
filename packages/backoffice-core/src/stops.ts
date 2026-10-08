import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseClient } from '@pickchick/database';
import { digest } from '@pickchick/commerce-core';
import { localCatalogId } from '@pickchick/menu-sync';
import { BackofficeError, type StopRequestInput } from './model.js';

/**
 * Back-office side of remote stops. The cashier edge stays the single writer of stops: the
 * back-office only queues a command (cloud_stop_commands, cloud046) that the fulfillment
 * transport delivers and the edge applies with an expected_version check. Names and ids come
 * from the published catalog, hashed exactly like the POS menu (localCatalogId).
 */
export interface BackofficeOptions {
  /** BACKOFFICE_REMOTE_STOPS_ENABLED: managers may queue stop/unstop commands. Default off. */
  remoteStopsEnabled?: boolean;
}
export function backofficeOptions(
  env: Record<string, string | undefined> = process.env,
): BackofficeOptions {
  const value = env['BACKOFFICE_REMOTE_STOPS_ENABLED'] ?? 'false';
  if (value !== 'true' && value !== 'false')
    throw new Error('BACKOFFICE_REMOTE_STOPS_ENABLED must be true or false');
  return { remoteStopsEnabled: value === 'true' };
}
export interface StopActor {
  id: string;
  organization_id: string;
  role: 'manager' | 'analyst';
}
type Db = Pick<DatabaseClient, 'query'>;
/** Same grace as the transport (fulfillment-transport cloud.ts): a delivered command may still
 * get its edge verdict for this long after expires_at. */
export const STOP_VERDICT_GRACE_SECONDS = 60;

const title = z.object({ ru: z.string() });
/** Only the fields the stop list needs; the payload was fully validated when it was published. */
const PublishedCatalogShape = z.object({
  products: z.array(
    z.object({
      id: z.string(),
      name: title,
      available: z.boolean(),
      modifier_groups: z.array(
        z.object({
          id: z.string(),
          title,
          options: z.array(z.object({ id: z.string(), label: title, available: z.boolean() })),
        }),
      ),
    }),
  ),
});
export interface StopCatalogEntry {
  catalog_ref: { product_id: string; group_id?: string; option_id?: string };
  variant_id: string;
  kind: 'product' | 'option';
  name_ru: string;
  product_name_ru: string;
  group_name_ru: string | null;
  /** The product is in the published menu (catalog available=true), so the POS menu has it. */
  listed: boolean;
}
/** Hashed POS identity of a catalog product (base-preview) or option (modifier-option). */
export function stopVariantId(
  branchId: string,
  ref: { product_id: string; group_id?: string | undefined; option_id?: string | undefined },
) {
  return ref.group_id !== undefined && ref.option_id !== undefined
    ? localCatalogId(
        branchId,
        'modifier-option',
        `${ref.product_id}:${ref.group_id}:${ref.option_id}`,
      )
    : localCatalogId(branchId, 'base-preview', ref.product_id);
}
/** Every product and option of a published catalog, in catalog order. */
export function stopCatalogEntries(branchId: string, payload: unknown): StopCatalogEntry[] {
  const catalog = PublishedCatalogShape.parse(payload);
  return catalog.products.flatMap((product) => [
    {
      catalog_ref: { product_id: product.id },
      variant_id: stopVariantId(branchId, { product_id: product.id }),
      kind: 'product' as const,
      name_ru: product.name.ru,
      product_name_ru: product.name.ru,
      group_name_ru: null,
      listed: product.available,
    },
    ...product.modifier_groups.flatMap((group) =>
      group.options.map((option) => {
        const ref = { product_id: product.id, group_id: group.id, option_id: option.id };
        return {
          catalog_ref: ref,
          variant_id: stopVariantId(branchId, ref),
          kind: 'option' as const,
          name_ru: option.label.ru,
          product_name_ru: product.name.ru,
          group_name_ru: group.title.ru,
          listed: product.available,
        };
      }),
    ),
  ]);
}
async function readable(db: Db, table: string) {
  // CASE keeps the privilege lookup from resolving a table that does not exist yet.
  return (
    (
      await db.query<{ readable: boolean }>(
        'SELECT CASE WHEN to_regclass($1) IS NULL THEN false ELSE has_table_privilege($1,$2) END AS readable',
        [table, 'SELECT'],
      )
    ).rows[0]?.readable === true
  );
}
/** Current head publication; null before the first publication or without read access. */
export async function publishedCatalog(db: Db, branchId: string) {
  if (!(await readable(db, 'catalog_publications'))) return null;
  const row = (
    await db.query<{ version: number; published_at: Date; payload: unknown }>(
      `SELECT p.version,p.published_at,p.payload FROM catalog_branch_heads h
      JOIN catalog_publications p ON p.branch_id=h.branch_id AND p.version=h.published_version
      WHERE h.branch_id=$1`,
      [branchId],
    )
  ).rows[0];
  if (!row) return null;
  return {
    version: row.version,
    published_at: row.published_at,
    entries: stopCatalogEntries(branchId, row.payload),
  };
}
/** v1 read model: names for stopped ids that are catalog hashes (the legacy tables miss them). */
export async function catalogStopNames(db: Db, branchId: string, ids: readonly string[]) {
  if (!ids.length) return [];
  const catalog = await publishedCatalog(db, branchId);
  if (!catalog) return [];
  const wanted = new Set(ids);
  return catalog.entries
    .filter((entry) => wanted.has(entry.variant_id))
    .map((entry) => ({
      id: entry.variant_id,
      name: entry.kind === 'option' ? `${entry.product_name_ru} · ${entry.name_ru}` : entry.name_ru,
      kind: 'variant',
    }));
}
const StopStatesSchema = z.array(
  z.looseObject({
    id: z.string(),
    version: z.number().int(),
    stopped: z.boolean(),
    source: z.enum(['pos', 'backoffice']),
    expiresAt: z.string().nullable(),
    shiftScoped: z.boolean(),
  }),
);
type StopState = z.infer<typeof StopStatesSchema>[number];
/** Edge projection through the active transport binding, as branchAvailability reads it. */
async function edgeAvailability(db: Db, branchId: string) {
  const row = (
    await db.query<{
      device_id: string;
      stopped_ids: string[];
      revision: string;
      observed_at: Date;
      fresh: boolean;
      stop_states: unknown;
    }>(
      `SELECT a.device_id,a.stopped_ids,a.revision::text,a.observed_at,
      (a.observed_at > clock_timestamp()-interval '30 seconds') fresh,
      to_jsonb(a)->'stop_states' stop_states
      FROM cloud_branch_availability a
      JOIN fulfillment_transport_bindings b ON b.branch_id=a.branch_id AND b.device_id=a.device_id AND b.active
      JOIN devices d ON d.id=b.device_id AND d.status='active' WHERE a.branch_id=$1`,
      [branchId],
    )
  ).rows[0];
  // stop_states is written only by protocol-4 heartbeats: its presence means the edge
  // exchanges stop commands. Malformed reports are ignored rather than trusted.
  const states = row?.stop_states == null ? null : StopStatesSchema.safeParse(row.stop_states);
  return {
    device_id: row?.device_id ?? null,
    revision: row?.revision ?? null,
    observed_at: row?.observed_at ?? null,
    fresh: row?.fresh ?? false,
    stopped_ids: row?.stopped_ids ?? [],
    states: states?.success ? new Map(states.data.map((s) => [s.id, s])) : null,
  };
}
type CommandRow = {
  id: string;
  variant_id: string;
  stopped: boolean;
  duration: 'manual' | 'hour' | 'shift';
  state: string;
  result_version: number | null;
  actor_label: string;
  created_at: Date;
  expires_at: Date;
  resolved_at: Date | null;
  lapsed: boolean;
  blocks_sales: boolean;
};
/** Latest open and latest resolved command per variant. An open command past its deadline
 * is shown as expired already: the transport closes it on its next pull. */
async function latestCommands(db: Db, branchId: string) {
  if (!(await readable(db, 'cloud_stop_commands'))) return null;
  const rows = (
    await db.query<CommandRow>(
      `SELECT * FROM (
        SELECT DISTINCT ON (variant_id) id,variant_id,stopped,duration,state,result_version,actor_label,created_at,expires_at,resolved_at,
        ((state='pending' AND expires_at<=clock_timestamp()) OR (state='delivered' AND expires_at+$2*interval '1 second'<=clock_timestamp())) lapsed,
        (stopped AND expires_at>clock_timestamp()) blocks_sales
        FROM cloud_stop_commands WHERE branch_id=$1 AND state IN ('pending','delivered') ORDER BY variant_id,created_at DESC,id DESC) open
      UNION ALL SELECT * FROM (
        SELECT DISTINCT ON (variant_id) id,variant_id,stopped,duration,state,result_version,actor_label,created_at,expires_at,resolved_at,false,false
        FROM cloud_stop_commands WHERE branch_id=$1 AND state NOT IN ('pending','delivered') ORDER BY variant_id,created_at DESC,id DESC) resolved`,
      [branchId, STOP_VERDICT_GRACE_SECONDS],
    )
  ).rows;
  const open = new Map<string, CommandRow>(),
    resolved = new Map<string, CommandRow>();
  for (const row of rows) {
    if (['pending', 'delivered'].includes(row.state) && !row.lapsed) open.set(row.variant_id, row);
    else {
      const view = row.lapsed ? { ...row, state: 'expired', resolved_at: null } : row;
      const known = resolved.get(row.variant_id);
      if (!known || known.created_at < view.created_at) resolved.set(row.variant_id, view);
    }
  }
  return { open, resolved };
}
const iso = (value: Date | null) => (value ? value.toISOString() : null);
const pendingView = (row: CommandRow) => ({
  command_id: row.id,
  stopped: row.stopped,
  duration: row.duration,
  state: row.state as 'pending' | 'delivered',
  actor_label: row.actor_label,
  created_at: iso(row.created_at),
  expires_at: iso(row.expires_at),
});
const resultView = (row: CommandRow) => ({
  command_id: row.id,
  stopped: row.stopped,
  state: row.state,
  result_version: row.result_version,
  actor_label: row.actor_label,
  created_at: iso(row.created_at),
  resolved_at: iso(row.resolved_at),
});
function stateView(state: StopState | undefined) {
  return {
    source: state?.source ?? null,
    expires_at: state?.expiresAt ?? null,
    shift_scoped: state?.shiftScoped ?? false,
  };
}
/**
 * Stop list v2: one row per published product and option with the edge state, the open
 * back-office command and the last edge verdict. Stopped ids that are not in the catalog
 * (legacy or delisted) fall back to the old products tables for a name.
 */
export async function readStopList(
  db: Db,
  actor: StopActor,
  branchId: string,
  options: BackofficeOptions,
) {
  const catalog = await publishedCatalog(db, branchId);
  const edge = await edgeAvailability(db, branchId);
  const commands = await latestCommands(db, branchId);
  const stopped = new Set(edge.stopped_ids);
  const entries = catalog?.entries ?? [];
  const items = entries.map((entry) => {
    const state = edge.states?.get(entry.variant_id);
    const open = commands?.open.get(entry.variant_id);
    const last = commands?.resolved.get(entry.variant_id);
    const lastVersion =
      last && ['applied', 'conflict'].includes(last.state) ? last.result_version : null;
    return {
      catalog_ref: entry.catalog_ref,
      variant_id: entry.variant_id,
      kind: entry.kind,
      name_ru: entry.name_ru,
      product_name_ru: entry.product_name_ru,
      group_name_ru: entry.group_name_ru,
      listed: entry.listed,
      stopped: stopped.has(entry.variant_id),
      // Expected version for the next command. A variant the edge has never stopped is 0.
      version: state?.version ?? lastVersion ?? (edge.states ? 0 : null),
      ...stateView(state),
      sales_blocked: stopped.has(entry.variant_id) || open?.blocks_sales === true,
      pending: open ? pendingView(open) : null,
      last_result: last ? resultView(last) : null,
    };
  });
  const known = new Set(entries.map((entry) => entry.variant_id));
  const unknownIds = edge.stopped_ids.filter((id) => !known.has(id));
  const legacy = unknownIds.length
    ? (
        await db.query<{ id: string; name: string; kind: string }>(
          `SELECT p.id,p.name_ru name,'product' kind FROM products p
          WHERE p.organization_id=$2 AND p.id=ANY($1::uuid[])
          UNION ALL SELECT v.id,p.name_ru name,'variant' kind FROM product_variants v
          JOIN products p ON p.id=v.product_id AND p.organization_id=v.organization_id
          WHERE v.organization_id=$2 AND v.id=ANY($1::uuid[])`,
          [unknownIds, actor.organization_id],
        )
      ).rows
    : [];
  const edgeReady = edge.device_id !== null && edge.states !== null && commands !== null;
  return {
    schema_version: 2 as const,
    branch_id: branchId,
    role: actor.role,
    as_of: new Date().toISOString(),
    remote_stops: {
      enabled: options.remoteStopsEnabled === true,
      edge_ready: edgeReady,
      writable:
        options.remoteStopsEnabled === true &&
        actor.role === 'manager' &&
        edgeReady &&
        catalog !== null,
    },
    catalog: catalog
      ? { version: catalog.version, published_at: catalog.published_at.toISOString() }
      : null,
    availability: {
      device_id: edge.device_id,
      revision: edge.revision,
      observed_at: iso(edge.observed_at),
      fresh: edge.fresh,
      stopped_count: edge.stopped_ids.length,
      states_reported: edge.states !== null,
      source: 'edge_transport' as const,
    },
    items,
    unknown_stops: unknownIds.map((id) => {
      const row = legacy.find((r) => r.id === id);
      const state = edge.states?.get(id);
      return {
        variant_id: id,
        name_ru: row?.name ?? null,
        kind: row?.kind ?? null,
        version: state?.version ?? null,
        ...stateView(state),
      };
    }),
  };
}
const fail = (
  code: ConstructorParameters<typeof BackofficeError>[0],
  reason?: ConstructorParameters<typeof BackofficeError>[1],
): never => {
  throw new BackofficeError(code, reason);
};
/**
 * Queues one stop/unstop command for the edge, inside the caller's transaction after a
 * manager scope check. Idempotent per actor and request_id (bo_commands), audited in bo_audit.
 */
export async function requestStopInTransaction(
  db: Db,
  actor: StopActor,
  branchId: string,
  request: StopRequestInput,
  options: BackofficeOptions,
) {
  if (options.remoteStopsEnabled !== true) fail('SERVICE_UNAVAILABLE', 'REMOTE_STOPS_DISABLED');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'bo:actor:' + actor.id + ':' + request.request_id,
  ]);
  const hash = digest({ branch: branchId, type: 'remote_stop', ...request });
  const previous = (
    await db.query<{ digest: string; result: unknown }>(
      'SELECT digest,result FROM bo_commands WHERE actor_id=$1 AND request_id=$2',
      [actor.id, request.request_id],
    )
  ).rows[0];
  if (previous) return previous.digest === hash ? previous.result : fail('CONFLICT');
  const catalog = await publishedCatalog(db, branchId);
  if (!catalog) return fail('NOT_READY', 'CATALOG_NOT_PUBLISHED');
  const ref = request.catalog_ref;
  const entry = catalog.entries.find(
    (e) =>
      e.catalog_ref.product_id === ref.product_id &&
      e.catalog_ref.group_id === ref.group_id &&
      e.catalog_ref.option_id === ref.option_id,
  );
  // A delisted product is not in the POS menu: the edge could only answer not_found.
  if (!entry || !entry.listed) return fail('NOT_FOUND', 'CATALOG_ITEM_NOT_FOUND');
  if (!(await readable(db, 'cloud_stop_commands')))
    return fail('NOT_READY', 'EDGE_STOPS_NOT_READY');
  const edge = await edgeAvailability(db, branchId);
  // Without protocol-4 heartbeats nobody would deliver the command; refuse instead of letting
  // a pending stop block online sales for two minutes and then lapse.
  if (!edge.device_id || !edge.states) return fail('NOT_READY', 'EDGE_STOPS_NOT_READY');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'bo:stop:' + branchId + ':' + entry.variant_id,
  ]);
  // Close a command whose deadline passed while no pull did it (edge offline), with exactly
  // the transport's rule, so it cannot hold the one-open-command slot forever.
  await db.query(
    `UPDATE cloud_stop_commands SET state='expired',resolved_at=clock_timestamp()
    WHERE branch_id=$1 AND variant_id=$2 AND ((state='pending' AND expires_at<=clock_timestamp())
      OR (state='delivered' AND expires_at+$3*interval '1 second'<=clock_timestamp()))`,
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
    return fail('CONFLICT', 'STOP_COMMAND_IN_PROGRESS');
  const label = (
    await db.query<{ name: string }>('SELECT name FROM catalog_managers WHERE id=$1', [actor.id])
  ).rows[0]!.name;
  const command = (
    await db.query<{ id: string; created_at: Date; expires_at: Date }>(
      `INSERT INTO cloud_stop_commands(id,organization_id,branch_id,variant_id,catalog_ref,stopped,duration,reason,expected_version,actor_id,actor_label,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp()+interval '120 seconds')
      RETURNING id,created_at,expires_at`,
      [
        randomUUID(),
        actor.organization_id,
        branchId,
        entry.variant_id,
        [ref.product_id, ref.group_id, ref.option_id].filter(Boolean).join(':'),
        request.stopped,
        request.duration,
        request.reason,
        request.expected_version,
        actor.id,
        label,
      ],
    )
  ).rows[0]!;
  const result = {
    command_id: command.id,
    branch_id: branchId,
    variant_id: entry.variant_id,
    catalog_ref: entry.catalog_ref,
    stopped: request.stopped,
    duration: request.duration,
    expected_version: request.expected_version,
    state: 'pending' as const,
    created_at: command.created_at.toISOString(),
    expires_at: command.expires_at.toISOString(),
  };
  const state = edge.states.get(entry.variant_id);
  await db.query(
    'INSERT INTO bo_audit(id,branch_id,organization_id,actor_id,request_id,action,entity_id,reason,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      randomUUID(),
      branchId,
      actor.organization_id,
      actor.id,
      request.request_id,
      request.stopped ? 'remote_stop:stop' : 'remote_stop:unstop',
      command.id,
      request.reason,
      state ? { ...state, effective: edge.stopped_ids.includes(entry.variant_id) } : null,
      result,
    ],
  );
  await db.query(
    'INSERT INTO bo_commands(actor_id,request_id,branch_id,digest,result) VALUES($1,$2,$3,$4,$5)',
    [actor.id, request.request_id, branchId, hash, result],
  );
  return result;
}
