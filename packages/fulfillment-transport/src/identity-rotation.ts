import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { DeviceIdentitySchema } from '@pickchick/contracts';
import type { DeviceIdentity } from '@pickchick/contracts';
import { deviceJsonRequest, TransportHttpError } from './http.js';
import type { TransportIo } from './http.js';

const DAY_MS = 24 * 3600 * 1000;
/** Cloud renews only inside its 10-day window; start one hour later to absorb clock skew. */
export const IDENTITY_RENEWAL_THRESHOLD_MS = 10 * DAY_MS - 3600 * 1000;
/** Below this the operator must act even if automatic renewal is running. */
export const IDENTITY_CRITICAL_MS = 3 * DAY_MS;

export type IdentityExpiryState = 'ok' | 'renewal_due' | 'critical' | 'expired';
export interface IdentityExpiryStatus {
  state: IdentityExpiryState;
  /** Whole hundredths of a day, rounded down; negative once expired. */
  daysRemaining: number;
  expiresAt: string;
}

/** Days to expiry of a stored identity, for worker status lines and monitoring. */
export function identityExpiryStatus(
  identity: { expires_at: string },
  now = Date.now(),
): IdentityExpiryStatus {
  const expires = Date.parse(identity.expires_at);
  if (!Number.isFinite(expires)) throw new Error('Invalid identity expiry');
  const remaining = expires - now;
  return {
    state:
      remaining <= 0
        ? 'expired'
        : remaining < IDENTITY_CRITICAL_MS
          ? 'critical'
          : remaining < IDENTITY_RENEWAL_THRESHOLD_MS
            ? 'renewal_due'
            : 'ok',
    daysRemaining: Math.floor((remaining / DAY_MS) * 100) / 100,
    expiresAt: new Date(expires).toISOString(),
  };
}

/** EDGE_IDENTITY_AUTO_ROTATE: 'true' or 'false' (default). Anything else is a configuration error. */
export function edgeIdentityAutoRotate(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.EDGE_IDENTITY_AUTO_ROTATE ?? 'false';
  if (value !== 'true' && value !== 'false')
    throw new Error('EDGE_IDENTITY_AUTO_ROTATE must be true or false');
  return value === 'true';
}

const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const RotatedSchema = z.strictObject({
  device_id: z.uuid(),
  branch_id: z.uuid(),
  token: hex64,
  expires_at: z.iso.datetime(),
  rotation_id: z.uuid(),
  previous_valid_until: z.iso.datetime(),
  replayed: z.boolean(),
});
const ConfirmedSchema = z.strictObject({
  device_id: z.uuid(),
  rotation_id: z.uuid(),
  expires_at: z.iso.datetime(),
  confirmed_at: z.iso.datetime(),
  previous_valid_until: z.iso.datetime().nullable(),
});
/** Durable before the first request, so a crash or lost response replays the same rotation. */
const IntentSchema = z.strictObject({
  format: z.literal('pickchick-edge-identity-rotation-v1'),
  rotation_id: z.uuid(),
  device_id: z.uuid(),
  from_token_sha256: hex64,
  created_at: z.iso.datetime(),
});
type Intent = z.infer<typeof IntentSchema>;

export interface IdentityRenewalOptions {
  /** The identity file the workers read (exactly the four DeviceIdentity fields). */
  path: string;
  /** Other copies of the same device identity, replaced together (only if they hold the old token). */
  mirrors?: readonly string[];
  origin: string;
  branchId: string;
  deviceId: string;
  io?: TransportIo;
  now?: () => number;
  /** Applied to every temporary file before it is renamed into place (Windows protected ACL). */
  secureFile?: (path: string) => Promise<void>;
  newRotationId?: () => string;
  /** A lock older than this is considered abandoned by a crashed run. Default 10 minutes. */
  lockStaleMs?: number;
}
export type MirrorState = 'replaced' | 'current' | 'mismatch' | 'missing';
export interface IdentityRenewalResult {
  state: 'not_due' | 'rotated' | 'busy' | 'retry' | 'refused' | 'unauthorized' | 'blocked';
  error?: string;
  daysRemaining?: number;
  expiresAt?: string;
  replayed?: boolean;
  mirrors?: MirrorState[];
}

