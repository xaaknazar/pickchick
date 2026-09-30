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

const legacyTables = [
  'active_menu',
  'branch_config',
  'checkout_quotes',
  'fulfillment_commands',
  'fulfillment_config',
  'fulfillment_inbox',
  'fulfillment_outbox',
  'fulfillment_release_results',
  'fulfillment_reservations',
  'fulfillment_routing',
  'fulfillment_station_grants',
  'fulfillment_stations',
  'fulfillment_tasks',
  'fulfillment_transport_failures',
  'fulfillment_transport_reverse_failures',
  'fulfillment_transport_state',
  'inbox_messages',
  'local_audit',
  'local_command_results',
  'local_order_streams',
  'local_orders',
  'local_staff',
  'local_stops',
  'local_terminals',
  'menu_snapshots',
  'menu_sync_state',
  'outbox_events',
  'pos_order_sync_state',
  'schema_migrations',
  'staff_sessions',
];
const newTables = [
  [10, 'local_cash_shifts'],
  [11, 'local_staff_passwords'],
  [11, 'local_staff_login_limits'],
  [12, 'local_pos_service_setup'],
  [13, 'pos_kitchen_sync_state'],
  [14, 'local_staff_pins'],
  [14, 'local_pin_lookup_keys'],
  [14, 'local_cash_movements'],
];
const excludedColumns = {
  branch_config: ['pos_service_mode'],
  local_orders: ['cash_shift_id', 'execution_mode'],
  local_stops: ['expires_at', 'expires_shift_id', 'updated_at', 'updated_by'],
  fulfillment_reservations: ['admission_kind', 'local_order_id', 'authorized_by_staff_id'],
};

