import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHmac } from 'node:crypto';
import {
  StaffCredentialSchema,
  StaffLoginNameSchema,
  StaffLoginSchema,
  StaffPasswordSchema,
  UuidSchema,
} from '@pickchick/contracts';
import type { StaffCredential } from '@pickchick/contracts';
import { transaction } from '@pickchick/database';
import type { DatabasePool } from '@pickchick/database';
import { hashToken } from '@pickchick/menu-sync';
import { audit, authenticateStaff } from './staff.js';
import type { StaffAuth } from './staff.js';
import { authenticateManagedTerminal, type TerminalAuth } from './terminal-access.js';
import { OrderError } from './errors.js';

const SCRYPT = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 } as const;
const dummySalt = randomBytes(32).toString('hex');
const dummyVerifier = randomBytes(32).toString('hex');
let activePasswordOperations = 0;

export class StaffRateLimitError extends Error {
  readonly code = 'AUTH_RATE_LIMITED';
  /** Seconds until a retry can succeed (HTTP Retry-After); the same for every PIN. */
  constructor(readonly retryAfterSeconds = 60) {
    super('AUTH_RATE_LIMITED');
  }
}

/**
 * PIN login backoff per terminal (finding 6.5). A PIN is also the login, so a wrong PIN cannot
 * be attributed to a person and the per-staff lock never sees it. Each terminal gets a few free
 * typos, then every further failure locks PIN login there for 30 s, doubling up to 15 min. A
 * successful login does not forgive failures (an insider cannot interleave their own PIN); only
 * half an hour without failures does. While locked every PIN, right or wrong, gets the same
 * rate-limit answer without password work. State lives in the single edge process, like the
 * concurrency guard above; restarting the edge service (Windows administrator) clears it.
 */
export const PIN_BACKOFF = Object.freeze({
  freeFailures: 5,
  baseLockMs: 30_000,
  maxLockMs: 15 * 60_000,
  decayMs: 30 * 60_000,
  maxTerminals: 1000,
});
type PinBackoffPolicy = typeof PIN_BACKOFF;
interface PinBackoffState {
  failures: number;
  lastFailureAt: number;
  lockedUntil: number;
}
export class PinBackoff {
  private readonly terminals = new Map<string, PinBackoffState>();
  constructor(
    private readonly now: () => number = Date.now,
    readonly policy: PinBackoffPolicy = PIN_BACKOFF,
  ) {}
  private current(key: string) {
    const state = this.terminals.get(key);
    if (state && this.now() - state.lastFailureAt >= this.policy.decayMs) {
      this.terminals.delete(key);
      return undefined;
    }
    return state;
  }
  lockedMs(key: string) {
    const state = this.current(key);
    return state ? Math.max(0, state.lockedUntil - this.now()) : 0;
  }
  /** Records one failed PIN on a verified terminal and returns the lock it starts, if any. */
  fail(key: string) {
    const now = this.now(),
      state = this.current(key) ?? { failures: 0, lastFailureAt: now, lockedUntil: 0 };
    state.failures += 1;
    state.lastFailureAt = now;
    const over = state.failures - this.policy.freeFailures;
    if (over >= 0)
      state.lockedUntil =
        now + Math.min(this.policy.maxLockMs, this.policy.baseLockMs * 2 ** Math.min(over, 20));
    this.terminals.delete(key);
    this.terminals.set(key, state);
    while (this.terminals.size > this.policy.maxTerminals)
      this.terminals.delete(this.terminals.keys().next().value!);
    return { failures: state.failures, lockedMs: Math.max(0, state.lockedUntil - now) };
  }
  status(key: string) {
    return { failures: this.current(key)?.failures ?? 0, lockedMs: this.lockedMs(key) };
  }
}
const pinBackoff = new PinBackoff();
const pinBackoffKey = (branchId: string, terminalId: string) =>
  `${branchId.toLowerCase()}:${terminalId.toLowerCase()}`;
/** Monitoring only: failures and remaining lock of one terminal (never a PIN or staff id). */
export function pinBackoffStatus(branchId: string, terminalId: string) {
  const status = pinBackoff.status(pinBackoffKey(branchId, terminalId));
  return { failures: status.failures, lockedSeconds: Math.ceil(status.lockedMs / 1000) };
}
/** New and changed PINs may be 6 digits; existing 4-digit PINs keep working. */
const PIN_FORMAT = /^(?:[0-9]{4}|[0-9]{6})$/;

