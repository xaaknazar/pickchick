import { randomUUID } from 'node:crypto';
import {
  ChecksumSchema,
  EventEnvelopeSchema,
  MenuAckSchema,
  MenuPublishedSchema,
} from '@pickchick/contracts';
import type { MenuAck, MenuPublished, MenuRejectReason } from '@pickchick/contracts';
import { transaction } from '@pickchick/database';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { canonicalJson, hashJson, SyncError } from './common.js';
import { menuImageShas, missingMenuMedia } from './media.js';
import { deriveRouting, MenuRoutingError } from './routing.js';
import type { KitchenRouting, KitchenStation } from './routing.js';

/** Deterministic, data-level failure: acknowledged as rejected instead of retried forever. */
export class MenuRejection extends Error {
  constructor(readonly reason: MenuRejectReason) {
    super(reason);
    this.name = 'MenuRejection';
  }
}

/** Identity of a delivered event; enough to ACK it even when the menu itself is invalid. */
interface DeliveredEvent {
  event_id: string;
  producer_id: string;
  producer_sequence: string;
  aggregate_version: number;
  correlation_id: string;
  release_id: string;
  version: number;
  checksum: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function identity(
  event: Pick<
    MenuPublished,
    'event_id' | 'producer_id' | 'producer_sequence' | 'aggregate_version' | 'correlation_id'
  >,
  releaseId: string,
  version: number,
  checksum: string,
): DeliveredEvent {
  return {
    event_id: event.event_id,
    producer_id: event.producer_id,
    producer_sequence: event.producer_sequence,
    aggregate_version: event.aggregate_version,
    correlation_id: event.correlation_id,
    release_id: releaseId,
    version,
    checksum,
  };
}

/**
 * Integrity first: a corrupt, foreign or mismatched envelope is a CONFLICT and is retried.
 * A menu that is intact (the checksum over the raw menu matches) but that this edge cannot
 * parse is INVALID_MENU, so a schema drift cannot block every later publication.
 */
function deliveredEvent(branchId: string, input: unknown) {
  const parsed = MenuPublishedSchema.safeParse(input);
  if (parsed.success) {
    const event = parsed.data;
    const { menu, checksum } = event.payload;
    if (
      event.branch_id !== branchId ||
      menu.branch_id !== branchId ||
      event.aggregate_id !== menu.release_id ||
      event.aggregate_version !== menu.version ||
      hashJson(menu) !== checksum
    )
      throw new SyncError('CONFLICT');
    return { event, delivered: identity(event, menu.release_id, menu.version, checksum) };
  }
  const envelope = EventEnvelopeSchema.safeParse(input);
  if (
    !envelope.success ||
    envelope.data.aggregate_type !== 'menu_release' ||
    envelope.data.event_type !== 'menu.published'
  )
    throw new SyncError('INVALID_REQUEST');
  const raw = envelope.data;
  const { menu, checksum } = raw.payload;
  if (
    Object.keys(raw.payload).sort().join(',') !== 'checksum,menu' ||
    !ChecksumSchema.safeParse(checksum).success ||
    !isRecord(menu)
  )
    throw new SyncError('INVALID_REQUEST');
  if (
    raw.branch_id !== branchId ||
    menu.branch_id !== branchId ||
    menu.release_id !== raw.aggregate_id ||
    menu.version !== raw.aggregate_version ||
    hashJson(menu) !== checksum
  )
    throw new SyncError('CONFLICT');
  return {
    event: null,
    delivered: identity(raw, raw.aggregate_id, raw.aggregate_version, checksum as string),
  };
}

/**
 * Serializes menu effects, replays a stored result and enforces the producer stream.
 * Returns the stored ACK for a duplicate delivery, otherwise null.
 */
async function admitDelivery(
  client: DatabaseClient,
  branchId: string,
  delivered: DeliveredEvent,
  eventHash: string,
): Promise<MenuAck | null> {
  // Serializes all menu effects and acknowledgments on this edge.
  const binding = await client.query('SELECT id FROM branch_config WHERE id = $1 FOR UPDATE', [
    branchId,
  ]);
  if (!binding.rowCount) throw new SyncError('CONFLICT');
  const existing = await client.query(
    'SELECT payload_hash, result FROM inbox_messages WHERE producer_id = $1 AND event_id = $2',
    [delivered.producer_id, delivered.event_id],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].payload_hash !== eventHash) throw new SyncError('CONFLICT');
    return MenuAckSchema.parse(existing.rows[0].result);
  }
  const state = await client.query(
    'SELECT producer_id, last_sequence FROM menu_sync_state WHERE branch_id = $1',
    [branchId],
  );
  if (state.rows[0] && state.rows[0].producer_id !== delivered.producer_id)
    throw new SyncError('CONFLICT');
  const sequence = BigInt(state.rows[0]?.last_sequence ?? '0');
  if (BigInt(delivered.producer_sequence) !== sequence + 1n) throw new SyncError('CONFLICT');
  return null;
}