/** Read-only checks. Tests provide their own explicitly isolated schema. */
export async function inspectServiceUpgrade(
  client,
  { branchId, migrations, role, schema = 'public' },
) {
  const ns = identifier(schema);
  const user = (await client.query('SELECT current_user AS role')).rows[0].role;
  if (
    user !== role ||
    !/^[a-f0-9-]{36}$/i.test(branchId) ||
    !(migrations.length >= 9 && migrations.length <= 14)
  )
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
  const branches = (
    await client.query(
      `SELECT id,ordering_enabled,to_jsonb(b)->>'pos_service_mode' AS pos_service_mode FROM ${ns}.branch_config b`,
    )
  ).rows;
  if (
    branches.length !== 1 ||
    branches[0].id !== branchId ||
    branches[0].ordering_enabled !== false ||
    (migrations.length >= 12 && branches[0].pos_service_mode !== 'payment_required')
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
    'fulfillment_reservations',
    'fulfillment_tasks',
    'fulfillment_config',
    'pos_order_sync_state',
    ...newTables.filter(([version]) => version <= migrations.length).map(([, table]) => table),
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
  const expectedTables = [
    ...legacyTables,
    ...newTables.filter(([version]) => version <= migrations.length).map(([, table]) => table),
  ].sort();
  if (JSON.stringify(tables) !== JSON.stringify(expectedTables))
    throw new Error('Unexpected preview table set');
  const fingerprints = {},
    tableCounts = {};
  for (const table of tables) {
    if (table === 'schema_migrations' || !legacyTables.includes(table)) continue;
    const excluded = excludedColumns[table] ?? [];
    const projection =
      'to_jsonb(t)' +
      (excluded.length
        ? '-ARRAY[' + excluded.map((column) => "'" + column + "'").join(',') + ']::text[]'
        : '');
    const rows = (
      await client.query(
        `SELECT ${projection} AS value FROM ${ns}.${identifier(table)} t ORDER BY (${projection})::text LIMIT 10001`,
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
    serviceMode: 'payment_required',
  };
}

export async function inspectServiceRuntime(client, { branchId, role, schema = 'public' }) {
  await client.query('SET LOCAL search_path TO ' + identifier(schema));
  const actual = (await client.query('SELECT current_user AS role')).rows[0].role;
  const branch = (
    await client.query('SELECT id,ordering_enabled,pos_service_mode FROM branch_config')
  ).rows;
  if (
    actual !== role ||
    branch.length !== 1 ||
    branch[0].id !== branchId ||
    branch[0].ordering_enabled ||
    branch[0].pos_service_mode !== 'payment_required'
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
    'local_staff_passwords',
    'local_staff_login_limits',
  ])
    await client.query(`SELECT 1 FROM ${identifier(table)} LIMIT 0`);
  const permissions = (
    await client.query(`SELECT has_table_privilege(current_user,'local_cash_shifts','INSERT') AS shift_insert,
        has_column_privilege(current_user,'local_cash_shifts','counted_cash_minor','UPDATE') AS shift_close,
        has_column_privilege(current_user,'local_cash_shifts','opening_cash_minor','UPDATE') AS shift_rewrite,
        has_table_privilege(current_user,'local_cash_shifts','DELETE') AS shift_delete,
        has_column_privilege(current_user,'local_staff','role','UPDATE') AS staff_role,
        has_column_privilege(current_user,'staff_sessions','token_hash','UPDATE') AS token_rewrite,
        has_table_privilege(current_user,'local_staff_passwords','SELECT') AS password_read,
        has_column_privilege(current_user,'local_staff_passwords','failed_attempts','UPDATE') AS password_failures,
        has_column_privilege(current_user,'local_staff_passwords','verifier','UPDATE') AS password_rewrite,
        has_column_privilege(current_user,'branch_config','pos_service_mode','UPDATE') AS service_mode_write,
        has_table_privilege(current_user,'fulfillment_reservations','INSERT') AS kitchen_admission,
        has_table_privilege(current_user,'local_pos_service_setup','INSERT') AS service_setup,
        has_table_privilege(current_user,'pos_kitchen_sync_state','UPDATE') AS sync_writer`)
  ).rows[0];
  if (
    !permissions.shift_insert ||
    !permissions.shift_close ||
    permissions.shift_rewrite ||
    permissions.shift_delete ||
    permissions.staff_role ||
    permissions.token_rewrite ||
    !permissions.password_read ||
    !permissions.password_failures ||
    permissions.password_rewrite ||
    permissions.service_mode_write ||
    permissions.kitchen_admission ||
    permissions.service_setup ||
    permissions.sync_writer
  )
    throw new Error('Runtime grant boundary differs');
  return {
    runtimeVerified: true,
    orderingEnabled: false,
    serviceMode: 'payment_required',
    fulfillmentEnabled: false,
  };
}

async function main() {
  const [phase, toolsRoot, branchId, ...extra] = process.argv.slice(2);
  if (extra.length || !['before', 'progress', 'after', 'runtime'].includes(phase) || !toolsRoot)
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
    process.env.EDGE_FULFILLMENT_ENABLED !== 'false' ||
    [
      'EDGE_FULFILLMENT_TRANSPORT_ENABLED',
      'EDGE_POS_ORDER_SYNC_ENABLED',
      'EDGE_POS_KITCHEN_SYNC_ENABLED',
      'TEST_ORDER_FLOW_ENABLED',
    ].some((key) => process.env[key] !== undefined && process.env[key] !== 'false')
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
      console.log(JSON.stringify(await inspectServiceRuntime(client, { branchId, role })));
    } else {
      const dir = join(toolsRoot, 'db', 'edge', 'migrations');
      const names = (await readdir(dir)).filter((name) => /^\d{3}_[a-z_]+\.sql$/.test(name)).sort();
      if (
        names.length !== 14 ||
        names.some((name, index) => !name.startsWith(String(index + 1).padStart(3, '0') + '_'))
      )
        throw new Error('Expected reviewed edge migrations 001-014');
      const count =
        phase === 'progress'
          ? Number(
              (
                await client.query(
                  "SELECT count(*)::int AS count FROM schema_migrations WHERE scope='edge'",
                )
              ).rows[0].count,
            )
          : phase === 'before'
            ? 9
            : 14;
      if (count < 9 || count > 14) throw new Error('Unexpected partial upgrade ledger');
      const migrations = [];
      for (const name of names.slice(0, count))
        migrations.push({
          name,
          checksum: createHash('sha256')
            .update(await readFile(join(dir, name)))
            .digest('hex'),
        });
      console.log(
        JSON.stringify(await inspectServiceUpgrade(client, { branchId, migrations, role })),
      );
    }
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(JSON.stringify({ event: 'native_service_upgrade_verification_failed' }));
    process.exitCode = 1;
  });
}
