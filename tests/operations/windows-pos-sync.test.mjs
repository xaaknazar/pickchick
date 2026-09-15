import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { DeviceIdentitySchema } from '@pickchick/contracts';
import { createPool, migrate } from '@pickchick/database';
import { provisionEdgePosSync } from '@pickchick/pos-order-sync';
import { configureDatabase } from '../../infra/windows/native-foundation-db.mjs';
import {
  configureSyncDatabase,
  validateSyncSecret,
  syncVerifier,
  syncRole,
} from '../../infra/windows/native-pos-sync-db.mjs';
import {
  validateWorkerConfig,
  readWindowsIdentity,
} from '../../infra/windows/native-pos-sync-worker.mjs';

const secret = () => randomBytes(32).toString('hex');
function credentials() {
  const foundation = {
    format: 'pickchick-native-secrets-v1',
    installId: randomUUID(),
    branchId: randomUUID(),
    passwords: Object.fromEntries(
      ['pickchick_bootstrap', 'pickchick_edge_owner', 'pickchick_edge_runtime'].map((role) => [
        role,
        secret(),
      ]),
    ),
  };
  return {
    foundation,
    sync: {
      format: 'pickchick-pos-sync-secrets-v1',
      installId: foundation.installId,
      branchId: foundation.branchId,
      syncInstallId: randomUUID(),
      password: secret(),
    },
  };
}
test('sync credential is separate, bound and deterministically recoverable', () => {
  const { foundation, sync } = credentials();
  assert.equal(validateSyncSecret(sync, foundation), sync);
  for (const patch of [
    { password: foundation.passwords.pickchick_edge_owner },
    { branchId: randomUUID() },
    { installId: randomUUID() },
    { password: 'invalid' },
    { extra: true },
  ])
    assert.throws(() => validateSyncSecret({ ...sync, ...patch }, foundation));
  assert.equal(syncVerifier(sync), syncVerifier({ ...sync }));
  assert.notEqual(syncVerifier(sync), syncVerifier({ ...sync, syncInstallId: randomUUID() }));
  assert.ok(!syncVerifier(sync).includes(sync.password));
});
test('worker refuses owner credentials, remote/override DB URLs and scope drift', () => {
  const branchId = randomUUID(),
    deviceId = randomUUID(),
    password = secret();
  const config = {
    posOrderSyncEnabled: true,
    branchId,
    edgeDeviceId: deviceId,
    databaseUrl: `postgresql://${syncRole}:${password}@127.0.0.1:55433/pickchick_edge`,
  };
  validateWorkerConfig(config, 'http://127.0.0.1:43100', branchId, deviceId);
  for (const patch of [
    { databaseUrl: config.databaseUrl.replace(syncRole, 'pickchick_edge_owner') },
    { databaseUrl: config.databaseUrl + '?host=elsewhere' },
    { databaseUrl: config.databaseUrl.replace('127.0.0.1', '192.168.1.1') },
    { branchId: randomUUID() },
    { posOrderSyncEnabled: false },
  ])
    assert.throws(() =>
      validateWorkerConfig({ ...config, ...patch }, 'http://127.0.0.1:43100', branchId, deviceId),
    );
  assert.throws(() => validateWorkerConfig(config, 'http://127.0.0.1:3100', branchId, deviceId));
});
test('Windows identity parser rejects stale/wrong/mutated identities and links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pickchick-identity-test-'));
  const path = join(root, 'device-identity.json');
  const identity = {
    device_id: randomUUID(),
    branch_id: randomUUID(),
    token: secret(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
  };
  const read = () =>
    readWindowsIdentity(path, DeviceIdentitySchema, identity.branch_id, identity.device_id);
  try {
    await writeFile(path, JSON.stringify(identity), { mode: 0o600 });
    assert.deepEqual(await read(), identity);
    for (const patch of [
      { device_id: randomUUID() },
      { branch_id: randomUUID() },
      { token: 'x' },
      { expires_at: '2020-01-01T00:00:00.000Z' },
      { extra: true },
    ]) {
      await writeFile(path, JSON.stringify({ ...identity, ...patch }));
      await assert.rejects(read());
    }
    await writeFile(path, ' '.repeat(5000));
    await assert.rejects(read(), /Unsafe/);
    await rm(path);
    await symlink(join(root, 'absent'), path);
    await assert.rejects(read(), /Unsafe/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('installer keeps transport private and does not mutate restaurant services or OS capabilities', async () => {
  const script = await readFile(
    new URL('../../infra/windows/install-native-pos-sync.ps1', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    script,
    /Add-WindowsCapability|Remove-Service|Stop-Service|Restart-Service|New-NetFirewallRule|StrictHostKeyChecking no|ssh-keyscan|DROP DATABASE|ALTER ROLE/,
  );
  assert.match(script, /LocalForward 127\.0\.0\.1:43100 127\.0\.0\.1:/);
  assert.match(script, /@\('PickChickEdge','PickChickSyncTunnel'\)/);
  assert.match(script, /FileMode\]::CreateNew/);
  assert.match(script, /\/setowner','\*S-1-5-19'/);
});

// Opt-in: isolated native PostgreSQL only. Never uses a supplied database URL,
// existing cluster, Windows service or VPS. Passwords are never shell arguments.
test(
  'native PostgreSQL sync role partial recovery, least rights and immutable producer binding',
  {
    skip: !process.env.PICKCHICK_TEST_NATIVE_SYNC && !process.env.PICKCHICK_SYNC_DISPOSABLE_FIXTURE,
    timeout: 120000,
  },
  async () => {
    const run = promisify(execFile),
      require = createRequire(import.meta.url);
    const { Client } = createRequire(require.resolve('@pickchick/database'))('pg');
    const root = await mkdtemp(join(tmpdir(), 'pickchick-sync-cluster-'));
    const data = process.env.PICKCHICK_SYNC_DISPOSABLE_FIXTURE
      ? '/var/lib/postgresql/18/docker'
      : join(root, 'data');
    const fixturePath = process.env.PICKCHICK_SYNC_DISPOSABLE_FIXTURE;
    if (
      fixturePath &&
      !(await readFile('/.dockerenv').then(
        () => true,
        () => false,
      ))
    )
      throw new Error('Container-only disposable fixture');
    const fixture = fixturePath ? JSON.parse(await readFile(fixturePath, 'utf8')) : undefined;
    const { foundation, sync } = fixture ?? credentials();
    const reservation = createServer();
    await new Promise((done, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', done);
    });
    const port = fixture ? 55433 : reservation.address().port;
    const command = async (name, args) => {
      try {
        await run(name, args, { timeout: 30000, maxBuffer: 1024 * 1024 });
      } catch (error) {
        let diagnostic = String(error.stderr ?? '');
        for (const password of [...Object.values(foundation.passwords), sync.password])
          diagnostic = diagnostic.replaceAll(password, '[redacted]');
        // The original child-process error may retain private environment/arguments.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(`Disposable PostgreSQL command failed: ${name}: ${diagnostic}`);
      }
    };
    let started = false,
      owner,
      admin;
    try {
      if (!fixture) {
        const pw = join(root, 'bootstrap-password');
        await writeFile(pw, foundation.passwords.pickchick_bootstrap + '\n', { mode: 0o600 });
        await command('initdb', [
          '-D',
          data,
          '--username=pickchick_bootstrap',
          '--pwfile=' + pw,
          '--encoding=UTF8',
          '--locale=C',
          '--data-checksums',
          '--auth-host=scram-sha-256',
          '--auth-local=scram-sha-256',
        ]);
        await rm(pw);
        await writeFile(
          join(data, 'postgresql.conf'),
          `listen_addresses='127.0.0.1'\nport=${port}\npassword_encryption='scram-sha-256'\nunix_socket_directories=''\nlog_statement='none'\nlog_min_error_statement='panic'\n`,
          { mode: 0o600 },
        );
        await new Promise((done) => reservation.close(done));
        started = true;
        await command('pg_ctl', ['-D', data, '-l', join(root, 'postgres.log'), '-w', 'start']);
      }
      const initial = await configureDatabase(Client, foundation, data, 'bootstrap', '', port);
      const options = {
        mode: 'prepare',
        pgData: data,
        systemIdentifier: initial.systemIdentifier,
        port,
      };
      await assert.rejects(
        configureSyncDatabase(Client, foundation, sync, {
          ...options,
          systemIdentifier: '1111111111111111111',
        }),
        /cluster identity/,
      );
      admin = new Client({
        host: '127.0.0.1',
        port,
        database: 'postgres',
        user: 'pickchick_bootstrap',
        password: foundation.passwords.pickchick_bootstrap,
      });
      await admin.connect();
      assert.equal(
        (await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [syncRole])).rowCount,
        0,
      );
      // Role creation may commit before a later setup failure. The next run accepts
      // only the same generated verifier, never overwrites or escalates that role.
      await assert.rejects(configureSyncDatabase(Client, foundation, sync, options));
      assert.equal(
        (await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [syncRole])).rowCount,
        1,
      );
      const ownerUrl = `postgresql://pickchick_edge_owner:${foundation.passwords.pickchick_edge_owner}@127.0.0.1:${port}/pickchick_edge`;
      owner = createPool(ownerUrl, 2);
      await migrate(owner, resolve('db/edge/migrations'), 'edge');
      await owner.query(
        "INSERT INTO branch_config(id,code,name,timezone) VALUES($1,'SYNTHETIC-SYNC','Disposable test','Asia/Almaty')",
        [sync.branchId],
      );
      assert.equal((await configureSyncDatabase(Client, foundation, sync, options)).verified, true);
      assert.equal(
        (await configureSyncDatabase(Client, foundation, sync, { ...options, mode: 'verify' }))
          .verified,
        true,
      );
      await assert.rejects(
        configureSyncDatabase(Client, foundation, { ...sync, password: secret() }, options),
        /role differs/,
      );
      await owner.query(`GRANT SELECT ON local_orders TO ${syncRole}`);
      await assert.rejects(
        configureSyncDatabase(Client, foundation, sync, options),
        /privileges differ/,
      );
      await owner.query(`REVOKE SELECT ON local_orders FROM ${syncRole}`);
      const producerId = randomUUID();
      await owner.query('INSERT INTO local_order_streams(branch_id,producer_id) VALUES($1,$2)', [
        sync.branchId,
        producerId,
      ]);
      const binding = {
        branchId: sync.branchId,
        organizationId: randomUUID(),
        deviceId: randomUUID(),
      };
      const bind = async () => provisionEdgePosSync(owner, binding);
      const first = await configureSyncDatabase(Client, foundation, sync, {
        ...options,
        mode: 'bind',
        bind,
      });
      assert.equal(first.scope.producerId, producerId);
      assert.deepEqual(
        await configureSyncDatabase(Client, foundation, sync, { ...options, mode: 'bind', bind }),
        first,
      );
      await assert.rejects(
        configureSyncDatabase(Client, foundation, sync, {
          ...options,
          mode: 'bind',
          bind: async () => provisionEdgePosSync(owner, { ...binding, deviceId: randomUUID() }),
        }),
      );
      assert.equal(
        (await owner.query('SELECT ordering_enabled FROM branch_config')).rows[0].ordering_enabled,
        false,
      );
      if (fixture) {
        const foundationPrivate = join(root, 'foundation'),
          syncPrivate = join(root, 'operator'),
          servicePrivate = join(root, 'service');
        for (const directory of [foundationPrivate, syncPrivate, servicePrivate])
          await mkdir(directory, { mode: 0o700 });
        await writeFile(
          join(foundationPrivate, 'foundation-credentials.json'),
          JSON.stringify(foundation),
          { mode: 0o600 },
        );
        await writeFile(join(syncPrivate, 'sync-secrets.json'), JSON.stringify(sync), {
          mode: 0o600,
        });
        const state = {
          format: 'pickchick-native-pos-sync-v1',
          installId: foundation.installId,
          branchId: sync.branchId,
          syncInstallId: sync.syncInstallId,
        };
        const statePath = join(syncPrivate, 'sync-state.json');
        await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
        const bindingPath = join(syncPrivate, 'binding.json');
        await writeFile(bindingPath, JSON.stringify(binding), { mode: 0o600 });
        const identityPath = join(servicePrivate, 'device-identity.json');
        const identity = {
          device_id: binding.deviceId,
          branch_id: binding.branchId,
          token: secret(),
          expires_at: new Date(Date.now() + 60000).toISOString(),
        };
        await writeFile(identityPath, JSON.stringify(identity), { mode: 0o600 });
        const args = [
          'infra/windows/native-pos-sync-db.mjs',
          'bind',
          '/app',
          foundationPrivate,
          syncPrivate,
          data,
          initial.systemIdentifier,
          bindingPath,
        ];
        const cli = await run(process.execPath, args, { timeout: 10000 });
        assert.equal(JSON.parse(cli.stdout).scope.producerId, producerId);
        for (const privateValue of [
          ...Object.values(foundation.passwords),
          sync.password,
          identity.token,
        ])
          assert.ok(!cli.stdout.includes(privateValue));
        await writeFile(statePath, JSON.stringify({ ...state, syncInstallId: randomUUID() }));
        await assert.rejects(run(process.execPath, args, { timeout: 10000 }));
        await writeFile(statePath, JSON.stringify(state));
        await writeFile(identityPath, JSON.stringify({ ...identity, extra: true }));
        await assert.rejects(run(process.execPath, args, { timeout: 10000 }));
      }
      const worker = new Client({
        host: '127.0.0.1',
        port,
        database: 'pickchick_edge',
        user: syncRole,
        password: sync.password,
      });
      await worker.connect();
      try {
        await worker.query('SELECT branch_id FROM pos_order_sync_state');
        await worker.query(
          'UPDATE pos_order_sync_state SET lease_token=NULL,lease_until=NULL WHERE false',
        );
        for (const sql of [
          'SELECT * FROM local_orders',
          'DELETE FROM outbox_events',
          'UPDATE pos_order_sync_state SET active=false',
          'UPDATE outbox_events SET payload=payload',
        ])
          await assert.rejects(worker.query(sql), { code: '42501' });
      } finally {
        await worker.end();
      }
    } finally {
      await Promise.allSettled([owner?.end(), admin?.end()]);
      if (reservation.listening) await new Promise((done) => reservation.close(done));
      if (started) await command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
      await rm(root, { recursive: true, force: true });
    }
  },
);
