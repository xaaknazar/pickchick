/** Flags-only owner for installed cloud051. Never migrates, seeds or resets other ACL. */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fingerprint,
  runtimePrivileges,
  flagGrants,
  OwnerGuardError,
} from './unified-menu-owner.mjs';
const guard = (ok, message) => {
  if (!ok) throw new OwnerGuardError(message);
};
const hash = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
const MEDIA = [
  'catalog_assets||INSERT',
  'catalog_asset_variants||INSERT',
  'catalog_asset_audit||SELECT',
  'catalog_asset_audit||INSERT',
];
const STOP = ['cloud_stop_commands||INSERT'];
const STOP_SHARED = [
  'cloud_stop_commands||SELECT',
  'catalog_publications||SELECT',
  'cloud_stop_commands|state|UPDATE',
  'cloud_stop_commands|resolved_at|UPDATE',
];
export function expectedPrivileges(before, phase, enabled) {
  guard(
    ['remote-stops', 'media-upload'].includes(phase) && typeof enabled === 'boolean',
    'Invalid continuation phase',
  );
  const owned = phase === 'remote-stops' ? STOP : MEDIA;
  guard(
    owned.every((p) => before.includes(p) === !enabled),
    'Feature ACL is partial, already changed or disagrees with the flag',
  );
  if (phase === 'media-upload') {
    const allowed = new Set([...MEDIA, 'catalog_assets||SELECT', 'catalog_asset_variants||SELECT']);
    guard(
      before
        .filter((p) => /^catalog_asset(s|_variants|_audit)\|/.test(p))
        .every((p) => allowed.has(p)),
      'Unexpected asset ACL; canonical helper would revoke unrelated rights',
    );
    guard(
      ['catalog_assets||SELECT', 'catalog_asset_variants||SELECT'].every((p) => before.includes(p)),
      'Asset reads missing',
    );
  }
  return enabled
    ? [...new Set([...before, ...owned, ...(phase === 'remote-stops' ? STOP_SHARED : [])])].sort()
    : before.filter((p) => !owned.includes(p)).sort();
}
export async function exactLedger(c, directory) {
  const files = (await readdir(directory)).filter((n) => /^\d{3}_[a-z0-9_]+\.sql$/.test(n)).sort();
  guard(
    files.at(-1) === '051_cloud_device_registry.sql' &&
      JSON.stringify(files.map((n) => +n.slice(0, 3))) ===
        JSON.stringify([
          ...Array.from({ length: 40 }, (_, i) => i + 1),
          ...Array.from({ length: 10 }, (_, i) => i + 42),
        ]),
    'Exact cloud051 candidate required',
  );
  const expected = await Promise.all(
    files.map(async (version) => ({
      version,
      checksum: hash(await readFile(join(directory, version), 'utf8')),
      scope: 'cloud',
    })),
  );
  const actual = (
    await c.query('SELECT version,checksum,scope FROM schema_migrations ORDER BY version')
  ).rows;
  guard(
    JSON.stringify(actual) === JSON.stringify(expected),
    'Exact cloud051 ledger/checksums required',
  );
  return actual;
}
async function metadata(c) {
  // All role attributes, memberships, database/schema ACL and every table/column ACL are covered.
  const roles = (
    await c.query(
      'SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig FROM pg_roles ORDER BY rolname',
    )
  ).rows;
  const memberships = (
    await c.query('SELECT * FROM pg_auth_members ORDER BY roleid,member,grantor')
  ).rows;
  const boundaries = (
    await c.query(
      'SELECT datname::text AS name,datacl::text AS acl FROM pg_database WHERE datname=current_database() UNION ALL SELECT nspname,nspacl::text FROM pg_namespace WHERE nspname=current_schema() ORDER BY name',
    )
  ).rows;
  const acl = (
    await c.query(
      `SELECT c.relname AS name,NULL::text AS col,x.grantor,x.grantee,x.privilege_type AS privilege,x.is_grantable AS grantable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) x WHERE n.nspname=current_schema() AND c.relkind IN ('r','p','v','m','f','S') UNION ALL SELECT c.relname,a.attname,x.grantor,x.grantee,x.privilege_type,x.is_grantable FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE n.nspname=current_schema() AND a.attnum>0 AND NOT a.attisdropped ORDER BY 1,2,3,4,5`,
    )
  ).rows;
  const columns = Object.fromEntries(
    (
      await c.query(
        `SELECT c.relname AS name,array_agg(a.attname::text ORDER BY a.attnum) AS columns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE n.nspname=current_schema() AND c.relkind IN ('r','p') GROUP BY c.relname ORDER BY c.relname`,
      )
    ).rows.map((r) => [r.name, r.columns]),
  );
  return { roles, memberships, boundaries, acl, columns };
}
export async function continueUnifiedMenu(
  c,
  { directory, role, phase, enabled, inspect = false, expectedState },
) {
  guard(/^[a-z][a-z0-9_]{0,62}$/.test(role), 'Invalid runtime role');
  await c.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='120s'");
  if (!inspect) await c.query('SELECT pg_advisory_xact_lock($1)', [724001]);
  const ledger = await exactLedger(c, directory),
    before = await metadata(c);
  const runtime = before.roles.find((r) => r.rolname === role);
  guard(
    runtime &&
      !runtime.rolsuper &&
      !runtime.rolcreaterole &&
      !runtime.rolcreatedb &&
      !runtime.rolreplication &&
      !runtime.rolbypassrls,
    'Runtime role is privileged',
  );
  const oid = (await c.query('SELECT oid FROM pg_roles WHERE rolname=$1', [role])).rows[0].oid;
  guard(!before.memberships.some((r) => r.member === oid), 'Runtime role has memberships');
  guard(!before.acl.some((r) => r.grantee === oid && r.grantable), 'Grant options are forbidden');
  const aclBefore = await runtimePrivileges(c, role),
    expected = expectedPrivileges(aclBefore, phase, enabled);
  if (enabled && phase === 'remote-stops')
    guard(
      [
        'bo_access_grants||SELECT',
        'cloud_stop_commands||SELECT',
        'cloud_branch_availability||UPDATE',
      ].every((p) => aclBefore.includes(p)),
      'Remote stops require access roles and fulfillment transport',
    );
  const state = hash({ ledger, ...before }),
    added = expected.filter((p) => !aclBefore.includes(p)),
    removed = aclBefore.filter((p) => !expected.includes(p));
  if (inspect)
    return {
      phase,
      enabled,
      schema: 51,
      state_digest: state,
      privilegesAdded: added,
      privilegesRemoved: removed,
    };
  guard(expectedState === state, 'Owner metadata changed after review');
  const rows = await fingerprint(c, before.columns);
  await c.query(flagGrants(role, phase, enabled));
  const after = await metadata(c),
    aclAfter = await runtimePrivileges(c, role);
  guard(JSON.stringify(aclAfter) === JSON.stringify(expected), 'Unexpected runtime ACL delta');
  const unaffected = (m) => ({ ...m, acl: m.acl.filter((r) => r.grantee !== oid) });
  guard(
    JSON.stringify(unaffected(before)) === JSON.stringify(unaffected(after)),
    'Other ACL, schema or roles changed',
  );
  guard(!after.acl.some((r) => r.grantee === oid && r.grantable), 'Grant options changed');
  const retained = (r) =>
    r.grantee === oid &&
    !added.includes(`${r.name}|${r.col ?? ''}|${r.privilege}`) &&
    !removed.includes(`${r.name}|${r.col ?? ''}|${r.privilege}`);
  guard(
    JSON.stringify(before.acl.filter(retained)) === JSON.stringify(after.acl.filter(retained)),
    'Existing grantor/ACL changed',
  );
  guard(
    JSON.stringify(await fingerprint(c, before.columns)) === JSON.stringify(rows),
    'Data changed within owner transaction',
  );
  return {
    phase,
    enabled,
    schema: 51,
    existingDataPreserved: true,
    privilegesAdded: added,
    privilegesRemoved: removed,
    state_before: state,
    state_after: hash({ ledger, ...after }),
  };
}
async function main(argv) {
  const [action, phase, value, expectedState] = argv;
  guard(
    ['inspect', 'apply'].includes(action) &&
      ['true', 'false'].includes(value) &&
      argv.length === (action === 'inspect' ? 3 : 4),
    'Usage: continuation-owner inspect|apply remote-stops|media-upload true|false [state digest]',
  );
  const url = new URL(process.env.CLOUD_DATABASE_URL ?? '');
  guard(
    url.username === 'pickchick_owner' && url.pathname === '/pickchick_cloud',
    'Owner database required',
  );
  const { createPool } = await import('@pickchick/database'),
    pool = createPool(url.href),
    c = await pool.connect();
  try {
    await c.query(
      'BEGIN ISOLATION LEVEL REPEATABLE READ' + (action === 'inspect' ? ' READ ONLY' : ''),
    );
    const result = await continueUnifiedMenu(c, {
      directory: fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url)),
      role: 'pickchick_app',
      phase,
      enabled: value === 'true',
      inspect: action === 'inspect',
      expectedState,
    });
    await c.query(action === 'inspect' ? 'ROLLBACK' : 'COMMIT');
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
  main(process.argv.slice(2)).catch((e) => {
    console.error(
      e instanceof OwnerGuardError
        ? e.message
        : `Continuation owner failed (${e?.code ?? 'error'})`,
    );
    process.exitCode = 1;
  });
