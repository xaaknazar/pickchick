/**
 * Owner-side database step of the unified-menu cloud release (release-unified-menu.py).
 * Runs inside the candidate API image as the owner role, never as the runtime role.
 *
 *   node infra/staging/unified-menu-owner.mjs inspect
 *   node infra/staging/unified-menu-owner.mjs deploy
 *   node infra/staging/unified-menu-owner.mjs flag <access-roles|edge-publication|remote-stops|media-upload> <true|false>
 *
 * deploy applies cloud migrations 047-049 and only the grants they need with every new flag
 * off, in ONE repeatable-read transaction that also proves every pre-existing table kept every
 * row: the before/after fingerprints come from the same snapshot, so live traffic (cashier
 * heartbeats, orders) neither blocks the proof nor makes it flaky. Full provision.mjs is never
 * run: it rewrites unrelated runtime ACL. Output is counts and booleans only, never row data.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backofficeStopGrants } from './backoffice-stop-grants.mjs';
import { catalogAssetGrants } from './catalog-asset-grants.mjs';
import {
  catalogAccessGrants,
  edgeMenuStateGrants,
  edgePublicationGrants,
} from './catalog-edge-grants.mjs';

export const UNIFIED_MENU_MIGRATIONS = Object.freeze([
  '047_cloud_edge_menu_state.sql',
  '048_cloud_stop_commands.sql',
  '049_cloud_catalog_assets.sql',
]);
export const UNIFIED_MENU_TABLES = Object.freeze([
  'catalog_asset_audit',
  'catalog_asset_variants',
  'catalog_assets',
  'catalog_menu_delivery_results',
  'cloud_stop_commands',
  'edge_menu_state',
]);
/** The only column the release adds to an existing table (cloud048); NULL until protocol 4. */
export const UNIFIED_MENU_COLUMNS = Object.freeze({ cloud_branch_availability: ['stop_states'] });
export const UNIFIED_MENU_FLAGS = Object.freeze([
  'access-roles',
  'edge-publication',
  'remote-stops',
  'media-upload',
]);
const MIGRATION_LOCK = 724001; // Same advisory lock as @pickchick/database migrate().

export class OwnerGuardError extends Error {}
const guard = (condition, message) => {
  if (!condition) throw new OwnerGuardError(message);
};
const ROLE = /^[a-z][a-z0-9_]{0,62}$/;
const quoteIdent = (name) => '"' + name.replaceAll('"', '""') + '"';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Runtime privileges as a sorted list of "table|column|privilege" (column '' for table level). */
export async function runtimePrivileges(client, role) {
  guard(ROLE.test(role), 'Invalid runtime role');
  const { rows } = await client.query(
    `SELECT c.relname AS name, NULL::text AS col, x.privilege_type AS privilege
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       CROSS JOIN LATERAL aclexplode(c.relacl) x JOIN pg_roles r ON r.oid=x.grantee
      WHERE n.nspname=current_schema() AND r.rolname=$1 AND c.relkind IN ('r','p','v','m','f','S')
     UNION ALL
     SELECT c.relname, a.attname, x.privilege_type
       FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
       CROSS JOIN LATERAL aclexplode(a.attacl) x JOIN pg_roles r ON r.oid=x.grantee
      WHERE n.nspname=current_schema() AND r.rolname=$1 AND a.attnum>0 AND NOT a.attisdropped`,
    [role],
  );
  return rows.map((r) => `${r.name}|${r.col ?? ''}|${r.privilege}`).sort();
}

/**
 * Per table: the column list and a hash over every row restricted to the given columns, so a
 * column added by a migration does not change the fingerprint of the rows that existed.
 */
export async function fingerprint(client, columnsByTable) {
  const result = {};
  for (const [table, columns] of Object.entries(columnsByTable).sort()) {
    guard(/^[a-z_][a-z0-9_]*$/.test(table), 'Unexpected table identifier');
    const projection = columns.length
      ? `jsonb_build_object(${columns.map((c) => `'${c.replaceAll("'", "''")}',t.${quoteIdent(c)}`).join(',')})`
      : `'{}'::jsonb`;
    const { rows } = await client.query(
      `SELECT count(*)::int AS rows,
              encode(sha256(convert_to(coalesce(string_agg(h,'' ORDER BY h),''),'UTF8')),'hex') AS hash
         FROM (SELECT encode(sha256(convert_to((${projection})::text,'UTF8')),'hex') h
                 FROM ${quoteIdent(table)} t) hashed`,
    );
    result[table] = { columns: [...columns], rows: rows[0].rows, hash: rows[0].hash };
  }
  return result;
}

