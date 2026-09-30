import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, lstat, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { validateCredentials } from './native-foundation-db.mjs';

const execute = promisify(execFile);
export function rehearsalName(id) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id))
    throw new Error('Invalid rehearsal identifier');
  return 'pickchick_restore_' + id.replaceAll('-', '').toLowerCase();
}
const identifier = (name) => '"' + name.replaceAll('"', '""') + '"';

export async function dropOwnedRehearsal(admin, name, oid, marker) {
  if (!/^pickchick_restore_[a-f0-9]{32}$/.test(name) || !Number.isInteger(oid) || oid <= 0)
    throw new Error('Invalid cleanup target');
  const row = (
    await admin.query(
      `SELECT oid,pg_get_userbyid(datdba) AS owner,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1`,
      [name],
    )
  ).rows[0];
  if (!row || row.oid !== oid || row.owner !== 'pickchick_bootstrap' || row.marker !== marker)
    throw new Error('Rehearsal ownership changed; cleanup refused');
  // No FORCE: unrelated/open sessions cause preservation and a failed report.
  await admin.query(`DROP DATABASE ${identifier(name)}`);
}

async function tableCounts(client) {
  const tables = (
    await client.query(
      "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname",
    )
  ).rows;
  const counts = {};
  for (const { relname } of tables)
    counts[relname] = (
      await client.query(`SELECT count(*)::text AS count FROM public.${identifier(relname)}`)
    ).rows[0].count;
  return counts;
}

async function tableFingerprints(client, counts) {
  const result = {};
  for (const name of Object.keys(counts)) {
    result[name] = (
      await client.query(`SELECT md5(COALESCE(string_agg(row_hash, '' ORDER BY row_hash), '')) AS digest
      FROM (SELECT md5(to_jsonb(t)::text) AS row_hash FROM public.${identifier(name)} t) rows`)
    ).rows[0].digest;
  }
  return result;
}

async function readJson(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 10000)
    throw new Error('Invalid private operator record');
  return JSON.parse(await readFile(file, 'utf8'));
}

export function verifyServiceSnapshot(branches, ledger, branchId, expectedLedger) {
  if (
    branches.length !== 1 ||
    branches[0].id !== branchId ||
    branches[0].ordering_enabled !== true ||
    branches[0].pos_service_mode !== 'unpaid_service'
  )
    throw new Error('Unexpected active service branch');
  if (ledger.length !== 14 || JSON.stringify(ledger) !== JSON.stringify(expectedLedger))
    throw new Error('Service migration ledger differs');
}

