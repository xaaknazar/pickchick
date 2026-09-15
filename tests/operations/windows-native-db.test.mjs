import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  configureDatabase,
  scramVerifier,
  validateCredentials,
} from '../../infra/windows/native-foundation-db.mjs';

const execute = promisify(execFile);
const credentials = () => ({
  format: 'pickchick-native-secrets-v1',
  installId: randomUUID(),
  branchId: randomUUID(),
  passwords: Object.fromEntries(
    ['pickchick_bootstrap', 'pickchick_edge_owner', 'pickchick_edge_runtime'].map((role) => [
      role,
      randomBytes(32).toString('hex'),
    ]),
  ),
});

test('private credential binding and SCRAM input validation', () => {
  const value = credentials();
  assert.equal(validateCredentials(value, value.branchId), value);
  assert.throws(() => validateCredentials(value, randomUUID()));
  assert.throws(() =>
    validateCredentials(
      { ...value, passwords: { ...value.passwords, extra: '0'.repeat(64) } },
      value.branchId,
    ),
  );
  const first = scramVerifier(
    value.passwords.pickchick_edge_owner,
    value.installId,
    'pickchick_edge_owner',
  );
  assert.match(first, /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/);
  assert.equal(
    scramVerifier(value.passwords.pickchick_edge_owner, value.installId, 'pickchick_edge_owner'),
    first,
  );
  assert.notEqual(
    scramVerifier(value.passwords.pickchick_edge_owner, value.installId, 'pickchick_edge_runtime'),
    first,
  );
  assert.throws(() => scramVerifier('unsafe', value.installId, 'pickchick_edge_owner'));
});

// Opt-in only: never connects to an existing server. Reserve the dedicated test
// port first; initdb and cleanup target a unique newly-created private directory.
test(
  'PostgreSQL 18 native foundation: SCRAM, migrations, rights and recovery identity',
  {
    skip: !process.env.PICKCHICK_NATIVE_RUNTIME,
    timeout: 120_000,
  },
  async () => {
    const runtimeRoot = resolve(process.env.PICKCHICK_NATIVE_RUNTIME);
    const { Client } = createRequire(join(runtimeRoot, 'package.json'))('pg');
    const reservation = createServer();
    await new Promise((done, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', done);
    });
    const port = reservation.address().port;
    const configure = (value, data, mode, expected = '') =>
      configureDatabase(Client, value, data, mode, expected, port);
    const root = await mkdtemp(join(tmpdir(), 'pickchick-native-db-test-'));
    await chmod(root, 0o700);
    const data = join(root, 'data');
    const value = credentials();
    const pwFile = join(root, 'initdb-password');
    await writeFile(pwFile, value.passwords.pickchick_bootstrap + '\n', { mode: 0o600 });
    let started = false;
    let admin;
    const run = async (name, args, env = process.env) => {
      const executable = process.env.PICKCHICK_TEST_PG_BIN
        ? join(process.env.PICKCHICK_TEST_PG_BIN, name)
        : name;
      try {
        return await execute(executable, args, { env, timeout: 30_000, maxBuffer: 1024 * 1024 });
      } catch (error) {
        let diagnostic = String(error.stderr ?? '');
        for (const password of Object.values(value.passwords))
          diagnostic = diagnostic.replaceAll(password, '[redacted]');
        // The original child-process error can contain private arguments/environment.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(`Disposable database test command failed: ${name}: ${diagnostic}`);
      }
    };
    try {
      await run('initdb', [
        '-D',
        data,
        '--username=pickchick_bootstrap',
        '--pwfile=' + pwFile,
        '--encoding=UTF8',
        '--locale=C',
        '--data-checksums',
        '--auth-host=scram-sha-256',
        '--auth-local=scram-sha-256',
      ]);
      await rm(pwFile);
      await writeFile(
        join(data, 'postgresql.conf'),
        `listen_addresses='127.0.0.1'\nport=${port}\npassword_encryption='scram-sha-256'\nunix_socket_directories=''\nlog_statement='none'\nlog_min_error_statement='panic'\n`,
        { mode: 0o600 },
      );
      await new Promise((done) => reservation.close(done));
      started = true;
      await run('pg_ctl', ['-D', data, '-l', join(root, 'postgres.log'), '-w', 'start']);
      const initial = await configure(value, data, 'bootstrap');
      assert.equal(initial.databaseConfigured, true);
      assert.deepEqual(
        await configure(value, data, 'bootstrap', initial.systemIdentifier),
        initial,
      );
      const cleanEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(PG|EDGE_|NODE_OPTIONS|CLOUD_|APP_ENV)/.test(key),
        ),
      );
      const ownerUrl = `postgresql://pickchick_edge_owner:${value.passwords.pickchick_edge_owner}@127.0.0.1:${port}/pickchick_edge`;
      const env = {
        ...cleanEnv,
        APP_ENV: 'local',
        EDGE_BRANCH_ID: value.branchId,
        EDGE_DATABASE_URL: ownerUrl,
        EDGE_FULFILLMENT_ENABLED: 'false',
      };
      await execute(process.execPath, [join(runtimeRoot, 'scripts/edge-migrate.mjs')], {
        env,
        timeout: 30_000,
      }).catch(() => {
        throw new Error('Disposable migration failed');
      });
      await execute(
        process.execPath,
        [join(runtimeRoot, 'scripts/edge-runtime-grants.mjs'), 'pickchick_edge_runtime'],
        { env, timeout: 30_000 },
      ).catch(() => {
        throw new Error('Disposable grants failed');
      });
      const verified = await configure(value, data, 'verify', initial.systemIdentifier);
      assert.equal(verified.migrations, 9);
      assert.equal(verified.branchBound, false);
      assert.equal(verified.fulfillmentEnabled, false);
      // Wrong identity must stop before role creation, even with valid bootstrap auth.
      admin = new Client({
        host: '127.0.0.1',
        port,
        database: 'pickchick_edge',
        user: 'pickchick_bootstrap',
        password: value.passwords.pickchick_bootstrap,
      });
      await admin.connect();
      await admin.query('ALTER ROLE pickchick_edge_runtime CREATEDB');
      await assert.rejects(
        configure(value, data, 'bootstrap', '1111111111111111111'),
        /identity changed/,
      );
      await assert.rejects(
        configure(value, data, 'verify', initial.systemIdentifier),
        /role differs/,
      );
      await admin.query('ALTER ROLE pickchick_edge_runtime NOCREATEDB');
      const altered = {
        ...value,
        passwords: { ...value.passwords, pickchick_edge_runtime: randomBytes(32).toString('hex') },
      };
      await assert.rejects(
        configure(altered, data, 'bootstrap', initial.systemIdentifier),
        /role differs/,
      );
      await assert.rejects(
        configure(value, data + '-foreign', 'bootstrap'),
        /Wrong PostgreSQL cluster/,
      );
      await configure(value, data, 'verify', initial.systemIdentifier);
    } finally {
      await admin?.end();
      if (reservation.listening) await new Promise((done) => reservation.close(done));
      if (started) await run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
      // If stop fails, execution never reaches removal: preserve possible live data.
      await rm(root, { recursive: true, force: true });
    }
  },
);