async function tableColumns(client) {
  const { rows } = await client.query(
    `SELECT c.relname AS name, coalesce(array_agg(a.attname::text ORDER BY a.attnum) FILTER (WHERE a.attnum>0), '{}'::text[]) AS columns
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      WHERE n.nspname=current_schema() AND c.relkind IN ('r','p')
      GROUP BY c.relname ORDER BY c.relname`,
  );
  return Object.fromEntries(rows.map((r) => [r.name, r.columns]));
}

async function sequences(client) {
  const { rows } = await client.query(
    'SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY 1',
  );
  return rows.map((r) => r.name);
}

/** Ledger must be an exact prefix of the candidate files; only 047-049 may be pending. */
export async function migrationPlan(client, directory) {
  const dir = directory instanceof URL ? fileURLToPath(directory) : directory;
  const files = (await readdir(dir)).filter((n) => /^\d{3}_[a-z_]+\.sql$/.test(n)).sort();
  const sql = new Map();
  for (const name of files) sql.set(name, await readFile(join(dir, name), 'utf8'));
  const exists = (
    await client.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS present")
  ).rows[0].present;
  guard(exists, 'Migration ledger missing');
  const ledger = (
    await client.query('SELECT version, checksum, scope FROM schema_migrations ORDER BY version')
  ).rows;
  guard(
    ledger.length <= files.length &&
      ledger.every(
        (row, i) =>
          row.scope === 'cloud' &&
          row.version === files[i] &&
          row.checksum === sha256(sql.get(files[i])),
      ),
    'Installed migration ledger differs from the candidate',
  );
  const pending = files.slice(ledger.length);
  guard(
    pending.every((name) => UNIFIED_MENU_MIGRATIONS.includes(name)) &&
      UNIFIED_MENU_MIGRATIONS.every((name) => files.includes(name)) &&
      files.at(-1) === UNIFIED_MENU_MIGRATIONS.at(-1),
    'Pending migrations are not exactly the reviewed unified-menu set',
  );
  return { files, ledger: ledger.map((r) => r.version), pending, sql };
}

/** Grants for cloud047-049 with every unified-menu flag off (what provision.mjs would grant). */
export function deployGrants(role, { transport }) {
  guard(ROLE.test(role) && typeof transport === 'boolean', 'Invalid grant configuration');
  return [
    edgeMenuStateGrants(role),
    // Delivery/verdict columns belong to the fulfillment transport, only where it runs.
    transport
      ? `GRANT SELECT ON cloud_stop_commands TO ${role};
 GRANT UPDATE(state,result_version,delivered_at,resolved_at) ON cloud_stop_commands TO ${role};`
      : '',
    catalogAssetGrants(role, false),
    backofficeStopGrants(role, false),
  ].join('\n');
}

/** Grants that follow one flag. Turning access-roles off keeps the read grants back-office uses. */
export function flagGrants(role, flag, enabled) {
  guard(ROLE.test(role) && typeof enabled === 'boolean', 'Invalid grant configuration');
  guard(UNIFIED_MENU_FLAGS.includes(flag), 'Unknown unified-menu flag');
  if (flag === 'access-roles') return enabled ? catalogAccessGrants(role, true) : '';
  if (flag === 'edge-publication') return edgePublicationGrants(role, enabled);
  if (flag === 'remote-stops') return backofficeStopGrants(role, enabled);
  return catalogAssetGrants(role, enabled);
}

async function has(client, role, table, privilege) {
  return (
    await client.query('SELECT has_table_privilege($1,$2,$3) AS ok', [role, table, privilege])
  ).rows[0].ok;
}

