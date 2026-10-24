// Audit 6.4 / owner action 16: scheduled, encrypted cashier database backup to a second location.
// Real PostgreSQL (the lane's edge database, one disposable schema per test) with the dedicated
// read-only role; pg_dump/pg_restore are fakes that read through the exported snapshot unless
// EDGE_BACKUP_TEST_PG_BIN names a directory with pg_dump/pg_restore of the server's version.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createPool } from '@pickchick/database';
import { withSyncDatabases } from '../helpers/sync.mjs';
import {
  BACKUP_ROLE,
  archiveName,
  backupLayout,
  createBackupKey,
  listBackupCopies,
  parseBackupKey,
  planRetention,
  readEncryptedArchive,
  runEdgeBackup,
} from '../../infra/windows/edge-backup-lib.mjs';
import {
  assertBackupPrivileges,
  ensureBackupRole,
  grantBackupAccess,
  prepareCredential,
  prepareKey,
  readBackupRole,
  removeBackupRole,
  verifyBackupLogin,
} from '../../infra/windows/edge-backup-setup.mjs';
import { maintenanceLease } from '../../infra/windows/edge-backup-task.mjs';
import { compareRestoredDatabase } from '../../infra/windows/edge-backup-restore.mjs';

const pinned = JSON.parse(
  await readFile(new URL('../../infra/windows/native-edge-backup-ledger.json', import.meta.url)),
);
const realTools = process.env.EDGE_BACKUP_TEST_PG_BIN;

async function dropRole(admin) {
  const client = await admin.connect();
  try {
    if (await readBackupRole(client)) {
      await client.query(`DROP OWNED BY ${BACKUP_ROLE}`);
      await client.query(`DROP ROLE ${BACKUP_ROLE}`);
    }
  } finally {
    client.release();
  }
}

