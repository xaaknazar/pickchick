import { randomBytes, randomUUID } from 'node:crypto';
import { DeviceIdentitySchema, UuidSchema } from '@pickchick/contracts';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { transaction } from '@pickchick/database';
import { hashToken, SyncError } from './common.js';

// Trusted local operator API, intentionally not exposed over HTTP.
export async function provisionDevice(pool: DatabasePool, deviceId: string, rotate = false) {
  if (!UuidSchema.safeParse(deviceId).success) throw new SyncError('INVALID_REQUEST');
  return transaction(pool, async (client) => {
    const { rows } = await client.query<{ branch_id: string; status: string; kind: string }>(
      'SELECT branch_id, status, kind FROM devices WHERE id = $1 FOR UPDATE',
      [deviceId],
    );
    const device = rows[0];
    if (!device) throw new SyncError('NOT_FOUND');
    if (
      device.kind !== 'edge' ||
      device.status === 'revoked' ||
      (device.status === 'active' && !rotate) ||
      (device.status === 'pending' && rotate)
    ) {
      throw new SyncError('CONFLICT');
    }
    const token = randomBytes(32).toString('hex');
    const result = await client.query<{ expires_at: Date }>(
      `INSERT INTO device_credentials(device_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '30 days') ON CONFLICT (device_id)
       DO UPDATE SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at, issued_at = now()
       RETURNING expires_at`,
      [deviceId, hashToken(token)],
    );
    await client.query("UPDATE devices SET status = 'active' WHERE id = $1", [deviceId]);
    await client.query(
      'INSERT INTO device_audit(id, device_id, action, actor) VALUES ($1, $2, $3, $4)',
      [randomUUID(), deviceId, rotate ? 'rotated' : 'provisioned', 'local_setup'],
    );
    return DeviceIdentitySchema.parse({
      device_id: deviceId,
      branch_id: device.branch_id,
      token,
      expires_at: result.rows[0]!.expires_at.toISOString(),
    });
  });
}

export async function revokeDevice(pool: DatabasePool, deviceId: string): Promise<void> {
  if (!UuidSchema.safeParse(deviceId).success) throw new SyncError('INVALID_REQUEST');
  await transaction(pool, async (client) => {
    const result = await client.query(
      "UPDATE devices SET status = 'revoked' WHERE id = $1 AND status <> 'revoked' RETURNING id",
      [deviceId],
    );
    if (result.rowCount)
      await client.query(
        "INSERT INTO device_audit(id, device_id, action, actor) VALUES ($1, $2, 'revoked', 'local_setup')",
        [randomUUID(), deviceId],
      );
  });
}

export interface DeviceAuth {
  deviceId: string;
  token: string;
}
export async function authenticateDevice(
  client: DatabaseClient,
  auth: DeviceAuth,
): Promise<string> {
  if (!UuidSchema.safeParse(auth.deviceId).success || !/^[a-f0-9]{64}$/.test(auth.token)) {
    throw new SyncError('UNAUTHORIZED');
  }
  // Shared locks serialize revocation/rotation against the entire pull/ack transaction.
  const result = await client.query<{ branch_id: string }>(
    `SELECT d.branch_id FROM devices d JOIN device_credentials c ON c.device_id = d.id
     WHERE d.id = $1 AND c.token_hash = $2 AND c.expires_at > clock_timestamp()
       AND d.status = 'active' AND d.kind = 'edge' FOR SHARE OF d, c`,
    [auth.deviceId, hashToken(auth.token)],
  );
  if (!result.rows[0]) throw new SyncError('UNAUTHORIZED');
  return result.rows[0].branch_id;
}
