import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { transaction } from '@pickchick/database';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { CloudKitchenError, parse } from './model.js';
import type { KitchenActor } from './model.js';

/**
 * Kitchen screens of the cloud feed (ADR-0014 S4, cloud 056). Independent of the device
 * registry (051) and of the cashier: a manager (back office) or the owner operator creates a
 * screen and a one-time pairing code; the screen exchanges the code for a long random key that
 * it stores locally. Only hashes are kept. Revocation and re-pairing take effect at once.
 */
export type ScreenRole = 'prep' | 'assembly' | 'display';
export interface ScreenRow {
  id: string;
  branch_id: string;
  role: ScreenRole;
  station_ids: string[];
  name: string;
  generation: number;
  key_issued_at: Date | null;
  created_by: string;
  created_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
  revoked_reason: string | null;
  last_seen_at: Date | null;
}
/** Authenticated screen: the kitchen actor plus its role. Never a manager. */
export interface KitchenScreen {
  screenId: string;
  branchId: string;
  role: ScreenRole;
  generation: number;
  actor: KitchenActor;
}
/** Pairing code lifetime and wrong-secret budget (cloud 056 CHECKs pin the same values). */
export const PAIRING_TTL_SECONDS = 600;
export const PAIRING_MAX_FAILURES = 5;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_PREFIX = 'pcks_';
const KEY = /^pcks_[A-Za-z0-9_-]{43}$/;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const keyHash = (key: string) => sha256('pickchick-kitchen-screen:' + key);
const codeHash = (selector: string, secret: string, salt: string) =>
  sha256(`pickchick-kitchen-pairing:${salt}:${selector}:${secret}`);
const randomText = (length: number) =>
  Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
/** Accepts what a person types: case, spaces, dashes and the usual O/I/L confusions. */
export function normalizePairingCode(input: unknown) {
  if (typeof input !== 'string' || input.length > 40) return null;
  const text = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(text)
    ? { selector: text.slice(0, 4), secret: text.slice(4) }
    : null;
}

const Actor = z.string().trim().min(1).max(200);
const Reason = z.string().trim().min(3).max(500);
export const CreateScreenSchema = z.strictObject({
  branchId: z.uuid(),
  role: z.enum(['prep', 'assembly', 'display']),
  stationIds: z.array(z.uuid()).max(20),
  name: z.string().trim().min(1).max(100),
  actor: Actor,
  reason: Reason,
});
const ScreenRef = z.strictObject({
  branchId: z.uuid(),
  screenId: z.uuid(),
  actor: Actor,
  reason: Reason,
});

export function screenView(row: ScreenRow) {
  return {
    screenId: row.id,
    branchId: row.branch_id,
    role: row.role,
    stationIds: row.station_ids,
    name: row.name,
    generation: row.generation,
    paired: row.key_issued_at !== null,
    keyIssuedAt: row.key_issued_at?.toISOString() ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
    revokedBy: row.revoked_by,
    revokedReason: row.revoked_reason,
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
  };
}
export type ScreenView = ReturnType<typeof screenView>;

async function event(
  db: DatabaseClient,
  screen: Pick<ScreenRow, 'id' | 'branch_id' | 'generation'>,
  action: 'created' | 'code_issued' | 'paired' | 'code_burned' | 'revoked',
  actor: string,
  reason: string | null,
) {
  await db.query(
    'INSERT INTO cloud_kitchen_screen_events(id,screen_id,branch_id,action,actor,reason,generation) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(), screen.id, screen.branch_id, action, actor, reason, screen.generation],
  );
}
async function lockedScreen(db: DatabaseClient, branchId: string, screenId: string) {
  const row = (
    await db.query<ScreenRow>(
      'SELECT * FROM cloud_kitchen_screens WHERE id=$1 AND branch_id=$2 FOR UPDATE',
      [screenId, branchId],
    )
  ).rows[0];
  if (!row) throw new CloudKitchenError('NOT_FOUND');
  return row;
}