/** One dedicated connection as `user`, shaped like a pg Client (query/end). */
async function connectAs(edgeUrl, user, password) {
  const url = new URL(edgeUrl);
  url.username = user;
  url.password = password;
  url.search = '';
  const pool = createPool(url.toString(), 1);
  try {
    const client = await pool.connect();
    return {
      query: (...args) => client.query(...args),
      end: async () => {
        client.release();
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

/**
 * The run's environment: a role with a known password, the key and credential files written by
 * the setup helpers, an empty destination and a configuration pointing at this test's schema.
 */
async function backupFixture(f, root) {
  const admin = await f.edge.admin.connect();
  let password;
  try {
    const database = (await admin.query('SELECT current_database() AS name')).rows[0].name;
    const stateRoot = join(root, 'state');
    const layout = backupLayout(stateRoot, posix);
    for (const dir of ['private', 'staging', 'logs', 'health'])
      await mkdir(join(stateRoot, dir), { recursive: true });
    const destination = join(root, 'second-disk');
    await mkdir(destination);
    const key = await prepareKey(layout.keyFile);
    ({ password } = await prepareCredential(layout.credentialFile, { roleExists: false }));
    await ensureBackupRole(admin, { password });
    await grantBackupAccess(admin, { database });
    const systemIdentifier = (
      await admin.query('SELECT system_identifier::text AS id FROM pg_control_system()')
    ).rows[0].id;
    const url = new URL(f.edge.config.databaseUrl);
    return {
      layout,
      keyId: key.keyId,
      password,
      destination,
      database: { host: url.hostname, port: Number(url.port), name: database },
      config: {
        branchId: f.branch,
        systemIdentifier,
        destination,
        retention: { hourly: 48, daily: 14 },
        timeZone: 'Asia/Almaty',
        maxAgeMinutes: 120,
        reportInHeartbeat: false,
      },
    };
  } finally {
    admin.release();
  }
}

/**
 * pg_dump stand-in: logs in with the password file it was given, imports the exported snapshot
 * and writes every table's row count as the "dump"; pg_restore --list prints a TOC for it.
 */
function fakeTools(f, calls, { failDump = false, dropTable, beforeDump } = {}) {
  return async (name, args, { env }) => {
    calls.push({ name, args, env });
    if (name === 'pg_dump') {
      await beforeDump?.();
      if (failDump) throw new Error('pg_dump: connection to server failed: password=secret');
      const file = args.find((arg) => arg.startsWith('--file=')).slice(7);
      const snapshot = args.find((arg) => arg.startsWith('--snapshot=')).slice(11);
      const [host, port, database, user, password] = (await readFile(env.PGPASSFILE, 'utf8'))
        .trim()
        .split(':');
      assert.equal(`${host}:${port}`, `${env.PGHOST}:${env.PGPORT}`);
      const url = new URL(f.edge.config.databaseUrl);
      url.pathname = '/' + database;
      const client = await connectAs(url.toString(), user, password);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query(`SET TRANSACTION SNAPSHOT '${snapshot}'`);
        const tables = (
          await client.query(
            `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname=$1 AND relkind='r' ORDER BY relname`,
            [f.edge.schema],
          )
        ).rows.map((row) => row.relname);
        const counts = {};
        for (const table of tables)
          counts[table] = (
            await client.query(`SELECT count(*)::text AS n FROM ${f.edge.schema}.${table}`)
          ).rows[0].n;
        await client.query('ROLLBACK');
        await writeFile(
          file,
          JSON.stringify({
            schema: f.edge.schema,
            counts,
            filler: randomBytes(4096).toString('hex'),
          }),
        );
      } finally {
        await client.end();
      }
      return '';
    }
    const dump = JSON.parse(await readFile(args[1], 'utf8'));
    return Object.keys(dump.counts)
      .filter((table) => table !== dropTable)
      .map((table, index) => `${index + 100}; 0 0 TABLE DATA ${dump.schema} ${table} owner`)
      .join('\n');
  };
}

const realRunner = (name, args, { env, timeoutMs }) =>
  promisify(execFile)(join(realTools, name), args, {
    env,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  }).then((result) => result.stdout);

async function run(f, fixture, overrides = {}, deps = {}) {
  const calls = [];
  const result = await runEdgeBackup(
    {
      config: { ...fixture.config, ...overrides },
      layout: fixture.layout,
      pinned,
      database: fixture.database,
      schema: f.edge.schema,
    },
    {
      connect: ({ user, password }) => connectAs(f.edge.config.databaseUrl, user, password),
      runTool: fakeTools(f, calls, deps.tools),
      enterMaintenance: async () => ({ release: async () => undefined }),
      ...deps,
    },
  );
  return { ...result, calls };
}

const status = async (fixture) => JSON.parse(await readFile(fixture.layout.statusFile, 'utf8'));
const files = (dir) => readdir(dir).then((names) => names.sort());

async function withBackup(runTest) {
  const root = await mkdtemp(join(tmpdir(), 'pickchick-edge-backup-'));
  try {
    await withSyncDatabases(async (f) => {
      await dropRole(f.edge.admin);
      try {
        await runTest(f, await backupFixture(f, root));
      } finally {
        await dropRole(f.edge.admin);
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('backup role reads every edge table through pg_read_all_data and can change nothing', async () => {
  await withBackup(async (f, fixture) => {
    const admin = await f.edge.admin.connect();
    const database = fixture.database.name;
    const ns = f.edge.schema;
    try {
      const proof = await assertBackupPrivileges(admin, {
        schema: ns,
        databaseDefaultsRevoked: false, // shared test database keeps PUBLIC TEMP
      });
      assert.ok(proof.relations > 40);
      assert.equal(proof.ownerFunctionsClosed, 2); // display allocator and restore fence
      const backup = await connectAs(f.edge.config.databaseUrl, BACKUP_ROLE, fixture.password);
      try {
        assert.deepEqual(
          await verifyBackupLogin(backup, {
            branchId: f.branch,
            systemIdentifier: fixture.config.systemIdentifier,
            pinned,
            schema: ns,
          }),
          { schema: 'schema023', timeZone: 'Asia/Almaty' },
        );
        assert.equal(
          (await backup.query(`SELECT count(*)::int AS n FROM ${ns}.schema_migrations`)).rows[0].n,
          23,
        );
        for (const sql of [
          `INSERT INTO ${ns}.branch_config(id,code,name,timezone) VALUES(gen_random_uuid(),'X','X','UTC')`,
          `UPDATE ${ns}.branch_config SET name='changed'`,
          `DELETE FROM ${ns}.schema_migrations`,
          `TRUNCATE ${ns}.local_orders`,
          `CREATE TABLE ${ns}.backup_probe(id int)`,
          `SELECT nextval('${ns}.fulfillment_display_sequence')`,
          `SELECT * FROM ${ns}.edge_restore_fence(true)`,
          `SELECT ${ns}.fulfillment_display_allocate('${f.branch}')`,
          'SET ROLE pg_read_all_data',
          `CREATE DATABASE backup_probe`,
          `CREATE ROLE backup_probe`,
        ])
          await assert.rejects(
            backup.query(sql),
            /permission denied|must have|not have|Permission/,
            sql,
          );
      } finally {
        await backup.end();
      }
      // Re-running setup never resets the password of an existing role.
      assert.deepEqual(await ensureBackupRole(admin, { password: 'f'.repeat(64) }), {
        created: false,
      });
      const again = await connectAs(f.edge.config.databaseUrl, BACKUP_ROLE, fixture.password);
      await again.end();
      // Broader rights on the role are detected, never accepted.
      for (const [widen, narrow] of [
        [`ALTER ROLE ${BACKUP_ROLE} CREATEDB`, `ALTER ROLE ${BACKUP_ROLE} NOCREATEDB`],
        [`ALTER ROLE ${BACKUP_ROLE} INHERIT`, `ALTER ROLE ${BACKUP_ROLE} NOINHERIT`],
        [`GRANT pg_monitor TO ${BACKUP_ROLE}`, `REVOKE pg_monitor FROM ${BACKUP_ROLE}`],
        [
          `GRANT pg_read_all_data TO ${BACKUP_ROLE} WITH SET TRUE`,
          `GRANT pg_read_all_data TO ${BACKUP_ROLE} WITH SET FALSE`,
        ],
        [
          `GRANT INSERT ON ${ns}.branch_config TO ${BACKUP_ROLE}`,
          `REVOKE INSERT ON ${ns}.branch_config FROM ${BACKUP_ROLE}`,
        ],
        [
          `GRANT UPDATE(name) ON ${ns}.branch_config TO ${BACKUP_ROLE}`,
          `REVOKE UPDATE(name) ON ${ns}.branch_config FROM ${BACKUP_ROLE}`,
        ],
        [
          `GRANT USAGE ON SEQUENCE ${ns}.fulfillment_display_sequence TO ${BACKUP_ROLE}`,
          `REVOKE USAGE ON SEQUENCE ${ns}.fulfillment_display_sequence FROM ${BACKUP_ROLE}`,
        ],
        [
          `GRANT CREATE ON SCHEMA ${ns} TO ${BACKUP_ROLE}`,
          `REVOKE CREATE ON SCHEMA ${ns} FROM ${BACKUP_ROLE}`,
        ],
        [
          `GRANT EXECUTE ON FUNCTION ${ns}.edge_restore_fence(boolean) TO ${BACKUP_ROLE}`,
          `REVOKE EXECUTE ON FUNCTION ${ns}.edge_restore_fence(boolean) FROM ${BACKUP_ROLE}`,
        ],
        [
          `GRANT CREATE ON DATABASE ${database} TO ${BACKUP_ROLE}`,
          `REVOKE CREATE ON DATABASE ${database} FROM ${BACKUP_ROLE}`,
        ],
        [
          `ALTER ROLE ${BACKUP_ROLE} SET work_mem='64MB'`,
          `ALTER ROLE ${BACKUP_ROLE} RESET work_mem`,
        ],
      ]) {
        await admin.query(widen);
        try {
          await assert.rejects(
            assertBackupPrivileges(admin, { schema: ns, databaseDefaultsRevoked: false }),
            /differ|owns|may run/,
            widen,
          );
          if (/ALTER ROLE .*(CREATEDB|INHERIT|SET)/.test(widen) || widen.includes('pg_monitor'))
            await assert.rejects(
              ensureBackupRole(admin, { password: fixture.password }),
              /differs/,
            );
        } finally {
          await admin.query(narrow);
        }
      }
      await assertBackupPrivileges(admin, { schema: ns, databaseDefaultsRevoked: false });
      // An existing role without its private credential file is not silently reset.
      await assert.rejects(
        prepareCredential(join(fixture.destination, 'missing.json'), { roleExists: true }),
        /not reset/,
      );
      assert.deepEqual(await removeBackupRole(admin, { database, dryRun: true }), {
        removed: false,
        existed: true,
      });
      assert.ok(await readBackupRole(admin));
      assert.deepEqual(await removeBackupRole(admin, { database }), {
        removed: true,
        existed: true,
      });
      assert.equal(await readBackupRole(admin), null);
      assert.deepEqual(await removeBackupRole(admin, { database }), {
        removed: false,
        existed: false,
      });
    } finally {
      admin.release();
    }
  });
});

test('a run stores one encrypted, verified copy of exactly the snapshot it checked', async () => {
  await withBackup(async (f, fixture) => {
    // Crash leftovers of an earlier run (plaintext dump, password file) are removed first.
    await writeFile(join(fixture.layout.stagingDir, 'edge-0badf00d.dump'), 'old plaintext');
    await writeFile(join(fixture.layout.stagingDir, 'pgpass-0badf00d.tmp'), 'old secret');
    let liveRows;
    const {
      status: result,
      exitCode,
      calls,
    } = await run(
      f,
      fixture,
      {},
      {
        tools: {
          // A sale between the snapshot and the dump must not appear in either.
          beforeDump: async () => {
            await f.edge.pool.query(
              "INSERT INTO local_staff(id,branch_id,name,role,access_expires_at) VALUES(gen_random_uuid(),$1,'Synthetic','cashier',now()+interval '1 day')",
              [f.branch],
            );
            liveRows = (await f.edge.pool.query('SELECT count(*)::text AS n FROM local_staff'))
              .rows[0].n;
          },
        },
      },
    );
    assert.equal(exitCode, 0);
    assert.equal(result.state, 'ok', JSON.stringify(result));
    assert.equal(result.schema, 'schema023');
    assert.equal(result.copies, 1);
    assert.equal(result.keyId, fixture.keyId);
    assert.deepEqual(await status(fixture), result);
    // pg_dump got the snapshot, the role and a password file; never the password itself.
    const dump = calls.find((call) => call.name === 'pg_dump');
    assert.ok(dump.args.includes('--username=' + BACKUP_ROLE));
    assert.ok(dump.args.includes('--no-password'));
    assert.ok(dump.args.some((arg) => arg.startsWith('--snapshot=')));
    assert.equal(JSON.stringify(calls.map((call) => call.args)).includes(fixture.password), false);
    assert.equal(
      Object.entries(dump.env).some(
        ([name, value]) => /^PGPASSWORD$/i.test(name) || value === fixture.password,
      ),
      false,
    );
    assert.equal(dump.env.PGAPPNAME, 'pickchick-edge-backup');
    // Staging holds no plaintext or password afterwards.
    assert.deepEqual(await files(fixture.layout.stagingDir), []);
    const [archive, sidecar] = await files(fixture.destination);
    assert.match(archive, /^pickchick-edge-[a-f0-9]{8}-\d{8}T\d{6}Z-[a-f0-9]{8}\.pcbak$/);
    assert.equal(sidecar, archive + '.json');
    const key = parseBackupKey(JSON.parse(await readFile(fixture.layout.keyFile, 'utf8')));
    const restored = join(fixture.destination, '..', 'restored.dump');
    const read = await readEncryptedArchive({
      file: join(fixture.destination, archive),
      key,
      output: restored,
    });
    const content = JSON.parse(await readFile(restored, 'utf8'));
    // Counts recorded in the archive equal what pg_dump read through the same snapshot, and
    // exclude the row written after the snapshot.
    assert.deepEqual(read.meta.tableCounts, content.counts);
    assert.equal(Number(read.meta.tableCounts.local_staff) + 1, Number(liveRows));
    assert.equal(read.meta.schema, 'schema023');
    assert.equal(read.meta.branchId, f.branch);
    assert.equal(read.meta.ledger.length, 23);
    // The restore runbook's comparison sees exactly the row written after the snapshot.
    const live = await connectAs(f.edge.config.databaseUrl, BACKUP_ROLE, fixture.password);
    try {
      assert.deepEqual(await compareRestoredDatabase(live, read.meta, { schema: f.edge.schema }), [
        'rows:local_staff',
      ]);
      await f.edge.pool.query("DELETE FROM local_staff WHERE name='Synthetic'");
      assert.deepEqual(
        await compareRestoredDatabase(live, read.meta, { schema: f.edge.schema }),
        [],
      );
      assert.deepEqual(
        await compareRestoredDatabase(
          live,
          { ...read.meta, branchId: '00000000-0000-4000-8000-000000000000', ledger: [] },
          { schema: f.edge.schema },
        ),
        ['ledger', 'branch'],
      );
    } finally {
      await live.end();
    }
    const side = JSON.parse(await readFile(join(fixture.destination, sidecar), 'utf8'));
    assert.equal(side.archiveSha256, read.archiveSha256);
    assert.equal(side.archiveBytes, (await stat(join(fixture.destination, archive))).size);
    assert.equal(side.dumpSha256, read.dumpSha256);
    const log = await readFile(fixture.layout.logFile, 'utf8');
    for (const secret of [
      fixture.password,
      key.key.toString('hex'),
      fixture.destination,
      'Synthetic',
    ])
      assert.equal(log.includes(secret), false);
    assert.match(log, /"event":"edge_backup","at":"[^"]+","state":"ok"/);
    await rm(restored);
  });
});

test('retention keeps 48 hourly and 14 daily copies and touches nothing else', async () => {
  await withBackup(async (f, fixture) => {
    const key = parseBackupKey(JSON.parse(await readFile(fixture.layout.keyFile, 'utf8')));
    const now = Date.now();
    const seeded = [];
    // 30 days of hourly copies (complete: archive plus a matching sidecar).
    for (let hour = 1; hour <= 24 * 30; hour += 1) {
      const name = archiveName(
        f.branch,
        new Date(now - hour * 3600_000),
        randomBytes(4).toString('hex'),
      );
      await writeFile(join(fixture.destination, name), 'x');
      await writeFile(
        join(fixture.destination, name + '.json'),
        JSON.stringify({
          format: 'pickchick-edge-backup-copy-v1',
          archive: name,
          branchId: f.branch,
          createdAt: new Date(now - hour * 3600_000).toISOString(),
          schema: 'schema023',
          keyId: key.keyId,
          archiveBytes: 1,
          archiveSha256: 'a'.repeat(64),
          dumpSha256: 'b'.repeat(64),
          dumpBytes: 1,
          verifiedAt: new Date(now - hour * 3600_000).toISOString(),
        }),
      );
      seeded.push(name);
    }
    const old = new Date(now - 24 * 3600_000);
    const stray = '.' + archiveName(f.branch, old, 'aaaaaaaa') + '.tmp-0a0b0c0d';
    await writeFile(join(fixture.destination, stray), 'partial');
    await utimes(join(fixture.destination, stray), old, old);
    const foreign = 'pickchick-edge-00000000-20261001T000000Z-00000000.pcbak';
    await writeFile(join(fixture.destination, foreign), 'other cashier');
    await utimes(join(fixture.destination, foreign), old, old);
    await writeFile(join(fixture.destination, 'README.txt'), 'owner note');
    const before = await listBackupCopies(fixture.destination, { branchId: f.branch });
    const { status: result } = await run(f, fixture);
    assert.equal(result.state, 'ok', JSON.stringify(result));
    const after = await listBackupCopies(fixture.destination, { branchId: f.branch });
    const expected = planRetention([after.copies[0], ...before.copies], {
      hourly: 48,
      daily: 14,
      timeZone: 'Asia/Almaty',
    }).keep;
    assert.deepEqual(
      after.copies.map((copy) => copy.name),
      expected,
    );
    assert.equal(result.copies, expected.length);
    assert.ok(expected.length >= 48 && expected.length <= 48 + 14);
    assert.deepEqual(after.strays, []);
    const names = await files(fixture.destination);
    assert.ok(names.includes(foreign));
    assert.ok(names.includes('README.txt'));
    assert.ok(!names.includes(stray));
    // Sidecar and archive leave together.
    assert.equal(names.filter((name) => name.endsWith('.pcbak.json')).length, expected.length);
  });
});

test('refused runs keep the last success, write nothing to the destination and clean staging', async () => {
  await withBackup(async (f, fixture) => {
    const first = await run(f, fixture);
    assert.equal(first.status.state, 'ok');
    const lastSuccessAt = first.status.lastSuccessAt;
    const copies = await files(fixture.destination);
    const refused = async (overrides, deps, code, { connects = true } = {}) => {
      let connected = false;
      const result = await run(f, fixture, overrides, {
        connect: async (credential) => {
          connected = true;
          return connectAs(f.edge.config.databaseUrl, credential.user, credential.password);
        },
        ...deps,
      });
      assert.equal(result.status.error, code, JSON.stringify(result.status));
      assert.equal(result.status.lastSuccessAt, lastSuccessAt);
      assert.deepEqual(await files(fixture.destination), copies);
      assert.deepEqual(
        (await files(fixture.layout.stagingDir)).filter((name) => name !== 'run.lock'),
        [],
      );
      assert.equal(connected, connects, code);
      return result;
    };
    let result = await refused(
      { branchId: '00000000-0000-4000-8000-000000000000' },
      {},
      'BRANCH_MISMATCH',
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.status.state, 'failed');
    assert.equal(result.calls.length, 0);
    assert.deepEqual(await status(fixture), result.status);
    await refused({ systemIdentifier: '1234567890123' }, {}, 'CLUSTER_MISMATCH');
    result = await refused({}, { tools: { failDump: true } }, 'DUMP_FAILED');
    assert.equal(JSON.stringify(result.status).includes('secret'), false);
    await refused({}, { tools: { dropTable: 'local_orders' } }, 'ARCHIVE_INCOMPLETE');
    await refused({}, { freeBytes: async () => 1024 }, 'DESTINATION_FULL');
    await refused(
      { destination: join(fixture.destination, 'offline') },
      {},
      'DESTINATION_UNAVAILABLE',
      {
        connects: false,
      },
    );
    result = await refused(
      {},
      {
        enterMaintenance: async () => {
          const { EdgeBackupError } = await import('../../infra/windows/edge-backup-lib.mjs');
          throw new EdgeBackupError('MAINTENANCE');
        },
      },
      'MAINTENANCE',
      { connects: false },
    );
    assert.equal(result.status.state, 'skipped');
    assert.equal(result.exitCode, 0);
    // An unreviewed later migration stops the backup before pg_dump runs.
    await f.edge.pool.query(
      "INSERT INTO schema_migrations(version,checksum,scope) VALUES('024_edge_future.sql',$1,'edge')",
      ['c'.repeat(64)],
    );
    result = await refused({}, {}, 'UNREVIEWED_SCHEMA');
    assert.equal(result.calls.length, 0);
    await f.edge.pool.query("DELETE FROM schema_migrations WHERE version='024_edge_future.sql'");
    // A wrong password or a broken key file never reaches pg_dump either.
    const credential = JSON.parse(await readFile(fixture.layout.credentialFile, 'utf8'));
    await writeFile(
      fixture.layout.credentialFile,
      JSON.stringify({ ...credential, password: 'e'.repeat(64) }),
    );
    await refused({}, {}, 'DATABASE_UNAVAILABLE');
    await writeFile(fixture.layout.credentialFile, JSON.stringify(credential));
    const keyText = await readFile(fixture.layout.keyFile, 'utf8');
    await writeFile(
      fixture.layout.keyFile,
      JSON.stringify({ ...JSON.parse(keyText), keyId: '0'.repeat(16) }),
    );
    await refused({}, {}, 'KEY_INVALID', { connects: false });
    await writeFile(fixture.layout.keyFile, keyText);
    // A run that finds another run's fresh lock leaves its status alone.
    const before = await readFile(fixture.layout.statusFile, 'utf8');
    await writeFile(fixture.layout.lockFile, '{}');
    result = await run(f, fixture);
    assert.deepEqual(
      [result.status.state, result.status.error, result.exitCode],
      ['skipped', 'LOCKED', 0],
    );
    assert.equal(await readFile(fixture.layout.statusFile, 'utf8'), before);
    assert.equal(result.calls.length, 0);
    // A lock older than the task's time limit belongs to a crashed run and is replaced.
    const stale = new Date(Date.now() - 4 * 3600_000);
    await utimes(fixture.layout.lockFile, stale, stale);
    // Two hours later, so the new copy has its own hour bucket next to the first one.
    result = await run(f, fixture, {}, { now: () => new Date(Date.now() + 2 * 3600_000) });
    assert.equal(result.status.state, 'ok');
    assert.equal(result.status.copies, 2);
    assert.deepEqual(await files(fixture.layout.stagingDir), []);
  });
});

test('maintenance lease is a no-op without the lock file and holds it open otherwise', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-edge-lease-'));
  try {
    const missing = await maintenanceLease(join(dir, 'unified-menu-maintenance.lock'));
    await missing.release();
    assert.deepEqual(await readdir(dir), []);
    await writeFile(join(dir, 'unified-menu-maintenance.lock'), '');
    const held = await maintenanceLease(join(dir, 'unified-menu-maintenance.lock'));
    await held.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  'real pg_dump/pg_restore produce a restorable archive (EDGE_BACKUP_TEST_PG_BIN)',
  {
    skip: realTools
      ? false
      : 'set EDGE_BACKUP_TEST_PG_BIN to pg_dump/pg_restore of the server version',
  },
  async () => {
    await withBackup(async (f, fixture) => {
      const calls = [];
      const result = await runEdgeBackup(
        {
          config: fixture.config,
          layout: fixture.layout,
          pinned,
          database: fixture.database,
          schema: f.edge.schema,
        },
        {
          connect: ({ user, password }) => connectAs(f.edge.config.databaseUrl, user, password),
          runTool: (name, args, options) => {
            calls.push(name);
            return realRunner(name, args, options);
          },
          enterMaintenance: async () => ({ release: async () => undefined }),
        },
      );
      assert.equal(result.status.state, 'ok', JSON.stringify(result.status));
      assert.deepEqual(calls, ['pg_dump', 'pg_restore']);
      const [archive] = await files(fixture.destination);
      const key = parseBackupKey(JSON.parse(await readFile(fixture.layout.keyFile, 'utf8')));
      const restored = join(fixture.destination, '..', 'real.dump');
      const read = await readEncryptedArchive({
        file: join(fixture.destination, archive),
        key,
        output: restored,
      });
      const list = await realRunner('pg_restore', ['--list', restored], {
        env: process.env,
        timeoutMs: 60000,
      });
      for (const table of Object.keys(read.meta.tableCounts))
        assert.match(list, new RegExp(`TABLE DATA ${f.edge.schema} ${table} `));
      // Full restore into a new database, then the runbook comparison against the archive.
      const target = 'ebk_restore_' + randomBytes(6).toString('hex');
      await f.edge.admin.query(`CREATE DATABASE ${target}`);
      try {
        const url = new URL(f.edge.config.databaseUrl);
        url.pathname = '/' + target;
        url.search = '';
        await realRunner(
          'pg_restore',
          [
            '--no-owner',
            '--no-acl',
            '--exit-on-error',
            '--single-transaction',
            '--dbname=' + url,
            restored,
          ],
          { env: process.env, timeoutMs: 120000 },
        );
        const restoredDb = await connectAs(
          url.toString(),
          url.username,
          decodeURIComponent(url.password),
        );
        try {
          assert.deepEqual(
            await compareRestoredDatabase(restoredDb, read.meta, { schema: f.edge.schema }),
            [],
          );
        } finally {
          await restoredDb.end();
        }
      } finally {
        await f.edge.admin.query(`DROP DATABASE ${target} WITH (FORCE)`);
      }
      await rm(restored);
    });
  },
);

test('a fresh key is never replaced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-edge-key-'));
  try {
    const path = join(dir, 'backup-key.json');
    assert.deepEqual(await prepareKey(path, { dryRun: true }), { keyId: null, created: true });
    await assert.rejects(readFile(path), { code: 'ENOENT' });
    const first = await prepareKey(path);
    assert.equal(first.created, true);
    assert.deepEqual(await prepareKey(path), { keyId: first.keyId, created: false });
    assert.equal(parseBackupKey(JSON.parse(await readFile(path, 'utf8'))).keyId, first.keyId);
    await writeFile(path, JSON.stringify({ ...createBackupKey(), keyId: '1'.repeat(16) }));
    await assert.rejects(prepareKey(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
