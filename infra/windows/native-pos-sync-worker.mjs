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
    origin !== 'http://127.0.0.1:43100' ||
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
    throw new Error('Unsafe Windows identity file');
  const identity = schema.parse(JSON.parse(await readFile(path, 'utf8')));
  if (
    identity.branch_id !== branchId ||
    identity.device_id !== deviceId ||
    Date.parse(identity.expires_at) <= now
  )
    throw new Error('Expired or mismatched Windows identity');
  return identity;
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
        for (const [event, work] of [
          ['pos_order_sync', sync.syncPosOrdersOnce],
          ['pos_kitchen_sync', sync.syncPosKitchenOnce],
        ]) {
          const result = await work(pool, { enabled: true, branchId, origin, identity });
          // Whitelisted metadata only. Never log request bodies, driver errors,
          // URLs, database credentials or the transport identity.
          if (once || !['idle', 'busy', 'disabled'].includes(result.state))
            console.log(JSON.stringify({ event, state: result.state }));
          if (result.state === 'delivered') delivered = true;
          if (once && ['retry', 'dead_letter'].includes(result.state)) process.exitCode = 1;
        }
      } catch {
        console.error(JSON.stringify({ event: 'native_pos_sync_failed', retrying: !once }));
        if (once) process.exitCode = 1;
      }
      if (once || stop.signal.aborted) break;
      if (!delivered)
        await delay(1000 + Math.floor(Math.random() * 250), undefined, {
          signal: stop.signal,
        }).catch(() => undefined);
    } while (!stop.signal.aborted);
  } finally {
    await pool.end();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(JSON.stringify({ event: 'native_pos_sync_start_failed' }));
    process.exitCode = 1;
  });
}