/** Create a screen (unpaired). Stations must exist in the branch and match the role. */
export async function createScreenInTransaction(db: DatabaseClient, input: unknown) {
  const p = parse(CreateScreenSchema, input);
  if ((p.role === 'display') !== (p.stationIds.length === 0))
    throw new CloudKitchenError('INVALID');
  const stations = (
    await db.query<{ id: string }>(
      'SELECT id FROM cloud_kitchen_stations WHERE branch_id=$1 AND kind=$2 AND id=ANY($3::uuid[])',
      [p.branchId, p.role, p.stationIds],
    )
  ).rows;
  if (new Set(p.stationIds).size !== p.stationIds.length || stations.length !== p.stationIds.length)
    throw new CloudKitchenError('INVALID');
  const row = (
    await db.query<ScreenRow>(
      `INSERT INTO cloud_kitchen_screens(id,branch_id,role,station_ids,name,created_by,created_reason)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [randomUUID(), p.branchId, p.role, p.stationIds, p.name, p.actor, p.reason],
    )
  ).rows[0]!;
  await event(db, row, 'created', p.actor, p.reason);
  return screenView(row);
}

/**
 * Issue a one-time pairing code for a live screen (first pairing or re-pairing/rotation). An
 * older open code of the same screen is burned. The plain code is returned once and never
 * stored: `XXXX-XXXXXX`, a public selector and a secret.
 */
export async function issuePairingCodeInTransaction(db: DatabaseClient, input: unknown) {
  const p = parse(ScreenRef, input);
  const screen = await lockedScreen(db, p.branchId, p.screenId);
  if (screen.revoked_at) throw new CloudKitchenError('CONFLICT');
  // Expired codes free their selector; the old open code of this screen is replaced.
  await db.query(
    `UPDATE cloud_kitchen_pairing_codes SET burned_at=clock_timestamp()
     WHERE used_at IS NULL AND burned_at IS NULL AND (screen_id=$1 OR expires_at<=clock_timestamp())`,
    [screen.id],
  );
  for (let attempt = 0; attempt < 8; attempt++) {
    const selector = randomText(4),
      secret = randomText(6),
      salt = randomBytes(16).toString('hex');
    const inserted = await db.query<{ expires_at: Date }>(
      `INSERT INTO cloud_kitchen_pairing_codes(id,screen_id,branch_id,selector,salt,code_hash,issued_by,reason,expires_at)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+$9*interval '1 second'
       WHERE NOT EXISTS(SELECT 1 FROM cloud_kitchen_pairing_codes WHERE selector=$4 AND used_at IS NULL AND burned_at IS NULL)
       RETURNING expires_at`,
      [
        randomUUID(),
        screen.id,
        screen.branch_id,
        selector,
        salt,
        codeHash(selector, secret, salt),
        p.actor,
        p.reason,
        PAIRING_TTL_SECONDS,
      ],
    );
    if (inserted.rows[0]) {
      await event(db, screen, 'code_issued', p.actor, p.reason);
      return {
        screen: screenView(screen),
        pairingCode: `${selector}-${secret}`,
        expiresAt: inserted.rows[0].expires_at.toISOString(),
      };
    }
  }
  throw new CloudKitchenError('CONFLICT');
}

/** Revoke a screen: its key stops working at once and an open code is burned. Final. */
export async function revokeScreenInTransaction(db: DatabaseClient, input: unknown) {
  const p = parse(ScreenRef, input);
  const screen = await lockedScreen(db, p.branchId, p.screenId);
  if (screen.revoked_at) return screenView(screen);
  await db.query(
    'UPDATE cloud_kitchen_pairing_codes SET burned_at=clock_timestamp() WHERE screen_id=$1 AND used_at IS NULL AND burned_at IS NULL',
    [screen.id],
  );
  const row = (
    await db.query<ScreenRow>(
      'UPDATE cloud_kitchen_screens SET revoked_at=clock_timestamp(),revoked_by=$2,revoked_reason=$3 WHERE id=$1 RETURNING *',
      [screen.id, p.actor, p.reason],
    )
  ).rows[0]!;
  await event(db, row, 'revoked', p.actor, p.reason);
  return screenView(row);
}

export async function listScreens(db: Pick<DatabaseClient, 'query'>, branchId: string) {
  parse(z.uuid(), branchId);
  const rows = (
    await db.query<ScreenRow & { code_expires_at: Date | null }>(
      `SELECT s.*,(SELECT c.expires_at FROM cloud_kitchen_pairing_codes c WHERE c.screen_id=s.id
         AND c.used_at IS NULL AND c.burned_at IS NULL AND c.expires_at>clock_timestamp()) AS code_expires_at
       FROM cloud_kitchen_screens s WHERE s.branch_id=$1 ORDER BY s.revoked_at IS NOT NULL,s.created_at,s.id`,
      [branchId],
    )
  ).rows;
  return {
    items: rows.map((row) => ({
      ...screenView(row),
      pairingCodeExpiresAt: row.code_expires_at?.toISOString() ?? null,
    })),
  };
}

/**
 * Screen side of the pairing (one call per code). Unknown, expired, used or burned codes and
 * wrong secrets look the same to the caller. A wrong secret for an open selector counts against
 * that code and is committed even though the call fails; the fifth one burns it.
 */
export async function exchangePairingCode(pool: DatabasePool, input: unknown) {
  const code = normalizePairingCode((input as { pairingCode?: unknown } | null)?.pairingCode);
  if (
    !code ||
    !input ||
    typeof input !== 'object' ||
    Object.keys(input).sort().join() !== 'pairingCode'
  )
    throw new CloudKitchenError('FORBIDDEN');
  const outcome = await transaction(pool, async (db) => {
    const row = (
      await db.query<{
        id: string;
        screen_id: string;
        branch_id: string;
        salt: string;
        code_hash: string;
        failed_attempts: number;
        live: boolean;
      }>(
        `SELECT id,screen_id,branch_id,salt,code_hash,failed_attempts,expires_at>clock_timestamp() AS live
         FROM cloud_kitchen_pairing_codes WHERE selector=$1 AND used_at IS NULL AND burned_at IS NULL FOR UPDATE`,
        [code.selector],
      )
    ).rows[0];
    if (!row) return { ok: false as const };
    const screen = await lockedScreen(db, row.branch_id, row.screen_id);
    if (!row.live || screen.revoked_at) {
      await db.query(
        'UPDATE cloud_kitchen_pairing_codes SET burned_at=clock_timestamp() WHERE id=$1',
        [row.id],
      );
      await event(
        db,
        screen,
        'code_burned',
        'pairing',
        row.live ? 'Screen revoked' : 'Code expired',
      );
      return { ok: false as const };
    }
    const expected = Buffer.from(row.code_hash, 'hex'),
      actual = Buffer.from(codeHash(code.selector, code.secret, row.salt), 'hex');
    if (!timingSafeEqual(expected, actual)) {
      const burned = row.failed_attempts + 1 >= PAIRING_MAX_FAILURES;
      await db.query(
        'UPDATE cloud_kitchen_pairing_codes SET failed_attempts=failed_attempts+1,burned_at=CASE WHEN $2 THEN clock_timestamp() END WHERE id=$1',
        [row.id, burned],
      );
      if (burned) await event(db, screen, 'code_burned', 'pairing', 'Too many wrong codes');
      return { ok: false as const };
    }
    const key = KEY_PREFIX + randomBytes(32).toString('base64url');
    await db.query('UPDATE cloud_kitchen_pairing_codes SET used_at=clock_timestamp() WHERE id=$1', [
      row.id,
    ]);
    const paired = (
      await db.query<ScreenRow>(
        `UPDATE cloud_kitchen_screens SET generation=generation+1,key_hash=$2,key_issued_at=clock_timestamp()
         WHERE id=$1 RETURNING *`,
        [screen.id, keyHash(key)],
      )
    ).rows[0]!;
    await event(db, paired, 'paired', 'pairing', null);
    return { ok: true as const, key, screen: paired };
  });
  if (!outcome.ok) throw new CloudKitchenError('FORBIDDEN');
  const view = screenView(outcome.screen);
  return {
    screenKey: outcome.key,
    screen: {
      screenId: view.screenId,
      branchId: view.branchId,
      role: view.role,
      stationIds: view.stationIds,
      name: view.name,
      generation: view.generation,
    },
  };
}

/**
 * Resolve a screen key. With `heartbeat` (a feed poll of a prep/assembly screen) the same
 * statement records the poll for each of the screen's stations: the input of the
 * KITCHEN_OFFLINE gate. Revoked, replaced and unknown keys are refused alike.
 */
export async function authenticateScreen(
  pool: Pick<DatabasePool, 'query'>,
  key: unknown,
  options: { heartbeat?: boolean } = {},
): Promise<KitchenScreen> {
  if (typeof key !== 'string' || !KEY.test(key)) throw new CloudKitchenError('FORBIDDEN');
  const row = (
    await pool.query<Pick<ScreenRow, 'id' | 'branch_id' | 'role' | 'station_ids' | 'generation'>>(
      options.heartbeat
        ? `WITH s AS (UPDATE cloud_kitchen_screens SET last_seen_at=greatest(clock_timestamp(),coalesce(last_seen_at,clock_timestamp()))
             WHERE key_hash=$1 AND revoked_at IS NULL RETURNING id,branch_id,role,station_ids,generation),
           p AS (INSERT INTO cloud_kitchen_station_presence(branch_id,device_id,station_id)
             SELECT s.branch_id,s.id,x FROM s CROSS JOIN LATERAL unnest(s.station_ids) x WHERE s.role<>'display'
             ON CONFLICT(branch_id,device_id,station_id) DO UPDATE SET seen_at=clock_timestamp())
           SELECT * FROM s`
        : 'SELECT id,branch_id,role,station_ids,generation FROM cloud_kitchen_screens WHERE key_hash=$1 AND revoked_at IS NULL',
      [keyHash(key)],
    )
  ).rows[0];
  if (!row) throw new CloudKitchenError('FORBIDDEN');
  return {
    screenId: row.id,
    branchId: row.branch_id,
    role: row.role,
    generation: row.generation,
    actor: {
      branchId: row.branch_id,
      deviceId: row.id,
      stationIds: row.station_ids,
      manager: false,
    },
  };
}

/** Owner/manager port over one pool; each write is one transaction. */
export class KitchenScreens {
  constructor(private readonly pool: DatabasePool) {}
  create(input: unknown) {
    return transaction(this.pool, (db) => createScreenInTransaction(db, input));
  }
  issuePairingCode(input: unknown) {
    return transaction(this.pool, (db) => issuePairingCodeInTransaction(db, input));
  }
  revoke(input: unknown) {
    return transaction(this.pool, (db) => revokeScreenInTransaction(db, input));
  }
  list(branchId: string) {
    return listScreens(this.pool, branchId);
  }
  exchange(input: unknown) {
    return exchangePairingCode(this.pool, input);
  }
  authenticate(key: unknown, options: { heartbeat?: boolean } = {}) {
    return authenticateScreen(this.pool, key, options);
  }
}
