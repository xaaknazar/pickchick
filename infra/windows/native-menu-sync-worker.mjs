import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join, dirname, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { readWindowsIdentity } from './native-pos-sync-worker.mjs';

export { readWindowsIdentity };

/** The private cloud API through the existing fulfillment tunnel; never a WAN origin. */
export const MENU_SYNC_ORIGIN = 'http://127.0.0.1:43100';
export const MENU_SYNC_DATABASE_ROLE = 'pickchick_menu_sync';
export const MENU_SYNC_SCHEMA = '018_edge_menu_publication.sql';
const IDLE_MS = 2000;
const MAX_BACKOFF_MS = 60000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * off (default): no cloud request and no database write; the service stays installed idle.
 * report: reports the active menu on every pull (cloud edge_menu_state bootstrap) and drains
 *   already committed ACKs, but holds any delivered publication without applying it.
 * apply: downloads photos and applies publications.
 */
export function menuSyncMode(env = process.env) {
  const value = env.EDGE_MENU_SYNC_MODE ?? 'off';
  if (!['off', 'report', 'apply'].includes(value))
    throw new Error('EDGE_MENU_SYNC_MODE must be off, report or apply');
  return value;
}

/** 2 s between idle polls; exponential backoff capped at 60 s after failures. */
export function menuSyncRetryDelay(failures, random = Math.random) {
  if (!Number.isInteger(failures) || failures < 0) throw new Error('Invalid failure count');
  if (failures === 0) return IDLE_MS;
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(6, failures)) + Math.floor(random() * 500);
}

/**
 * Pins the worker to its dedicated role on the local edge database, the exact tunnel origin
 * and the branch/device it was installed for. The env file must not enable other edge roles.
 */
export function validateWorkerConfig(config, env, origin, branchId, deviceId) {
  let url;
  try {
    url = new URL(config.databaseUrl);
  } catch {
    throw new Error('Windows menu sync scope or dedicated database role differs');
  }
  if (
    config.service !== 'edge' ||
    !uuid.test(branchId ?? '') ||
    !uuid.test(deviceId ?? '') ||
    config.branchId !== branchId ||
    env.EDGE_DEVICE_ID !== deviceId ||
    origin !== MENU_SYNC_ORIGIN ||
    config.edgeFulfillmentEnabled ||
    config.fulfillmentTransportEnabled ||
    config.posOrderSyncEnabled ||
    config.remoteStopsEnabled ||
    config.testOrderFlowEnabled ||
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '55433' ||
    url.pathname !== '/pickchick_edge' ||
    url.username !== MENU_SYNC_DATABASE_ROLE ||
    !/^[a-f0-9]{64}$/.test(url.password) ||
    url.search ||
    url.hash
  )
    throw new Error('Windows menu sync scope or dedicated database role differs');
}

/** Sanitized failure class for logs: never a message body, URL, token or SQL text. */
export function failureCode(error) {
  if (error && typeof error === 'object') {
    // menu-sync SyncError: message and code are the same fixed code.
    if (
      ['INVALID_REQUEST', 'UNAUTHORIZED', 'CONFLICT', 'NOT_FOUND'].includes(error.code) &&
      error.message === error.code
    )
      return error.code;
    const status = /^Sync HTTP (\d{3})$/.exec(error.message ?? '')?.[1];
    if (status) return `HTTP_${status}`;
    if (/Windows identity/.test(error.message ?? '')) return 'IDENTITY';
    if (error.name === 'ZodError' || error.name === 'SyntaxError') return 'INVALID_DATA';
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'TIMEOUT';
    if (typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) return 'DATABASE';
    if (typeof error.code === 'string' && /^E[A-Z]+$/.test(error.code)) return 'NETWORK';
  }
  return 'UNEXPECTED';
}

/**
 * Service loop with injected effects so it is testable off Windows.
 * - mode off: logs once and waits for the stop signal; no request, no database access.
 * - otherwise: checks schema018 first, then loops syncMenuOnce. Applied/acknowledged/rejected
 *   results continue at once (drain), idle/held wait 2 s, failures back off up to 60 s.
 * Logs are JSON events with states, versions and sanitized codes only.
 */
