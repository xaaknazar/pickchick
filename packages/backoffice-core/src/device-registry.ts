import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
} from 'node:crypto';
import { z } from 'zod';
import { transaction, type DatabasePool, type DatabaseClient } from '@pickchick/database';
import { catalogHash } from '@pickchick/catalog-admin';
import { createKioskEnrollmentMaterial, digest } from '@pickchick/commerce-core';
import { BackofficeError, deviceRevocable, parse, type BackofficeErrorReason } from './model.js';

export const DEVICE_REGISTRY = Symbol('DEVICE_REGISTRY');
/** Crockford base32: no I, L, O or U, so a code read aloud or typed is unambiguous. */
export const PAIRING_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** MVP kiosk pairing reuses the cloud044 alias exchange; 30 minutes instead of 24 hours. */
export const KIOSK_ALIAS_TTL_MINUTES = 30;
/** Per actor within PAIRING_ISSUE_WINDOW_MINUTES, and live open codes per branch. */
export const PAIRING_ISSUE_LIMIT = 10;
export const PAIRING_ISSUE_WINDOW_MINUTES = 10;
export const PAIRING_OPEN_LIMIT = 10;
const ROLES = ['edge', 'pos', 'kiosk', 'kitchen_prep', 'kitchen_assembly', 'board'] as const;
type Role = (typeof ROLES)[number];

/** 8 random Crockford characters (40 bits), shown as XXXX-XXXX. Stage 2 short codes. */
export function generatePairingCode(): string {
  let code = '';
  for (let i = 0; i < 8; i++) code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  return code.slice(0, 4) + '-' + code.slice(4);
}
/** Case, spaces and hyphens are ignored; I/L read as 1 and O as 0. Null when malformed. */
export function normalizePairingCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 32) return null;
  const code = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return code.length === 8 && [...code].every((c) => PAIRING_ALPHABET.includes(c)) ? code : null;
}
/** HMAC-SHA256 with a pepper held outside the database; the plaintext code is never stored. */
export function pairingCodeHash(pepper: Buffer, purpose: string, code: string): Buffer {
  if (pepper.length !== 32) throw new Error('Invalid pairing pepper');
  return createHmac('sha256', pepper)
    .update(purpose + '\0' + code)
    .digest();
}
export function devicePairingPepper(env: NodeJS.ProcessEnv): Buffer | null {
  const value = env.DEVICE_PAIRING_PEPPER;
  if (!value) return null;
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid DEVICE_PAIRING_PEPPER');
  return Buffer.from(value, 'hex');
}
/** Separate opt-in on top of BACKOFFICE_ENABLED: requires cloud051 and its runtime grants. */
export function deviceRegistryEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.BACKOFFICE_DEVICE_REGISTRY_ENABLED === 'true';
}
const lower = (length: number) => {
  let s = '';
  for (let i = 0; i < length; i++)
    s += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]!.toLowerCase();
  return s;
};
/** Alias login and a 12-character password (60 bits) typed on the existing iPad screen. */
export function kioskAliasCredentials() {
  return { login: 'kiosk-' + lower(8), password: lower(12) };
}
const sealAad = (d: { device: string; kiosk: string; organization: string; branch: string }) =>
  Buffer.from(
    JSON.stringify(['device_pairing.kiosk', d.device, d.kiosk, d.organization, d.branch]),
  );
