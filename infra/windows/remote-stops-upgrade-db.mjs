import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve, win32, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFreshBackup, foundationCredentials } from './menu-sync-upgrade-db.mjs';

/**
 * Guarded edge database phase for back-office remote stops (edge schema019).
 *
 * - inspect: read-only checks, then ROLLBACK.
 * - apply: in one owner transaction under maintenance locks: applies edge migration 019 when
 *   the ledger stops at 018, then grants exactly the reviewed remote-stop privileges to the
 *   existing edge runtime role (applies commands, writes stop history) and the existing
 *   fulfillment worker role (fills the inbox, reports verdicts, reads stop versions). It proves
 *   the exact privilege set on the 019 objects, that no other ACL entry of any role changed and
 *   that no existing business row or sequence changed. Re-running it is idempotent.
 *
 * Both roles must already exist and stay unprivileged; no role is created, no password is set
 * or read. A fresh, completed backup + restore proof whose ledger equals the current ledger is
 * required for both modes. Credentials never enter arguments, SQL text or output.
 */
export const REMOTE_STOPS_MIGRATION = '019_edge_remote_stops.sql';
export const REMOTE_STOPS_PREREQUISITE = '018_edge_menu_publication.sql';
export const REMOTE_STOPS_RUNTIME_ROLE = 'pickchick_edge_runtime';
/** The Windows fulfillment worker logs in as this role (native-fulfillment-worker.mjs). */
export const REMOTE_STOPS_WORKER_ROLE = 'pickchick_fulfillment_sync';
const NEW_RELATIONS = Object.freeze(['remote_stop_commands', 'local_stop_events']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const identifier = (value) => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw new Error('Invalid identifier');
  return '"' + value + '"';
};
const sorted = (values) => [...new Set(values)].sort();

/**
 * Every privilege this upgrade adds. columns:null is a table-level grant. The runtime entries
 * equal edgeRuntimeGrantSql({remoteStops:true}) minus its default, the worker entries equal
 * fulfillmentWorkerGrants({remoteStops:true}) minus its default (pinned by unit tests), and
 * both follow the SQL in packages/local-orders/src/remote-stops.ts and orders.ts (runtime) and
 * packages/fulfillment-transport/src/worker.ts (worker).
 */
export const REMOTE_STOP_GRANTS = Object.freeze(
  [
    // applyRemoteStops/setStop: INSERT ... ON CONFLICT DO UPDATE SET source=...
    { role: 'runtime', relation: 'local_stops', privilege: 'UPDATE', columns: ['source'] },
    // Inbox scan with SELECT ... FOR UPDATE SKIP LOCKED, then one verdict per command.
    { role: 'runtime', relation: 'remote_stop_commands', privilege: 'SELECT', columns: null },
    {
      role: 'runtime',
      relation: 'remote_stop_commands',
      privilege: 'UPDATE',
      columns: ['state', 'result_version', 'applied_at'],
    },
    // Append-only stop history from POS and back-office stops.
    { role: 'runtime', relation: 'local_stop_events', privilege: 'INSERT', columns: null },
    // Protocol-4 stop-state report: version, source and recency of each local stop.
    {
      role: 'worker',
      relation: 'local_stops',
      privilege: 'SELECT',
      columns: ['version', 'source', 'updated_at'],
    },
    {
      role: 'worker',
      relation: 'remote_stop_commands',
      privilege: 'SELECT',
      columns: ['command_id', 'branch_id', 'state', 'result_version', 'applied_at', 'reported_at'],
    },
    {
      role: 'worker',
      relation: 'remote_stop_commands',
      privilege: 'INSERT',
      columns: [
        'command_id',
        'branch_id',
        'variant_id',
        'stopped',
        'duration',
        'reason',
        'expected_version',
        'actor_label',
        'issued_at',
      ],
    },
    {
      role: 'worker',
      relation: 'remote_stop_commands',
      privilege: 'UPDATE',
      columns: ['reported_at'],
    },
  ].map((entry) =>
    Object.freeze({ ...entry, columns: entry.columns && Object.freeze(entry.columns) }),
  ),
);
/** Stop columns the worker already reads for the stop-list heartbeat (pre-019 grant). */
export const WORKER_BASE_STOP_COLUMNS = Object.freeze([
  'branch_id',
  'variant_id',
  'stopped',
  'expires_at',
  'expires_shift_id',
]);