export async function runMenuSyncLoop({
  mode,
  once = false,
  signal,
  sync,
  schemaReady,
  log,
  wait = (ms) =>
    delay(ms, undefined, { signal }).catch((error) => {
      if (error.name !== 'AbortError') throw error;
    }),
  random = Math.random,
}) {
  if (mode === 'off') {
    log({ event: 'menu_sync_disabled', mode });
    if (!once) while (!signal.aborted) await wait(60000);
    return { exitCode: 0 };
  }
  let failures = 0,
    held = null,
    ready = false,
    exitCode = 0;
  do {
    let drain = false;
    try {
      if (!ready) {
        if (!(await schemaReady())) {
          failures = Math.min(6, failures + 1);
          log({ event: 'menu_sync_schema_missing', retrying: !once });
          if (once) exitCode = 1;
          if (once || signal.aborted) break;
          await wait(menuSyncRetryDelay(failures, random));
          continue;
        }
        ready = true;
      }
      const result = await sync({ applyEvents: mode === 'apply' });
      failures = 0;
      if (result.state === 'held') {
        const key = `${result.release_id}:${result.version}`;
        // Report mode polls every 2 s; log a held publication once, not on every poll.
        if (once || key !== held)
          log({
            event: 'menu_sync',
            mode,
            state: 'held',
            release_id: result.release_id,
            version: result.version,
          });
        held = key;
      } else {
        held = null;
        if (once || result.state !== 'idle') log({ event: 'menu_sync', mode, ...result });
        drain = ['applied', 'acknowledged', 'rejected'].includes(result.state);
      }
    } catch (error) {
      failures = Math.min(6, failures + 1);
      log({ event: 'menu_sync_failed', code: failureCode(error), failures, retrying: !once });
      if (once) exitCode = 1;
    }
    if (once || signal.aborted) break;
    if (!drain) await wait(menuSyncRetryDelay(failures, random));
  } while (!signal.aborted);
  return { exitCode };
}

async function main() {
  const [identityPath, branchId, deviceId, ...extra] = process.argv.slice(2);
  if (
    process.platform !== 'win32' ||
    !identityPath ||
    extra.some((arg) => arg !== '--once') ||
    extra.length > 1 ||
    !win32.isAbsolute(identityPath) ||
    win32.basename(identityPath) !== 'device-identity.json'
  )
    throw new Error('Windows service invocation required');
  // This script lives in immutable app/infra/windows; the resolved dependency
  // closure belongs to that release, never a user-selected module directory.
  const require = createRequire(new URL('../../package.json', import.meta.url));
  const importPackage = (name) => import(pathToFileURL(require.resolve(name)).href);
  const [{ loadConfig }, { createPool }, { DeviceIdentitySchema }, sync] = await Promise.all([
    importPackage('@pickchick/platform'),
    importPackage('@pickchick/database'),
    importPackage('@pickchick/contracts'),
    importPackage('@pickchick/menu-sync'),
  ]);
  const mode = menuSyncMode(),
    config = loadConfig('edge'),
    origin = process.env.EDGE_MENU_SYNC_CLOUD_ORIGIN;
  validateWorkerConfig(config, process.env, origin, branchId, deviceId);
  const stop = new AbortController(),
    once = extra.includes('--once');
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stop.abort());
  const log = (entry) => console.log(JSON.stringify(entry));
  if (mode === 'off') {
    process.exitCode = (await runMenuSyncLoop({ mode, once, signal: stop.signal, log })).exitCode;
    return;
  }
  // Same protected device identity as the fulfillment worker; ACL checked before reading.
  await promisify(execFile)(
    join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(dirname(fileURLToPath(import.meta.url)), 'native-pos-sync-permissions.ps1'),
      '-IdentityPath',
      identityPath,
    ],
    { windowsHide: true, timeout: 15000, maxBuffer: 4096 },
  );
  const pool = createPool(config.databaseUrl, 2);
  // Photo download failures per menu event; after three the publication is ACKed rejected.
  const mediaAttempts = new Map();
  try {
    const { exitCode } = await runMenuSyncLoop({
      mode,
      once,
      signal: stop.signal,
      log,
      schemaReady: async () =>
        (
          await pool.query("SELECT 1 FROM schema_migrations WHERE scope='edge' AND version=$1", [
            MENU_SYNC_SCHEMA,
          ])
        ).rowCount === 1,
      sync: async ({ applyEvents }) =>
        sync.syncMenuOnce(
          pool,
          branchId,
          origin,
          await readWindowsIdentity(identityPath, DeviceIdentitySchema, branchId, deviceId),
          { mediaAttempts, applyEvents },
        ),
    });
    process.exitCode = exitCode;
  } finally {
    await pool.end();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(JSON.stringify({ event: 'native_menu_sync_start_failed' }));
    process.exitCode = 1;
  });
}
