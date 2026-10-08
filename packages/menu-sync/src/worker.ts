import {
  AckReceiptSchema,
  DeviceIdentitySchema,
  MenuAckSchema,
  MenuPublishedSchema,
  MenuPullSchema,
  menuAckResult,
} from '@pickchick/contracts';
import type { DeviceIdentity, MenuRejectReason } from '@pickchick/contracts';
import type { DatabasePool } from '@pickchick/database';
import { applyMenu, readActiveMenuState } from './edge.js';
import { SyncError } from './common.js';
import { deviceRequest, localCloudOrigin } from './device-http.js';
import { fetchMenuMedia, menuImageShas, missingMenuMedia } from './media.js';

export { localCloudOrigin } from './device-http.js';

/** Download attempts for a publication's photos before it is rejected as MEDIA_UNAVAILABLE. */
export const MENU_MEDIA_ATTEMPTS = 3;

export interface SyncMenuOptions {
  /**
   * Failed photo downloads per menu event, kept across calls by the long-running worker.
   * Defaults to one map per process. A restart only grants a fresh set of attempts.
   */
  mediaAttempts?: Map<string, number>;
  /**
   * false: report the active menu and drain durable ACKs, but hold a delivered publication
   * without downloading photos or applying it (operator 'report' mode). Defaults to true.
   */
  applyEvents?: boolean;
}
const processMediaAttempts = new Map<string, number>();

// Bounded JSON reads; redirects are forbidden so a token cannot be forwarded elsewhere.
async function requestJson(origin: string, path: string, identity: DeviceIdentity, body?: unknown) {
  const bytes = await deviceRequest(origin, path, identity, { body, maxBytes: 3_000_000 });
  return JSON.parse(bytes.toString('utf8')) as unknown;
}

/** A pulled event the edge cannot parse is still handed to applyMenu to be ACKed INVALID_MENU. */
function pulledEvent(body: unknown): unknown {
  const parsed = MenuPullSchema.safeParse(body);
  if (parsed.success) return parsed.data.event;
  if (
    body === null ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).join(',') !== 'event'
  )
    throw new SyncError('INVALID_REQUEST');
  return (body as { event: unknown }).event;
}

export type SyncMenuResult =
  | { state: 'idle' | 'acknowledged' | 'applied' }
  | { state: 'rejected'; reason: MenuRejectReason }
  | { state: 'held'; release_id: string | null; version: number | null };

export async function syncMenuOnce(
  pool: DatabasePool,
  branchId: string,
  originInput: string,
  identityInput: unknown,
  options: SyncMenuOptions = {},
): Promise<SyncMenuResult> {
  const origin = localCloudOrigin(originInput);
  const identity = DeviceIdentitySchema.parse(identityInput);
  if (identity.branch_id !== branchId) throw new SyncError('CONFLICT');
  const attempts = options.mediaAttempts ?? processMediaAttempts;
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
  if (await sendPendingAck()) return { state: 'acknowledged' };
  // Report the active menu so the cloud publishes a strictly newer version (bootstrap).
  const active = await readActiveMenuState(pool, branchId);
  const query = active
    ? `?${new URLSearchParams({
        active_release_id: active.release_id,
        active_version: String(active.version),
      })}`
    : '';
  const event = pulledEvent(
    await requestJson(origin, `/internal/v1/edge/sync/pull${query}`, identity),
  );
  if (event === null) return { state: 'idle' };
  const published = MenuPublishedSchema.safeParse(event);
  if (options.applyEvents === false)
    return {
      state: 'held',
      release_id: published.success ? published.data.aggregate_id : null,
      version: published.success ? published.data.aggregate_version : null,
    };
  if (published.success) {
    const missing = await missingMenuMedia(pool, menuImageShas(published.data.payload.menu));
    const key = published.data.event_id;
    if (missing.length) {
      try {
        await fetchMenuMedia(pool, origin, identity, missing);
        attempts.delete(key);
      } catch (error) {
        const failures = (attempts.get(key) ?? 0) + 1;
        if (failures < MENU_MEDIA_ATTEMPTS) {
          if (attempts.size >= 100) attempts.clear();
          attempts.set(key, failures);
          throw error;
        }
        // Exhausted: applyMenu now records a rejected MEDIA_UNAVAILABLE ACK.
        attempts.delete(key);
      }
    }
  }
  const ack = await applyMenu(pool, branchId, event);
  await sendPendingAck();
  return menuAckResult(ack) === 'rejected' && ack.reason
    ? { state: 'rejected', reason: ack.reason }
    : { state: 'applied' };
}
