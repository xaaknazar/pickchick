#!/usr/bin/env node
/** Exact cloud050 -> 052 additive transaction; device tables remain dormant without new runtime grants. */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, runtimePrivileges, OwnerGuardError } from './unified-menu-owner.mjs';
import { workforceGrants } from './workforce-grants.mjs';
export const MIGRATIONS = ['051_cloud_device_registry.sql', '052_cloud_workforce.sql'];
export const DEVICE_MIGRATION = MIGRATIONS[1];
export const WORKFORCE_TABLES = [
  'bo_workforce_records',
  'bo_workforce_events',
  'bo_workforce_periods',
  'bo_workforce_commands',
];
export const DEVICE_TABLES = [
  ...WORKFORCE_TABLES,
  'device_terminal_registry',
  'cloud_device_commands',
  'device_events',
  'cloud_kitchen_password_resets',
  'kitchen_password_reset_events',
].sort();
export const DEVICE_PRIVILEGES = [
  ...WORKFORCE_TABLES.flatMap((t) => [`${t}||SELECT`, `${t}||INSERT`]),
  ...['revision', 'payload', 'updated_at'].map((c) => `bo_workforce_records|${c}|UPDATE`),
  ...['closed', 'revision', 'snapshot'].map((c) => `bo_workforce_periods|${c}|UPDATE`),
].sort();
const guard = (condition, message) => {
  if (!condition) throw new OwnerGuardError(message);
};
const hash = (text) => createHash('sha256').update(text).digest('hex');
async function columns(c) {
  return Object.fromEntries(
    (
      await c.query(
        `SELECT c.relname AS name,array_agg(a.attname::text ORDER BY a.attnum) AS columns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE n.nspname=current_schema() AND c.relkind IN ('r','p') GROUP BY c.relname ORDER BY c.relname`,
      )
    ).rows.map((r) => [r.name, r.columns]),
  );
}
async function roles(c) {
  return (
    await c.query(
      `SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig FROM pg_roles ORDER BY rolname`,
    )
  ).rows;
}
async function otherAcl(c, role) {
  return (
    await c.query(
      `SELECT c.relname,a.attname,x.grantor,x.grantee,x.privilege_type,x.is_grantable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE n.nspname=current_schema() AND c.relkind IN ('r','p','v','m','f','S') AND x.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$1) UNION ALL SELECT c.relname,NULL,x.grantor,x.grantee,x.privilege_type,x.is_grantable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) x WHERE n.nspname=current_schema() AND c.relkind IN ('r','p','v','m','f','S') AND x.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$1) AND c.relname<>ALL($2::text[]) ORDER BY 1,2,3,4,5`,
      [role, DEVICE_TABLES],
    )
  ).rows;
}
export async function workforcePlan(c, directory) {
  const files = (await readdir(directory)).filter((n) => /^\d{3}_[a-z0-9_]+\.sql$/.test(n)).sort();
  guard(
    JSON.stringify(files.slice(-2)) === JSON.stringify(MIGRATIONS),
    'Candidate must end at cloud051/052',
  );
  guard(
    JSON.stringify(files.slice(0, -2).map((n) => +n.slice(0, 3))) ===
      JSON.stringify([
        ...Array.from({ length: 40 }, (_, i) => i + 1),
        ...Array.from({ length: 9 }, (_, i) => i + 42),
      ]),
    'Exact cloud050 baseline required',
  );
  const sql = new Map(
    await Promise.all(files.map(async (n) => [n, await readFile(join(directory, n), 'utf8')])),
  );
  const ledger = (
    await c.query('SELECT version,checksum,scope FROM schema_migrations ORDER BY version')
  ).rows;
  guard(
    ledger.length === files.length - 2 &&
      ledger.every(
        (r, i) =>
          r.version === files[i] && r.scope === 'cloud' && r.checksum === hash(sql.get(r.version)),
      ),
    'Exact cloud050 ledger required; applied/partial051/052 is not replayed',
  );
  return { sql, ledger };
}
export async function deployWorkforce(c, { directory, role, inspect = false }) {
  guard(/^[a-z][a-z0-9_]{0,62}$/.test(role), 'Invalid runtime role');
  await c.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='120s'");
  if (!inspect) await c.query('SELECT pg_advisory_xact_lock($1)', [724001]);
  const plan = await workforcePlan(c, directory),
    before = await columns(c),
    aclBefore = await runtimePrivileges(c, role);
  guard(
    DEVICE_TABLES.every((t) => !(t in before)),
    'Device table exists before051',
  );
  const required = DEVICE_PRIVILEGES.filter((p) => !aclBefore.includes(p));
  if (inspect) return { pending: MIGRATIONS, privilegesAdded: required };
  const existing = Object.fromEntries(
    Object.entries(before).filter(([name]) => name !== 'schema_migrations'),
  );
  const data = await fingerprint(c, existing),
    rolesBefore = await roles(c),
    otherBefore = await otherAcl(c, role);
  const appended = [];
  for (const name of MIGRATIONS) {
    await c.query(plan.sql.get(name));
    const row = { version: name, checksum: hash(plan.sql.get(name)), scope: 'cloud' };
    await c.query('INSERT INTO schema_migrations(version,checksum,scope) VALUES($1,$2,$3)', [
      row.version,
      row.checksum,
      row.scope,
    ]);
    appended.push(row);
  }
  const ledgerAfter = (
    await c.query('SELECT version,checksum,scope FROM schema_migrations ORDER BY version')
  ).rows;
  guard(
    JSON.stringify(ledgerAfter) === JSON.stringify([...plan.ledger, ...appended]),
    'Existing migration ledger changed',
  );
  await c.query(workforceGrants(role, true));
  const after = await columns(c);
  guard(
    JSON.stringify(Object.keys(after).sort()) ===
      JSON.stringify([...Object.keys(before), ...DEVICE_TABLES].sort()),
    'Unexpected table delta',
  );
  for (const [table, cols] of Object.entries(before))
    guard(JSON.stringify(after[table]) === JSON.stringify(cols), 'Existing columns changed');
  const end = await fingerprint(c, existing);
  guard(
    JSON.stringify(end) === JSON.stringify(data),
    'Existing data changed within migration transaction',
  );
  for (const t of DEVICE_TABLES)
    guard(
      (await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n === 0,
      'New device tables must be empty',
    );
  const aclAfter = await runtimePrivileges(c, role);
  guard(
    JSON.stringify(aclAfter) ===
      JSON.stringify([...new Set([...aclBefore, ...DEVICE_PRIVILEGES])].sort()),
    'Unexpected runtime ACL delta',
  );
  guard(JSON.stringify(await roles(c)) === JSON.stringify(rolesBefore), 'Role attributes changed');
  guard(
    JSON.stringify(await otherAcl(c, role)) === JSON.stringify(otherBefore),
    'Other role ACL changed',
  );
  return {
    applied: MIGRATIONS,
    existingDataPreserved: true,
    privilegesAdded: required,
    privilegesRemoved: [],
    emptyTables: DEVICE_TABLES,
  };
}
async function main(argv) {
  guard(
    argv.length === 1 && ['inspect', 'deploy'].includes(argv[0]),
    'Usage: workforce-owner.mjs inspect|deploy',
  );
  const url = new URL(process.env.CLOUD_DATABASE_URL ?? '');
  guard(
    url.username === 'pickchick_owner' && url.pathname === '/pickchick_cloud',
    'Owner database required',
  );
  const { createPool } = await import('@pickchick/database');
  const pool = createPool(url.href),
    c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const result = await deployWorkforce(c, {
      directory: fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url)),
      role: 'pickchick_app',
      inspect: argv[0] === 'inspect',
    });
    await c.query(argv[0] === 'inspect' ? 'ROLLBACK' : 'COMMIT');
    console.log(JSON.stringify(result));
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    c.release();
    await pool.end();
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      error instanceof OwnerGuardError
        ? error.message
        : `Device owner failed (${error?.code ?? 'error'})`,
    );
    process.exitCode = 1;
  });
