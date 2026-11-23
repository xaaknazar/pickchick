import { lstat, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join, dirname, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export function validateWorkerConfig(config, origin, branchId, deviceId) {
  const url = new URL(config.databaseUrl);
  if (
    !config.posOrderSyncEnabled ||
    config.branchId !== branchId ||
    config.edgeDeviceId !== deviceId ||
    origin !== 'http://127.0.0.1:43110' ||
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '55433' ||
    url.pathname !== '/pickchick_edge' ||
    url.username !== 'pickchick_pos_sync' ||
    !/^[a-f0-9]{64}$/.test(url.password) ||
    url.search ||
    url.hash
  )
    throw new Error('Windows sync scope or dedicated database role differs');
}
export async function readWindowsIdentity(path, schema, branchId, deviceId, now = Date.now()) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
    throw Object.assign(new Error('Unsafe Windows identity file'), { code: 'IDENTITY_UNSAFE' });
  const identity = schema.parse(JSON.parse(await readFile(path, 'utf8')));
  if (
    identity.branch_id !== branchId ||
    identity.device_id !== deviceId ||
    Date.parse(identity.expires_at) <= now
  )
    throw Object.assign(new Error('Expired or mismatched Windows identity'), {
      code: 'IDENTITY_EXPIRED',
    });
  return identity;
}
/**
 * posSales (contracts 5.6, cutover CC-4): a loop of its own beside the order and kitchen streams
 * of main(), with its own schedule in @pickchick/pos-order-sync (10 minutes while the cloud does
 * not support it, own backoff, empty probe while idle). Its failures stay here: they never delay,
 * stop or log as the two other streams. A runtime whose package has no sender skips the loop.
 */
export async function runPosSalesLoop({
  pool,
  sync,
  identity,
  branchId,
  origin,
  once,
  signal,
  log = (line) => console.log(line),
  fail = (line) => console.error(line),
  pause = () =>
    delay(1000 + Math.floor(Math.random() * 250), undefined, { signal }).catch(() => undefined),
}) {
  if (
    typeof sync.syncPosSalesOnce !== 'function' ||
    typeof sync.createPosSalesSchedule !== 'function'
  )
    return;
  const schedule = sync.createPosSalesSchedule();
  do {
    let more = false;
    if (once || Date.now() >= schedule.nextAttemptAt) {
      try {
        let current;
        try {
          current = await identity();
        } catch (error) {
          schedule.failures = Math.min(schedule.failures + 1, 1000000);
          schedule.nextAttemptAt = Date.now() + sync.posRetryDelayMs(schedule.failures);
          throw error;
        }
        const result = await sync.syncPosSalesOnce(
          pool,
          { enabled: true, branchId, origin, identity: current },
          schedule,
        );
        // Whitelisted metadata only, as in main(): never bodies, URLs, credentials or identity.
        if (once || !['idle', 'busy', 'disabled', 'waiting'].includes(result.state))
          log(JSON.stringify({ event: 'pos_sales_sync', state: result.state }));
        more = result.state === 'delivered' && result.more;
        if (once && ['retry', 'parked'].includes(result.state)) process.exitCode = 1;
      } catch {
        fail(JSON.stringify({ event: 'pos_sales_sync_failed', retrying: !once }));
        if (once) process.exitCode = 1;
      }
    }
    if (once || signal.aborted) break;
    if (!more) await pause();
  } while (!signal.aborted);
}
/**
 * Whitelisted error code of a failed step: PosSyncError.code, a PostgreSQL SQLSTATE or a Node
 * system code. Anything else (messages, driver text, URLs, credentials) is never logged.
 */
export function syncErrorCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'UNKNOWN';
}
/** An unchanged retry, dead letter or failure is written again only after this long. */
export const POS_SYNC_REPEAT_LOG_MS = 600_000;
/**
 * The order and kitchen streams of main(). Each stream has its own try/catch: a stream that
 * throws on every pass never keeps the other one from running, and its failure line names the
 * stream and the error code.
 *
 * The loop passes about once a second, so a line is written when a stream's state changes, not
 * on every pass: `delivered` always, `idle`/`busy`/`disabled` never, a standing `retry`,
 * `dead_letter` or failure once and then every 10 minutes. An unreadable (for example expired)
 * identity file is read again with the 2 s .. 60 s backoff of the streams instead of every pass.
 */