/** Pure SQL for the reviewed remote-stop grants. Requires applied edge schema019. */
export function remoteStopGrantSql({
  runtimeRole = REMOTE_STOPS_RUNTIME_ROLE,
  workerRole = REMOTE_STOPS_WORKER_ROLE,
  schema = 'public',
} = {}) {
  if (runtimeRole === workerRole) throw new Error('Separate runtime roles required');
  const roles = { runtime: identifier(runtimeRole), worker: identifier(workerRole) };
  const namespace = identifier(schema);
  return REMOTE_STOP_GRANTS.map(
    ({ role, relation, privilege, columns }) =>
      `GRANT ${privilege}${columns ? `(${columns.map(identifier).join(',')})` : ''} ON ${namespace}.${identifier(relation)} TO ${roles[role]};`,
  ).join('\n');
}

/** ACL entries (grantee|relation|column|privilege) the reviewed grants produce. */
export function remoteStopAclEntries({
  runtimeRole = REMOTE_STOPS_RUNTIME_ROLE,
  workerRole = REMOTE_STOPS_WORKER_ROLE,
} = {}) {
  const roles = { runtime: runtimeRole, worker: workerRole };
  return sorted(
    REMOTE_STOP_GRANTS.flatMap(({ role, relation, privilege, columns }) =>
      (columns ?? ['']).map((column) => `${roles[role]}|${relation}|${column}|${privilege}`),
    ),
  );
}

/** Reviewed edge migrations shipped with the candidate app, in ledger form. */
export async function readRemoteStopMigrations(appRoot) {
  const dir = join(appRoot, 'db', 'edge', 'migrations');
  const names = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  if (
    names.length < 19 ||
    names[17] !== REMOTE_STOPS_PREREQUISITE ||
    names[18] !== REMOTE_STOPS_MIGRATION ||
    names.some(
      (name, index) =>
        !/^\d{3}_[a-z0-9_]+\.sql$/.test(name) ||
        !name.startsWith(String(index + 1).padStart(3, '0') + '_'),
    )
  )
    throw new Error('Expected reviewed edge migrations including 018 and 019');
  return Promise.all(
    names.map(async (version) => ({
      scope: 'edge',
      version,
      checksum: hash(await readFile(join(dir, version))),
    })),
  );
}

const ledgerText = (rows) =>
  JSON.stringify(
    rows.map((row) => ({ scope: row.scope, version: row.version, checksum: row.checksum })),
  );

/** Row and sequence fingerprint. local_stops.source is added by 019 with default 'pos' and is
 * checked separately, so the fingerprint before and after the migration is comparable. */
async function fingerprint(client, schema, tables) {
  const ns = identifier(schema);
  const rows = {};
  for (const table of tables)
    rows[table] = (
      await client.query(
        `SELECT count(*)::text AS count,md5(COALESCE(string_agg(h,'' ORDER BY h),'')) AS hash
         FROM (SELECT md5((to_jsonb(t)${table === 'local_stops' ? " - 'source'" : ''})::text) h
           FROM ${ns}.${identifier(table)} t) r`,
      )
    ).rows[0];
  rows.sequences = (
    await client.query(
      'SELECT sequencename,last_value FROM pg_sequences WHERE schemaname=$1 ORDER BY sequencename',
      [schema],
    )
  ).rows;
  return JSON.stringify(rows);
}

/** Table, sequence and column ACL entries per grantee, without the owner's implicit rights. */
async function aclEntries(client, schema) {
  const rows = (
    await client.query(
      `SELECT c.relname,NULL::text AS attname,COALESCE(r.rolname,'PUBLIC') AS grantee,x.privilege_type
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       CROSS JOIN LATERAL aclexplode(c.relacl) x LEFT JOIN pg_roles r ON r.oid=x.grantee
       WHERE n.nspname=$1 AND x.grantee<>c.relowner
       UNION ALL
       SELECT c.relname,a.attname::text,COALESCE(r.rolname,'PUBLIC'),x.privilege_type
       FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
       CROSS JOIN LATERAL aclexplode(a.attacl) x LEFT JOIN pg_roles r ON r.oid=x.grantee
       WHERE n.nspname=$1 AND a.attnum>0 AND x.grantee<>c.relowner`,
      [schema],
    )
  ).rows;
  return rows.map(
    (row) => `${row.grantee}|${row.relname}|${row.attname ?? ''}|${row.privilege_type}`,
  );
}