/** Inbox, cursor, durable outbox ACK and apply result, in the caller's transaction. */
async function recordDelivery(
  client: DatabaseClient,
  branchId: string,
  delivered: DeliveredEvent,
  eventHash: string,
  ack: MenuAck,
  routingVersion: number | null,
) {
  await client.query(
    `INSERT INTO inbox_messages(producer_id, event_id, branch_id, payload_hash, result) VALUES ($1,$2,$3,$4,$5)`,
    [delivered.producer_id, delivered.event_id, branchId, eventHash, ack],
  );
  const stream = await client.query(
    `INSERT INTO menu_sync_state(branch_id, producer_id, last_sequence) VALUES ($1,$2,$3)
    ON CONFLICT(branch_id) DO UPDATE SET last_sequence = EXCLUDED.last_sequence RETURNING ack_producer_id`,
    [branchId, delivered.producer_id, delivered.producer_sequence],
  );
  // Separate menu ACK stream; other domains must allocate their own producer/sequence.
  await client.query(
    `INSERT INTO outbox_events(event_id, producer_id, producer_sequence, branch_id,
    aggregate_type, aggregate_id, aggregate_version, schema_version, event_type, payload, occurred_at, correlation_id, causation_id)
    VALUES ($1,$2,$3,$4,'menu_release',$5,$6,1,'menu.applied',$7,now(),$8,$9)`,
    [
      randomUUID(),
      stream.rows[0].ack_producer_id,
      delivered.producer_sequence,
      branchId,
      delivered.release_id,
      delivered.aggregate_version,
      ack,
      delivered.correlation_id,
      delivered.event_id,
    ],
  );
  // An edge database still before migration 018 (historical upgrade fixtures, or an edge
  // whose guarded upgrade is pending) keeps the earlier behaviour: no apply-result row.
  const results = await client.query<{ present: boolean }>(
    "SELECT to_regclass('menu_apply_results') IS NOT NULL AS present",
  );
  if (!results.rows[0]?.present) return;
  await client.query(
    `INSERT INTO menu_apply_results(release_id, branch_id, event_id, version, result, reason, routing_version)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      delivered.release_id,
      branchId,
      delivered.event_id,
      delivered.version,
      ack.result ?? 'applied',
      ack.reason ?? null,
      routingVersion,
    ],
  );
}

function ackFor(branchId: string, delivered: DeliveredEvent, reason?: MenuRejectReason) {
  // An applied ACK carries no result field: byte-identical to ACKs older clouds hash and store.
  return MenuAckSchema.parse({
    event_id: delivered.event_id,
    producer_id: delivered.producer_id,
    producer_sequence: delivered.producer_sequence,
    branch_id: branchId,
    release_id: delivered.release_id,
    checksum: delivered.checksum,
    ...(reason ? { result: 'rejected', reason } : {}),
  });
}

/**
 * Derives and activates kitchen routing inside the menu transaction. Skipped when fulfillment
 * is not provisioned, and for a legacy snapshot in which no item carries the published kitchen
 * field (an operator-installed menu keeps its operator-installed routing).
 * Returns the routing version that is active once the menu applies, or null.
 */
async function activateRouting(
  client: DatabaseClient,
  branchId: string,
  menu: MenuPublished['payload']['menu'],
): Promise<number | null> {
  const readConfig = async (lock: boolean) =>
    (
      await client.query<{ active_routing_version: number }>(
        `SELECT active_routing_version FROM fulfillment_config WHERE branch_id = $1${lock ? ' FOR UPDATE' : ''}`,
        [branchId],
      )
    ).rows[0];
  // Routing only changes here (under the branch lock) or by local provisioning, so the
  // row lock is taken only when a new version will be written. Lock order is
  // branch_config -> fulfillment_config, the same as the POS order commands.
  const config = await readConfig(false);
  if (!config) return null;
  if (!menu.items.some((item) => item.kitchen)) return config.active_routing_version;
  const stored = (
    await client.query<{ payload: KitchenRouting }>(
      'SELECT payload FROM fulfillment_routing WHERE branch_id = $1 AND version = $2',
      [branchId, config.active_routing_version],
    )
  ).rows[0];
  if (!stored || stored.payload.version !== config.active_routing_version)
    throw new MenuRejection('ROUTING_UNRESOLVED');
  const stations = (
    await client.query<KitchenStation>(
      'SELECT id, kind FROM fulfillment_stations WHERE branch_id = $1 ORDER BY id',
      [branchId],
    )
  ).rows;
  let next: KitchenRouting | null;
  try {
    next = deriveRouting(menu, stored.payload, stations);
  } catch (error) {
    if (error instanceof MenuRoutingError) throw new MenuRejection('ROUTING_UNRESOLVED');
    throw error;
  }
  if (!next) return config.active_routing_version;
  // A concurrent local re-provisioning is transient: retry against the new routing.
  if ((await readConfig(true))?.active_routing_version !== config.active_routing_version)
    throw new SyncError('CONFLICT');
  // payload_hash uses the same canonical JSON as edge-fulfillment digest().
  await client.query(
    'INSERT INTO fulfillment_routing(branch_id, version, payload, payload_hash) VALUES ($1,$2,$3,$4)',
    [branchId, next.version, next, hashJson(next)],
  );
  await client.query(
    'UPDATE fulfillment_config SET active_routing_version = $2 WHERE branch_id = $1',
    [branchId, next.version],
  );
  return next.version;
}

/**
 * Applies one delivered menu publication. In one transaction: stream checks, version, media
 * and routing checks, derived routing activation, snapshot, active menu, inbox, cursor,
 * durable 'menu.applied' ACK and apply result. A deterministic failure (VERSION_NOT_NEWER,
 * MEDIA_UNAVAILABLE, ROUTING_UNRESOLVED, INVALID_MENU) rolls that back and commits a rejected
 * ACK that only advances the cursor. Producer, branch and integrity mismatches still throw.
 */
export async function applyMenu(
  pool: DatabasePool,
  branchId: string,
  input: unknown,
): Promise<MenuAck> {
  const { event, delivered } = deliveredEvent(branchId, input);
  const eventHash = hashJson(event ?? input);
  try {
    return await transaction(pool, async (client) => {
      const replay = await admitDelivery(client, branchId, delivered, eventHash);
      if (replay) return replay;
      if (!event) throw new MenuRejection('INVALID_MENU');
      const { menu, checksum } = event.payload;
      if (new Set(menu.items.map((item) => item.variant_id)).size !== menu.items.length)
        throw new MenuRejection('INVALID_MENU');
      const current = await client.query(
        `SELECT m.version FROM active_menu a JOIN menu_snapshots m ON m.id = a.release_id WHERE a.branch_id = $1`,
        [branchId],
      );
      if (current.rows[0] && current.rows[0].version >= menu.version)
        throw new MenuRejection('VERSION_NOT_NEWER');
      if ((await missingMenuMedia(client, menuImageShas(menu))).length)
        throw new MenuRejection('MEDIA_UNAVAILABLE');
      const routingVersion = await activateRouting(client, branchId, menu);
      await client.query(
        `INSERT INTO menu_snapshots(id, branch_id, version, schema_version, payload, checksum, published_at)
        VALUES ($1,$2,$3,1,$4,$5,$6)`,
        [menu.release_id, branchId, menu.version, canonicalJson(menu), checksum, menu.published_at],
      );
      await client.query(
        `INSERT INTO active_menu(branch_id, release_id) VALUES ($1,$2)
        ON CONFLICT(branch_id) DO UPDATE SET release_id = EXCLUDED.release_id`,
        [branchId, menu.release_id],
      );
      const ack = ackFor(branchId, delivered);
      await recordDelivery(client, branchId, delivered, eventHash, ack, routingVersion);
      return ack;
    });
  } catch (error) {
    if (!(error instanceof MenuRejection)) throw error;
    // The apply transaction rolled back. Commit only the cursor advance and a rejected ACK,
    // so the cloud can deliver later publications while this edge keeps its active menu.
    return transaction(pool, async (client) => {
      const replay = await admitDelivery(client, branchId, delivered, eventHash);
      if (replay) return replay;
      const ack = ackFor(branchId, delivered, error.reason);
      await recordDelivery(client, branchId, delivered, eventHash, ack, null);
      return ack;
    });
  }
}

/** Active menu as reported to the cloud on every pull (version bootstrap). */
export async function readActiveMenuState(
  db: Pick<DatabaseClient | DatabasePool, 'query'>,
  branchId: string,
): Promise<{ release_id: string; version: number } | null> {
  const row = (
    await db.query<{ release_id: string; version: number }>(
      `SELECT s.id AS release_id, s.version FROM active_menu a
      JOIN menu_snapshots s ON s.id = a.release_id AND s.branch_id = a.branch_id
      WHERE a.branch_id = $1`,
      [branchId],
    )
  ).rows[0];
  return row ? { release_id: row.release_id, version: row.version } : null;
}
