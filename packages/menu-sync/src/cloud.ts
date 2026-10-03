import { randomUUID } from 'node:crypto';
import { MenuAckSchema, MenuPublishedSchema, MenuSnapshotSchema } from '@pickchick/contracts';
import type { MenuPublished } from '@pickchick/contracts';
import { transaction } from '@pickchick/database';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { authenticateDevice } from './identity.js';
import type { DeviceAuth } from './identity.js';
import { canonicalJson, hashJson, SyncError } from './common.js';

const eventColumns = `event_id, producer_id, producer_sequence, branch_id, aggregate_type,
  aggregate_id, aggregate_version, schema_version, event_type, payload, occurred_at, correlation_id, causation_id`;

async function readEvent(client: DatabaseClient, eventId: string): Promise<MenuPublished> {
  const result = await client.query(
    `SELECT ${eventColumns} FROM outbox_events WHERE event_id = $1`,
    [eventId],
  );
  const row = result.rows[0];
  if (!row) throw new SyncError('NOT_FOUND');
  return MenuPublishedSchema.parse({
    ...row,
    aggregate_version: Number(row.aggregate_version),
    occurred_at: row.occurred_at.toISOString(),
  });
}

// Local operator command; release UUID is the idempotency key. Publication is never activation.
export async function publishMenu(pool: DatabasePool, input: unknown): Promise<MenuPublished> {
  const parsed = MenuSnapshotSchema.safeParse(input);
  if (!parsed.success) throw new SyncError('INVALID_REQUEST');
  const menu = parsed.data;
  if (
    Buffer.byteLength(canonicalJson(menu)) > 2_000_000 ||
    new Set(menu.items.map((item) => item.variant_id)).size !== menu.items.length
  ) {
    throw new SyncError('INVALID_REQUEST');
  }
  return transaction(pool, (client) => publishMenuInTransaction(client, menu));
}

