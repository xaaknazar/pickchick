import { randomUUID } from 'node:crypto';
import { MenuAckSchema, MenuPublishedSchema } from '@pickchick/contracts';
import type { MenuAck } from '@pickchick/contracts';
import { transaction } from '@pickchick/database';
import type { DatabasePool } from '@pickchick/database';
import { canonicalJson, hashJson, SyncError } from './common.js';

export async function applyMenu(
  pool: DatabasePool,
  branchId: string,
  input: unknown,
): Promise<MenuAck> {
  const parsed = MenuPublishedSchema.safeParse(input);
  if (!parsed.success) throw new SyncError('INVALID_REQUEST');
  const event = parsed.data;
  const { menu, checksum } = event.payload;
  if (
    event.branch_id !== branchId ||
    menu.branch_id !== branchId ||
    event.aggregate_id !== menu.release_id ||
    event.aggregate_version !== menu.version ||
    hashJson(menu) !== checksum ||
    new Set(menu.items.map((item) => item.variant_id)).size !== menu.items.length
  ) {
    throw new SyncError('CONFLICT');
  }
  return transaction(pool, async (client) => {
    // Serializes all menu effects and acknowledgments on this edge.
    const binding = await client.query('SELECT id FROM branch_config WHERE id = $1 FOR UPDATE', [
      branchId,
    ]);
    if (!binding.rowCount) throw new SyncError('CONFLICT');
    const existing = await client.query(
      'SELECT payload_hash, result FROM inbox_messages WHERE producer_id = $1 AND event_id = $2',
      [event.producer_id, event.event_id],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].payload_hash !== hashJson(event)) throw new SyncError('CONFLICT');
      return MenuAckSchema.parse(existing.rows[0].result);
    }
    const state = await client.query(
      'SELECT producer_id, last_sequence FROM menu_sync_state WHERE branch_id = $1',
      [branchId],
    );
    if (state.rows[0] && state.rows[0].producer_id !== event.producer_id)
      throw new SyncError('CONFLICT');
    const sequence = BigInt(state.rows[0]?.last_sequence ?? '0');
    if (BigInt(event.producer_sequence) !== sequence + 1n) throw new SyncError('CONFLICT');
    const current = await client.query(
      `SELECT m.version FROM active_menu a JOIN menu_snapshots m ON m.id = a.release_id WHERE a.branch_id = $1`,
      [branchId],
    );
    if (current.rows[0] && current.rows[0].version >= menu.version) throw new SyncError('CONFLICT');
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
    const ack = MenuAckSchema.parse({
      event_id: event.event_id,
      producer_id: event.producer_id,
      producer_sequence: event.producer_sequence,
      branch_id: branchId,
      release_id: menu.release_id,
      checksum,
    });
    await client.query(
      `INSERT INTO inbox_messages(producer_id, event_id, branch_id, payload_hash, result) VALUES ($1,$2,$3,$4,$5)`,
      [event.producer_id, event.event_id, branchId, hashJson(event), ack],
    );
    const stream = await client.query(
      `INSERT INTO menu_sync_state(branch_id, producer_id, last_sequence) VALUES ($1,$2,$3)
      ON CONFLICT(branch_id) DO UPDATE SET last_sequence = EXCLUDED.last_sequence RETURNING ack_producer_id`,
      [branchId, event.producer_id, event.producer_sequence],
    );
    // Separate menu ACK stream; other domains must allocate their own producer/sequence.
    await client.query(
      `INSERT INTO outbox_events(event_id, producer_id, producer_sequence, branch_id,
      aggregate_type, aggregate_id, aggregate_version, schema_version, event_type, payload, occurred_at, correlation_id, causation_id)
      VALUES ($1,$2,$3,$4,'menu_release',$5,$6,1,'menu.applied',$7,now(),$8,$9)`,
      [
        randomUUID(),
        stream.rows[0].ack_producer_id,
        event.producer_sequence,
        branchId,
        menu.release_id,
        menu.version,
        ack,
        event.correlation_id,
        event.event_id,
      ],
    );
    return ack;
  });
}
