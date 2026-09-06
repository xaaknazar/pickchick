import {
  AckReceiptSchema,
  DeviceIdentitySchema,
  MenuAckSchema,
  MenuPullSchema,
} from '@pickchick/contracts';
import type { DeviceIdentity } from '@pickchick/contracts';
import type { DatabasePool } from '@pickchick/database';
import { applyMenu } from './edge.js';
import { SyncError } from './common.js';

export function localCloudOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SyncError('INVALID_REQUEST');
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new SyncError('INVALID_REQUEST');
  return url.origin;
}

// Bounded JSON reads; redirects are forbidden so a token cannot be forwarded elsewhere.
async function requestJson(origin: string, path: string, identity: DeviceIdentity, body?: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: {
      Authorization: `Bearer ${identity.token}`,
      'X-Device-Id': identity.device_id,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Sync HTTP ${response.status}`);
  }
  if (!response.body) throw new Error('Empty sync response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 3_000_000) throw new Error('Sync response too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export async function syncMenuOnce(
  pool: DatabasePool,
  branchId: string,
  originInput: string,
  identityInput: unknown,
) {
  const origin = localCloudOrigin(originInput);
  const identity = DeviceIdentitySchema.parse(identityInput);
  if (identity.branch_id !== branchId) throw new SyncError('CONFLICT');
  // Drain durable ACK before pulling another event. Retries after lost responses are safe.
  async function sendPendingAck() {
    const pending = await pool.query(
      `SELECT event_id, payload FROM outbox_events WHERE branch_id = $1
      AND event_type = 'menu.applied' AND acknowledged_at IS NULL ORDER BY producer_sequence LIMIT 1`,
      [branchId],
    );
    const row = pending.rows[0];
    if (!row) return false;
    const ack = MenuAckSchema.parse(row.payload);
    await pool.query('UPDATE outbox_events SET attempts = attempts + 1 WHERE event_id = $1', [
      row.event_id,
    ]);
    const result = AckReceiptSchema.parse(
      await requestJson(origin, '/internal/v1/edge/sync/ack', identity, ack),
    );
    if (result.event_id !== ack.event_id) throw new SyncError('CONFLICT');
    await pool.query('UPDATE outbox_events SET acknowledged_at = now() WHERE event_id = $1', [
      row.event_id,
    ]);
    return true;
  }
  if (await sendPendingAck()) return { state: 'acknowledged' as const };
  const response = MenuPullSchema.parse(
    await requestJson(origin, '/internal/v1/edge/sync/pull', identity),
  );
  if (!response.event) return { state: 'idle' as const };
  await applyMenu(pool, branchId, response.event);
  await sendPendingAck();
  return { state: 'applied' as const };
}