/** Removes every privilege both roles hold on the two 019 relations (and only there). */
async function resetNewRelations(client, schema, roles) {
  const ns = identifier(schema);
  for (const relation of NEW_RELATIONS) {
    const columns = (
      await client.query(
        `SELECT array_agg(attname::text ORDER BY attnum) AS columns FROM pg_attribute
         WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped`,
        [`${ns}.${identifier(relation)}`],
      )
    ).rows[0].columns.map(identifier);
    for (const role of roles) {
      await client.query(
        `REVOKE ALL ON TABLE ${ns}.${identifier(relation)} FROM ${identifier(role)}`,
      );
      // REVOKE ALL ON TABLE does not remove earlier column grants.
      await client.query(
        `REVOKE SELECT(${columns}),INSERT(${columns}),UPDATE(${columns}),REFERENCES(${columns}) ON ${ns}.${identifier(relation)} FROM ${identifier(role)}`,
      );
    }
  }
}

/**
 * Proves the exact remote-stop authority of both roles with has_table_privilege and
 * has_column_privilege: on remote_stop_commands and local_stop_events nothing missing and
 * nothing extra; the worker reads exactly the reviewed local_stops columns and never writes
 * stops; the runtime can set local_stops.source and never deletes stops.
 */
export async function assertRemoteStopPrivileges(
  client,
  {
    runtimeRole = REMOTE_STOPS_RUNTIME_ROLE,
    workerRole = REMOTE_STOPS_WORKER_ROLE,
    schema = 'public',
  } = {},
) {
  for (const name of [schema, runtimeRole, workerRole]) identifier(name);
  if (runtimeRole === workerRole) throw new Error('Separate runtime roles required');
  const roles = { runtime: runtimeRole, worker: workerRole };
  const checks = [
    ...NEW_RELATIONS.flatMap((relation) => [
      { role: 'runtime', relation },
      { role: 'worker', relation },
    ]),
    { role: 'worker', relation: 'local_stops', base: { SELECT: WORKER_BASE_STOP_COLUMNS } },
  ];
  for (const { role, relation, base = {} } of checks) {
    const grants = REMOTE_STOP_GRANTS.filter(
      (entry) => entry.role === role && entry.relation === relation,
    );
    const tableLevel = (privilege) =>
      grants.some((entry) => entry.privilege === privilege && entry.columns === null);
    const columnLevel = (privilege, column) =>
      tableLevel(privilege) ||
      (base[privilege] ?? []).includes(column) ||
      grants.some((entry) => entry.privilege === privilege && entry.columns?.includes(column));
    const table = (
      await client.query(
        `SELECT c.oid,has_table_privilege($1,c.oid,'SELECT') AS "SELECT",
          has_table_privilege($1,c.oid,'INSERT') AS "INSERT",
          has_table_privilege($1,c.oid,'UPDATE') AS "UPDATE",
          has_table_privilege($1,c.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER') AS other
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname=$2 AND c.relname=$3 AND c.relkind IN ('r','p')`,
        [roles[role], schema, relation],
      )
    ).rows[0];
    if (!table) throw new Error('Remote stop schema019 relation missing');
    if (
      table.other ||
      ['SELECT', 'INSERT', 'UPDATE'].some((privilege) => table[privilege] !== tableLevel(privilege))
    )
      throw new Error(`Remote stop table privileges differ: ${role} ${relation}`);
    const columns = (
      await client.query(
        `SELECT attname,
          has_column_privilege($1,attrelid,attnum,'SELECT') AS "SELECT",
          has_column_privilege($1,attrelid,attnum,'INSERT') AS "INSERT",
          has_column_privilege($1,attrelid,attnum,'UPDATE') AS "UPDATE",
          has_column_privilege($1,attrelid,attnum,'REFERENCES') AS ref
         FROM pg_attribute WHERE attrelid=$2 AND attnum>0 AND NOT attisdropped`,
        [roles[role], table.oid],
      )
    ).rows;
    for (const column of columns)
      if (
        column.ref ||
        ['SELECT', 'INSERT', 'UPDATE'].some(
          (privilege) => column[privilege] !== columnLevel(privilege, column.attname),
        )
      )
        throw new Error(`Remote stop column privileges differ: ${role} ${relation}`);
  }
  // The same probes the services use to switch the feature on (remoteStopsReady,
  // stopAuditReady, remoteStopTransportReady), evaluated for each role.
  const ready = (
    await client.query(
      `SELECT
        has_column_privilege($1,$3::regclass,'state','UPDATE')
          AND has_table_privilege($1,$4::regclass,'INSERT')
          AND has_column_privilege($1,$5::regclass,'source','UPDATE')
          AND has_column_privilege($1,$5::regclass,'source','INSERT')
          AND has_column_privilege($1,$5::regclass,'source','SELECT')
          AND NOT has_table_privilege($1,$5::regclass,'DELETE,TRUNCATE') AS runtime,
        has_column_privilege($2,$3::regclass,'variant_id','INSERT')
          AND has_column_privilege($2,$3::regclass,'reported_at','UPDATE')
          AND has_column_privilege($2,$5::regclass,'source','SELECT')
          AND has_column_privilege($2,$5::regclass,'version','SELECT') AS worker`,
      [
        roles.runtime,
        roles.worker,
        `${identifier(schema)}.remote_stop_commands`,
        `${identifier(schema)}.local_stop_events`,
        `${identifier(schema)}.local_stops`,
      ],
    )
  ).rows[0];
  if (!ready.runtime || !ready.worker) throw new Error('Remote stop readiness probes differ');
  return { runtimeReady: true, workerReady: true, verified: true };
}