export async function runPosStreamsLoop({
  pool,
  sync,
  identity,
  branchId,
  origin,
  once,
  signal,
  log = (line) => console.log(line),
  fail = (line) => console.error(line),
  pause = () =>
    delay(1000 + Math.floor(Math.random() * 250), undefined, { signal }).catch(() => undefined),
  now = Date.now,
}) {
  const seen = new Map();
  // Whether the standing state `key` of `stream` is due for a line.
  const changed = (stream, key) => {
    const last = seen.get(stream);
    if (!once && last?.key === key && now() - last.at < POS_SYNC_REPEAT_LOG_MS) return false;
    seen.set(stream, { key, at: now() });
    return true;
  };
  const failed = (stream, error) => {
    const code = syncErrorCode(error);
    if (changed(stream, `failed:${code}`))
      fail(JSON.stringify({ event: 'native_pos_sync_failed', stream, code, retrying: !once }));
    if (once) process.exitCode = 1;
  };
  let identityFailures = 0,
    identityAt = 0;
  do {
    let delivered = false,
      current;
    if (once || now() >= identityAt)
      try {
        current = await identity();
        identityFailures = 0;
        seen.delete('identity');
      } catch (error) {
        identityFailures = Math.min(identityFailures + 1, 1000000);
        identityAt = now() + Math.min(60000, 1000 * 2 ** Math.min(identityFailures, 6));
        failed('identity', error);
      }
    if (current)
      for (const [event, work] of [
        ['pos_order_sync', sync.syncPosOrdersOnce],
        ['pos_kitchen_sync', sync.syncPosKitchenOnce],
      ]) {
        try {
          const { state } = await work(pool, {
            enabled: true,
            branchId,
            origin,
            identity: current,
          });
          // Whitelisted metadata only. Never log request bodies, driver errors,
          // URLs, database credentials or the transport identity.
          if (state === 'delivered') delivered = true;
          if (once && ['retry', 'dead_letter'].includes(state)) process.exitCode = 1;
          // `busy` is another holder of the same stream: it says nothing about its state.
          if (state === 'busy' && !once) continue;
          if (['idle', 'busy', 'disabled', 'delivered'].includes(state)) {
            seen.delete(event);
            if (once || state === 'delivered') log(JSON.stringify({ event, state }));
          } else if (changed(event, state)) log(JSON.stringify({ event, state }));
        } catch (error) {
          failed(event, error);
        }
      }
    if (once || signal.aborted) break;
    if (!delivered) await pause();
  } while (!signal.aborted);
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
    importPackage('@pickchick/pos-order-sync'),
  ]);
  const config = loadConfig('edge'),
    origin = process.env.EDGE_POS_ORDER_SYNC_CLOUD_ORIGIN;
  validateWorkerConfig(config, origin, branchId, deviceId);
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
  const pool = createPool(config.databaseUrl),
    stop = new AbortController(),
    once = extra.includes('--once');
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stop.abort());
  const sales = runPosSalesLoop({
    pool,
    sync,
    identity: () => readWindowsIdentity(identityPath, DeviceIdentitySchema, branchId, deviceId),
    branchId,
    origin,
    once,
    signal: stop.signal,
  });
  try {
    await runPosStreamsLoop({
      pool,
      sync,
      identity: () => readWindowsIdentity(identityPath, DeviceIdentitySchema, branchId, deviceId),
      branchId,
      origin,
      once,
      signal: stop.signal,
    });
  } finally {
    // The posSales loop ends with the same signal (or after its single --once step).
    await sales;
    await pool.end();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(JSON.stringify({ event: 'native_pos_sync_start_failed' }));
    process.exitCode = 1;
  });
}
