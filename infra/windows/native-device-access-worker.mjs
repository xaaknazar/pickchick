import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join, dirname, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { readWindowsIdentity } from './native-pos-sync-worker.mjs';

export function validateDeviceAccessWorker(config, origin, branchId, deviceId, env = process.env) {
  const url = new URL(config.databaseUrl);
  if (
    env.DEVICE_ACCESS_WORKER_ENABLED !== 'true' ||
    !config.edgeFulfillmentEnabled ||
    config.branchId !== branchId ||
    config.edgeDeviceId !== deviceId ||
    origin !== 'http://127.0.0.1:43100' ||
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '55433' ||
    url.pathname !== '/pickchick_edge' ||
    url.username !== 'pickchick_device_access_sync' ||
    !/^[a-f0-9]{64}$/.test(url.password) ||
    url.search ||
    url.hash
  )
    throw new Error('Device mailbox worker scope differs');
}
async function main() {
  const [identityPath, branchId, deviceId, ...extra] = process.argv.slice(2);
  if (
    process.platform !== 'win32' ||
    !identityPath ||
    !win32.isAbsolute(identityPath) ||
    win32.basename(identityPath) !== 'device-identity.json' ||
    extra.some((arg) => arg !== '--once') ||
    extra.length > 1
  )
    throw new Error('Windows device worker invocation required');
  const require = createRequire(new URL('../../package.json', import.meta.url));
  const load = (name) => import(pathToFileURL(require.resolve(name)).href);
  const [
    { loadConfig },
    { createPool },
    { DeviceIdentitySchema },
    { TerminalAccess, exchangeTerminalAccess, KitchenPasswordReset },
  ] = await Promise.all([
    load('@pickchick/platform'),
    load('@pickchick/database'),
    load('@pickchick/contracts'),
    load('@pickchick/local-orders'),
  ]);
  const config = loadConfig('edge'),
    origin = process.env.EDGE_FULFILLMENT_CLOUD_ORIGIN;
  validateDeviceAccessWorker(config, origin, branchId, deviceId);
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
    access = new TerminalAccess(pool, branchId, deviceId),
    stop = new AbortController(),
    once = extra.includes('--once');
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stop.abort());
  try {
    do {
      try {
        const identity = await readWindowsIdentity(
          identityPath,
          DeviceIdentitySchema,
          branchId,
          deviceId,
        );
        const result = await exchangeTerminalAccess(
          access,
          identity,
          origin,
          fetch,
          new KitchenPasswordReset(pool, branchId, deviceId),
        );
        if (once || result.received || result.acknowledged)
          console.log(JSON.stringify({ event: 'device_access_exchange', ...result }));
      } catch {
        // Only a fixed event, never HTTP bodies, database diagnostics, identity or codes.
        console.error(JSON.stringify({ event: 'device_access_exchange_failed' }));
        if (once) process.exitCode = 1;
      }
      if (once || stop.signal.aborted) break;
      await delay(2000, undefined, { signal: stop.signal }).catch(() => undefined);
    } while (!stop.signal.aborted);
  } finally {
    await pool.end();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error(JSON.stringify({ event: 'device_access_worker_start_failed' }));
    process.exitCode = 1;
  });
