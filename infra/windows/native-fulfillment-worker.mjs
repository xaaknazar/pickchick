import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join, dirname, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export function fulfillmentRetryDelay(failures, random = Math.random) {
  // The same loop publishes the stop-list heartbeat, which expires after 30s.
  // A blocked order must not make a connected restaurant appear offline. Keep
  // retry pacing below that window, with headroom for bounded HTTP requests.
  return (
    Math.min(15000, 1000 * 2 ** Math.min(6, Math.max(0, failures))) + Math.floor(random() * 250)
  );
}

export function validateWorkerConfig(config, origin, branchId, deviceId) {
  const url = new URL(config.databaseUrl);
  if (
    !config.fulfillmentTransportEnabled ||
    !config.edgeFulfillmentEnabled ||
    config.branchId !== branchId ||
    config.edgeDeviceId !== deviceId ||
    origin !== 'http://127.0.0.1:43100' ||
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '55433' ||
    url.pathname !== '/pickchick_edge' ||
    url.username !== 'pickchick_fulfillment_sync' ||
    !/^[a-f0-9]{64}$/.test(url.password) ||
    url.search ||
    url.hash
  )
    throw new Error('Windows sync scope or dedicated database role differs');
}
export { readWindowsIdentity } from './native-pos-sync-worker.mjs';
import { readWindowsIdentity } from './native-pos-sync-worker.mjs';
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
    importPackage('@pickchick/fulfillment-transport'),
  ]);
  const config = loadConfig('edge'),
    origin = process.env.EDGE_FULFILLMENT_CLOUD_ORIGIN;
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
  let failures = 0;
  try {
    do {
      let delivered = false;
      try {
        const identity = await readWindowsIdentity(
          identityPath,
          DeviceIdentitySchema,
          branchId,
          deviceId,
        );
        const result = await sync.syncFulfillmentOnce(pool, {
          enabled: true,
          branchId,
          origin,
          identity,
        });
        if (once || !['idle', 'busy', 'disabled'].includes(result.state))
          console.log(JSON.stringify({ event: 'fulfillment_transport', ...result }));
        delivered = ['applied', 'acknowledged'].includes(result.state);
        if (['retry', 'blocked', 'parked'].includes(result.state)) {
          failures = Math.min(6, failures + 1);
          if (once) process.exitCode = 1;
        } else failures = 0;
      } catch {
        failures = Math.min(6, failures + 1);
        console.error(JSON.stringify({ event: 'native_fulfillment_sync_failed', retrying: !once }));
        if (once) process.exitCode = 1;
      }
      if (once || stop.signal.aborted) break;
      if (!delivered)
        await delay(fulfillmentRetryDelay(failures), undefined, {
          signal: stop.signal,
        }).catch(() => undefined);
    } while (!stop.signal.aborted);
  } finally {
    await pool.end();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(JSON.stringify({ event: 'native_fulfillment_sync_start_failed' }));
    process.exitCode = 1;
  });
}
