// Run only against two newly-created isolated containers. No published ports,
// cloud network, existing database URLs, Windows services or durable Docker volume.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
const image = process.env.PICKCHICK_SYNC_TEST_IMAGE;
if (!image || !/^[a-zA-Z0-9_./:@-]+$/.test(image))
  throw new Error('Explicit locally-built PickChick API image required');
const run = promisify(execFile),
  name = 'pickchick-sync-proof-' + randomUUID(),
  root = await mkdtemp(join(tmpdir(), 'sync-proof-'));
const password = () => randomBytes(32).toString('hex');
const foundation = {
  format: 'pickchick-native-secrets-v1',
  installId: randomUUID(),
  branchId: randomUUID(),
  passwords: Object.fromEntries(
    ['pickchick_bootstrap', 'pickchick_edge_owner', 'pickchick_edge_runtime'].map((role) => [
      role,
      password(),
    ]),
  ),
};
const fixture = {
  foundation,
  sync: {
    format: 'pickchick-pos-sync-secrets-v1',
    installId: foundation.installId,
    branchId: foundation.branchId,
    syncInstallId: randomUUID(),
    password: password(),
  },
};
const docker = async (args) => run('docker', args, { timeout: 120000, maxBuffer: 1024 * 1024 });
let started = false;
try {
  // image inspect is deliberately restricted to ID; Config.Env may contain secrets.
  await docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  await writeFile(join(root, 'fixture.json'), JSON.stringify(fixture), { mode: 0o600 });
  await writeFile(
    join(root, 'postgres.env'),
    `POSTGRES_USER=pickchick_bootstrap\nPOSTGRES_PASSWORD=${foundation.passwords.pickchick_bootstrap}\nPOSTGRES_DB=postgres\nPOSTGRES_INITDB_ARGS=--data-checksums --encoding=UTF8 --locale=C --auth-host=scram-sha-256\n`,
    { mode: 0o600 },
  );
  await docker([
    'run',
    '-d',
    '--name',
    name,
    '--network',
    'none',
    '--env-file',
    join(root, 'postgres.env'),
    'postgres:18.6-alpine',
    'postgres',
    '-c',
    'listen_addresses=127.0.0.1',
    '-c',
    'port=55433',
    '-c',
    'password_encryption=scram-sha-256',
    '-c',
    'log_statement=none',
    '-c',
    'log_min_error_statement=panic',
  ]);
  started = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await docker([
        'exec',
        name,
        'pg_isready',
        '-h',
        '127.0.0.1',
        '-p',
        '55433',
        '-U',
        'pickchick_bootstrap',
      ]);
      ready = true;
      break;
    } catch {
      await delay(500);
    }
  }
  if (!ready) throw new Error('Disposable database did not become ready');
  const result = await docker([
    'run',
    '--rm',
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--network',
    'container:' + name,
    '--cap-drop',
    'ALL',
    '--mount',
    `type=bind,source=${root},target=/fixture,readonly`,
    '--mount',
    `type=bind,source=${resolve('infra/windows')},target=/app/infra/windows,readonly`,
    '--mount',
    `type=bind,source=${resolve('db/edge/migrations')},target=/app/db/edge/migrations,readonly`,
    '--mount',
    `type=bind,source=${resolve('tests/operations/windows-pos-sync.test.mjs')},target=/app/tests/operations/windows-pos-sync.test.mjs,readonly`,
    '-e',
    'PICKCHICK_SYNC_DISPOSABLE_FIXTURE=/fixture/fixture.json',
    '--entrypoint',
    'node',
    image,
    '--test',
    'tests/operations/windows-pos-sync.test.mjs',
  ]);
  process.stdout.write(result.stdout);
} catch (error) {
  let diagnostic = String(error.stdout ?? error.message);
  for (const value of [...Object.values(foundation.passwords), fixture.sync.password])
    diagnostic = diagnostic.replaceAll(value, '[redacted]');
  process.stderr.write(diagnostic + '\n');
  process.exitCode = 1;
} finally {
  if (started) await docker(['rm', '-f', '-v', name]);
  await rm(root, { recursive: true, force: true });
}