export async function upgradeRemoteStops(
  client,
  {
    mode,
    appRoot,
    branchId,
    backup,
    now = new Date(),
    schema = 'public',
    runtimeRole = REMOTE_STOPS_RUNTIME_ROLE,
    workerRole = REMOTE_STOPS_WORKER_ROLE,
  },
) {
  if (
    !['inspect', 'apply'].includes(mode) ||
    !uuid.test(branchId ?? '') ||
    runtimeRole === workerRole
  )
    throw new Error('Invalid remote stop upgrade scope');
  const ns = identifier(schema);
  identifier(runtimeRole);
  identifier(workerRole);
  const scope = { runtimeRole, workerRole, schema };
  const expected = await readRemoteStopMigrations(appRoot);
  await client.query(
    mode === 'apply' ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  );
  try {
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('SET LOCAL search_path TO ' + ns);
    if (mode === 'apply')
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('pickchick-remote-stops-019',0))",
      );
    const tables = (
      await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [
        schema,
      ])
    ).rows.map((row) => row.tablename);
    if (!tables.includes('schema_migrations') || !tables.includes('local_stops'))
      throw new Error('Missing edge schema');
    // Writers stay out while data, ACLs and the ledger are compared and changed.
    if (mode === 'apply')
      await client.query(
        'LOCK TABLE ' +
          tables.map((table) => `${ns}.${identifier(table)}`).join(',') +
          ' IN ACCESS EXCLUSIVE MODE',
      );
    const ledger = (
      await client.query('SELECT scope,version,checksum FROM schema_migrations ORDER BY version')
    ).rows;
    if (
      ![18, 19].includes(ledger.length) ||
      ledgerText(ledger) !== ledgerText(expected.slice(0, ledger.length))
    )
      throw new Error('Edge migration ledger differs; schema018 from this release is required');
    const pending = ledger.length === 18;
    const branches = (await client.query('SELECT id FROM branch_config')).rows;
    if (branches.length !== 1 || branches[0].id !== branchId) throw new Error('Branch differs');
    const backupProof = assertFreshBackup(backup, { branchId, ledger, now });
    const roles = (
      await client.query(
        `SELECT r.rolname,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
          EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS member_of
         FROM pg_roles r WHERE r.rolname=ANY($1)`,
        [[runtimeRole, workerRole]],
      )
    ).rows;
    if (
      roles.length !== 2 ||
      roles.some(
        (row) =>
          row.rolsuper ||
          row.rolcreatedb ||
          row.rolcreaterole ||
          row.rolreplication ||
          row.rolbypassrls ||
          row.member_of,
      )
    )
      throw new Error('Restricted existing runtime and worker roles required');
    const existing = tables.filter((table) => table !== 'schema_migrations');
    const before = await fingerprint(client, schema, existing);
    let migrationApplied = false,
      grantsVerified = false;
    if (mode === 'apply') {
      const aclBefore = await aclEntries(client, schema);
      if (pending) {
        await client.query(
          await readFile(join(appRoot, 'db', 'edge', 'migrations', REMOTE_STOPS_MIGRATION), 'utf8'),
        );
        await client.query(
          'INSERT INTO schema_migrations(scope,version,checksum) VALUES($1,$2,$3)',
          ['edge', REMOTE_STOPS_MIGRATION, expected[18].checksum],
        );
        migrationApplied = true;
      }
      await resetNewRelations(client, schema, [runtimeRole, workerRole]);
      await client.query(remoteStopGrantSql(scope));
      await assertRemoteStopPrivileges(client, scope);
      grantsVerified = true;
      // Exactly the reviewed entries were added; the two roles' rights on the 019 relations
      // were reset first; nothing else of any role changed.
      const reset = new Set(NEW_RELATIONS);
      const allowed = sorted([
        ...aclBefore.filter((entry) => {
          const [grantee, relation] = entry.split('|');
          return !([runtimeRole, workerRole].includes(grantee) && reset.has(relation));
        }),
        ...remoteStopAclEntries(scope),
      ]);
      if (JSON.stringify(sorted(await aclEntries(client, schema))) !== JSON.stringify(allowed))
        throw new Error('Unexpected privilege change');
      if ((await fingerprint(client, schema, existing)) !== before)
        throw new Error('Existing business rows or sequences changed');
      if (migrationApplied) {
        const fresh = (
          await client.query(
            `SELECT (SELECT count(*) FROM local_stops WHERE source IS DISTINCT FROM 'pos')::int AS foreign_source,
              (SELECT count(*) FROM remote_stop_commands)::int AS commands,
              (SELECT count(*) FROM local_stop_events)::int AS events`,
          )
        ).rows[0];
        if (fresh.foreign_source || fresh.commands || fresh.events)
          throw new Error('Unexpected remote stop rows after migration');
      }
    } else if (!pending) {
      try {
        await assertRemoteStopPrivileges(client, scope);
        grantsVerified = true;
      } catch {
        grantsVerified = false;
      }
    }
    const result = {
      mode,
      migrations: ledger.length + (migrationApplied ? 1 : 0),
      migrationPending: pending && !migrationApplied,
      migrationApplied,
      grantsVerified,
      existingDataPreserved: true,
      backupSha256: backupProof.sha256,
      fingerprint: hash(before),
    };
    await client.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