/** Caller must hold a transaction; publication and CMS source commit atomically. */
export async function publishMenuInTransaction(
  client: DatabaseClient,
  input: unknown,
): Promise<MenuPublished> {
  const parsed = MenuSnapshotSchema.safeParse(input);
  if (!parsed.success) throw new SyncError('INVALID_REQUEST');
  const menu = parsed.data;
  if (
    Buffer.byteLength(canonicalJson(menu)) > 2_000_000 ||
    new Set(menu.items.map((item) => item.variant_id)).size !== menu.items.length
  )
    throw new SyncError('INVALID_REQUEST');

  const branch = await client.query('SELECT id FROM branches WHERE id = $1 FOR UPDATE', [
    menu.branch_id,
  ]);
  if (!branch.rowCount) throw new SyncError('NOT_FOUND');
  const existing = await client.query('SELECT payload FROM menu_releases WHERE id = $1', [
    menu.release_id,
  ]);
  if (existing.rowCount) {
    if (hashJson(existing.rows[0].payload) !== hashJson(menu)) throw new SyncError('CONFLICT');
    const event = await client.query(
      "SELECT event_id FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'menu.published'",
      [menu.release_id],
    );
    if (!event.rows[0]) throw new SyncError('CONFLICT'); // Legacy seed is not a publication command.
    return readEvent(client, event.rows[0].event_id);
  }
  const latest = await client.query(
    'SELECT coalesce(max(version), 0) AS version FROM menu_releases WHERE branch_id = $1',
    [menu.branch_id],
  );
  if (menu.version !== latest.rows[0].version + 1) throw new SyncError('CONFLICT');
  const checksum = hashJson(menu);
  await client.query(
    `INSERT INTO menu_releases(id, branch_id, version, schema_version, payload, checksum, published_at)
      VALUES ($1, $2, $3, 1, $4, $5, $6)`,
    [
      menu.release_id,
      menu.branch_id,
      menu.version,
      canonicalJson(menu),
      checksum,
      menu.published_at,
    ],
  );
  await client.query(
    'INSERT INTO menu_streams(branch_id, producer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [menu.branch_id, randomUUID()],
  );
  const stream = await client.query(
    'UPDATE menu_streams SET last_sequence = last_sequence + 1 WHERE branch_id = $1 RETURNING producer_id, last_sequence',
    [menu.branch_id],
  );
  const event = MenuPublishedSchema.parse({
    event_id: randomUUID(),
    producer_id: stream.rows[0].producer_id,
    producer_sequence: stream.rows[0].last_sequence,
    branch_id: menu.branch_id,
    aggregate_type: 'menu_release',
    aggregate_id: menu.release_id,
    aggregate_version: menu.version,
    schema_version: 1,
    event_type: 'menu.published',
    payload: { menu, checksum },
    occurred_at: new Date().toISOString(),
    correlation_id: randomUUID(),
    causation_id: null,
  });
  await client.query(
    `INSERT INTO outbox_events(${eventColumns}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      event.event_id,
      event.producer_id,
      event.producer_sequence,
      event.branch_id,
      event.aggregate_type,
      event.aggregate_id,
      event.aggregate_version,
      event.schema_version,
      event.event_type,
      event.payload,
      event.occurred_at,
      event.correlation_id,
      event.causation_id,
    ],
  );
  return event;
}

export async function pullMenu(pool: DatabasePool, auth: DeviceAuth) {
  return transaction(pool, async (client) => {
    const branchId = await authenticateDevice(client, auth);
    // No caller-controlled cursor: the earliest unacknowledged event is always redelivered.
    const result = await client.query(
      `SELECT event_id FROM outbox_events
      WHERE branch_id = $1 AND event_type = 'menu.published' AND acknowledged_at IS NULL
      ORDER BY producer_sequence LIMIT 1 FOR UPDATE`,
      [branchId],
    );
    if (!result.rows[0]) return { event: null };
    const eventId = result.rows[0].event_id;
    await client.query('UPDATE outbox_events SET attempts = attempts + 1 WHERE event_id = $1', [
      eventId,
    ]);
    return { event: await readEvent(client, eventId) };
  });
}

export async function acknowledgeMenu(pool: DatabasePool, auth: DeviceAuth, input: unknown) {
  const parsed = MenuAckSchema.safeParse(input);
  if (!parsed.success) throw new SyncError('INVALID_REQUEST');
  const ack = parsed.data;
  return transaction(pool, async (client) => {
    const branchId = await authenticateDevice(client, auth);
    if (ack.branch_id !== branchId) throw new SyncError('NOT_FOUND');
    await client.query('SELECT id FROM branches WHERE id = $1 FOR UPDATE', [branchId]);
    const row = await client.query(
      `SELECT event_id, acknowledged_at FROM outbox_events
      WHERE event_id = $1 AND branch_id = $2 AND event_type = 'menu.published' FOR UPDATE`,
      [ack.event_id, branchId],
    );
    if (!row.rows[0]) throw new SyncError('NOT_FOUND');
    const event = await readEvent(client, ack.event_id);
    if (
      ack.producer_id !== event.producer_id ||
      ack.producer_sequence !== event.producer_sequence ||
      ack.release_id !== event.aggregate_id ||
      ack.checksum !== event.payload.checksum
    )
      throw new SyncError('CONFLICT');
    const previous = await client.query(
      'SELECT payload_hash FROM inbox_messages WHERE producer_id = $1 AND event_id = $2',
      [auth.deviceId, ack.event_id],
    );
    const result = { event_id: ack.event_id, acknowledged: true as const };
    if (previous.rows[0]) {
      if (previous.rows[0].payload_hash !== hashJson(ack)) throw new SyncError('CONFLICT');
      return result;
    }
    // Replacing an edge requires its own snapshot/fencing protocol, not a forged old ACK.
    if (row.rows[0].acknowledged_at) throw new SyncError('CONFLICT');
    const first = await client.query(
      `SELECT event_id FROM outbox_events WHERE branch_id = $1
      AND event_type = 'menu.published' AND acknowledged_at IS NULL ORDER BY producer_sequence LIMIT 1`,
      [branchId],
    );
    if (first.rows[0]?.event_id !== ack.event_id) throw new SyncError('CONFLICT');
    await client.query(
      `INSERT INTO branch_menu_activations(branch_id, release_id, acknowledged_at)
      VALUES ($1, $2, now()) ON CONFLICT (branch_id) DO UPDATE
      SET release_id = EXCLUDED.release_id, acknowledged_at = EXCLUDED.acknowledged_at
      WHERE (SELECT version FROM menu_releases WHERE id = branch_menu_activations.release_id) < $3`,
      [branchId, ack.release_id, event.aggregate_version],
    );
    await client.query('UPDATE outbox_events SET acknowledged_at = now() WHERE event_id = $1', [
      ack.event_id,
    ]);
    await client.query(
      `INSERT INTO inbox_messages(producer_id, event_id, branch_id, payload_hash, result)
      VALUES ($1,$2,$3,$4,$5)`,
      [auth.deviceId, ack.event_id, branchId, hashJson(ack), result],
    );
    return result;
  });
}