class RenewalStop extends Error {
  constructor(readonly result: IdentityRenewalResult) {
    super(result.state);
  }
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const serialize = (identity: DeviceIdentity) =>
  `${JSON.stringify(DeviceIdentitySchema.parse(identity))}\n`;
const isMissing = (error: unknown) =>
  !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT';

async function readBounded(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
    throw new RenewalStop({ state: 'blocked', error: 'UNSAFE_FILE' });
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new RenewalStop({ state: 'blocked', error: 'UNREADABLE_FILE' });
  }
}
async function readIdentity(path: string, options: IdentityRenewalOptions) {
  const parsed = DeviceIdentitySchema.safeParse(await readBounded(path));
  if (
    !parsed.success ||
    parsed.data.device_id !== options.deviceId ||
    parsed.data.branch_id !== options.branchId
  )
    throw new RenewalStop({ state: 'blocked', error: 'IDENTITY_SCOPE_MISMATCH' });
  return parsed.data;
}
async function readOptional<T>(path: string, read: (path: string) => Promise<T>) {
  try {
    await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  return read(path);
}

/** Temp file in the same directory, fsync, protect, then one rename over the target. */
async function writeAtomic(target: string, text: string, options: IdentityRenewalOptions) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.secureFile?.(temporary);
    // A reader without FILE_SHARE_DELETE can briefly block a Windows rename.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, target);
        break;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (attempt >= 9 || !['EPERM', 'EBUSY', 'EACCES'].includes(String(code))) throw error;
        await delay(100 * (attempt + 1));
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
  if (process.platform !== 'win32') {
    const directory = await open(dirname(target), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

/** Wall-clock staleness (file mtimes), independent of an injected test clock. */
async function acquireLock(path: string, staleMs: number) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.close();
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'EEXIST') throw error;
      const info = await stat(path).catch(() => null);
      if (info && Date.now() - info.mtimeMs < staleMs) return false;
      await rm(path, { force: true });
    }
  }
  return false;
}

const httpStatus = (error: unknown) =>
  error instanceof TransportHttpError && error.code === 'HTTP_REJECTED' ? error.status : undefined;
const transportCode = (error: unknown) =>
  error instanceof TransportHttpError
    ? error.code
    : error instanceof z.ZodError
      ? 'INVALID_RESPONSE'
      : 'LOCAL_STORAGE_UNKNOWN';

async function confirm(
  options: IdentityRenewalOptions,
  identity: DeviceIdentity,
  intent: Intent,
): Promise<'confirmed' | 'rejected'> {
  try {
    const confirmed = ConfirmedSchema.parse(
      await deviceJsonRequest(
        options.origin,
        '/internal/v1/edge/identity/confirm',
        identity,
        { rotation_id: intent.rotation_id },
        options.io,
      ),
    );
    if (
      confirmed.device_id !== identity.device_id ||
      confirmed.rotation_id !== intent.rotation_id ||
      Date.parse(confirmed.expires_at) !== Date.parse(identity.expires_at)
    )
      throw new TransportHttpError('INVALID_RESPONSE');
    return 'confirmed';
  } catch (error) {
    if ([401, 409].includes(httpStatus(error) ?? 0)) return 'rejected';
    // Rotation unavailable (cloud flag off or an older API): the cloud may already hold the
    // candidate as the current key, so keep .next and the intent and confirm on a later run.
    if (httpStatus(error) === 404)
      throw new RenewalStop({ state: 'refused', error: 'CLOUD_ROTATION_DISABLED' });
    throw new RenewalStop({ state: 'retry', error: transportCode(error) });
  }
}

/** Replace one copy only when it still holds the rotated-away credential; keep it as .previous. */
async function replace(
  target: string,
  candidate: DeviceIdentity,
  intent: Intent,
  options: IdentityRenewalOptions,
): Promise<MirrorState> {
  const existing = await readOptional(target, (path) => readIdentity(path, options));
  if (!existing) return 'missing';
  if (existing.token === candidate.token) return 'current';
  if (sha256(existing.token) !== intent.from_token_sha256) return 'mismatch';
  await writeAtomic(`${target}.previous`, serialize(existing), options);
  await writeAtomic(target, serialize(candidate), options);
  return 'replaced';
}

async function finish(
  options: IdentityRenewalOptions,
  current: DeviceIdentity,
  intent: Intent,
  extra: Partial<IdentityRenewalResult>,
): Promise<IdentityRenewalResult> {
  const mirrors: MirrorState[] = [];
  for (const mirror of options.mirrors ?? [])
    mirrors.push(await replace(mirror, current, intent, options));
  // The new credential is confirmed by the cloud and in place everywhere: drop the old copies.
  for (const target of [options.path, ...(options.mirrors ?? [])])
    await rm(`${target}.previous`, { force: true });
  await rm(`${options.path}.next`, { force: true });
  await rm(`${options.path}.rotation`, { force: true });
  const status = identityExpiryStatus(current, (options.now ?? Date.now)());
  return {
    state: 'rotated',
    daysRemaining: status.daysRemaining,
    expiresAt: status.expiresAt,
    ...(mirrors.length ? { mirrors } : {}),
    ...extra,
  };
}