/** The caller owns the transaction (BEGIN ISOLATION LEVEL REPEATABLE READ ... COMMIT). */
export async function deployUnifiedMenu(client, { directory, role }) {
  guard(ROLE.test(role), 'Invalid runtime role');
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
  const plan = await migrationPlan(client, directory);
  const before = await tableColumns(client);
  guard(
    plan.pending.length === 0 || UNIFIED_MENU_TABLES.every((t) => !(t in before)),
    'Unified-menu tables exist without their migrations',
  );
  const existing = Object.fromEntries(
    Object.entries(before).filter(([name]) => name !== 'schema_migrations'),
  );
  const start = await fingerprint(client, existing);
  const sequencesBefore = await sequences(client);
  const privilegesBefore = await runtimePrivileges(client, role);
  const transport = await has(client, role, 'cloud_branch_availability', 'UPDATE');
  for (const name of plan.pending) {
    await client.query(plan.sql.get(name));
    await client.query(
      'INSERT INTO schema_migrations (version, checksum, scope) VALUES ($1,$2,$3)',
      [name, sha256(plan.sql.get(name)), 'cloud'],
    );
  }
  await client.query(deployGrants(role, { transport }));
  const after = await tableColumns(client);
  // Pre-existing tables: same rows (on their original columns); only the reviewed column added.
  for (const [table, columns] of Object.entries(before)) {
    guard(table in after, 'A pre-existing table disappeared');
    guard(
      columns.every((c, i) => after[table][i] === c),
      'A pre-existing column changed: ' + table,
    );
    const added = after[table].slice(columns.length);
    const allowed = plan.pending.includes('048_cloud_stop_commands.sql')
      ? (UNIFIED_MENU_COLUMNS[table] ?? [])
      : [];
    guard(JSON.stringify(added) === JSON.stringify(allowed), 'Unexpected column added to ' + table);
  }
  const end = await fingerprint(client, existing);
  for (const table of Object.keys(existing))
    guard(
      end[table].rows === start[table].rows && end[table].hash === start[table].hash,
      'Pre-existing data changed: ' + table,
    );
  const created = Object.keys(after)
    .filter((t) => !(t in before))
    .sort();
  guard(
    plan.pending.length === 0
      ? created.length === 0
      : JSON.stringify(created) === JSON.stringify([...UNIFIED_MENU_TABLES].sort()),
    'Unexpected tables created',
  );
  for (const table of created)
    guard(
      (await client.query(`SELECT count(*)::int AS n FROM ${quoteIdent(table)}`)).rows[0].n === 0,
      'A new table was seeded: ' + table,
    );
  if (plan.pending.includes('048_cloud_stop_commands.sql'))
    guard(
      (
        await client.query(
          'SELECT count(*)::int AS n FROM cloud_branch_availability WHERE stop_states IS NOT NULL',
        )
      ).rows[0].n === 0,
      'stop_states was filled by the migration',
    );
  guard(
    JSON.stringify(await sequences(client)) === JSON.stringify(sequencesBefore),
    'Sequences changed',
  );
  const ledger = (await client.query('SELECT version FROM schema_migrations ORDER BY version'))
    .rows;
  guard(
    JSON.stringify(ledger.map((r) => r.version)) === JSON.stringify(plan.files),
    'Ledger does not match the candidate after migration',
  );
  const privilegesAfter = await runtimePrivileges(client, role);
  return {
    applied: plan.pending,
    migrationFiles: plan.files.length,
    lastMigration: plan.files.at(-1),
    preservedTables: Object.keys(existing).length,
    createdTables: created,
    transportGrants: transport,
    privilegesAdded: privilegesAfter.filter((p) => !privilegesBefore.includes(p)),
    privilegesRemoved: privilegesBefore.filter((p) => !privilegesAfter.includes(p)),
  };
}

/** Prerequisites a flag needs on the runtime role (other features already granted). */
const FLAG_REQUIRES = {
  'access-roles': ['catalog_managers', 'SELECT'],
  'edge-publication': ['catalog_publications', 'SELECT'],
  'remote-stops': ['cloud_stop_commands', 'SELECT'],
  'media-upload': ['catalog_assets', 'SELECT'],
};