/** The manifest must sit next to its archive, whose size and SHA-256 it records, and belong to
 * this foundation's PostgreSQL cluster. */
export async function verifyBackupArchive(manifestPath, manifest, state) {
  const archive = join(resolve(manifestPath, '..'), 'pickchick_edge.dump');
  const info = await lstat(archive);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size !== manifest?.archiveBytes ||
    manifest?.systemIdentifier !== state?.systemIdentifier ||
    !/^\d{10,20}$/.test(state?.systemIdentifier ?? '')
  )
    throw new Error('Backup archive differs from its manifest');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(archive)) digest.update(chunk);
  if (digest.digest('hex') !== manifest.sha256)
    throw new Error('Backup archive differs from its manifest');
}

async function readSmallJson(path, limit) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
    throw new Error('Unsafe operator file');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main() {
  const [mode, toolsRoot, appRoot, branchId, backupPath, ...extra] = process.argv.slice(2);
  const absolute = (path) => win32.isAbsolute(path ?? '') || posix.isAbsolute(path ?? '');
  if (
    extra.length ||
    !['inspect', 'apply'].includes(mode) ||
    ![toolsRoot, appRoot, backupPath].every(absolute) ||
    win32.basename(backupPath) !== 'backup-manifest.json' ||
    !uuid.test(branchId ?? '')
  )
    throw new Error('Invalid remote stop upgrade invocation');
  const credentials = foundationCredentials(
    await readSmallJson(join(toolsRoot, 'private', 'foundation-credentials.json'), 10000),
    branchId,
  );
  const state = await readSmallJson(join(toolsRoot, 'private', 'foundation-state.json'), 10000);
  if (
    state.format !== 'pickchick-native-state-v1' ||
    !state.complete ||
    state.branchId !== branchId ||
    state.installId !== credentials.installId
  )
    throw new Error('Completed matching native foundation required');
  const backup = await readSmallJson(backupPath, 1_000_000);
  await verifyBackupArchive(backupPath, backup, state);
  const { Client } = createRequire(join(resolve(toolsRoot), 'package.json'))('pg');
  const owner = new Client({
    host: '127.0.0.1',
    port: 55433,
    ssl: false,
    connectionTimeoutMillis: 3000,
    statement_timeout: 60000,
    application_name: 'pickchick-remote-stops-setup',
    database: 'pickchick_edge',
    user: 'pickchick_edge_owner',
    password: credentials.passwords.pickchick_edge_owner,
  });
  owner.on('error', () => {});
  await owner.connect();
  try {
    const scope = { appRoot, branchId, backup };
    const inspected = await upgradeRemoteStops(owner, { ...scope, mode: 'inspect' });
    console.log(
      JSON.stringify(
        mode === 'inspect'
          ? inspected
          : await upgradeRemoteStops(owner, { ...scope, mode: 'apply' }),
      ),
    );
  } finally {
    await owner.end().catch(() => {});
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error(
      JSON.stringify({ event: 'remote_stops_upgrade_failed', detail: 'Inspect protected state.' }),
    );
    process.exitCode = 1;
  });
