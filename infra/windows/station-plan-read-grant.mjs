import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Kitchen timer norms (owner 27.11): the kitchen station list of the edge runtime reads the
 * back-office norm of each station from the applied station plan (edge schema024). That needs
 * SELECT on station_plan_active and station_plan_snapshots for the edge runtime role. This tool
 * adds (or removes) exactly those two table grants on the live cashier and nothing else:
 *
 *   node --env-file=<edge owner env> station-plan-read-grant.mjs inspect|apply|revoke <toolsRoot> <branchId>
 *
 * Without the grant the edge simply sends no norms and the kitchen keeps 5 and 10 minutes, so
 * the grant is optional and reversible. Like cloud-link-grant.mjs it never resets the role:
 * one transaction under an advisory lock, one branch, a restricted runtime role, both tables
 * present, and the full privilege map of every role (tables, columns, sequences, functions,
 * schema) must differ by exactly the two grants. Replays change nothing. Output: codes and
 * booleans only.
 */
export const STATION_PLAN_READ_TABLES = Object.freeze([
  'station_plan_active',
  'station_plan_snapshots',
]);
const ROLE = /^[a-z][a-z0-9_]{0,62}$/;
const identifier = (name) => {
  if (!ROLE.test(name ?? '')) throw Error('Invalid identifier');
  return '"' + name + '"';
};

/** Every privilege of every role on the schema's objects, as sorted text rows. */
async function privilegeMap(client, schema) {
  const { rows } = await client.query(
    `SELECT format('%s|%s||%s',x.grantee::regrole,c.relname,x.privilege_type) AS p
       FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
      WHERE c.relnamespace=$1::regnamespace
     UNION ALL
     SELECT format('%s|%s|%s|%s',x.grantee::regrole,c.relname,a.attname,x.privilege_type)
       FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid CROSS JOIN LATERAL aclexplode(a.attacl) x
      WHERE c.relnamespace=$1::regnamespace AND a.attnum>0 AND NOT a.attisdropped
     UNION ALL
     SELECT format('%s|%s()||%s',x.grantee::regrole,p.proname,x.privilege_type)
       FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
      WHERE p.pronamespace=$1::regnamespace
     UNION ALL
     SELECT format('%s|schema||%s',x.grantee::regrole,x.privilege_type)
       FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) x
      WHERE n.oid=$1::regnamespace`,
    [schema],
  );
  return rows.map((r) => r.p).sort();
}

export async function stationPlanReadGrant(
  client,
  { mode, branchId, schema = 'public', runtimeRole = 'pickchick_edge_runtime' },
) {
  if (!['inspect', 'apply', 'revoke'].includes(mode)) throw Error('Invalid mode');
  if (!/^[a-f0-9-]{36}$/.test(branchId ?? '')) throw Error('Invalid branch');
  const ns = identifier(schema),
    role = identifier(runtimeRole);
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('SET LOCAL search_path TO ' + ns);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('pickchick-station-plan-read-grant',0))",
    );
    const present = (
      await client.query(
        `SELECT count(*)::int n FROM pg_class c
          WHERE c.relnamespace=$1::regnamespace AND c.relkind='r' AND c.relname=ANY($2::text[])`,
        [schema, STATION_PLAN_READ_TABLES],
      )
    ).rows[0].n;
    if (present !== STATION_PLAN_READ_TABLES.length) throw Error('Station plan schema024 required');
    const branches = (await client.query('SELECT id FROM branch_config')).rows;
    if (branches.length !== 1 || branches[0].id !== branchId) throw Error('Branch differs');
    const actual = (
      await client.query(
        `SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
           EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) member
           FROM pg_roles r WHERE rolname=$1`,
        [runtimeRole],
      )
    ).rows[0];
    if (!actual || Object.values(actual).some(Boolean))
      throw Error('Existing restricted runtime role required');
    const before = await privilegeMap(client, schema);
    const entries = STATION_PLAN_READ_TABLES.map((t) => `${runtimeRole}|${t}||SELECT`);
    for (const table of STATION_PLAN_READ_TABLES)
      if (
        before.some(
          (p) =>
            p.startsWith(`${runtimeRole}|${table}|`) && p !== `${runtimeRole}|${table}||SELECT`,
        )
      )
        throw Error('Unexpected privilege on the station plan');
    const held = entries.filter((e) => before.includes(e));
    if (held.length === 1) throw Error('Partial station plan grant; inspect');
    const granted = held.length === entries.length;
    const change = (mode === 'apply' && !granted) || (mode === 'revoke' && granted);
    if (change) {
      const list = STATION_PLAN_READ_TABLES.map((t) => `${ns}.${identifier(t)}`).join(',');
      await client.query(
        mode === 'apply'
          ? `GRANT SELECT ON ${list} TO ${role}`
          : `REVOKE SELECT ON ${list} FROM ${role}`,
      );
      const want =
        mode === 'apply'
          ? [...before, ...entries].sort()
          : before.filter((p) => !entries.includes(p));
      if (JSON.stringify(await privilegeMap(client, schema)) !== JSON.stringify(want))
        throw Error('Unexpected privilege change');
    }
    await client.query(change ? 'COMMIT' : 'ROLLBACK');
    return {
      mode,
      runtimeRole,
      stationPlanRead: change ? mode === 'apply' : granted,
      changed: change,
      privilegesAdded: change && mode === 'apply' ? entries : [],
      privilegesRemoved: change && mode === 'revoke' ? entries : [],
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function main() {
  const [mode, toolsRoot, branchId, ...extra] = process.argv.slice(2);
  if (extra.length || !toolsRoot || !/^[a-f0-9-]{36}$/.test(branchId ?? ''))
    throw Error('Invalid invocation');
  const url = new URL(process.env.EDGE_DATABASE_URL ?? '');
  if (
    url.hostname !== '127.0.0.1' ||
    url.port !== '55433' ||
    url.pathname !== '/pickchick_edge' ||
    url.username !== 'pickchick_edge_owner'
  )
    throw Error('Local edge owner required');
  const { Client } = createRequire(join(resolve(toolsRoot), 'package.json'))('pg');
  const c = new Client({
    connectionString: url.href,
    connectionTimeoutMillis: 3000,
    statement_timeout: 60000,
  });
  c.on('error', () => {});
  await c.connect();
  try {
    console.log(JSON.stringify(await stationPlanReadGrant(c, { mode, branchId })));
  } finally {
    await c.end();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error(JSON.stringify({ event: 'station_plan_read_grant_failed' }));
    process.exitCode = 1;
  });