export async function setUnifiedMenuFlag(client, { role, flag, enabled }) {
  guard(ROLE.test(role) && UNIFIED_MENU_FLAGS.includes(flag), 'Invalid flag request');
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
  const files = (await client.query('SELECT version FROM schema_migrations ORDER BY version')).rows;
  guard(
    files.at(-1)?.version === UNIFIED_MENU_MIGRATIONS.at(-1),
    'Unified-menu schema is not the installed head',
  );
  const [table, privilege] = FLAG_REQUIRES[flag];
  guard(await has(client, role, table, privilege), 'Feature prerequisite grant missing');
  if (enabled && flag === 'edge-publication') {
    for (const table of [
      'catalog_menu_deliveries',
      'menu_releases',
      'menu_streams',
      'outbox_events',
      'branches',
      'devices',
      'branch_menu_activations',
      'inbox_messages',
      'fulfillment_transport_bindings',
      'edge_menu_state',
      'catalog_menu_delivery_results',
    ])
      guard(
        await has(client, role, table, 'SELECT'),
        'Menu publication read grant missing: ' + table,
      );
    // FOR UPDATE/SHARE needs UPDATE on any column, not a new redundant lock-anchor grant.
    for (const table of ['branches', 'devices'])
      guard(
        (await client.query("SELECT has_any_column_privilege($1,$2,'UPDATE') AS ok", [role, table]))
          .rows[0].ok,
        'Menu publication row-lock grant missing: ' + table,
      );
  }
  if (enabled && flag === 'remote-stops')
    guard(
      (await has(client, role, 'bo_access_grants', 'SELECT')) &&
        (await has(client, role, 'cloud_branch_availability', 'UPDATE')),
      'Remote stops need the back-office and the fulfillment transport',
    );
  const before = await runtimePrivileges(client, role);
  const sql = flagGrants(role, flag, enabled);
  if (sql) await client.query(sql);
  const after = await runtimePrivileges(client, role);
  return {
    flag,
    enabled,
    privilegesAdded: after.filter((p) => !before.includes(p)),
    privilegesRemoved: before.filter((p) => !after.includes(p)),
  };
}

/** Read-only readiness for preflight; counts only. */
export async function inspectUnifiedMenu(client, { directory }) {
  const plan = await migrationPlan(client, directory);
  const coverage = (
    await client.query(
      `SELECT count(*)::int AS missing FROM catalog_manager_branches s
         JOIN catalog_managers m ON m.id=s.actor_id AND m.organization_id=s.organization_id
         LEFT JOIN bo_access_grants g ON g.actor_id=s.actor_id AND g.branch_id=s.branch_id
        WHERE m.revoked_at IS NULL AND g.actor_id IS NULL`,
    )
  ).rows[0].missing;
  return {
    pending: plan.pending,
    migrationFiles: plan.files.length,
    managersWithoutGrant: coverage,
  };
}

async function main(argv) {
  const { createPool } = await import('@pickchick/database');
  const url = new URL(process.env.CLOUD_DATABASE_URL ?? '');
  guard(
    url.username === 'pickchick_owner' && url.pathname === '/pickchick_cloud',
    'Owner database required',
  );
  const directory = new URL('../../db/cloud/migrations/', import.meta.url);
  const [command, flag, value] = argv;
  const pool = createPool(url.href);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    let result;
    if (command === 'inspect' && argv.length === 1) {
      result = await inspectUnifiedMenu(client, { directory });
      await client.query('ROLLBACK');
    } else if (command === 'deploy' && argv.length === 1) {
      result = await deployUnifiedMenu(client, { directory, role: 'pickchick_app' });
      await client.query('COMMIT');
    } else if (command === 'flag' && argv.length === 3 && ['true', 'false'].includes(value)) {
      result = await setUnifiedMenuFlag(client, {
        role: 'pickchick_app',
        flag,
        enabled: value === 'true',
      });
      await client.query('COMMIT');
    } else {
      throw new OwnerGuardError(
        'Usage: unified-menu-owner.mjs inspect|deploy|flag <name> <true|false>',
      );
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    // Curated guard messages only; database errors print their SQLSTATE, never row data.
    console.error(
      error instanceof OwnerGuardError
        ? error.message
        : `Owner step failed (${error?.code ?? 'error'})`,
    );
    process.exitCode = 1;
  });
}
