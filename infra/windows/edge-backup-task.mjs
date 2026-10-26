import { execFile } from 'node:child_process';
import { lstat, open, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  EdgeBackupError,
  appendBackupLog,
  backupLayout,
  backupLogEntry,
  backupStatus,
  isWindowsDrivePath,
  parseEdgeBackupConfig,
  readBackupStatus,
  runEdgeBackup,
  writeFileAtomic,
} from './edge-backup-lib.mjs';

/**
 * Hourly SYSTEM scheduled task \PickChick\PickChickEdgeBackup (install-edge-backup.ps1):
 *   node.exe edge-backup-task.mjs C:\ProgramData\PickChick\EdgeBackup\private\edge-backup.json
 * The only argument is the protected configuration path; the database password and archive key
 * are read from protected files and never appear in arguments, output or logs.
 */
export const EDGE_DATABASE = Object.freeze({
  host: '127.0.0.1',
  port: 55433,
  name: 'pickchick_edge',
});
const execute = promisify(execFile);

/** <stateRoot>\private\edge-backup.json, absolute and normalized. Returns the state root. */
export function stateRootOf(configPath) {
  if (
    !isWindowsDrivePath(configPath) ||
    win32.basename(configPath) !== 'edge-backup.json' ||
    win32.basename(win32.dirname(configPath)) !== 'private'
  )
    throw new EdgeBackupError('CONFIG_INVALID');
  return win32.dirname(win32.dirname(configPath));
}

/**
 * Holds the shared native maintenance lock file open for the whole run. Operator scripts open it
 * exclusively (FileShare.None): while they hold it this open fails and the run is skipped, and
 * while this run holds it their exclusive open fails, so a release never meets a running dump.
 * A missing file means no maintenance tool has ever run; it is not created here.
 */
export async function maintenanceLease(path) {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return { release: async () => undefined };
    if (['EBUSY', 'EPERM'].includes(error.code)) throw new EdgeBackupError('MAINTENANCE');
    throw new EdgeBackupError('INTERNAL');
  }
  return { release: () => handle.close() };
}

/**
 * Health record for an unreadable configuration. It keeps the owner's report choice and limit
 * from the previous record, so a broken file still reaches monitoring.
 */
export function configFailureStatus(previous, at = new Date()) {
  const limit = previous?.maxAgeMinutes;
  return backupStatus({
    state: 'failed',
    error: 'CONFIG_INVALID',
    startedAt: at,
    finishedAt: at,
    previous,
    config: {
      maxAgeMinutes: Number.isInteger(limit) && limit >= 60 && limit <= 4320 ? limit : 120,
      reportInHeartbeat: previous?.reportInHeartbeat === true,
    },
  });
}

async function readConfig(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw new Error('size');
    return parseEdgeBackupConfig(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    throw new EdgeBackupError('CONFIG_INVALID');
  }
}

/**
 * The pinned ledger next to this file and the pg driver of the protected foundation tools (the
 * same one the operator backup uses). Anything missing, for example a foundation release folder
 * that was renamed, is TOOL_INVALID.
 */
export async function loadBackupTools(
  config,
  ledgerUrl = new URL('./native-edge-backup-ledger.json', import.meta.url),
) {
  try {
    const pinned = JSON.parse(await readFile(ledgerUrl, 'utf8'));
    const { Client } = createRequire(win32.join(config.toolsRoot, 'package.json'))('pg');
    if (!Array.isArray(pinned) || typeof Client !== 'function') throw new Error('tools');
    return { pinned, Client };
  } catch {
    throw new EdgeBackupError('TOOL_INVALID');
  }
}

/** Health record and log line of a run that stopped before it started (codes only). */
async function recordStartFailure(layout, status) {
  await writeFileAtomic(layout.statusFile, JSON.stringify(status, null, 2) + '\n').catch(
    () => undefined,
  );
  await appendBackupLog(layout.logFile, backupLogEntry(status, new Date())).catch(() => undefined);
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows scheduled task invocation required');
  const [configPath, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Unexpected arguments');
  const stateRoot = stateRootOf(configPath);
  const layout = backupLayout(stateRoot);
  let config;
  try {
    config = await readConfig(configPath);
    if (config.stateRoot !== stateRoot) throw new EdgeBackupError('CONFIG_INVALID');
  } catch {
    // Still leave a health record: Inspect and the heartbeat must see a broken configuration.
    await recordStartFailure(
      layout,
      configFailureStatus(await readBackupStatus(layout.statusFile)),
    );
    process.exitCode = 1;
    return;
  }
  let pinned;
  let Client;
  try {
    ({ pinned, Client } = await loadBackupTools(config));
  } catch {
    const at = new Date();
    await recordStartFailure(
      layout,
      backupStatus({
        state: 'failed',
        error: 'TOOL_INVALID',
        startedAt: at,
        finishedAt: at,
        previous: await readBackupStatus(layout.statusFile),
        config,
      }),
    );
    process.exitCode = 1;
    return;
  }
  const { exitCode } = await runEdgeBackup(
    { config, layout, pinned, database: EDGE_DATABASE },
    {
      connect: async ({ user, password }) => {
        const client = new Client({
          host: EDGE_DATABASE.host,
          port: EDGE_DATABASE.port,
          database: EDGE_DATABASE.name,
          user,
          password,
          ssl: false,
          connectionTimeoutMillis: 5000,
          statement_timeout: 120000,
          application_name: 'pickchick-edge-backup',
        });
        client.on('error', () => undefined);
        await client.connect();
        return client;
      },
      runTool: async (name, args, { env, timeoutMs }) => {
        if (!['pg_dump', 'pg_restore'].includes(name)) throw new Error('Unexpected tool');
        return (
          await execute(win32.join(config.pgBin, name + '.exe'), args, {
            env,
            timeout: timeoutMs,
            maxBuffer: 16 * 1024 * 1024,
            windowsHide: true,
          })
        ).stdout;
      },
      enterMaintenance: () => maintenanceLease(config.maintenanceLock),
    },
  );
  process.exitCode = exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error(JSON.stringify({ event: 'edge_backup_start_failed' }));
    process.exitCode = 1;
  });