async function renewLocked(options: IdentityRenewalOptions): Promise<IdentityRenewalResult> {
  const now = options.now ?? Date.now;
  const intentPath = `${options.path}.rotation`,
    nextPath = `${options.path}.next`;
  let current = await readIdentity(options.path, options);
  let intent = await readOptional(intentPath, async (path) => {
    const parsed = IntentSchema.safeParse(await readBounded(path));
    if (!parsed.success || parsed.data.device_id !== options.deviceId)
      throw new RenewalStop({ state: 'blocked', error: 'INTENT_MISMATCH' });
    return parsed.data;
  });
  const status = identityExpiryStatus(current, now());
  const summary = { daysRemaining: status.daysRemaining, expiresAt: status.expiresAt };
  if (!intent) {
    if (status.state === 'expired') return { state: 'unauthorized', error: 'EXPIRED', ...summary };
    if (status.state === 'ok') return { state: 'not_due', ...summary };
    intent = {
      format: 'pickchick-edge-identity-rotation-v1',
      rotation_id: (options.newRotationId ?? randomUUID)(),
      device_id: current.device_id,
      from_token_sha256: sha256(current.token),
      created_at: new Date(now()).toISOString(),
    };
    await writeAtomic(intentPath, `${JSON.stringify(IntentSchema.parse(intent))}\n`, options);
  }
  if (intent.from_token_sha256 !== sha256(current.token)) {
    // A previous run swapped the file but did not finish: confirm and complete the mirrors.
    if ((await confirm(options, current, intent)) === 'confirmed')
      return finish(options, current, intent, {});
    // The file holds some other credential (for example a manual re-provisioning).
    await rm(nextPath, { force: true });
    await rm(intentPath, { force: true });
    return { state: 'refused', error: 'INTENT_DISCARDED', ...summary };
  }
  let candidate = await readOptional(nextPath, (path) => readIdentity(path, options));
  let replayed = false;
  if (candidate && candidate.token === current.token) candidate = null;
  if (!candidate) {
    // The replaced key is never valid past its own expiry, so a replay cannot succeed.
    if (status.state === 'expired') return { state: 'unauthorized', error: 'EXPIRED', ...summary };
    let issued;
    try {
      issued = RotatedSchema.parse(
        await deviceJsonRequest(
          options.origin,
          '/internal/v1/edge/identity/rotate',
          current,
          { rotation_id: intent.rotation_id },
          options.io,
        ),
      );
    } catch (error) {
      const code = httpStatus(error);
      // Rotation unavailable (cloud flag off or an older API). An earlier attempt with this
      // rotation_id may have committed with its response lost: only this id can replay it, so
      // keep the intent. A new id would get 409 forever and the device would lock out at expiry.
      if (code === 404) return { state: 'refused', error: 'CLOUD_ROTATION_DISABLED', ...summary };
      // The cloud answered for this rotation_id: nothing can be replayed, the next due run
      // starts afresh.
      if (code === 401) {
        await rm(intentPath, { force: true });
        return { state: 'unauthorized', error: 'CREDENTIAL_REJECTED', ...summary };
      }
      if (code === 400 || code === 409) {
        await rm(intentPath, { force: true });
        return { state: 'refused', error: 'ROTATION_REFUSED', ...summary };
      }
      return { state: 'retry', error: transportCode(error), ...summary };
    }
    if (
      issued.device_id !== current.device_id ||
      issued.branch_id !== current.branch_id ||
      issued.rotation_id !== intent.rotation_id ||
      issued.token === current.token ||
      Date.parse(issued.expires_at) <= Date.parse(current.expires_at)
    )
      return { state: 'retry', error: 'INVALID_RESPONSE', ...summary };
    replayed = issued.replayed;
    candidate = DeviceIdentitySchema.parse({
      device_id: issued.device_id,
      branch_id: issued.branch_id,
      token: issued.token,
      expires_at: issued.expires_at,
    });
    await writeAtomic(nextPath, serialize(candidate), options);
  }
  if ((await confirm(options, candidate, intent)) === 'rejected') {
    // Never install a credential the cloud does not accept; replay with the old one next run.
    await rm(nextPath, { force: true });
    return { state: 'retry', error: 'CANDIDATE_REJECTED', ...summary };
  }
  if ((await replace(options.path, candidate, intent, options)) !== 'replaced')
    return { state: 'blocked', error: 'SWAP_FAILED', ...summary };
  current = await readIdentity(options.path, options);
  if (current.token !== candidate.token)
    return { state: 'blocked', error: 'SWAP_FAILED', ...summary };
  return finish(options, current, intent, { replayed });
}

/**
 * One renewal turn for a device identity file (EDGE_IDENTITY_AUTO_ROTATE). Does nothing until the
 * credential is inside the renewal window. Protocol: durable intent -> rotate -> write .next ->
 * confirm with the new credential -> keep .previous, rename .next over the file (and mirrors) ->
 * remove .previous/.next/intent. Every step is resumable; the token is never logged or returned.
 */
export async function renewIdentityFile(
  options: IdentityRenewalOptions,
): Promise<IdentityRenewalResult> {
  const lockPath = `${options.path}.lock`;
  if (!(await acquireLock(lockPath, options.lockStaleMs ?? 10 * 60 * 1000)))
    return { state: 'busy' };
  try {
    return await renewLocked(options);
  } catch (error) {
    if (error instanceof RenewalStop) return error.result;
    return { state: 'retry', error: transportCode(error) };
  } finally {
    await rm(lockPath, { force: true });
  }
}
