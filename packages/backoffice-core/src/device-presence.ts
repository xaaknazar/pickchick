import { createHash } from 'node:crypto';
import { z } from 'zod';
import { transaction, type DatabasePool } from '@pickchick/database';
import { BackofficeError } from './model.js';
export const PresenceSchema = z.strictObject({
  appVersion: z.string().trim().min(1).max(60),
  state: z.enum(['active', 'background']),
  issue: z.enum(['none', 'connection', 'data', 'login', 'demo']),
  menuVersion: z.number().int().positive().max(2147483647).nullable(),
});
/** Authenticates a device, never creates a guest, order, invoice or financial effect. */
export async function kioskPresence(pool: DatabasePool, id: string, key: string, body: unknown) {
  if (!z.uuid().safeParse(id).success || !/^[a-f0-9]{64}$/.test(key))
    throw new BackofficeError('UNAUTHORIZED');
  const parsed = PresenceSchema.safeParse(body);
  if (!parsed.success) throw new BackofficeError('INVALID_REQUEST');
  return transaction(pool, async (db) => {
    const device = (
      await db.query(
        'SELECT branch_id FROM kiosk_devices WHERE id=$1 AND token_hash=$2 AND active',
        [id, createHash('sha256').update(key).digest('hex')],
      )
    ).rows[0];
    if (!device) throw new BackofficeError('UNAUTHORIZED');
    const p = parsed.data;
    await db.query(
      `INSERT INTO device_presence(branch_id,device_id,source,app_version,state,issue,menu_version)
      VALUES($1,$2,'kiosk',$3,$4,$5,$6) ON CONFLICT(branch_id,device_id,source) DO UPDATE
      SET observed_at=clock_timestamp(),app_version=excluded.app_version,state=excluded.state,
      issue=excluded.issue,menu_version=excluded.menu_version`,
      [device.branch_id, id, p.appVersion, p.state, p.issue, p.menuVersion],
    );
    return { accepted: true };
  });
}