async function main() {
  const [toolsRoot, pgBin, runRoot, branchId, ...extra] = process.argv.slice(2);
  if (extra.length || !toolsRoot || !pgBin || !runRoot || !branchId)
    throw new Error('Invalid backup invocation');
  const state = await readJson(join(toolsRoot, 'private', 'foundation-state.json'));
  const credentials = validateCredentials(
    await readJson(join(toolsRoot, 'private', 'foundation-credentials.json')),
    branchId,
  );
  if (
    state.format !== 'pickchick-native-state-v1' ||
    !state.complete ||
    state.installId !== credentials.installId ||
    state.branchId !== branchId ||
    !/^\d{10,20}$/.test(state.systemIdentifier)
  )
    throw new Error('Completed matching native foundation required');
  const { Client } = createRequire(join(resolve(toolsRoot), 'package.json'))('pg');
  const pgData = resolve(toolsRoot, '..', '..', 'Postgres', '18', 'data');
  const expectedLedger = JSON.parse(
    await readFile(new URL('./native-service-backup-ledger.json', import.meta.url), 'utf8'),
  );
  const runId = randomUUID();
  const database = rehearsalName(runId);
  const marker = `pickchick-backup-rehearsal:${runId}:${state.installId}`;
  const archive = join(runRoot, 'pickchick_edge.dump');
  const passfile = join(runRoot, 'pgpass.tmp');
  const manifestFile = join(runRoot, 'backup-manifest.json');
  const manifest = {
    format: 'pickchick-native-service-backup-v1',
    runId,
    branchId,
    systemIdentifier: state.systemIdentifier,
    startedAt: new Date().toISOString(),
    sourceDatabase: 'pickchick_edge',
    rehearsalDatabase: database,
    backupVerified: false,
    restoreVerified: false,
    rehearsalDropped: false,
    completed: false,
  };
  const common = {
    host: '127.0.0.1',
    port: 55433,
    ssl: false,
    user: 'pickchick_bootstrap',
    password: credentials.passwords.pickchick_bootstrap,
    database: 'postgres',
    connectionTimeoutMillis: 3000,
    statement_timeout: 30000,
  };
  const admin = new Client(common);
  const source = new Client({
    ...common,
    database: 'pickchick_edge',
    user: 'pickchick_edge_owner',
    password: credentials.passwords.pickchick_edge_owner,
  });
  for (const client of [admin, source]) client.on('error', () => {});
  let target;
  let ownedOid;
  let snapshotOpen = false;
  let failure;
  const save = () =>
    writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(PG|EDGE_|NODE_OPTIONS|CLOUD_)/i.test(key)),
  );
  Object.assign(env, {
    PGPASSFILE: passfile,
    PGHOST: '127.0.0.1',
    PGPORT: '55433',
    PGSSLMODE: 'disable',
    PGCONNECT_TIMEOUT: '3',
  });
  const run = async (name, args) => {
    try {
      return (
        await execute(join(pgBin, name + '.exe'), args, {
          env,
          timeout: 120000,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        })
      ).stdout;
    } catch {
      throw new Error(`Local backup process failed: ${name}`);
    }
  };
  try {
    await save();
    await writeFile(
      passfile,
      ['pickchick_bootstrap', 'pickchick_edge_owner']
        .map((role) => `127.0.0.1:55433:*:${role}:${credentials.passwords[role]}\n`)
        .join(''),
      { flag: 'wx', mode: 0o600 },
    );
    await admin.connect();
    const cluster = (
      await admin.query(
        "SELECT system_identifier::text AS id, current_setting('data_directory') AS directory FROM pg_control_system()",
      )
    ).rows[0];
    if (
      cluster.id !== state.systemIdentifier ||
      cluster.directory.replaceAll('\\', '/').toLowerCase() !==
        pgData.replaceAll('\\', '/').toLowerCase()
    )
      throw new Error('Different PostgreSQL cluster');
    await source.connect();
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    snapshotOpen = true;
    const snapshot = (await source.query('SELECT pg_export_snapshot() AS snapshot')).rows[0]
      .snapshot;
    manifest.branch = (
      await source.query('SELECT id,ordering_enabled,pos_service_mode FROM branch_config')
    ).rows;
    manifest.ledger = (
      await source.query('SELECT version,checksum,scope FROM schema_migrations ORDER BY version')
    ).rows;
    verifyServiceSnapshot(manifest.branch, manifest.ledger, branchId, expectedLedger);
    manifest.tableCounts = await tableCounts(source);
    manifest.tableFingerprints = await tableFingerprints(source, manifest.tableCounts);
    if (Object.keys(manifest.tableCounts).length < 9)
      throw new Error('Unexpectedly incomplete edge schema');
    await run('pg_dump', [
      '--format=custom',
      '--file=' + archive,
      '--username=pickchick_edge_owner',
      '--no-password',
      '--snapshot=' + snapshot,
      '--dbname=pickchick_edge',
    ]);
    await source.query('ROLLBACK');
    snapshotOpen = false;
    const contents = await run('pg_restore', ['--list', archive]);
    if (!contents.includes('TABLE DATA public ') || !contents.includes('schema_migrations'))
      throw new Error('Archive contents are incomplete');
    await writeFile(join(runRoot, 'archive-list.txt'), contents, { flag: 'wx', mode: 0o600 });
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    manifest.sha256 = hash.digest('hex');
    manifest.archiveBytes = (await lstat(archive)).size;
    manifest.backupVerified = true;
    await save();
    if ((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount)
      throw new Error('Fresh rehearsal database name is occupied');
    await admin.query(
      `CREATE DATABASE ${identifier(database)} OWNER pickchick_bootstrap TEMPLATE template0 ENCODING 'UTF8'`,
    );
    ownedOid = (await admin.query('SELECT oid FROM pg_database WHERE datname=$1', [database]))
      .rows[0]?.oid;
    // Marker contains only validated/generated UUIDs, never credentials or input SQL.
    await admin.query(`COMMENT ON DATABASE ${identifier(database)} IS '${marker}'`);
    await admin.query(`REVOKE ALL ON DATABASE ${identifier(database)} FROM PUBLIC`);
    manifest.rehearsalOid = ownedOid;
    await save();
    await run('pg_restore', [
      '--username=pickchick_bootstrap',
      '--no-password',
      '--no-owner',
      '--no-acl',
      '--exit-on-error',
      '--single-transaction',
      '--dbname=' + database,
      archive,
    ]);
    target = new Client({ ...common, database });
    target.on('error', () => {});
    await target.connect();
    const restored = await tableCounts(target);
    if (JSON.stringify(restored) !== JSON.stringify(manifest.tableCounts))
      throw new Error('Restored table counts differ from the dump snapshot');
    if (
      JSON.stringify(await tableFingerprints(target, restored)) !==
      JSON.stringify(manifest.tableFingerprints)
    )
      throw new Error('Restored data fingerprints differ from the dump snapshot');
    const binding = (
      await target.query('SELECT id,ordering_enabled,pos_service_mode FROM branch_config')
    ).rows;
    const ledger = (
      await target.query('SELECT version,checksum,scope FROM schema_migrations ORDER BY version')
    ).rows;
    verifyServiceSnapshot(binding, ledger, branchId, expectedLedger);
    if (JSON.stringify(binding) !== JSON.stringify(manifest.branch))
      throw new Error('Restored branch differs');
    manifest.restoreVerified = true;
  } catch (error) {
    failure = error;
  } finally {
    if (snapshotOpen) await source.query('ROLLBACK').catch(() => {});
    await target?.end().catch(() => {
      failure ??= new Error('Rehearsal connection cleanup failed');
    });
    await source.end().catch(() => {
      failure ??= new Error('Source connection cleanup failed');
    });
    if (ownedOid) {
      try {
        await dropOwnedRehearsal(admin, database, ownedOid, marker);
        manifest.rehearsalDropped = true;
      } catch {
        failure ??= new Error(
          'Owned rehearsal database requires operator inspection; not force-dropped',
        );
      }
    }
    await admin.end().catch(() => {
      failure ??= new Error('Operator connection cleanup failed');
    });
    await unlink(passfile).catch((error) => {
      if (error.code !== 'ENOENT')
        failure ??= new Error('Private temporary password file cleanup failed');
    });
    manifest.completed =
      !failure && manifest.backupVerified && manifest.restoreVerified && manifest.rehearsalDropped;
    manifest.finishedAt = new Date().toISOString();
    await save();
  }
  if (failure) throw new Error('Local backup/rehearsal incomplete; inspect the protected manifest');
  console.log(
    JSON.stringify({
      event: 'native_backup_verified',
      backupVerified: true,
      restoreVerified: true,
      rehearsalDropped: true,
      publicTables: Object.keys(manifest.tableCounts).length,
      archiveBytes: manifest.archiveBytes,
      sha256: manifest.sha256,
    }),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(
      JSON.stringify({
        event: 'native_backup_failed',
        detail: 'Inspect protected local backup manifest; no existing database is overwritten.',
      }),
    );
    process.exitCode = 1;
  });
}
