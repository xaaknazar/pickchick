/** Exact schema057 -> 058. Only inventory and device telemetry privileges are added. */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, runtimePrivileges, OwnerGuardError } from './unified-menu-owner.mjs';
import { deviceCenterGrants } from './device-center-grants.mjs';
export const MIGRATION = '058_cloud_device_center.sql';
export const TABLES = ['device_inventory', 'device_inventory_commands', 'device_presence'];
const hash = (s) => createHash('sha256').update(s).digest('hex');
const guard = (ok, message) => {
  if (!ok) throw new OwnerGuardError(message);
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const PRIVILEGES = [
  ...['device_inventory', 'device_presence'].flatMap((t) =>
    ['SELECT', 'INSERT', 'UPDATE'].map((p) => `${t}||${p}`),
  ),
  ...['SELECT', 'INSERT'].map((p) => `device_inventory_commands||${p}`),
  ...[
    'device_terminal_registry',
    'cloud_device_commands',
    'device_events',
    'cloud_kitchen_password_resets',
    'kitchen_password_reset_events',
  ].map((t) => `${t}||SELECT`),
  ...['device_id', 'expires_at'].map((c) => `device_credentials|${c}|SELECT`),
  ...['id', 'branch_id', 'organization_id', 'active', 'token_hash'].map(
    (c) => `kiosk_devices|${c}|SELECT`,
  ),
].sort();
export async function deployDeviceCenter(c, { directory, role, inspect = false }) {
  guard(/^[a-z][a-z0-9_]{0,62}$/.test(role), 'Invalid runtime role');
  await c.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='120s'");
  if (!inspect) await c.query('SELECT pg_advisory_xact_lock($1)', [724001]);
  const files = (await readdir(directory)).filter((n) => /^\d{3}_[a-z0-9_]+\.sql$/.test(n)).sort();
  guard(
    files.at(-1) === MIGRATION &&
      equal(
        files.slice(0, -1).map((n) => +n.slice(0, 3)),
        [
          ...Array.from({ length: 40 }, (_, i) => i + 1),
          ...Array.from({ length: 16 }, (_, i) => i + 42),
        ],
      ),
    'Exact schema057 baseline and058 candidate required',
  );
  const sql = new Map(
    await Promise.all(files.map(async (n) => [n, await readFile(join(directory, n), 'utf8')])),
  );
  const ledger = (
    await c.query('SELECT version,checksum,scope FROM schema_migrations ORDER BY version')
  ).rows;
  guard(
    ledger.length === files.length - 1 &&
      ledger.every(
        (r, i) =>
          r.version === files[i] && r.scope === 'cloud' && r.checksum === hash(sql.get(r.version)),
      ),
    'Exact schema057 ledger required; do not replay partial apply',
  );
  const columns = async () =>
    Object.fromEntries(
      (
        await c.query(
          "SELECT c.relname AS name,array_agg(a.attname::text ORDER BY a.attnum) AS columns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE n.nspname=current_schema() AND c.relkind IN ('r','p') GROUP BY c.relname ORDER BY c.relname",
        )
      ).rows.map((r) => [r.name, r.columns]),
    );
  const before = await columns(),
    existing = Object.fromEntries(
      Object.entries(before).filter(([n]) => n !== 'schema_migrations'),
    );
  guard(
    TABLES.every((t) => !(t in before)),
    'Device center table already exists',
  );
  const acl = await runtimePrivileges(c, role),
    added = PRIVILEGES.filter((p) => !acl.includes(p));
  if (inspect) return { pending: [MIGRATION], privilegesAdded: added };
  const data = await fingerprint(c, existing);
  const roles = async () =>
    (
      await c.query(
        'SELECT rolname,rolsuper,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconfig FROM pg_roles ORDER BY rolname',
      )
    ).rows;
  const rolesBefore = await roles();
  await c.query(sql.get(MIGRATION));
  const appended = { version: MIGRATION, checksum: hash(sql.get(MIGRATION)), scope: 'cloud' };
  await c.query('INSERT INTO schema_migrations(version,checksum,scope) VALUES($1,$2,$3)', [
    appended.version,
    appended.checksum,
    appended.scope,
  ]);
  await c.query(deviceCenterGrants(role));
  const after = await columns();
  guard(
    equal(Object.keys(after).sort(), [...Object.keys(before), ...TABLES].sort()),
    'Unexpected tables',
  );
  for (const [t, cols] of Object.entries(before))
    guard(equal(after[t], cols), 'Existing columns changed');
  guard(equal(await fingerprint(c, existing), data), 'Existing rows changed');
  guard(equal(await roles(), rolesBefore), 'Role attributes changed');
  guard(
    equal(await runtimePrivileges(c, role), [...new Set([...acl, ...PRIVILEGES])].sort()),
    'Unexpected privilege delta',
  );
  guard(
    equal(
      (await c.query('SELECT version,checksum,scope FROM schema_migrations ORDER BY version')).rows,
      [...ledger, appended],
    ),
    'Ledger changed',
  );
  return {
    applied: [MIGRATION],
    existingDataPreserved: true,
    privilegesAdded: added,
    privilegesRemoved: [],
    pairingEnabled: false,
  };
}
async function main(argv) {
  guard(argv.length === 1 && ['inspect', 'deploy'].includes(argv[0]), 'Use inspect|deploy');
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
    const result = await deployDeviceCenter(c, {
      directory: fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url)),
      role: 'pickchick_app',
      inspect: argv[0] === 'inspect',
    });
    await c.query(argv[0] === 'inspect' ? 'ROLLBACK' : 'COMMIT');
    console.log(JSON.stringify(result));
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main(process.argv.slice(2)).catch(() => {
    console.error('Device center owner transaction failed; inspect state before retry.');
    process.exitCode = 1;
  });
