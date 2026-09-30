import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const identifier = (name) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error('Invalid schema identifier');
  return '"' + name + '"';
};
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Read-only checks. Tests provide their own explicitly isolated schema. */
export async function inspectPreview(client, { branchId, migrations, role, schema = 'public' }) {
  const ns = identifier(schema);
  const user = (await client.query('SELECT current_user AS role')).rows[0].role;
  if (user !== role || !/^[a-f0-9-]{36}$/i.test(branchId) || ![9, 10].includes(migrations.length))
    throw new Error('Upgrade scope mismatch');
  const ledger = (
    await client.query(
      `SELECT scope,version,checksum FROM ${ns}.schema_migrations ORDER BY version`,
    )
  ).rows;
  if (
    ledger.length !== migrations.length ||
    ledger.some(
      (row, index) =>
        row.scope !== 'edge' ||
        row.version !== migrations[index].name ||
        row.checksum !== migrations[index].checksum,
    )
  )
    throw new Error('Upgrade migration ledger differs');
  const branches = (await client.query(`SELECT id,ordering_enabled FROM ${ns}.branch_config`)).rows;
  if (
    branches.length !== 1 ||
    branches[0].id !== branchId ||
    branches[0].ordering_enabled !== false
  )
    throw new Error('Assigned closed preview branch required');
  const active = (
    await client.query(
      `SELECT s.id AS release_id,s.version FROM ${ns}.active_menu a
    JOIN ${ns}.menu_snapshots s ON s.id=a.release_id AND s.branch_id=a.branch_id WHERE a.branch_id=$1`,
      [branchId],
    )
  ).rows;
  if (active.length !== 1) throw new Error('Assigned preview menu required');
  for (const table of [
    'local_orders',
    'checkout_quotes',
    ...(migrations.length === 10 ? ['local_cash_shifts'] : []),
  ]) {
    if (
      (await client.query(`SELECT count(*)::text AS count FROM ${ns}.${identifier(table)}`)).rows[0]
        .count !== '0'
    )
      throw new Error('This upgrade accepts the unused preview only');
  }
  const tables = (
    await client.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p') ORDER BY c.relname`,
      [schema],
    )
  ).rows.map((row) => row.relname);
  if (tables.length !== (migrations.length === 9 ? 30 : 31))
    throw new Error('Unexpected preview table set');
  const fingerprints = {},
    tableCounts = {};
  for (const table of tables) {
    if (['schema_migrations', 'local_cash_shifts'].includes(table)) continue;
    const rows = (
      await client.query(
        `SELECT to_jsonb(t)-'cash_shift_id' AS value FROM ${ns}.${identifier(table)} t ORDER BY (to_jsonb(t)-'cash_shift_id')::text LIMIT 10001`,
      )
    ).rows;
    if (rows.length > 10000) throw new Error('Preview verification row limit exceeded');
    fingerprints[table] = digest(rows.map((row) => row.value));
    tableCounts[table] = String(rows.length);
  }
  return {
    branchId,
    migrations: ledger.length,
    fingerprints,
    tableCounts,
    activeMenu: active[0],
    orderingEnabled: false,
  };
}

async function main() {
  const [phase, toolsRoot, branchId, ...extra] = process.argv.slice(2);
  if (extra.length || !['before', 'after', 'runtime'].includes(phase) || !toolsRoot)
    throw new Error('Invalid upgrade invocation');
  const url = new URL(process.env.EDGE_DATABASE_URL ?? '');
  const role = phase === 'runtime' ? 'pickchick_edge_runtime' : 'pickchick_edge_owner';
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '55433' ||
    url.pathname !== '/pickchick_edge' ||
    url.username !== role ||
    !url.password ||
    url.search ||
    url.hash ||
    process.env.EDGE_BRANCH_ID !== branchId ||
    process.env.APP_ENV !== 'local' ||
    process.env.EDGE_FULFILLMENT_ENABLED !== 'false'
  )
    throw new Error('Protected closed edge environment required');
  const { Client } = createRequire(join(resolve(toolsRoot), 'package.json'))('pg');
  const client = new Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 3000,
    statement_timeout: 30000,
  });
  client.on('error', () => {});
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if (phase === 'runtime') {
      const actual = (await client.query('SELECT current_user AS role')).rows[0].role;
      const branch = (await client.query('SELECT id,ordering_enabled FROM branch_config')).rows;
      if (
        actual !== role ||
        branch.length !== 1 ||
        branch[0].id !== branchId ||
        branch[0].ordering_enabled
      )
        throw new Error('Runtime branch binding differs');
      for (const table of [
        'local_cash_shifts',
        'local_orders',
        'checkout_quotes',
        'local_staff',
        'local_terminals',
        'staff_sessions',
        'local_command_results',
      ])
        await client.query(`SELECT 1 FROM ${identifier(table)} LIMIT 0`);
      const permissions = (
        await client.query(`SELECT has_table_privilege(current_user,'local_cash_shifts','INSERT') AS shift_insert,
        has_column_privilege(current_user,'local_cash_shifts','counted_cash_minor','UPDATE') AS shift_close,
        has_column_privilege(current_user,'local_cash_shifts','opening_cash_minor','UPDATE') AS shift_rewrite,
        has_table_privilege(current_user,'local_cash_shifts','DELETE') AS shift_delete,
        has_column_privilege(current_user,'local_staff','role','UPDATE') AS staff_role,
        has_column_privilege(current_user,'staff_sessions','token_hash','UPDATE') AS token_rewrite`)
      ).rows[0];
      if (
        !permissions.shift_insert ||
        !permissions.shift_close ||
        permissions.shift_rewrite ||
        permissions.shift_delete ||
        permissions.staff_role ||
        permissions.token_rewrite
      )
        throw new Error('Runtime grant boundary differs');
      console.log(JSON.stringify({ runtimeVerified: true, orderingEnabled: false }));
    } else {
      const dir = join(toolsRoot, 'db', 'edge', 'migrations');
      const names = (await readdir(dir)).filter((name) => /^\d{3}_[a-z_]+\.sql$/.test(name)).sort();
      if (
        names.length !== 10 ||
        names.some((name, index) => !name.startsWith(String(index + 1).padStart(3, '0') + '_'))
      )
        throw new Error('Expected reviewed edge migrations 001-010');
      const migrations = [];
      for (const name of names.slice(0, phase === 'before' ? 9 : 10))
        migrations.push({
          name,
          checksum: createHash('sha256')
            .update(await readFile(join(dir, name)))
            .digest('hex'),
        });
      console.log(JSON.stringify(await inspectPreview(client, { branchId, migrations, role })));
    }
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(JSON.stringify({ event: 'native_upgrade_verification_failed' }));
    process.exitCode = 1;
  });
}
