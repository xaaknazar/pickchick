import { EdgeCloudLinkSchema } from '@pickchick/contracts';
import type { EdgeCloudLink } from '@pickchick/contracts';
import type { DatabasePool } from '@pickchick/database';
import { transaction } from '@pickchick/database';
import { authenticateStaff } from './staff.js';
import type { StaffAuth } from './staff.js';

/** Same window in which the cloud trusts the cashier heartbeat for kiosk/mobile sales. */
export const CLOUD_LINK_FRESH_SECONDS = 30;

/**
 * The cashier's own view of the internet link (offline stand finding, stage 2): the fulfillment
 * worker records `last_success_at` after every answered cloud pull. Online while that is younger
 * than the window; offline once the worker has a row but no recent answer. 'unknown' when no
 * transport has run here yet, on an older schema, or when the runtime role was not given the
 * opt-in column grant (edge-runtime-grants cloudLink); the POS then shows nothing new.
 * Any signed-in staff may read it; nothing else is revealed.
 */
export async function readCloudLink(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
): Promise<EdgeCloudLink> {
  const checkedAt = await transaction(pool, async (client) => {
    await authenticateStaff(client, branchId, auth);
    return (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
  });
  const unknown = EdgeCloudLinkSchema.parse({
    state: 'unknown',
    last_contact_at: null,
    checked_at: checkedAt.toISOString(),
  });
  let row: { last_success_at: Date | null; fresh: boolean; now: Date } | undefined;
  try {
    row = (
      await pool.query<{ last_success_at: Date | null; fresh: boolean; now: Date }>(
        `SELECT last_success_at, clock_timestamp() AS now,
        coalesce(last_success_at > clock_timestamp() - make_interval(secs => $2), false) AS fresh
        FROM fulfillment_transport_state WHERE branch_id = $1`,
        [branchId, CLOUD_LINK_FRESH_SECONDS],
      )
    ).rows[0];
  } catch (error) {
    // 42501: no column grant for this runtime role; 42P01: schema without the transport.
    const code = (error as { code?: unknown } | null)?.code;
    if (code === '42501' || code === '42P01') return unknown;
    throw error;
  }
  if (!row) return unknown;
  return EdgeCloudLinkSchema.parse({
    state: row.fresh ? 'online' : 'offline',
    last_contact_at: row.last_success_at ? row.last_success_at.toISOString() : null,
    checked_at: row.now.toISOString(),
  });
}