async function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, Buffer.from(salt, 'hex'), 32, SCRYPT, (error, result) => {
      if (error) reject(new Error('Password operation failed'));
      else resolve(result);
    });
  });
}

export async function makeStaffPasswordVerifier(password: unknown) {
  if (!StaffPasswordSchema.safeParse(password).success) throw new OrderError('INVALID_REQUEST');
  const salt = randomBytes(32).toString('hex');
  const result = await derive(password as string, salt);
  try {
    return { algorithm: 'scrypt-v1', salt, verifier: result.toString('hex') };
  } finally {
    result.fill(0);
  }
}

/** Owner-only enrollment. A protected, live operator bootstrap confirms existing identity and role. */
export async function setStaffPassword(
  pool: DatabasePool,
  branchId: string,
  bootstrap: StaffAuth,
  loginInput: unknown,
  password: unknown,
  replace = false,
  pinMode = false,
) {
  const table = pinMode ? 'local_staff_pins' : 'local_staff_passwords';
  const login = StaffLoginNameSchema.safeParse(loginInput);
  if (!login.success || !UuidSchema.safeParse(branchId).success || typeof replace !== 'boolean')
    throw new OrderError('INVALID_REQUEST');
  const hash = await makeStaffPasswordVerifier(password);
  return transaction(pool, async (client) => {
    // Same lock order as session renewal/login: staff, terminal, session/password.
    const identity = await client.query(
      'SELECT staff_id FROM staff_sessions WHERE id=$1 AND branch_id=$2 AND token_hash=$3',
      [UuidSchema.parse(bootstrap.sessionId), branchId, hashToken(bootstrap.token)],
    );
    if (!identity.rows[0]) throw new OrderError('UNAUTHORIZED');
    await client.query('SELECT id FROM local_staff WHERE id=$1 FOR UPDATE', [
      identity.rows[0].staff_id,
    ]);
    const session = await authenticateStaff(client, branchId, bootstrap);
    const existing = await client.query(`SELECT 1 FROM ${table} WHERE staff_id=$1`, [
      session.staff_id,
    ]);
    if (!!existing.rowCount !== replace) throw new OrderError('CONFLICT');
    const duplicate = await client.query(
      `SELECT 1 FROM ${table} WHERE branch_id=$1 AND login=$2 AND staff_id<>$3`,
      [branchId, login.data, session.staff_id],
    );
    if (duplicate.rowCount) throw new OrderError('CONFLICT');
    await client.query(
      `INSERT INTO ${table}(staff_id,branch_id,login,algorithm,salt,verifier)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(staff_id) DO UPDATE SET login=EXCLUDED.login,algorithm=EXCLUDED.algorithm,
         salt=EXCLUDED.salt,verifier=EXCLUDED.verifier,failed_attempts=0,locked_until=NULL,
         updated_at=clock_timestamp()`,
      [session.staff_id, branchId, login.data, hash.algorithm, hash.salt, hash.verifier],
    );
    // Changing a password invalidates every old bearer token, including the bootstrap.
    await client.query('UPDATE staff_sessions SET revoked=true WHERE staff_id=$1', [
      session.staff_id,
    ]);
    await audit(
      client,
      branchId,
      session.staff_id,
      replace ? 'staff.password_reset' : 'staff.password_enrolled',
      session.staff_id,
    );
    return {
      staff_id: session.staff_id,
      branch_id: branchId,
      terminal_id: session.terminal_id,
      role: session.role,
      login: login.data,
    };
  });
}

async function reserveAttempt(pool: DatabasePool, branchId: string, terminalId: string) {
  return transaction(pool, async (client) => {
    const terminal = await client.query(
      'SELECT id,device_access_managed FROM local_terminals WHERE id=$1 AND branch_id=$2 AND active FOR SHARE',
      [terminalId, branchId],
    );
    if (!terminal.rowCount) return false;
    const attempt = await client.query(
      `INSERT INTO local_staff_login_limits(terminal_id,branch_id,window_started_at,attempts)
       VALUES($1,$2,clock_timestamp(),1)
       ON CONFLICT(terminal_id) DO UPDATE SET
         window_started_at=CASE WHEN local_staff_login_limits.window_started_at <= clock_timestamp()-interval '60 seconds'
           THEN clock_timestamp() ELSE local_staff_login_limits.window_started_at END,
         attempts=CASE WHEN local_staff_login_limits.window_started_at <= clock_timestamp()-interval '60 seconds'
           THEN 1 ELSE local_staff_login_limits.attempts+1 END
       WHERE local_staff_login_limits.window_started_at <= clock_timestamp()-interval '60 seconds'
         OR local_staff_login_limits.attempts < 10
       RETURNING attempts`,
      [terminalId, branchId],
    );
    if (!attempt.rowCount) throw new StaffRateLimitError();
    return true;
  });
}

