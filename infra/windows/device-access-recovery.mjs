/** Read-only verification of an already committed020. Never replays migration or creates credentials. */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

export function assertCommittedInspection(value) {
  if (
    value?.mode !== 'inspect' ||
    value.migrations !== 20 ||
    value.migrationPending !== false ||
    value.migrationApplied !== false ||
    value.grantsVerified !== true ||
    value.roleExists !== true ||
    value.existingDataPreserved !== true ||
    value.managedTerminals !== 0 ||
    !/^[a-f0-9]{64}$/.test(value.backupSha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(value.fingerprint ?? '')
  )
    throw new Error('Committed020 with verified grants and no enrollment required');
  return value;
}

export async function verifyWorkerLogin(client) {
  await client.query('BEGIN READ ONLY');
  try {
    const { rows } = await client.query('SELECT current_user role');
    if (rows[0]?.role !== 'pickchick_device_access_sync') throw new Error('Unexpected worker role');
    for (const table of [
      'terminal_access_commands',
      'terminal_access_registry',
      'kitchen_password_reset_commands',
    ]) {
      const result = await client.query('SELECT count(*)::int count FROM ' + table);
      if (result.rows[0]?.count !== 0)
        throw new Error('Mailbox already used; explicit recovery review required');
    }
    return { loginVerified: true, mailboxEmpty: true };
  } finally {
    await client.query('ROLLBACK');
  }
}

export function recoveredResult(before, after, login) {
  assertCommittedInspection(before);
  assertCommittedInspection(after);
  if (
    before.fingerprint !== after.fingerprint ||
    before.backupSha256 !== after.backupSha256 ||
    login?.loginVerified !== true ||
    login.mailboxEmpty !== true
  ) {
    throw new Error('Read-only recovery state changed or login not verified');
  }
  return {
    ...after,
    ...login,
    recoveryVerification: 'read-only-current-state',
    originalPreparationReceiptAvailable: false,
  };
}

async function main() {
  const [toolsRoot, appRoot, branchId, deviceId, backupPath, envPath, ...extra] =
    process.argv.slice(2);
  if (
    process.platform !== 'win32' ||
    extra.length ||
    ![toolsRoot, appRoot, backupPath, envPath].every((p) => win32.isAbsolute(p ?? ''))
  ) {
    throw new Error('Windows recovery invocation required');
  }
  const helper = join(appRoot, 'infra/windows/terminal-access-upgrade-db.mjs');
  const inspect = () =>
    assertCommittedInspection(
      JSON.parse(
        execFileSync(
          process.execPath,
          [helper, 'inspect', toolsRoot, appRoot, branchId, deviceId, backupPath, envPath],
          { encoding: 'utf8', timeout: 120000, maxBuffer: 1048576, windowsHide: true },
        ),
      ),
    );
  const before = inspect();
  const { parseDeviceAccessEnv } = await import(pathToFileURL(helper));
  const { password, enabled } = parseDeviceAccessEnv(await readFile(envPath, 'utf8'), {
    branchId,
    deviceId,
  });
  if (enabled) throw new Error('Worker must remain disabled');
  const { Client } = createRequire(join(resolve(toolsRoot), 'package.json'))('pg');
  const client = new Client({
    host: '127.0.0.1',
    port: 55433,
    database: 'pickchick_edge',
    user: 'pickchick_device_access_sync',
    password,
    ssl: false,
    connectionTimeoutMillis: 3000,
    statement_timeout: 60000,
    options: '-c default_transaction_read_only=on',
    application_name: 'pickchick-device-recovery-read-only',
  });
  client.on('error', () => {});
  try {
    await client.connect();
    const login = await verifyWorkerLogin(client);
    console.log(JSON.stringify(recoveredResult(before, inspect(), login)));
  } finally {
    await client.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error(
      'Device recovery verification failed; no migration, credential or service change performed.',
    );
    process.exitCode = 1;
  });
}