/** nonce(12) || tag(16) || ciphertext, AES-256-GCM bound to the device and branch. */
export function sealDeviceSecret(
  key: Buffer,
  aad: { device: string; kiosk: string; organization: string; branch: string },
  secret: string,
): Buffer {
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(sealAad(aad));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}
export function unsealDeviceSecret(
  key: Buffer,
  aad: { device: string; kiosk: string; organization: string; branch: string },
  sealed: Buffer,
): string | null {
  if (sealed.length < 29) return null;
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
    cipher.setAAD(sealAad(aad));
    cipher.setAuthTag(sealed.subarray(12, 28));
    return Buffer.concat([cipher.update(sealed.subarray(28)), cipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

const id = z.uuid();
const Name = z.string().trim().min(1).max(80);
const Reason = z.string().trim().min(3).max(500);
const Create = z.strictObject({ request_id: id, role: z.enum(ROLES), name: Name, reason: Reason });
const Issue = z.strictObject({ request_id: id, reason: Reason });
const Revoke = z.strictObject({ request_id: id, reason: Reason, confirm_name: Name });
const Rename = z.strictObject({ request_id: id, reason: Reason, name: Name });
const EventsQuery = z.strictObject({ before: z.iso.datetime({ offset: true }).optional() });

type Actor = { id: string; organization_id: string; role: 'manager' | 'analyst' };
type KioskConfig = { encryptionKey: Buffer; organizationId: string; branchId: string };
export type DeviceRegistryOptions = {
  enabled: boolean;
  pepper: Buffer | null;
  kiosk: KioskConfig | null;
};
type DeviceRow = {
  id: string;
  organization_id: string;
  branch_id: string;
  kind: string;
  role: Role | null;
  name: string;
  status: 'pending' | 'active' | 'revoked';
  kiosk_device_id: string | null;
  kiosk_active: boolean | null;
  kiosk_token_hash: string | null;
};
type Write = { action: string; entity: string; before: unknown; after: unknown };
const fail = (code: BackofficeError['code'], reason?: BackofficeErrorReason): never => {
  throw new BackofficeError(code, reason);
};
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
/** Same label for a kiosk provisioned by CLI before cloud051, in the list and on adoption. */
const legacyKioskName = (kioskId: string) => 'Киоск ' + kioskId.slice(0, 8);
/** JSON round trip so a fresh result and a bo_commands replay have the same shape. */
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * Branch device registry (cloud051). Reads need any back-office grant; writes need the branch
 * manager role, a reason, bo_commands idempotency and leave bo_audit + device_events rows.
 * MVP pairing is iPad kiosks only, through the existing cloud044 alias exchange.
 */
export class DeviceRegistry {
  constructor(
    private readonly pool: DatabasePool,
    private readonly options: DeviceRegistryOptions,
  ) {
    if (options.pepper && options.pepper.length !== 32) throw new Error('Invalid pairing pepper');
    if (options.kiosk && options.kiosk.encryptionKey.length !== 32)
      throw new Error('Invalid kiosk enrollment key');
  }
  private async scope(db: DatabaseClient, token: string, branch: string, write: boolean) {
    if (!this.options.enabled) fail('SERVICE_UNAVAILABLE');
    parse(id, branch);
    if (!/^[a-f0-9]{64}$/.test(token)) fail('UNAUTHORIZED');
    const actor = (
      await db.query<Actor>(
        'SELECT id,organization_id FROM catalog_managers WHERE token_hash=$1 AND revoked_at IS NULL FOR SHARE',
        [catalogHash(token)],
      )
    ).rows[0];
    if (!actor) return fail('UNAUTHORIZED');
    const grant = (
      await db.query<{ role: Actor['role'] }>(
        'SELECT g.role FROM bo_access_grants g JOIN catalog_manager_branches s ON s.actor_id=g.actor_id AND s.branch_id=g.branch_id WHERE g.actor_id=$1 AND g.branch_id=$2 AND s.organization_id=$3 FOR SHARE OF g,s',
        [actor.id, branch, actor.organization_id],
      )
    ).rows[0];
    if (!grant || (write && grant.role !== 'manager')) return fail('FORBIDDEN');
    return { ...actor, role: grant.role };
  }
  /** Kiosk API serves exactly one branch (KIOSK_CHECKOUT_BRANCH_ID); others are not pairable. */
  private kioskFor(actor: Actor, branch: string): KioskConfig | null {
    const k = this.options.kiosk;
    return k &&
      this.options.pepper &&
      k.branchId.toLowerCase() === branch.toLowerCase() &&
      k.organizationId.toLowerCase() === actor.organization_id
      ? k
      : null;
  }

  async list(token: string, branch: string) {
    return transaction(this.pool, async (db) => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const actor = await this.scope(db, token, branch, false);
      const now = (await db.query<{ now: Date }>('SELECT clock_timestamp() now')).rows[0]!.now;
      const registered = (
        await db.query(
          `SELECT d.id,d.kind,d.role,d.name,d.status,d.created_at,d.revoked_at,d.app_version,d.kiosk_device_id,
            k.active kiosk_active,d.last_seen_at,
            CASE WHEN d.kind='edge' THEN (SELECT a.observed_at FROM cloud_branch_availability a WHERE a.device_id=d.id AND a.branch_id=d.branch_id)
                 WHEN d.kiosk_device_id IS NOT NULL THEN (SELECT max(s.created_at) FROM kiosk_sessions s WHERE s.device_id=d.kiosk_device_id) END observed_at,
            CASE WHEN d.kind='edge' THEN (SELECT c.expires_at FROM device_credentials c WHERE c.device_id=d.id) END credential_expires_at,
            d.kiosk_device_id IS NOT NULL AND (
              EXISTS(SELECT 1 FROM kiosk_enrollment_aliases e WHERE e.device_id=d.kiosk_device_id AND e.request_id IS NOT NULL)
              OR EXISTS(SELECT 1 FROM kiosk_sessions s WHERE s.device_id=d.kiosk_device_id)) kiosk_paired
          FROM devices d LEFT JOIN kiosk_devices k ON k.id=d.kiosk_device_id
          WHERE d.branch_id=$1 ORDER BY d.created_at,d.id`,
          [branch],
        )
      ).rows;
      const legacy = (
        await db.query(
          `SELECT k.id,k.active,k.created_at,(SELECT max(s.created_at) FROM kiosk_sessions s WHERE s.device_id=k.id) observed_at
          FROM kiosk_devices k WHERE k.branch_id=$1 AND k.organization_id=$2
           AND NOT EXISTS(SELECT 1 FROM devices d WHERE d.kiosk_device_id=k.id) ORDER BY k.created_at,k.id`,
          [branch, actor.organization_id],
        )
      ).rows;
      const codes = (
        await db.query(
          `SELECT id,device_id,purpose,created_at,expires_at,expires_at<=clock_timestamp() expired
          FROM device_pairing_codes WHERE branch_id=$1 AND state='open'`,
          [branch],
        )
      ).rows;
      // Same boundary as revoke: an open kiosk payment keeps the kiosk connected.
      const paying = new Set<string>();
      for (const kioskId of [
        ...registered
          .filter((d) => d.kiosk_device_id && d.status !== 'revoked' && d.kiosk_active !== false)
          .map((d) => d.kiosk_device_id as string),
        ...legacy.filter((k) => k.active).map((k) => k.id as string),
      ])
        if (await this.kioskPaymentOpen(db, kioskId)) paying.add(kioskId);
      const seen = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : (a ?? b));
      const age = (at: Date | null) =>
        at ? Math.max(0, Math.floor((now.getTime() - at.getTime()) / 1000)) : null;
      const devices = [
        ...registered.map((d) => {
          const revoked = d.status === 'revoked' || d.kiosk_active === false;
          const status = revoked
            ? 'revoked'
            : d.status === 'pending' && d.kiosk_paired
              ? 'active'
              : d.status;
          const code = codes.find((c) => c.device_id === d.id);
          const last = seen(d.last_seen_at, d.observed_at);
          return {
            id: d.id,
            registered: true,
            kind: d.kind,
            role: d.role,
            name: d.name,
            status,
            revocable: deviceRevocable(d.kind) && status !== 'revoked',
            created_at: d.created_at,
            revoked_at: d.revoked_at,
            app_version: d.app_version,
            last_seen_at: last,
            last_seen_age_seconds: age(last),
            last_seen_source:
              d.observed_at && last === d.observed_at
                ? d.kind === 'edge'
                  ? 'edge_availability'
                  : 'kiosk_session'
                : last
                  ? 'device'
                  : null,
            credential_expires_at: d.credential_expires_at,
            payment_open: !revoked && !!d.kiosk_device_id && paying.has(d.kiosk_device_id),
            pairing:
              code && !revoked
                ? {
                    id: code.id,
                    purpose: code.purpose,
                    state: d.kiosk_paired ? 'consumed' : code.expired ? 'expired' : 'open',
                    created_at: code.created_at,
                    expires_at: code.expires_at,
                  }
                : null,
          };
        }),
        ...legacy.map((k) => ({
          id: k.id as string,
          registered: false,
          kind: 'kiosk',
          role: 'kiosk',
          name: legacyKioskName(k.id),
          status: k.active ? 'active' : 'revoked',
          revocable: !!k.active,
          created_at: k.created_at,
          revoked_at: null,
          app_version: null,
          last_seen_at: k.observed_at,
          last_seen_age_seconds: age(k.observed_at),
          last_seen_source: k.observed_at ? 'kiosk_session' : null,
          credential_expires_at: null,
          payment_open: !!k.active && paying.has(k.id),
          pairing: null,
        })),
      ];
      return json({
        branch_id: branch,
        role: actor.role,
        server_time: now,
        kiosk_pairing: this.kioskFor(actor, branch) ? 'ready' : 'not_configured',
        devices,
      });
    });
  }

  async events(token: string, branch: string, deviceId: string, query: unknown = {}) {
    parse(id, deviceId);
    const q = parse(EventsQuery, query);
    return transaction(this.pool, async (db) => {
      await this.scope(db, token, branch, false);
      const device = (
        await db.query<{ id: string }>(
          'SELECT id FROM devices WHERE branch_id=$1 AND (id=$2 OR kiosk_device_id=$2)',
          [branch, deviceId],
        )
      ).rows[0];
      if (!device) return { events: [], next_before: null };
      const rows = (
        await db.query(
          `SELECT e.id,e.action,e.actor_kind,m.name actor_name,e.reason,e.at FROM device_events e
          LEFT JOIN catalog_managers m ON m.id=e.actor_id AND e.actor_kind='backoffice'
          WHERE e.device_id=$1 AND e.branch_id=$2 AND ($3::timestamptz IS NULL OR e.at<$3)
          ORDER BY e.at DESC,e.id DESC LIMIT 51`,
          [device.id, branch, q.before ?? null],
        )
      ).rows;
      const events = rows.slice(0, 50);
      return json({
        events,
        next_before: rows.length > 50 ? events.at(-1)!.at : null,
      });
    });
  }

  /** Shared write envelope: manager scope, idempotency, branch lock, bo_audit and bo_commands. */
  private async write(
    token: string,
    branch: string,
    kind: string,
    deviceId: string | null,
    req: { request_id: string; reason: string },
    run: (
      db: DatabaseClient,
      actor: Actor,
    ) => Promise<{
      result: Record<string, unknown>;
      secret?: Record<string, unknown>;
      audit: Write;
    }>,
  ) {
    try {
      return await transaction(this.pool, async (db) => {
        const actor = await this.scope(db, token, branch, true);
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'bo:actor:' + actor.id + ':' + req.request_id,
        ]);
        const hash = digest({ branch, kind, device: deviceId, ...req });
        const previous = (
          await db.query(
            'SELECT digest,result FROM bo_commands WHERE actor_id=$1 AND request_id=$2',
            [actor.id, req.request_id],
          )
        ).rows[0];
        if (previous) {
          if (previous.digest !== hash) return fail('CONFLICT');
          // The plaintext code was shown once and is not stored: a replay cannot return it.
          if (previous.result?.secret_issued === true)
            return fail('CONFLICT', 'CODE_ALREADY_ISSUED');
          return previous.result as Record<string, unknown>;
        }
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'bo:devices:' + branch,
        ]);
        const { result, secret, audit } = await run(db, actor);
        const stored = json(secret ? { ...result, secret_issued: true } : result);
        await db.query(
          'INSERT INTO bo_audit(id,branch_id,organization_id,actor_id,request_id,action,entity_id,reason,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            randomUUID(),
            branch,
            actor.organization_id,
            actor.id,
            req.request_id,
            audit.action,
            audit.entity,
            req.reason,
            json(audit.before),
            json(audit.after),
          ],
        );
        await db.query(
          'INSERT INTO bo_commands(actor_id,request_id,branch_id,digest,result) VALUES($1,$2,$3,$4,$5)',
          [actor.id, req.request_id, branch, hash, stored],
        );
        return secret ? { ...stored, ...json(secret) } : stored;
      });
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        !(error instanceof BackofficeError)
      ) {
        if (error.code === '23505') throw new BackofficeError('CONFLICT');
        if (['23503', '23514'].includes(String(error.code)))
          throw new BackofficeError('INVALID_REQUEST');
        if (['40001', '40P01'].includes(String(error.code)))
          throw new BackofficeError('SERVICE_UNAVAILABLE');
      }
      throw error;
    }
  }
  private async event(
    db: DatabaseClient,
    actor: Actor,
    device: { id: string; branch_id: string },
    action: string,
    req: { request_id: string; reason: string },
  ) {
    await db.query(
      `INSERT INTO device_events(id,organization_id,branch_id,device_id,actor_kind,actor_id,action,reason,request_id)
       VALUES($1,$2,$3,$4,'backoffice',$5,$6,$7,$8)`,
      [
        randomUUID(),
        actor.organization_id,
        device.branch_id,
        device.id,
        actor.id,
        action,
        req.reason,
        req.request_id,
      ],
    );
  }
  /**
   * Locks the device. A kiosk provisioned by CLI before cloud051 exists only in kiosk_devices;
   * it is adopted into the registry (event "created") so it can be renamed or revoked.
   */
  private async device(
    db: DatabaseClient,
    actor: Actor,
    branch: string,
    deviceId: string,
    req: { request_id: string; reason: string },
  ): Promise<DeviceRow> {
    parse(id, deviceId);
    const select = () =>
      db.query<DeviceRow>(
        `SELECT d.id,d.organization_id,d.branch_id,d.kind,d.role,d.name,d.status,d.kiosk_device_id,
          k.active kiosk_active,k.token_hash kiosk_token_hash
        FROM devices d LEFT JOIN kiosk_devices k ON k.id=d.kiosk_device_id
        WHERE d.branch_id=$1 AND d.organization_id=$3 AND (d.id=$2 OR d.kiosk_device_id=$2) FOR UPDATE OF d`,
        [branch, deviceId, actor.organization_id],
      );
    const found = (await select()).rows[0];
    if (found) {
      if (found.kiosk_device_id) {
        await db.query('SELECT 1 FROM kiosk_devices WHERE id=$1 FOR UPDATE', [
          found.kiosk_device_id,
        ]);
        // Lock aliases so a concurrent exchange either finishes first (and is seen) or fails.
        await db.query('SELECT 1 FROM kiosk_enrollment_aliases WHERE device_id=$1 FOR UPDATE', [
          found.kiosk_device_id,
        ]);
        return this.reconcileKiosk(db, found);
      }
      return found;
    }
    const kiosk = (
      await db.query<{ id: string; active: boolean }>(
        'SELECT id,active FROM kiosk_devices WHERE id=$1 AND branch_id=$2 AND organization_id=$3 FOR UPDATE',
        [deviceId, branch, actor.organization_id],
      )
    ).rows[0];
    if (!kiosk) return fail('NOT_FOUND');
    const adopted = randomUUID();
    await db.query(
      `INSERT INTO devices(id,branch_id,organization_id,kind,role,name,status,kiosk_device_id,created_by)
       VALUES($1,$2,$3,'kiosk','kiosk',$4,$5,$6,$7)`,
      [
        adopted,
        branch,
        actor.organization_id,
        legacyKioskName(kiosk.id),
        kiosk.active ? 'active' : 'revoked',
        kiosk.id,
        actor.id,
      ],
    );
    await this.event(db, actor, { id: adopted, branch_id: branch }, 'created', req);
    return (await select()).rows[0]!;
  }
  /**
   * MVP pairing happens in the unchanged cloud044 exchange, which knows nothing of the registry.
   * Before any write the registry records what the exchange did: the pending kiosk becomes
   * active, its open code consumed (at observation time) and a device event "paired" is added.
   */
  private async reconcileKiosk(db: DatabaseClient, device: DeviceRow): Promise<DeviceRow> {
    if (device.status !== 'pending' || device.kiosk_active === false) return device;
    const used = (
      await db.query<{ request_id: string }>(
        `SELECT request_id FROM kiosk_enrollment_aliases WHERE device_id=$1 AND request_id IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
        [device.kiosk_device_id],
      )
    ).rows[0];
    if (!used && !(await this.kioskPaired(db, device.kiosk_device_id!))) return device;
    await db.query(
      `UPDATE device_pairing_codes SET state='consumed',consumed_at=clock_timestamp(),consumed_request_id=$2
       WHERE device_id=$1 AND state='open'`,
      [device.id, used?.request_id ?? null],
    );
    await db.query("UPDATE devices SET status='active' WHERE id=$1 AND status='pending'", [
      device.id,
    ]);
    await db.query(
      `INSERT INTO device_events(id,organization_id,branch_id,device_id,actor_kind,actor_id,action,request_id)
       VALUES($1,$2,$3,$4,'device',$5,'paired',$6)`,
      [
        randomUUID(),
        device.organization_id,
        device.branch_id,
        device.id,
        device.kiosk_device_id,
        used?.request_id ?? null,
      ],
    );
    return { ...device, status: 'active' };
  }
  private async kioskPaired(db: DatabaseClient, kioskId: string) {
    return (
      await db.query<{ paired: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM kiosk_enrollment_aliases WHERE device_id=$1 AND request_id IS NOT NULL)
          OR EXISTS(SELECT 1 FROM kiosk_sessions WHERE device_id=$1) paired`,
        [kioskId],
      )
    ).rows[0]!.paired;
  }
  /** Closes open codes of a device (expired ones as expired) and their unused kiosk aliases. */
  private async closeCodes(
    db: DatabaseClient,
    actor: Actor,
    device: DeviceRow,
    req: { request_id: string; reason: string },
  ) {
    const closed = (
      await db.query<{ id: string; state: string }>(
        `UPDATE device_pairing_codes SET state=CASE WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE 'cancelled' END
        WHERE device_id=$1 AND state='open' RETURNING id,state`,
        [device.id],
      )
    ).rows;
    if (device.kiosk_device_id)
      await db.query(
        'UPDATE kiosk_enrollment_aliases SET active=false WHERE device_id=$1 AND active',
        [device.kiosk_device_id],
      );
    if (closed.some((c) => c.state === 'cancelled'))
      await this.event(db, actor, device, 'code_cancelled', req);
    return closed;
  }
  /** Seals the kiosk key into a new 30-minute alias and records only the code HMAC. */
  private async issueKioskCode(
    db: DatabaseClient,
    actor: Actor,
    device: DeviceRow,
    kiosk: KioskConfig,
    key: string,
    req: { request_id: string; reason: string },
  ) {
    const recent = (
      await db.query<{ actor_codes: number; open_codes: number }>(
        `SELECT (SELECT count(*)::int FROM device_pairing_codes WHERE created_by=$1
            AND created_at>clock_timestamp()-make_interval(mins=>$3)) actor_codes,
          (SELECT count(*)::int FROM device_pairing_codes WHERE branch_id=$2 AND state='open'
            AND expires_at>clock_timestamp()) open_codes`,
        [actor.id, device.branch_id, PAIRING_ISSUE_WINDOW_MINUTES],
      )
    ).rows[0]!;
    if (recent.actor_codes >= PAIRING_ISSUE_LIMIT || recent.open_codes >= PAIRING_OPEN_LIMIT)
      fail('CONFLICT', 'PAIRING_RATE_LIMITED');
    await this.closeCodes(db, actor, device, req);
    const { login, password } = kioskAliasCredentials();
    const material = await createKioskEnrollmentMaterial(
      {
        login,
        password,
        deviceId: device.kiosk_device_id!,
        organizationId: device.organization_id,
        branchId: device.branch_id,
        key,
      },
      kiosk.encryptionKey,
    );
    const now = (await db.query<{ now: Date }>('SELECT clock_timestamp() now')).rows[0]!.now;
    const expires = new Date(now.getTime() + KIOSK_ALIAS_TTL_MINUTES * 60_000);
    await db.query(
      `INSERT INTO kiosk_enrollment_aliases(login,device_id,organization_id,branch_id,password_salt,password_verifier,token_ciphertext,token_nonce,token_tag,created_at,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        login,
        device.kiosk_device_id,
        device.organization_id,
        device.branch_id,
        material.salt,
        material.verifier,
        material.ciphertext,
        material.nonce,
        material.tag,
        now,
        expires,
      ],
    );
    const codeId = randomUUID();
    await db.query(
      `INSERT INTO device_pairing_codes(id,organization_id,branch_id,device_id,purpose,code_hash,sealed_secret,created_by,created_at,expires_at,request_id)
       VALUES($1,$2,$3,$4,'kiosk',$5,$6,$7,$8,$9,$10)`,
      [
        codeId,
        device.organization_id,
        device.branch_id,
        device.id,
        pairingCodeHash(this.options.pepper!, 'kiosk', login + ':' + password),
        sealDeviceSecret(
          kiosk.encryptionKey,
          {
            device: device.id,
            kiosk: device.kiosk_device_id!,
            organization: device.organization_id,
            branch: device.branch_id,
          },
          key,
        ),
        actor.id,
        now,
        expires,
        req.request_id,
      ],
    );
    await this.event(db, actor, device, 'code_issued', req);
    return {
      pairing: { id: codeId, purpose: 'kiosk', expires_at: expires },
      secret: { login, password },
    };
  }
  private publicDevice(d: DeviceRow) {
    return { id: d.id, kind: d.kind, role: d.role, name: d.name, status: d.status };
  }

  /** MVP: only an iPad kiosk of the kiosk API branch; the response carries the code once. */
  async create(token: string, branch: string, input: unknown) {
    const req = parse(Create, input);
    return this.write(token, branch, 'device_create', null, req, async (db, actor) => {
      if (req.role !== 'kiosk') return fail('NOT_READY', 'ROLE_PAIRING_NOT_READY');
      if (!this.options.pepper) return fail('NOT_READY', 'PAIRING_NOT_CONFIGURED');
      const kiosk = this.kioskFor(actor, branch);
      if (!kiosk) return fail('NOT_READY', 'KIOSK_NOT_CONFIGURED');
      const kioskId = randomUUID(),
        deviceId = randomUUID(),
        key = randomBytes(32).toString('hex');
      await db.query(
        'INSERT INTO kiosk_devices(id,organization_id,branch_id,token_hash) VALUES($1,$2,$3,$4)',
        [kioskId, actor.organization_id, branch, sha(key)],
      );
      await db.query(
        `INSERT INTO devices(id,branch_id,organization_id,kind,role,name,status,kiosk_device_id,created_by)
         VALUES($1,$2,$3,'kiosk','kiosk',$4,'pending',$5,$6)`,
        [deviceId, branch, actor.organization_id, req.name, kioskId, actor.id],
      );
      const device: DeviceRow = {
        id: deviceId,
        organization_id: actor.organization_id,
        branch_id: branch,
        kind: 'kiosk',
        role: 'kiosk',
        name: req.name,
        status: 'pending',
        kiosk_device_id: kioskId,
        kiosk_active: true,
        kiosk_token_hash: sha(key),
      };
      await this.event(db, actor, device, 'created', req);
      const issued = await this.issueKioskCode(db, actor, device, kiosk, key, req);
      const result = { device: this.publicDevice(device), pairing: issued.pairing };
      return {
        result,
        secret: { pairing: { ...issued.pairing, ...issued.secret } },
        audit: { action: 'device_create', entity: deviceId, before: null, after: result },
      };
    });
  }

  /** New code for a pending kiosk; the previous open code and its alias stop working. */
  async issueCode(token: string, branch: string, deviceId: string, input: unknown) {
    const req = parse(Issue, input);
    return this.write(token, branch, 'device_pairing_code', deviceId, req, async (db, actor) => {
      if (!this.options.pepper) return fail('NOT_READY', 'PAIRING_NOT_CONFIGURED');
      const device = await this.device(db, actor, branch, deviceId, req);
      if (device.kind !== 'kiosk') return fail('NOT_READY', 'ROLE_PAIRING_NOT_READY');
      const kiosk = this.kioskFor(actor, branch);
      if (!kiosk) return fail('NOT_READY', 'KIOSK_NOT_CONFIGURED');
      if (device.status === 'revoked' || device.kiosk_active === false)
        return fail('CONFLICT', 'DEVICE_REVOKED');
      if (device.status !== 'pending') return fail('CONFLICT', 'DEVICE_NOT_PENDING');
      const sealed = (
        await db.query<{ sealed_secret: Buffer }>(
          `SELECT sealed_secret FROM device_pairing_codes WHERE device_id=$1 AND purpose='kiosk'
           AND sealed_secret IS NOT NULL ORDER BY created_at DESC,id LIMIT 1`,
          [device.id],
        )
      ).rows[0];
      const key = sealed
        ? unsealDeviceSecret(
            kiosk.encryptionKey,
            {
              device: device.id,
              kiosk: device.kiosk_device_id!,
              organization: device.organization_id,
              branch: device.branch_id,
            },
            sealed.sealed_secret,
          )
        : null;
      if (!key || !/^[0-9a-f]{64}$/.test(key) || sha(key) !== device.kiosk_token_hash)
        return fail('CONFLICT', 'DEVICE_NOT_PENDING');
      const issued = await this.issueKioskCode(db, actor, device, kiosk, key, req);
      const result = { device: this.publicDevice(device), pairing: issued.pairing };
      return {
        result,
        secret: { pairing: { ...issued.pairing, ...issued.secret } },
        audit: { action: 'device_pairing_code', entity: device.id, before: null, after: result },
      };
    });
  }

  async cancelCode(
    token: string,
    branch: string,
    deviceId: string,
    codeId: string,
    input: unknown,
  ) {
    parse(id, codeId);
    const req = parse(Issue, input);
    return this.write(
      token,
      branch,
      'device_pairing_cancel:' + codeId,
      deviceId,
      req,
      async (db, actor) => {
        const device = await this.device(db, actor, branch, deviceId, req);
        const code = (
          await db.query<{ state: string }>(
            'SELECT state FROM device_pairing_codes WHERE id=$1 AND device_id=$2 FOR UPDATE',
            [codeId, device.id],
          )
        ).rows[0];
        if (!code) return fail('NOT_FOUND');
        if (code.state !== 'open') return fail('CONFLICT', 'CODE_NOT_OPEN');
        const closed = await this.closeCodes(db, actor, device, req);
        const result = {
          device: this.publicDevice(device),
          code: { id: codeId, state: closed.find((c) => c.id === codeId)?.state ?? 'cancelled' },
        };
        return {
          result,
          audit: {
            action: 'device_pairing_cancel',
            entity: device.id,
            before: code,
            after: result,
          },
        };
      },
    );
  }

  /** Non-edge devices only. A kiosk with an unresolved payment stays connected. */
  async revoke(token: string, branch: string, deviceId: string, input: unknown) {
    const req = parse(Revoke, input);
    return this.write(token, branch, 'device_revoke', deviceId, req, async (db, actor) => {
      const device = await this.device(db, actor, branch, deviceId, req);
      if (!deviceRevocable(device.kind))
        return fail('CONFLICT', 'EDGE_REVOKE_REQUIRES_REPLACEMENT_PROTOCOL');
      if (device.status === 'revoked' || device.kiosk_active === false)
        return fail('CONFLICT', 'DEVICE_REVOKED');
      if (req.confirm_name !== device.name.trim())
        return fail('INVALID_REQUEST', 'CONFIRM_NAME_MISMATCH');
      if (device.kiosk_device_id && (await this.kioskPaymentOpen(db, device.kiosk_device_id)))
        return fail('CONFLICT', 'KIOSK_PAYMENT_OPEN');
      await this.closeCodes(db, actor, device, req);
      await db.query(
        "UPDATE devices SET status='revoked',revoked_at=clock_timestamp(),revoked_by=$2 WHERE id=$1",
        [device.id, actor.id],
      );
      if (device.kiosk_device_id)
        await db.query('UPDATE kiosk_devices SET active=false WHERE id=$1', [
          device.kiosk_device_id,
        ]);
      await this.event(db, actor, device, 'revoked', req);
      const result = { device: { ...this.publicDevice(device), status: 'revoked' } };
      return {
        result,
        audit: {
          action: 'device_revoke',
          entity: device.id,
          before: this.publicDevice(device),
          after: result.device,
        },
      };
    });
  }
  /**
   * Same boundary as the payment-incident hand-over: an open kiosk payment attempt that a
   * manager has not accepted as an incident blocks revocation of that kiosk.
   */
  private async kioskPaymentOpen(db: DatabaseClient, kioskId: string) {
    const incidents = (
      await db.query<{ ok: boolean }>(
        "SELECT coalesce(has_table_privilege(to_regclass('commerce_kiosk_payment_incidents'),'SELECT'),false) ok",
      )
    ).rows[0]!.ok;
    return (
      await db.query<{ open: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM kiosk_sessions s JOIN commerce_orders o ON o.principal_id=s.id
          JOIN commerce_payment_attempts a ON a.order_id=o.id AND a.state IN ('pending','unknown')
          WHERE s.device_id=$1 AND o.customer_id IS NULL AND o.snapshot->>'channel'='kiosk'
          ${incidents ? 'AND NOT EXISTS(SELECT 1 FROM commerce_kiosk_payment_incidents h WHERE h.attempt_id=a.id)' : ''}) open`,
        [kioskId],
      )
    ).rows[0]!.open;
  }

  async rename(token: string, branch: string, deviceId: string, input: unknown) {
    const req = parse(Rename, input);
    return this.write(token, branch, 'device_rename', deviceId, req, async (db, actor) => {
      const device = await this.device(db, actor, branch, deviceId, req);
      await db.query('UPDATE devices SET name=$2 WHERE id=$1', [device.id, req.name]);
      await this.event(db, actor, device, 'renamed', req);
      const result = { device: { ...this.publicDevice(device), name: req.name } };
      return {
        result,
        audit: {
          action: 'device_rename',
          entity: device.id,
          before: { name: device.name },
          after: { name: req.name },
        },
      };
    });
  }
}
