import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve, join, dirname, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

/**
 * Automatic device identity renewal on the Windows cashier (docs/operations/edge-identity-rotation.md).
 *
 * The always-running workers (FulfillmentWorker, MenuSync, PosSync) run as LocalService and may
 * only READ device-identity.json; native-pos-sync-permissions.ps1 refuses any broader ACL at their
 * start. Renewal therefore runs here, as an hourly SYSTEM scheduled task that owns the write,
 * while the workers keep re-reading the file before every cycle. EDGE_IDENTITY_AUTO_ROTATE
 * (default false) gates every cloud request and file change.
 */
export const IDENTITY_ROTATION_ORIGIN = 'http://127.0.0.1:43100';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LOG_BYTES = 1024 * 1024;

function identityFile(path) {
  if (
    typeof path !== 'string' ||
    !win32.isAbsolute(path) ||
    !/^[a-zA-Z]:\\/.test(path) ||
    path.slice(2).includes(':') ||
    win32.basename(path) !== 'device-identity.json' ||
    win32.normalize(path) !== path
  )
    throw new Error('Windows identity rotation invocation differs');
  return path;
}

/**
 * <identity> <branch> <device> [--mirror <identity>]... --log <file>. Mirrors are other
 * copies of the same device identity (PosSync). Paths are absolute, normalized and distinct.
 */
export function parseRotationArgs(argv) {
  const [identityPath, branchId, deviceId, ...rest] = argv;
  const mirrors = [];
  let logPath;
  for (let index = 0; index < rest.length; index += 2) {
    const [flag, value] = [rest[index], rest[index + 1]];
    if (flag === '--mirror' && value !== undefined) mirrors.push(identityFile(value));
    else if (flag === '--log' && value !== undefined && logPath === undefined) logPath = value;
    else throw new Error('Windows identity rotation invocation differs');
  }
  const primary = identityFile(identityPath);
  const all = [primary, ...mirrors].map((path) => path.toLowerCase());
  if (
    !uuid.test(branchId ?? '') ||
    !uuid.test(deviceId ?? '') ||
    mirrors.length > 3 ||
    new Set(all).size !== all.length ||
    typeof logPath !== 'string' ||
    !win32.isAbsolute(logPath) ||
    win32.normalize(logPath) !== logPath ||
    !/^[a-zA-Z]:\\/.test(logPath) ||
    logPath.slice(2).includes(':') ||
    win32.extname(logPath) !== '.log' ||
    all.includes(logPath.toLowerCase())
  )
    throw new Error('Windows identity rotation invocation differs');
  return {
    identityPath: primary,
    branchId: branchId.toLowerCase(),
    deviceId: deviceId.toLowerCase(),
    mirrors,
    logPath,
  };
}

/** Off unless EDGE_IDENTITY_AUTO_ROTATE=true; then only the private tunnel origin is accepted. */
export function rotationSettings(env, autoRotate) {
  const enabled = autoRotate(env);
  const origin = env.EDGE_IDENTITY_ROTATION_ORIGIN ?? IDENTITY_ROTATION_ORIGIN;
  if (enabled && origin !== IDENTITY_ROTATION_ORIGIN)
    throw new Error('Identity rotation requires the private tunnel origin');
  return { enabled, origin };
}

/** Whitelisted status line: never the token, rotation id, file contents or paths. */
export function rotationLogEntry(result, now = new Date()) {
  const entry = { event: 'edge_identity_rotation', at: now.toISOString(), state: result.state };
  for (const [key, name] of [
    ['error', 'error'],
    ['daysRemaining', 'days_remaining'],
    ['expiresAt', 'expires_at'],
    ['identityState', 'identity_state'],
    ['replayed', 'replayed'],
    ['mirrors', 'mirrors'],
  ])
    if (result[key] !== undefined) entry[name] = result[key];
  return entry;
}

/** Process exit for Task Scheduler's "Last Run Result": non-zero needs operator attention. */
export function rotationExitCode(state) {
  return ['not_due', 'rotated', 'busy', 'disabled'].includes(state) ? 0 : 1;
}

async function appendLog(path, entry) {
  await mkdir(dirname(path), { recursive: true });
  const size = (await stat(path).catch(() => null))?.size ?? 0;
  if (size > MAX_LOG_BYTES) {
    await rm(`${path}.1`, { force: true });
    await rename(path, `${path}.1`);
  }
  await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows scheduled task invocation required');
  const args = parseRotationArgs(process.argv.slice(2));
  const log = (entry) => appendLog(args.logPath, entry);
  try {
    // This script lives in immutable app/infra/windows; the resolved dependency
    // closure belongs to that release, never a user-selected module directory.
    const require = createRequire(new URL('../../package.json', import.meta.url));
    const importPackage = (name) => import(pathToFileURL(require.resolve(name)).href);
    const [{ DeviceIdentitySchema }, transport] = await Promise.all([
      importPackage('@pickchick/contracts'),
      importPackage('@pickchick/fulfillment-transport'),
    ]);
    const settings = rotationSettings(process.env, transport.edgeIdentityAutoRotate);
    const powershell = join(
      process.env.SystemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const here = dirname(fileURLToPath(import.meta.url));
    const runScript = (script, parameters) =>
      promisify(execFile)(
        powershell,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(here, script),
          ...parameters,
        ],
        { windowsHide: true, timeout: 15000, maxBuffer: 4096 },
      );
    // The workers' own startup check: every copy must keep the protected LocalService-read ACL.
    const verify = async () => {
      for (const path of [args.identityPath, ...args.mirrors]) {
        if (path !== args.identityPath && !(await stat(path).catch(() => null))) continue;
        await runScript('native-pos-sync-permissions.ps1', ['-IdentityPath', path]);
      }
    };
    await verify();
    const identity = DeviceIdentitySchema.parse(
      JSON.parse(await readFile(args.identityPath, 'utf8')),
    );
    if (identity.branch_id !== args.branchId || identity.device_id !== args.deviceId)
      throw new Error('Identity scope differs');
    const status = transport.identityExpiryStatus(identity);
    if (!settings.enabled) {
      await log(
        rotationLogEntry({
          state: 'disabled',
          identityState: status.state,
          daysRemaining: status.daysRemaining,
          expiresAt: status.expiresAt,
        }),
      );
      return;
    }
    const result = await transport.renewIdentityFile({
      path: args.identityPath,
      mirrors: args.mirrors,
      origin: settings.origin,
      branchId: args.branchId,
      deviceId: args.deviceId,
      secureFile: async (path) => {
        await runScript('native-identity-acl.ps1', ['-Path', path]);
      },
    });
    if (result.state === 'rotated') await verify();
    await log(rotationLogEntry(result));
    process.exitCode = rotationExitCode(result.state);
  } catch {
    await log(rotationLogEntry({ state: 'failed' })).catch(() => undefined);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(JSON.stringify({ event: 'edge_identity_rotation_start_failed' }));
    process.exitCode = 1;
  });
}
