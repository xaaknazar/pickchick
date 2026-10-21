import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Edge schema022 -> 023 (release fixes 2026-10-19, audit 6.4): database epoch ledger and the
 * owner-rights `edge_restore_fence()`. Run by the edge owner with every edge service stopped and a
 * fresh verified backup, after display-numbers-upgrade-db.mjs (022). `inspect` changes nothing;
 * `apply` adds the migration in one transaction, grants EXECUTE on the fence to the runtime and
 * transport roles, and proves every existing row (over its pre-023 columns: 023 adds the NULL
 * column menu_sync_state.restore_resync_from), sequence and table privilege unchanged, and that
 * the migration only recorded the 'initial' epoch. Rollback: the previous binary keeps working on
 * 023 (it never calls the fence), so no schema rollback is needed.
 */
export const RESTORE_FENCE_MIGRATION = '023_edge_restore_fence.sql';
export const ADDED_COLUMNS = { menu_sync_state: ['restore_resync_from'] };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identifier = (name) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name ?? '')) throw Error('Invalid identifier');
  return '"' + name + '"';
};

export async function restoreFenceMigration(
  client,
  {
    mode,
    appRoot,
    branchId,
    schema = 'public',
    runtimeRole = 'pickchick_edge_runtime',
    workerRole = 'pickchick_fulfillment_sync',
  },
) {
  if (!['inspect', 'apply'].includes(mode)) throw Error('Invalid mode');
  const ns = identifier(schema);
  identifier(runtimeRole);
  identifier(workerRole);
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('SET LOCAL search_path TO ' + ns);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('pickchick-restore-fence-023',0))",
    );
    const tables = (
      await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [
        schema,
      ])
    ).rows.map((r) => r.tablename);
    await client.query(
      'LOCK TABLE ' +
        tables.map((n) => ns + '.' + identifier(n)).join(',') +
        ' IN ACCESS EXCLUSIVE MODE',
    );
    const ledger = (
      await client.query('SELECT scope,version,checksum FROM schema_migrations ORDER BY version')
    ).rows;
    const dir = join(appRoot, 'db/edge/migrations');
    const names = (await readdir(dir)).filter((n) => /^\d{3}_[a-z_]+\.sql$/.test(n)).sort();
    const expected = [];
    for (const name of names.slice(0, 23))
      expected.push({
        scope: 'edge',
        version: name,
        checksum: digest(await readFile(join(dir, name))),
      });
    if (
      expected.length !== 23 ||
      names[22] !== RESTORE_FENCE_MIGRATION ||
      JSON.stringify(ledger) !== JSON.stringify(expected.slice(0, 22))
    )
      throw Error('Expected unchanged schema022 and only reviewed migration023');
    if (tables.includes('edge_database_epochs')) throw Error('Restore fence objects already exist');
    const branches = (await client.query('SELECT id FROM branch_config')).rows;
    if (branches.length !== 1 || branches[0].id !== branchId) throw Error('Branch differs');
    const columns = Object.fromEntries(
      (
        await client.query(
          `SELECT table_name AS name, array_agg(column_name::text ORDER BY ordinal_position) AS columns
             FROM information_schema.columns WHERE table_schema=$1 GROUP BY table_name`,
          [schema],
        )
      ).rows.map((r) => [r.name, r.columns]),
    );
    const snapshot = async () => {
      const result = {};
      for (const table of tables.filter((t) => t !== 'schema_migrations')) {
        const projection = `jsonb_build_object(${columns[table]
          .map((c) => `'${c}',t.${identifier(c)}`)
          .join(',')})`;
        result[table] = (
          await client.query(
            `SELECT count(*)::text AS count, md5(COALESCE(string_agg(h,'' ORDER BY h),'')) AS hash FROM (SELECT md5((${projection})::text) h FROM ${ns}.${identifier(table)} t) r`,
          )
        ).rows[0];
      }
      result.sequences = (
        await client.query(
          'SELECT sequencename,last_value FROM pg_sequences WHERE schemaname=$1 ORDER BY sequencename',
          [schema],
        )
      ).rows;
      result.acl = (
        await client.query(
          "SELECT relname,relacl FROM pg_class WHERE relnamespace=$1::regnamespace AND relkind IN ('r','S') AND relname=ANY($2) ORDER BY relname",
          [schema, tables],
        )
      ).rows;
      return JSON.stringify(result);
    };
    const before = await snapshot();
    const roles = (
      await client.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1) ORDER BY rolname', [
        [runtimeRole, workerRole],
      ])
    ).rows.map((r) => r.rolname);
    let epoch = null;
    if (mode === 'apply') {
      await client.query(await readFile(join(dir, RESTORE_FENCE_MIGRATION), 'utf8'));
      await client.query('INSERT INTO schema_migrations(scope,version,checksum) VALUES($1,$2,$3)', [
        'edge',
        RESTORE_FENCE_MIGRATION,
        expected[22].checksum,
      ]);
      for (const role of roles)
        await client.query(
          `GRANT EXECUTE ON FUNCTION ${ns}.edge_restore_fence(boolean) TO ${identifier(role)}`,
        );
      const after = (
        await client.query(
          `SELECT table_name AS name, array_agg(column_name::text ORDER BY ordinal_position) AS columns
             FROM information_schema.columns WHERE table_schema=$1 GROUP BY table_name`,
          [schema],
        )
      ).rows;
      for (const { name, columns: cols } of after)
        if (
          name !== 'edge_database_epochs' &&
          JSON.stringify(cols) !==
            JSON.stringify([...(columns[name] ?? []), ...(ADDED_COLUMNS[name] ?? [])])
        )
          throw Error('Unexpected column change');
      const epochs = (
        await client.query(
          'SELECT epoch,reason,sequence_gap::text AS gap FROM edge_database_epochs ORDER BY epoch',
        )
      ).rows;
      if (JSON.stringify(epochs) !== JSON.stringify([{ epoch: 1, reason: 'initial', gap: '0' }]))
        throw Error('Restore fence recorded more than the initial epoch');
      epoch = epochs[0].epoch;
      if ((await snapshot()) !== before)
        throw Error('Data, sequence or permission changed during migration');
    }
    await client.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
    return {
      mode,
      migrations: mode === 'apply' ? 23 : 22,
      fenceGrantedTo: mode === 'apply' ? roles : [],
      epoch,
      dataPreserved: true,
      fingerprint: digest(before),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function main() {
  const [mode, toolsRoot, appRoot, branchId, ...extra] = process.argv.slice(2);
  if (
    !['inspect', 'apply'].includes(mode) ||
    extra.length ||
    !toolsRoot ||
    !appRoot ||
    !/^[a-f0-9-]{36}$/.test(branchId ?? '')
  )
    throw Error('Invalid restore fence migration invocation');
  const url = new URL(process.env.EDGE_DATABASE_URL ?? '');
  if (
    url.hostname !== '127.0.0.1' ||
    url.port !== '55433' ||
    url.pathname !== '/pickchick_edge' ||
    url.username !== 'pickchick_edge_owner'
  )
    throw Error('Expected local edge owner');
  const { Client } = createRequire(join(resolve(toolsRoot), 'package.json'))('pg');
  const client = new Client({
    connectionString: url.href,
    connectionTimeoutMillis: 3000,
    statement_timeout: 30000,
  });
  client.on('error', () => {});
  await client.connect();
  try {
    console.log(JSON.stringify(await restoreFenceMigration(client, { mode, appRoot, branchId })));
  } finally {
    await client.end();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error('Restore fence migration stopped; inspect protected state.');
    process.exitCode = 1;
  });
