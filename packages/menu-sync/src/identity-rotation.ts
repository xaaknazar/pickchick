import { createHmac, randomBytes } from 'node:crypto';
import { DeviceIdentitySchema, UuidSchema } from '@pickchick/contracts';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { transaction } from '@pickchick/database';
import { hashToken, SyncError } from './common.js';
import type { DeviceAuth } from './identity.js';

/** Same lifetime as manual provisioning (identity.ts). */
export const EDGE_IDENTITY_TTL_SECONDS = 30 * 24 * 3600;
/** A device may renew only when less than this is left on its current credential. */
export const EDGE_IDENTITY_RENEWAL_WINDOW_SECONDS = 10 * 24 * 3600;
/**
 * Once the device confirms the new credential, the replaced one stays valid this much longer
 * (never past its own expiry), so every edge process can reload the file. Until confirmation it
 * stays valid up to its own expiry: a rotation whose response was lost can always be replayed,
 * so renewal can never leave a device worse off than not renewing.
 */
export const EDGE_IDENTITY_OVERLAP_SECONDS = 24 * 3600;

export interface RotatedDeviceIdentity {
  device_id: string;
  branch_id: string;
  token: string;
  expires_at: string;
  rotation_id: string;
  previous_valid_until: string;
  replayed: boolean;
}

export interface ConfirmedDeviceIdentity {
  device_id: string;
  rotation_id: string;
  expires_at: string;
  confirmed_at: string;
  /** End of the replaced credential's overlap, null if manual provisioning already ended it. */
  previous_valid_until: string | null;
}

interface CredentialRow {
  branch_id: string;
  status: string;
  kind: string;
  token_hash: string;
  expires_at: Date;
  previous_token_hash: string | null;
  previous_expires_at: Date | null;
  now: Date;
}

interface RotationRow {
  device_id: string;
  from_token_hash: string;
  to_token_hash: string;
  derivation_salt: string;
  overlap_until: Date;
  expires_at: Date;
  confirmed_at: Date | null;
}

function rotationId(body: unknown): string {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !UuidSchema.safeParse((body as { rotation_id?: unknown }).rotation_id).success
  )
    throw new SyncError('INVALID_REQUEST');
  return (body as { rotation_id: string }).rotation_id;
}

function presentedHash(auth: DeviceAuth): string {
  if (!UuidSchema.safeParse(auth.deviceId).success || !/^[a-f0-9]{64}$/.test(auth.token))
    throw new SyncError('UNAUTHORIZED');
  return hashToken(auth.token);
}

/**
 * The new secret is an HMAC of the old secret, so only a holder of the old token (and the cloud,
 * which receives it in the request) can recompute it for an idempotent replay. The random salt
 * stays in the cloud database; neither the salt nor the stored hashes alone reveal a token.
 */
function deriveToken(oldToken: string, id: string, salt: string): string {
  return createHmac('sha256', Buffer.from(oldToken, 'hex'))
    .update(`pickchick/edge-identity-rotation/v1\0${id}\0${salt}`)
    .digest('hex');
}

/**
 * Locks the credential row (FOR UPDATE: rotation is serialized against itself and against
 * authenticateDevice's FOR SHARE) and the device row (FOR SHARE: revocation waits for us, or we
 * observe it). Returns which of the two credentials the caller presented, if any is valid.
 */
async function lockCredential(client: DatabaseClient, deviceId: string, hash: string) {
  const row = (
    await client.query<CredentialRow>(
      `SELECT d.branch_id, d.status, d.kind, c.token_hash, c.expires_at, c.previous_token_hash,
         c.previous_expires_at, clock_timestamp() AS now
       FROM devices d JOIN device_credentials c ON c.device_id = d.id
       WHERE d.id = $1 FOR UPDATE OF c FOR SHARE OF d`,
      [deviceId],
    )
  ).rows[0];
  if (!row || row.status !== 'active' || row.kind !== 'edge') throw new SyncError('UNAUTHORIZED');
  const now = row.now.getTime();
  const presented =
    row.token_hash === hash && row.expires_at.getTime() > now
      ? ('current' as const)
      : row.previous_token_hash === hash && (row.previous_expires_at?.getTime() ?? 0) > now
        ? ('previous' as const)
        : null;
  if (!presented) throw new SyncError('UNAUTHORIZED');
  return { row, presented };
}

const isUniqueViolation = (error: unknown) =>
  !!error && typeof error === 'object' && (error as { code?: unknown }).code === '23505';

/**
 * Device-initiated renewal (POST /internal/v1/edge/identity/rotate, cloud flag
 * CLOUD_EDGE_IDENTITY_ROTATION_ENABLED). Only a valid, unrevoked current credential inside the
 * renewal window is rotated; it never extends an expired or revoked one. The replaced credential
 * keeps its own expiry until confirmation, then EDGE_IDENTITY_OVERLAP_SECONDS at most. Replaying
 * the same rotation_id with the old token (lost response) returns the same new token until the
 * device confirms it.
 */
