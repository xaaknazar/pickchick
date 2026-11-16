import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseClient } from '@pickchick/database';
import { createKioskEnrollmentMaterial, readKioskBranchSetting } from '@pickchick/commerce-core';
import { BackofficeError, parse } from './model.js';

/**
 * «Подключить киоск» (owner request 16.11.2026). A branch manager issues the same pair the
 * offline procedure creates (scripts/provision-kiosk.mjs + provision-kiosk-enrollment.mjs): a new
 * kiosk_devices row with a random device key, and a short-lived enrollment alias holding the
 * scrypt verifier of a one-time password and the AES-GCM ciphertext of the key. The iPad enters
 * the ID and password in its existing «Настройка киоска» form; /enrollment/exchange is unchanged.
 * The password and the device key leave the server once, in this response, and are never stored.
 */
export type KioskPairingOptions = {
  encryptionKey: Buffer;
  /** The env point of the kiosk API (KIOSK_CHECKOUT_ORGANIZATION_ID/BRANCH_ID). */
  organizationId: string;
  branchId: string;
  /**
   * ADR-0019 KIOSK_MULTI_BRANCH_ENABLED: other points of the organization are served once their
   * manager switches «Киоски на этой точке» on (kiosk_branch_settings). Off: the env point only.
   */
  multiBranch?: boolean;
  /** KIOSK_KASPI_TERMINAL_ACCOUNT_ID, shown as the env point's terminal account. */
  terminalAccountId?: string | null;
};
/** The kiosk API serves this point: the env point, or one switched on (ADR-0019). */
export async function kioskBranchServed(
  db: DatabaseClient,
  options: KioskPairingOptions,
  organizationId: string,
  branch: string,
) {
  if (organizationId.toLowerCase() !== options.organizationId.toLowerCase()) return false;
  if (branch.toLowerCase() === options.branchId.toLowerCase()) return true;
  return (
    !!options.multiBranch && !!(await readKioskBranchSetting(db, organizationId, branch))?.enabled
  );
}
/** The iPad has to be set up while the manager is next to it. Schema 044 allows at most 24 h. */
export const KIOSK_PAIRING_TTL_SECONDS = 1800;
const PER_ACTOR_10_MIN = 5;
const PENDING_PER_BRANCH = 5;
const LOWER = 'abcdefghjkmnpqrstuvwxyz23456789';
export const KioskPairingRequest = z.strictObject({
  request_id: z.uuid(),
  name: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(3).max(500),
});
/** Unambiguous lower-case letters and digits: the iPad field is secure and not auto-capitalized. */
export function kioskPairingText(length: number, alphabet = LOWER) {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      // Rejection sampling keeps every symbol equally likely.
      if (byte < 256 - (256 % alphabet.length)) out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function kioskPairingAvailable(db: DatabaseClient) {
  return (
    (
      await db.query(
        `SELECT 1 WHERE to_regclass('kiosk_pairing_issues') IS NOT NULL
         AND has_table_privilege('kiosk_pairing_issues','SELECT')`,
      )
    ).rowCount === 1
  );
}

/** Pending/used state of issued kiosks for the device list; never the password or the key. */
export async function kioskPairingStates(db: DatabaseClient, branch: string) {
  if (!(await kioskPairingAvailable(db))) return new Map<string, KioskPairingState>();
  const rows = (
    await db.query<{
      device_id: string;
      name: string;
      login: string;
      expires_at: Date;
      used: boolean;
      live: boolean;
    }>(
      `SELECT DISTINCT ON (i.device_id) i.device_id,i.name,i.login,a.expires_at,
        a.request_id IS NOT NULL AS used,a.expires_at>clock_timestamp() AS live
       FROM kiosk_pairing_issues i JOIN kiosk_enrollment_aliases a ON a.login=i.login
       WHERE i.branch_id=$1 ORDER BY i.device_id,i.created_at DESC`,
      [branch],
    )
  ).rows;
  return new Map(
    rows.map((r) => [
      r.device_id,
      {
        name: r.name,
        login: r.login,
        expires_at: new Date(r.expires_at).toISOString(),
        state: r.used ? 'paired' : r.live ? 'waiting' : 'expired',
      } as KioskPairingState,
    ]),
  );
}
export type KioskPairingState = {
  name: string;
  login: string;
  expires_at: string;
  state: 'waiting' | 'paired' | 'expired';
};

/** Runs inside the caller's transaction after the manager scope check. */
export async function issueKioskPairing(
  db: DatabaseClient,
  actor: { id: string; organization_id: string },
  branch: string,
  input: unknown,
  options: KioskPairingOptions | null,
) {
  const body = parse(KioskPairingRequest, input);
  if (!options || !(await kioskPairingAvailable(db)))
    throw new BackofficeError('SERVICE_UNAVAILABLE', 'KIOSK_PAIRING_DISABLED');
  if (!(await kioskBranchServed(db, options, actor.organization_id, branch)))
    throw new BackofficeError('CONFLICT', 'KIOSK_BRANCH_NOT_SERVED');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'kiosk-pairing:' + branch,
  ]);
  const hash = digest({ branch, body });
  const prior = (
    await db.query<{ request_digest: string }>(
      'SELECT request_digest FROM kiosk_pairing_issues WHERE actor_id=$1 AND request_id=$2',
      [actor.id, body.request_id],
    )
  ).rows[0];
  if (prior) {
    if (prior.request_digest !== hash) throw new BackofficeError('CONFLICT');
    // The password is shown once; a lost answer means issuing a new one.
    throw new BackofficeError('CONFLICT', 'KIOSK_PAIRING_ALREADY_ISSUED');
  }
  const limits = (
    await db.query<{ recent: string; pending: string }>(
      `SELECT (SELECT count(*) FROM kiosk_pairing_issues WHERE actor_id=$1
         AND created_at>clock_timestamp()-interval '10 minutes') recent,
       (SELECT count(*) FROM kiosk_pairing_issues i JOIN kiosk_enrollment_aliases a ON a.login=i.login
         WHERE i.branch_id=$2 AND a.request_id IS NULL AND a.expires_at>clock_timestamp()) pending`,
      [actor.id, branch],
    )
  ).rows[0]!;
  if (Number(limits.recent) >= PER_ACTOR_10_MIN || Number(limits.pending) >= PENDING_PER_BRANCH)
    throw new BackofficeError('CONFLICT', 'KIOSK_PAIRING_LIMIT');
  const deviceId = randomUUID(),
    key = randomBytes(32).toString('hex'),
    password = kioskPairingText(16);
  let login = '';
  for (let attempt = 0; attempt < 5 && !login; attempt++) {
    const candidate = 'ipad-' + kioskPairingText(6);
    const taken = await db.query('SELECT 1 FROM kiosk_enrollment_aliases WHERE login=$1', [
      candidate,
    ]);
    if (!taken.rowCount) login = candidate;
  }
  if (!login) throw new BackofficeError('SERVICE_UNAVAILABLE');
  const material = await createKioskEnrollmentMaterial(
    {
      login,
      password,
      deviceId,
      organizationId: options.organizationId.toLowerCase(),
      branchId: branch.toLowerCase(),
      key,
    },
    options.encryptionKey,
  );
  await db.query(
    'INSERT INTO kiosk_devices(id,organization_id,branch_id,token_hash) VALUES($1,$2,$3,$4)',
    [deviceId, options.organizationId.toLowerCase(), branch.toLowerCase(), material.tokenHash],
  );
  const alias = (
    await db.query<{ expires_at: Date }>(
      `INSERT INTO kiosk_enrollment_aliases(login,device_id,organization_id,branch_id,password_salt,
        password_verifier,token_ciphertext,token_nonce,token_tag,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+$10*interval '1 second') RETURNING expires_at`,
      [
        login,
        deviceId,
        options.organizationId.toLowerCase(),
        branch.toLowerCase(),
        material.salt,
        material.verifier,
        material.ciphertext,
        material.nonce,
        material.tag,
        KIOSK_PAIRING_TTL_SECONDS,
      ],
    )
  ).rows[0]!;
  await db.query(
    `INSERT INTO kiosk_pairing_issues(id,organization_id,branch_id,device_id,login,name,reason,actor_id,request_id,request_digest)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      randomUUID(),
      options.organizationId.toLowerCase(),
      branch.toLowerCase(),
      deviceId,
      login,
      body.name,
      body.reason,
      actor.id,
      body.request_id,
      hash,
    ],
  );
  return {
    device_id: deviceId,
    login,
    password,
    expires_at: new Date(alias.expires_at).toISOString(),
  };
}