/** Local password login works without cloud; grants neither a role nor a new terminal. */
export async function loginStaff(
  pool: DatabasePool,
  branchId: string,
  input: unknown,
  pinMode = false,
  terminalAuth?: TerminalAuth,
): Promise<StaffCredential> {
  const table = pinMode ? 'local_staff_pins' : 'local_staff_passwords';
  const parsed = StaffLoginSchema.safeParse(input);
  if (!parsed.success || !UuidSchema.safeParse(branchId).success)
    throw new OrderError('UNAUTHORIZED');
  const { login, password, terminal_id: terminalId } = parsed.data;
  const backoff = pinMode ? pinBackoffKey(branchId, terminalId) : null;
  // A locked terminal answers every PIN alike, before any lookup or password work.
  const lockedMs = backoff ? pinBackoff.lockedMs(backoff) : 0;
  if (lockedMs > 0) throw new StaffRateLimitError(Math.ceil(lockedMs / 1000));
  // Reserve and commit before password work. Rejections/failures do not roll the counter back.
  if (!(await reserveAttempt(pool, branchId, terminalId))) throw new OrderError('UNAUTHORIZED');
  if (activePasswordOperations >= 2) throw new StaffRateLimitError();
  activePasswordOperations++;
  try {
    const result = await transaction(pool, async (client) => {
      const found = await client.query(
        `SELECT s.id FROM local_staff s JOIN ${table} p ON p.staff_id=s.id AND p.branch_id=s.branch_id
         WHERE s.branch_id=$1 AND p.login=$2`,
        [branchId, login],
      );
      const staffId = found.rows[0]?.id as string | undefined;
      // Locking the parent serializes password resets, revocations and session renewal.
      const staff = staffId
        ? await client.query(
            'SELECT id,name,role,active FROM local_staff WHERE id=$1 AND branch_id=$2 FOR UPDATE',
            [staffId, branchId],
          )
        : undefined;
      const terminal = await client.query(
        'SELECT id,device_access_managed FROM local_terminals WHERE id=$1 AND branch_id=$2 AND active FOR SHARE',
        [terminalId, branchId],
      );
      if (terminal.rows[0]?.device_access_managed || terminalAuth?.key) {
        if (terminalAuth?.id !== terminalId) throw new OrderError('UNAUTHORIZED');
        const bound = await authenticateManagedTerminal(client, branchId, terminalAuth);
        if (bound?.mode === 'display') throw new OrderError('FORBIDDEN');
      }
      const stored = staffId
        ? await client.query(
            `SELECT *, (locked_until > clock_timestamp()) AS locked,
          (locked_until IS NOT NULL AND locked_until <= clock_timestamp()) AS lock_expired
         FROM ${table} WHERE staff_id=$1 AND branch_id=$2 AND login=$3 FOR UPDATE`,
            [staffId, branchId, login],
          )
        : undefined;
      const record = stored?.rows[0];
      const key = await derive(password, record?.salt ?? dummySalt);
      let matches: boolean;
      try {
        matches = timingSafeEqual(key, Buffer.from(record?.verifier ?? dummyVerifier, 'hex'));
      } finally {
        key.fill(0);
      }
      if (!record || !staff?.rows[0]?.active || !terminal.rowCount || record.locked) return null;
      if (!matches) {
        await client.query(
          `UPDATE ${table} SET
           failed_attempts=LEAST(5,CASE WHEN $2 THEN 1 ELSE failed_attempts+1 END),
           locked_until=CASE WHEN (CASE WHEN $2 THEN 1 ELSE failed_attempts+1 END)>=5
             THEN clock_timestamp()+interval '15 minutes' ELSE NULL END
           WHERE staff_id=$1`,
          [staffId, record.lock_expired],
        );
        return null; // Must commit the failed-attempt count before reporting generic failure.
      }
      await client.query(
        `UPDATE ${table} SET failed_attempts=0,locked_until=NULL WHERE staff_id=$1`,
        [staffId],
      );
      const expiry = await client.query(
        `UPDATE local_staff SET access_expires_at=clock_timestamp()+interval '8 hours' WHERE id=$1
         RETURNING access_expires_at`,
        [staffId],
      );
      await client.query(
        'UPDATE staff_sessions SET revoked=true WHERE staff_id=$1 AND terminal_id=$2',
        [staffId, terminalId],
      );
      const sessionId = randomUUID(),
        token = randomBytes(32).toString('hex');
      await client.query(
        `INSERT INTO staff_sessions(id,staff_id,terminal_id,branch_id,token_hash,expires_at)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [
          sessionId,
          staffId,
          terminalId,
          branchId,
          hashToken(token),
          expiry.rows[0].access_expires_at,
        ],
      );
      await audit(
        client,
        branchId,
        staffId!,
        pinMode ? 'staff.pin_login' : 'staff.password_login',
        sessionId,
      );
      return StaffCredentialSchema.parse({
        session_id: sessionId,
        staff_id: staffId,
        terminal_id: terminalId,
        branch_id: branchId,
        role: staff.rows[0].role,
        name: staff.rows[0].name,
        expires_at: expiry.rows[0].access_expires_at.toISOString(),
        token,
      });
    });
    if (!result) {
      // The terminal was verified active by reserveAttempt; unknown ids never create state.
      if (backoff) pinBackoff.fail(backoff);
      throw new OrderError('UNAUTHORIZED');
    }
    return result;
  } finally {
    activePasswordOperations--;
  }
}

export async function logoutStaff(pool: DatabasePool, branchId: string, auth: StaffAuth) {
  return transaction(pool, async (client) => {
    if (!UuidSchema.safeParse(auth.sessionId).success || !/^[a-f0-9]{64}$/.test(auth.token))
      throw new OrderError('UNAUTHORIZED');
    const identity = await client.query(
      'SELECT staff_id FROM staff_sessions WHERE id=$1 AND branch_id=$2 AND token_hash=$3',
      [auth.sessionId, branchId, hashToken(auth.token)],
    );
    if (!identity.rows[0]) throw new OrderError('UNAUTHORIZED');
    await client.query('SELECT id FROM local_staff WHERE id=$1 FOR UPDATE', [
      identity.rows[0].staff_id,
    ]);
    const session = await authenticateStaff(client, branchId, auth);
    await client.query('UPDATE staff_sessions SET revoked=true WHERE id=$1', [session.session_id]);
    await audit(client, branchId, session.staff_id, 'staff.session_logout', session.session_id);
  });
}

async function pinLoginName(pool: DatabasePool, branchId: string, pin: string) {
  const key = (
    await pool.query('SELECT secret FROM local_pin_lookup_keys WHERE branch_id=$1', [branchId])
  ).rows[0]?.secret;
  if (!key) throw new OrderError('UNAUTHORIZED');
  return createHmac('sha256', key).update(pin).digest('hex');
}
/** Owner-only enrollment, separate from password login. Never ships demo PINs. */
export async function setStaffPin(
  pool: DatabasePool,
  branchId: string,
  bootstrap: StaffAuth,
  pin: string,
  replace = false,
) {
  if (typeof pin !== 'string' || !PIN_FORMAT.test(pin)) throw new OrderError('INVALID_REQUEST');
  await pool.query(
    'INSERT INTO local_pin_lookup_keys(branch_id,secret) VALUES($1,$2) ON CONFLICT DO NOTHING',
    [branchId, randomBytes(32).toString('hex')],
  );
  const login = await pinLoginName(pool, branchId, pin);
  const result = await setStaffPassword(
    pool,
    branchId,
    bootstrap,
    login,
    'PickChick-PIN:' + pin,
    replace,
    true,
  );
  return { staff_id: result.staff_id, role: result.role, terminal_id: result.terminal_id };
}
export async function loginStaffPin(
  pool: DatabasePool,
  branchId: string,
  input: unknown,
  terminalAuth?: TerminalAuth,
) {
  const value = input as { pin?: unknown; terminal_id?: unknown };
  if (
    !value ||
    Object.keys(value).some((k) => !['pin', 'terminal_id'].includes(k)) ||
    typeof value.pin !== 'string' ||
    !PIN_FORMAT.test(value.pin) ||
    !UuidSchema.safeParse(value.terminal_id).success
  )
    throw new OrderError('UNAUTHORIZED');
  const login = await pinLoginName(pool, branchId, value.pin);
  return loginStaff(
    pool,
    branchId,
    { login, password: 'PickChick-PIN:' + value.pin, terminal_id: value.terminal_id },
    true,
    terminalAuth,
  );
}