export async function rotateDeviceIdentity(
  pool: DatabasePool,
  auth: DeviceAuth,
  body: unknown,
): Promise<RotatedDeviceIdentity> {
  const id = rotationId(body);
  const hash = presentedHash(auth);
  try {
    return await transaction(pool, async (client) => {
      const { row, presented } = await lockCredential(client, auth.deviceId, hash);
      const existing = (
        await client.query<RotationRow>(
          `SELECT device_id, from_token_hash, to_token_hash, derivation_salt, overlap_until,
             expires_at, confirmed_at FROM device_identity_rotations WHERE rotation_id = $1`,
          [id],
        )
      ).rows[0];
      const result = (token: string, expiresAt: Date, overlapUntil: Date, replayed: boolean) => ({
        ...DeviceIdentitySchema.parse({
          device_id: auth.deviceId,
          branch_id: row.branch_id,
          token,
          expires_at: expiresAt.toISOString(),
        }),
        rotation_id: id,
        previous_valid_until: overlapUntil.toISOString(),
        replayed,
      });
      if (existing) {
        if (existing.device_id !== auth.deviceId) throw new SyncError('CONFLICT');
        // The device already holds the new credential: answering is idempotent and reveals
        // nothing it did not present.
        if (presented === 'current' && existing.to_token_hash === hash)
          return result(auth.token, row.expires_at, existing.overlap_until, true);
        if (
          presented !== 'previous' ||
          existing.from_token_hash !== hash ||
          existing.to_token_hash !== row.token_hash ||
          existing.confirmed_at !== null
        )
          throw new SyncError('CONFLICT');
        const token = deriveToken(auth.token, id, existing.derivation_salt);
        if (hashToken(token) !== existing.to_token_hash) throw new SyncError('CONFLICT');
        await client.query(
          'UPDATE device_identity_rotations SET replay_count = replay_count + 1 WHERE rotation_id = $1',
          [id],
        );
        return result(token, row.expires_at, existing.overlap_until, true);
      }
      // A superseded credential may only finish its own rotation, never start another.
      if (presented !== 'current') throw new SyncError('CONFLICT');
      const now = row.now.getTime();
      if (row.expires_at.getTime() - now >= EDGE_IDENTITY_RENEWAL_WINDOW_SECONDS * 1000)
        throw new SyncError('CONFLICT');
      const salt = randomBytes(32).toString('hex');
      const token = deriveToken(auth.token, id, salt);
      const expiresAt = new Date(now + EDGE_IDENTITY_TTL_SECONDS * 1000);
      // Unconfirmed: the old credential is never cut short (see EDGE_IDENTITY_OVERLAP_SECONDS).
      const overlapUntil = row.expires_at;
      await client.query(
        `INSERT INTO device_identity_rotations(rotation_id, device_id, from_token_hash, to_token_hash,
           derivation_salt, from_expires_at, overlap_until, expires_at, actor, rotated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'device', $9)`,
        [
          id,
          auth.deviceId,
          hash,
          hashToken(token),
          salt,
          row.expires_at,
          overlapUntil,
          expiresAt,
          row.now,
        ],
      );
      const updated = await client.query(
        `UPDATE device_credentials SET previous_token_hash = token_hash, previous_expires_at = $3,
           token_hash = $4, expires_at = $5, issued_at = $6
         WHERE device_id = $1 AND token_hash = $2`,
        [auth.deviceId, hash, overlapUntil, hashToken(token), expiresAt, row.now],
      );
      if (updated.rowCount !== 1) throw new SyncError('CONFLICT');
      return result(token, expiresAt, overlapUntil, false);
    });
  } catch (error) {
    // A concurrent request that slipped past the row lock (or a rotation_id reused elsewhere)
    // hits the ledger's unique keys; nothing was committed for it.
    if (isUniqueViolation(error)) throw new SyncError('CONFLICT');
    throw error;
  }
}

/**
 * POST /internal/v1/edge/identity/confirm, authenticated with the NEW credential. Marks the
 * rotation as received; from then on the old credential can no longer replay it and expires at
 * most EDGE_IDENTITY_OVERLAP_SECONDS after the first confirmation. Idempotent.
 */
export async function confirmDeviceIdentity(
  pool: DatabasePool,
  auth: DeviceAuth,
  body: unknown,
): Promise<ConfirmedDeviceIdentity> {
  const id = rotationId(body);
  const hash = presentedHash(auth);
  return transaction(pool, async (client) => {
    const { row, presented } = await lockCredential(client, auth.deviceId, hash);
    if (presented !== 'current') throw new SyncError('CONFLICT');
    const confirmed = (
      await client.query<{ confirmed_at: Date; from_token_hash: string }>(
        `UPDATE device_identity_rotations SET confirmed_at = COALESCE(confirmed_at, $3)
         WHERE rotation_id = $1 AND device_id = $2 AND to_token_hash = $4
         RETURNING confirmed_at, from_token_hash`,
        [id, auth.deviceId, row.now, hash],
      )
    ).rows[0];
    // 409, never 404: a 404 must mean only "rotation unavailable" (flag off or an older API),
    // which the edge answers by keeping its pending rotation instead of discarding the key.
    if (!confirmed) throw new SyncError('CONFLICT');
    // Anchored at the first confirmation, so a repeated confirm never extends the overlap.
    const previous = (
      await client.query<{ previous_expires_at: Date }>(
        `UPDATE device_credentials SET previous_expires_at = LEAST(previous_expires_at,
           $3::timestamptz + $4::int * interval '1 second')
         WHERE device_id = $1 AND previous_token_hash = $2 RETURNING previous_expires_at`,
        [
          auth.deviceId,
          confirmed.from_token_hash,
          confirmed.confirmed_at,
          EDGE_IDENTITY_OVERLAP_SECONDS,
        ],
      )
    ).rows[0];
    return {
      device_id: auth.deviceId,
      rotation_id: id,
      expires_at: row.expires_at.toISOString(),
      confirmed_at: confirmed.confirmed_at.toISOString(),
      previous_valid_until: previous ? previous.previous_expires_at.toISOString() : null,
    };
  });
}
