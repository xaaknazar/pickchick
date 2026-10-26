import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Stage 2 integration (lane off, finding 1): the POS line «Нет интернета · касса работает» needs
 * SELECT(branch_id, last_success_at) ON fulfillment_transport_state for the edge runtime role.
 * This tool adds (or removes) exactly that grant on the live cashier and nothing else:
 *
 *   node --env-file=<edge owner env> cloud-link-grant.mjs inspect|apply|revoke <toolsRoot> <branchId>
 *
 * Why not `scripts/edge-runtime-grants.mjs <role> --cloud-link`: that command RESETS every table,
 * column and sequence privilege of the role and re-grants only edgeRuntimeGrantSql. On a cashier
 * at schema020+ it also revokes what other guarded tools granted the same role (terminal access
 * 020, terminal presence of the runtime 1021 release), so it must not be run on the live cashier.
 * The historical installers that call it (install-native-services.ps1, update-native-preview.ps1,
 * update-native-service.ps1) accept only the edge-0186902/schema010/schema014 archives, whose
 * grant script refuses --cloud-link; the runtime 1021 release never resets runtime grants.
 *
 * One transaction under an advisory lock: the ledger must equal a reviewed prefix (schema023 or
 * schema024) of native-edge-backup-ledger.json, one branch, a restricted runtime role without
 * table-level access to the transport state, and the full privilege map of every role (tables,
 * columns, sequences, functions, schema) must differ by exactly the two column grants. Replays
 * change nothing. Output: codes and booleans only.
 */
export const CLOUD_LINK_TABLE = 'fulfillment_transport_state';
export const CLOUD_LINK_COLUMNS = Object.freeze(['branch_id', 'last_success_at']);
/** Reviewed schemas the POS line ships with: the stage 2 runtime runs on 023 and 024. */
export const CLOUD_LINK_SCHEMAS = Object.freeze({ schema023: 23, schema024: 24 });
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

export async function cloudLinkGrant(
  client,
  { mode, branchId, schema = 'public', runtimeRole = 'pickchick_edge_runtime', pinned },
) {
  if (!['inspect', 'apply', 'revoke'].includes(mode)) throw Error('Invalid mode');
  if (!/^[a-f0-9-]{36}$/.test(branchId ?? '')) throw Error('Invalid branch');
  const ns = identifier(schema),
    role = identifier(runtimeRole);
  if (!Array.isArray(pinned) || pinned.length < Math.max(...Object.values(CLOUD_LINK_SCHEMAS)))
    throw Error('Pinned edge ledger is invalid');
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('SET LOCAL search_path TO ' + ns);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('pickchick-cloud-link-grant',0))",
    );
    const ledger = (
      await client.query('SELECT scope,version,checksum FROM schema_migrations ORDER BY version')
    ).rows;
    const reviewed = Object.entries(CLOUD_LINK_SCHEMAS).find(
      ([, length]) =>
        ledger.length === length &&
        JSON.stringify(ledger) ===
          JSON.stringify(
            pinned
              .slice(0, length)
              .map(({ scope, version, checksum }) => ({ scope, version, checksum })),
          ),
    );
    if (!reviewed) throw Error('Reviewed schema023 or schema024 required');
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
    const columns = (
      await client.query(
        'SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2',
        [schema, CLOUD_LINK_TABLE],
      )
    ).rows.map((r) => r.column_name);
    if (!CLOUD_LINK_COLUMNS.every((c) => columns.includes(c)))
      throw Error('Transport state columns missing');
    const before = await privilegeMap(client, schema);
    if (before.some((p) => p.startsWith(`${runtimeRole}|${CLOUD_LINK_TABLE}||`)))
      throw Error('Unexpected table privilege on the transport state');
    const entries = CLOUD_LINK_COLUMNS.map((c) => `${runtimeRole}|${CLOUD_LINK_TABLE}|${c}|SELECT`);
    const held = entries.filter((e) => before.includes(e));
    if (held.length === 1) throw Error('Partial cloud link grant; inspect');
    const granted = held.length === 2;
    const change = (mode === 'apply' && !granted) || (mode === 'revoke' && granted);
    if (change) {
      const list = CLOUD_LINK_COLUMNS.map(identifier).join(',');
      await client.query(
        mode === 'apply'
          ? `GRANT SELECT(${list}) ON ${ns}.${identifier(CLOUD_LINK_TABLE)} TO ${role}`
          : `REVOKE SELECT(${list}) ON ${ns}.${identifier(CLOUD_LINK_TABLE)} FROM ${role}`,
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
      schema: reviewed[0],
      runtimeRole,
      cloudLink: change ? mode === 'apply' : granted,
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
  const pinned = JSON.parse(
    await readFile(new URL('./native-edge-backup-ledger.json', import.meta.url), 'utf8'),
  );
  const { Client } = createRequire(join(resolve(toolsRoot), 'package.json'))('pg');
  const c = new Client({
    connectionString: url.href,
    connectionTimeoutMillis: 3000,
    statement_timeout: 60000,
  });
  c.on('error', () => {});
  await c.connect();
  try {
    console.log(JSON.stringify(await cloudLinkGrant(c, { mode, branchId, pinned })));
  } finally {
    await c.end();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error(JSON.stringify({ event: 'cloud_link_grant_failed' }));
    process.exitCode = 1;
  });
