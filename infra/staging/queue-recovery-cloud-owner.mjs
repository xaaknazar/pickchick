/** Transactional cloud071 -> 072 database step only. The release operator must hold the
 * server maintenance lease, stop writers and verify a restored backup and exact-source CI.
 * Does not deploy an API, change flags, reset old grants or emit a server release receipt.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { fingerprint, runtimePrivileges } from './unified-menu-owner.mjs';

export const MIGRATION = '072_cloud_kitchen_restore_review.sql';
export const CHECKSUM = 'd222ea9bf0aeebcaaeea96bc119c9b8aa3e1d9f032a1af7914aefe5c8981c5e2';
const TABLES = ['pos_kitchen_restore_conflicts', 'pos_kitchen_restore_decisions'];
const ident = (value) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value ?? '')) throw Error('Invalid identifier');
  return '"' + value + '"';
};
const digest = (value) => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const guard = (ok, reason) => {
  if (!ok) throw Error(reason);
};

export function queueRecoveryPrivileges({ posSyncEnabled, backofficeEnabled }) {
  guard(
    typeof posSyncEnabled === 'boolean' && typeof backofficeEnabled === 'boolean',
    'Explicit existing flag state required',
  );
  return [
    ...(posSyncEnabled || backofficeEnabled ? ['pos_kitchen_restore_conflicts||SELECT'] : []),
    ...(posSyncEnabled ? ['pos_kitchen_restore_conflicts||INSERT'] : []),
    ...(backofficeEnabled
      ? ['pos_kitchen_restore_decisions||SELECT', 'pos_kitchen_restore_decisions||INSERT']
      : []),
  ].sort();
}

export async function upgradeQueueRecoveryCloud(
  client,
  {
    mode,
    appRoot,
    branchId,
    runtimeRole = 'pickchick_app',
    schema = 'public',
    posSyncEnabled,
    backofficeEnabled,
  },
) {
  guard(['inspect', 'apply'].includes(mode), 'Invalid mode');
  guard(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(branchId ?? ''), 'Invalid branch');
  const ns = ident(schema),
    role = ident(runtimeRole);
  const expectedGrants = queueRecoveryPrivileges({ posSyncEnabled, backofficeEnabled });
  const dir = join(appRoot, 'db/cloud/migrations');
  const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  guard(
    files.at(-1) === MIGRATION && files.every((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)),
    'Exact schema072 candidate required',
  );
  const sql = new Map();
  const expectedLedger = [];
  for (const version of files) {
    const bytes = await readFile(join(dir, version));
    sql.set(version, bytes.toString('utf8'));
    expectedLedger.push({ version, checksum: digest(bytes), scope: 'cloud' });
  }
  guard(
    expectedLedger.at(-1).checksum === CHECKSUM &&
      files.at(-2) === '071_cloud_daily_reconciliation.sql',
    'Reviewed migration072 required',
  );
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
    await client.query('SET LOCAL search_path TO ' + ns);
    await client.query('SELECT pg_advisory_xact_lock(724001)');
    const tables = (
      await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [
        schema,
      ])
    ).rows.map((r) => r.tablename);
    guard(
      tables.includes('schema_migrations') && TABLES.every((t) => !tables.includes(t)),
      'Exact schema071 without review tables required; no replay',
    );
    await client.query(
      'LOCK TABLE ' +
        tables.map((t) => ns + '.' + ident(t)).join(',') +
        ' IN ACCESS EXCLUSIVE MODE',
    );
    const ledger = async () =>
      (await client.query('SELECT version,checksum,scope FROM schema_migrations ORDER BY version'))
        .rows;
    guard(same(await ledger(), expectedLedger.slice(0, -1)), 'Installed migration history differs');
    guard(
      (await client.query('SELECT id FROM branches WHERE id=$1', [branchId])).rowCount === 1,
      'Branch not present',
    );
    const roles = (
      await client.query(
        `SELECT oid,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
      EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS member,
      EXISTS(SELECT 1 FROM pg_shdepend d WHERE d.refclassid='pg_authid'::regclass AND d.refobjid=r.oid AND d.deptype='o') AS owns
      FROM pg_roles r WHERE rolname=$1`,
        [runtimeRole],
      )
    ).rows;
    guard(
      roles.length === 1 &&
        Object.entries(roles[0]).every(([key, value]) => key === 'oid' || !value),
      'Existing unprivileged non-owner runtime role required',
    );
    const acl = await runtimePrivileges(client, runtimeRole);
    guard(
      acl.includes('pos_order_sync_inbox||INSERT') === posSyncEnabled &&
        acl.includes('bo_commands||INSERT') === backofficeEnabled,
      'Existing grants disagree with declared flags',
    );
    const columns = Object.fromEntries(
      (
        await client.query(
          `SELECT table_name,array_agg(column_name::text ORDER BY ordinal_position) AS columns
      FROM information_schema.columns WHERE table_schema=$1 AND table_name=ANY($2) GROUP BY table_name ORDER BY table_name`,
          [schema, tables.filter((t) => t !== 'schema_migrations')],
        )
      ).rows.map((r) => [r.table_name, r.columns]),
    );
    const snapshot = async () => ({
      data: await fingerprint(client, columns),
      sequences: (
        await client.query(
          'SELECT sequencename,last_value FROM pg_sequences WHERE schemaname=$1 ORDER BY sequencename',
          [schema],
        )
      ).rows,
      acl: (
        await client.query(
          `SELECT c.relname,c.relacl,a.attname,a.attacl FROM pg_class c
        LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        WHERE c.relnamespace=$1::regnamespace AND c.relname=ANY($2) ORDER BY c.relname,a.attnum`,
          [schema, tables],
        )
      ).rows,
    });
    const before = await snapshot();
    if (mode === 'apply') {
      await client.query(sql.get(MIGRATION));
      await client.query('INSERT INTO schema_migrations(version,checksum,scope) VALUES($1,$2,$3)', [
        MIGRATION,
        CHECKSUM,
        'cloud',
      ]);
      for (const entry of expectedGrants) {
        const [table, , verb] = entry.split('|');
        await client.query(`GRANT ${verb} ON ${ns}.${ident(table)} TO ${role}`);
      }
      await client.query(
        `REVOKE ALL ON FUNCTION ${ns}.guard_pos_kitchen_restore_history() FROM PUBLIC`,
      );
      const granted = (
        await client.query(
          `SELECT c.relname AS name,x.grantee,x.privilege_type AS privilege,x.is_grantable FROM pg_class c
        CROSS JOIN LATERAL aclexplode(c.relacl) x WHERE c.relnamespace=$1::regnamespace AND c.relname=ANY($2) AND x.grantee<>c.relowner
        ORDER BY c.relname,x.privilege_type,x.grantee`,
          [schema, TABLES],
        )
      ).rows;
      guard(
        granted.every((r) => r.grantee === roles[0].oid && !r.is_grantable) &&
          same(granted.map((r) => `${r.name}||${r.privilege}`).sort(), expectedGrants),
        'Unexpected review table privileges',
      );
      guard(
        (
          await client.query(
            `SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
        WHERE p.pronamespace=$1::regnamespace AND p.proname='guard_pos_kitchen_restore_history' AND x.grantee<>p.proowner`,
            [schema],
          )
        ).rowCount === 0,
        'Unexpected review function privileges',
      );
      guard(
        same(await runtimePrivileges(client, runtimeRole), [...acl, ...expectedGrants].sort()),
        'Unexpected runtime privilege delta',
      );
      guard(same(await snapshot(), before), 'Existing data, sequences or privileges changed');
      guard(same(await ledger(), expectedLedger), 'Unexpected ledger after migration');
      for (const table of TABLES)
        guard(
          (await client.query(`SELECT count(*)::int n FROM ${ns}.${ident(table)}`)).rows[0].n === 0,
          'Migration must not reconcile existing orders',
        );
    }
    await client.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
    return {
      mode,
      migration: mode === 'apply' ? MIGRATION : null,
      schema: mode === 'apply' ? 72 : 71,
      existingDataPreserved: true,
      fingerprint: digest(JSON.stringify(before)),
      privilegesAdded: mode === 'apply' ? expectedGrants : [],
      privilegesRemoved: [],
      flagsChanged: false,
      apiDeployed: false,
      releaseReady: false,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function main() {
  const [mode, branchId, posSync, backoffice, ...extra] = process.argv.slice(2);
  guard(
    !extra.length &&
      ['inspect', 'apply'].includes(mode) &&
      ['true', 'false'].includes(posSync) &&
      ['true', 'false'].includes(backoffice),
    'Use inspect|apply branch-uuid existing-pos-sync-boolean existing-backoffice-boolean',
  );
  const url = new URL(process.env.CLOUD_DATABASE_URL ?? '');
  guard(
    ['postgres:', 'postgresql:'].includes(url.protocol) &&
      url.username === 'pickchick_owner' &&
      url.pathname === '/pickchick_cloud' &&
      !url.search &&
      !url.hash,
    'Owner database required',
  );
  const appRoot = fileURLToPath(new URL('../../', import.meta.url));
  const { Client } = createRequire(join(appRoot, 'packages/database/package.json'))('pg');
  const client = new Client({
    connectionString: url.href,
    connectionTimeoutMillis: 3000,
    statement_timeout: 60000,
  });
  client.on('error', () => {});
  await client.connect();
  try {
    console.log(
      JSON.stringify(
        await upgradeQueueRecoveryCloud(client, {
          mode,
          appRoot,
          branchId,
          posSyncEnabled: posSync === 'true',
          backofficeEnabled: backoffice === 'true',
        }),
      ),
    );
  } finally {
    await client.end();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error('Cloud queue upgrade stopped; inspect protected state.');
    process.exitCode = 1;
  });
