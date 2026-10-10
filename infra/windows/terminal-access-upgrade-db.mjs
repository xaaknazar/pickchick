/** Guarded019->020 only. No command, terminal, password, order or payment is created. */
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertFreshBackup,
  foundationCredentials,
  ensureMenuSyncRole,
} from './menu-sync-upgrade-db.mjs';
import { readRemoteStopMigrations, verifyBackupArchive } from './remote-stops-upgrade-db.mjs';
import { terminalAccessGrants } from './terminal-access-grants.mjs';
export const DEVICE_ACCESS_ROLE = 'pickchick_device_access_sync';
export const DEVICE_ACCESS_MIGRATION = '020_terminal_access.sql';
const newTables = [
  'terminal_access_commands',
  'terminal_access_registry',
  'terminal_pair_limits',
  'kitchen_password_reset_commands',
];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hash = (x) => createHash('sha256').update(x).digest('hex');
const sorted = (x) => [...new Set(x)].sort();
const id = (x) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(x)) throw new Error('Invalid identifier');
  return '"' + x + '"';
};
const ledgerText = (x) =>
  JSON.stringify(x.map(({ scope, version, checksum }) => ({ scope, version, checksum })));
export function deviceAccessEnvText({ password, branchId, deviceId, enabled = false }) {
  if (
    !/^[a-f0-9]{64}$/.test(password ?? '') ||
    !uuid.test(branchId ?? '') ||
    !uuid.test(deviceId ?? '') ||
    typeof enabled !== 'boolean'
  )
    throw new Error('Invalid device worker scope');
  return [
    'APP_ENV=local',
    `EDGE_BRANCH_ID=${branchId}`,
    `EDGE_DEVICE_ID=${deviceId}`,
    'EDGE_FULFILLMENT_ENABLED=true',
    'EDGE_FULFILLMENT_CLOUD_ORIGIN=http://127.0.0.1:43100',
    `DEVICE_ACCESS_WORKER_ENABLED=${enabled}`,
    `EDGE_DATABASE_URL=postgresql://${DEVICE_ACCESS_ROLE}:${password}@127.0.0.1:55433/pickchick_edge`,
    '',
  ].join('\n');
}
export function parseDeviceAccessEnv(text, scope) {
  const password =
    /^EDGE_DATABASE_URL=postgresql:\/\/pickchick_device_access_sync:([a-f0-9]{64})@127\.0\.0\.1:55433\/pickchick_edge$/m.exec(
      text,
    )?.[1];
  const match = /^DEVICE_ACCESS_WORKER_ENABLED=(true|false)$/m.exec(text);
  const enabled = match?.[1] === 'true';
  if (!match || text !== deviceAccessEnvText({ ...scope, password, enabled }))
    throw new Error('Existing device environment differs');
  return { password, enabled };
}
export function deviceAclEntries(role, schema, worker) {
  // Parse the canonical grant profile so the allowed delta cannot drift from installer SQL.
  return terminalAccessGrants(role, schema, { worker })
    .split('\n')
    .filter((line) => !line.includes(' ON SCHEMA '))
    .flatMap((line) => {
      const m = /^GRANT (.+) ON (.+) TO "[a-z0-9_]+";$/.exec(line);
      if (!m) throw new Error('Unsupported grant');
      const cols = /^(\w+)\(([^)]+)\)$/.exec(m[1]);
      const privileges = cols ? [cols[1]] : m[1].split(',');
      return m[2].split(',').flatMap((t) => {
        const table = /^"[a-z0-9_]+"\."([a-z0-9_]+)"$/.exec(t)?.[1];
        if (!table) throw new Error('Unsupported relation');
        return privileges.flatMap((p) =>
          (cols ? cols[2].split(',') : ['']).map((c) => `${role}|${table}|${c}|${p}`),
        );
      });
    });
}
async function acl(client, schema) {
  return (
    await client.query(
      `SELECT c.relname,COALESCE(a.attname,'') col,COALESCE(r.rolname,'PUBLIC') role,x.privilege_type privilege
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL (SELECT NULL::name attname,c.relacl acl UNION ALL SELECT attname,attacl FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped) a
    CROSS JOIN LATERAL aclexplode(a.acl) x LEFT JOIN pg_roles r ON r.oid=x.grantee
    WHERE n.nspname=$1 AND x.grantee<>c.relowner`,
      [schema],
    )
  ).rows.map((r) => `${r.role}|${r.relname}|${r.col}|${r.privilege}`);
}
async function fingerprint(client, schema, tables) {
  const rows = {};
  for (const table of tables)
    rows[table] = (
      await client.query(
        `SELECT count(*)::text count,md5(COALESCE(string_agg(h,'' ORDER BY h),'')) hash FROM (SELECT md5((to_jsonb(t)${table === 'local_terminals' ? " - 'device_access_managed'" : ''})::text) h FROM ${id(schema)}.${id(table)} t) r`,
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
async function roles(client, names) {
  const rows = (
    await client.query(
      `SELECT r.rolname,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
    EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) member
    FROM pg_roles r WHERE rolname=ANY($1)`,
      [names],
    )
  ).rows;
  if (
    rows.some(
      (r) =>
        r.rolsuper ||
        r.rolcreatedb ||
        r.rolcreaterole ||
        r.rolreplication ||
        r.rolbypassrls ||
        r.member,
    )
  )
    throw new Error('Role is not restricted');
  return rows;
}
async function databaseAcl(client) {
  const scope = (
    await client.query(`SELECT datname database,pg_get_userbyid(datdba) owner,
    current_user operator FROM pg_database WHERE datname=current_database()`)
  ).rows[0];
  const entries = (
    await client.query(`SELECT COALESCE(r.rolname,'PUBLIC') role,
    pg_get_userbyid(x.grantor) grantor,x.privilege_type privilege,x.is_grantable
    FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) x
    LEFT JOIN pg_roles r ON r.oid=x.grantee WHERE datname=current_database()`)
  ).rows;
  return { ...scope, entries };
}
export async function assertDeviceDatabaseConnect(client, role) {
  id(role);
  const database = await databaseAcl(client);
  const own = database.entries.filter((e) => e.role === role);
  const effective = (
    await client.query(
      `SELECT has_database_privilege($1,current_database(),'CONNECT') connect,
    has_database_privilege($1,current_database(),'CREATE,TEMP') broad`,
      [role],
    )
  ).rows[0];
  if (
    !effective.connect ||
    effective.broad ||
    own.length !== 1 ||
    own[0].privilege !== 'CONNECT' ||
    own[0].is_grantable ||
    own[0].grantor !== database.owner
  )
    throw new Error('Mailbox database privileges differ');
}
export async function ensureDeviceDatabaseConnect(client, role) {
  id(role);
  let committing = false;
  await client.query('BEGIN');
  try {
    const before = await databaseAcl(client);
    if (before.owner !== before.operator) throw new Error('Database owner connection required');
    const own = before.entries.filter((e) => e.role === role);
    if (own.some((e) => e.privilege !== 'CONNECT' || e.is_grantable || e.grantor !== before.owner))
      throw new Error('Existing mailbox database privileges differ');
    const key = (e) => `${e.role}|${e.grantor}|${e.privilege}|${e.is_grantable}`;
    const expected = sorted([
      ...before.entries.map(key),
      key({ role, grantor: before.owner, privilege: 'CONNECT', is_grantable: false }),
    ]);
    await client.query(`GRANT CONNECT ON DATABASE ${id(before.database)} TO ${id(role)}`);
    if (
      JSON.stringify(sorted((await databaseAcl(client)).entries.map(key))) !==
      JSON.stringify(expected)
    )
      throw new Error('Unexpected database ACL delta');
    await assertDeviceDatabaseConnect(client, role);
    committing = true;
    await client.query('COMMIT');
  } catch (error) {
    if (committing)
      throw new Error('Database CONNECT result unknown; inspect without replay', { cause: error });
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
export async function assertDevicePrivileges(
  client,
  { schema = 'public', runtimeRole = 'pickchick_edge_runtime', workerRole = DEVICE_ACCESS_ROLE },
) {
  const entries = await acl(client, schema);
  const want = sorted([
    ...deviceAclEntries(runtimeRole, schema, false),
    ...deviceAclEntries(workerRole, schema, true),
  ]);
  if (want.some((x) => !entries.includes(x))) throw new Error('Device privilege missing');
  // The dedicated worker must have exactly these rights throughout this schema, not just new tables.
  if (
    JSON.stringify(sorted(entries.filter((x) => x.startsWith(workerRole + '|')))) !==
    JSON.stringify(sorted(deviceAclEntries(workerRole, schema, true)))
  )
    throw new Error('Mailbox role has unrelated privileges');
  for (const role of [workerRole, runtimeRole])
    for (const table of newTables) {
      const allowed = want.filter((x) => x.startsWith(role + '|' + table + '|'));
      const actual = entries.filter((x) => x.startsWith(role + '|' + table + '|'));
      if (JSON.stringify(sorted(actual)) !== JSON.stringify(sorted(allowed)))
        throw new Error('New relation privileges differ');
    }
  const forbidden = (
    await client.query(
      `SELECT has_column_privilege($1,$2::regclass,'verifier','SELECT,UPDATE') bad_password,
    has_table_privilege($1,$3::regclass,'INSERT,UPDATE,DELETE') bad_staff,
    has_table_privilege($1,$4::regclass,'SELECT,INSERT,UPDATE,DELETE') bad_orders`,
      [
        workerRole,
        `${id(schema)}.local_staff_passwords`,
        `${id(schema)}.local_staff`,
        `${id(schema)}.local_orders`,
      ],
    )
  ).rows[0];
  if (Object.values(forbidden).some(Boolean))
    throw new Error('Mailbox role inherited sensitive access');
}
export async function upgradeTerminalAccess(
  client,
  {
    mode,
    appRoot,
    branchId,
    deviceId,
    backup,
    now = new Date(),
    schema = 'public',
    runtimeRole = 'pickchick_edge_runtime',
    workerRole = DEVICE_ACCESS_ROLE,
  },
) {
  if (
    !['inspect', 'apply'].includes(mode) ||
    !uuid.test(branchId ?? '') ||
    !uuid.test(deviceId ?? '') ||
    runtimeRole === workerRole
  )
    throw new Error('Invalid device upgrade scope');
  id(schema);
  id(runtimeRole);
  id(workerRole);
  const expected = await readRemoteStopMigrations(appRoot);
  if (
    expected.length !== 20 ||
    expected[19].version !== DEVICE_ACCESS_MIGRATION ||
    expected[19].checksum !== 'afeffbdd49c9dfaa5a3fea4be32b97aa99c45e6897f4ff0c220f9b89d02a24b6'
  )
    throw new Error('Exact candidate020 required');
  let committing = false;
  await client.query(
    mode === 'apply' ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  );
  try {
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('SET LOCAL search_path TO ' + id(schema));
    const tables = (
      await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [
        schema,
      ])
    ).rows.map((r) => r.tablename);
    if (mode === 'apply') {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('pickchick-terminal-access-020',0))",
      );
      await client.query(
        'LOCK TABLE ' +
          tables.map((t) => `${id(schema)}.${id(t)}`).join(',') +
          ' IN ACCESS EXCLUSIVE MODE',
      );
    }
    const ledger = (
      await client.query('SELECT scope,version,checksum FROM schema_migrations ORDER BY version')
    ).rows;
    if (
      ![19, 20].includes(ledger.length) ||
      ledgerText(ledger) !== ledgerText(expected.slice(0, ledger.length))
    )
      throw new Error('Exact019/020 ledger required');
    const pending = ledger.length === 19;
    const proof = assertFreshBackup(backup, { branchId, ledger, now });
    const branches = (await client.query('SELECT id FROM branch_config')).rows;
    const binding = (await client.query('SELECT branch_id,device_id FROM fulfillment_config')).rows;
    if (
      branches.length !== 1 ||
      branches[0].id !== branchId ||
      binding.length !== 1 ||
      binding[0].branch_id !== branchId ||
      binding[0].device_id !== deviceId
    )
      throw new Error('Branch/device binding differs');
    const rr = await roles(client, [runtimeRole, workerRole]);
    const roleExists = rr.some((r) => r.rolname === workerRole);
    if (!rr.some((r) => r.rolname === runtimeRole) || (mode === 'apply' && !roleExists))
      throw new Error('Restricted runtime/mailbox role required');
    const existing = tables.filter((t) => t !== 'schema_migrations' && !newTables.includes(t));
    const before = await fingerprint(client, schema, existing);
    let grantsVerified = false;
    if (mode === 'apply') {
      if (!pending) throw new Error('020 already applied; inspect instead of replay');
      const previousAcl = await acl(client, schema);
      if (previousAcl.some((x) => x.startsWith(workerRole + '|')))
        throw new Error('New mailbox role already holds privileges');
      await client.query(
        await readFile(join(appRoot, 'db/edge/migrations', DEVICE_ACCESS_MIGRATION), 'utf8'),
      );
      await client.query('INSERT INTO schema_migrations(scope,version,checksum) VALUES($1,$2,$3)', [
        'edge',
        DEVICE_ACCESS_MIGRATION,
        expected[19].checksum,
      ]);
      await client.query(terminalAccessGrants(runtimeRole, schema));
      await client.query(terminalAccessGrants(workerRole, schema, { worker: true }));
      await assertDevicePrivileges(client, { schema, runtimeRole, workerRole });
      grantsVerified = true;
      const allowed = sorted([
        ...previousAcl,
        ...deviceAclEntries(runtimeRole, schema, false),
        ...deviceAclEntries(workerRole, schema, true),
      ]);
      if (JSON.stringify(sorted(await acl(client, schema))) !== JSON.stringify(allowed))
        throw new Error('Unexpected ACL delta');
      if ((await fingerprint(client, schema, existing)) !== before)
        throw new Error('Existing rows or sequences changed');
      if (
        (
          await client.query(
            'SELECT count(*)::int count FROM local_terminals WHERE device_access_managed',
          )
        ).rows[0].count
      )
        throw new Error('Legacy terminal changed');
      for (const t of newTables)
        if ((await client.query('SELECT count(*)::int count FROM ' + id(t))).rows[0].count)
          throw new Error('New mailbox not empty');
    } else if (!pending && roleExists) {
      await assertDevicePrivileges(client, { schema, runtimeRole, workerRole });
      grantsVerified = true;
    }
    const result = {
      mode,
      migrations: pending && mode === 'apply' ? 20 : ledger.length,
      migrationPending: pending && mode !== 'apply',
      migrationApplied: pending && mode === 'apply',
      grantsVerified,
      roleExists,
      existingDataPreserved: true,
      backupSha256: proof.sha256,
      fingerprint: hash(before),
      managedTerminals:
        pending && mode !== 'apply'
          ? 0
          : (
              await client.query(
                'SELECT count(*)::int count FROM local_terminals WHERE device_access_managed',
              )
            ).rows[0].count,
    };
    committing = mode === 'apply';
    await client.query(committing ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    if (!committing) await client.query('ROLLBACK').catch(() => {});
    else throw new Error('Commit result unknown; inspect without replay', { cause: error });
    throw error;
  }
}
async function jsonFile(path, limit = 10000) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > limit) throw new Error('Unsafe setup file');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function main() {
  const [mode, toolsRoot, appRoot, branchId, deviceId, backupPath, envPath, ...extra] =
    process.argv.slice(2);
  if (
    process.platform !== 'win32' ||
    extra.length ||
    !['inspect', 'apply'].includes(mode) ||
    ![toolsRoot, appRoot, backupPath, envPath].every((x) => win32.isAbsolute(x ?? '')) ||
    win32.basename(envPath) !== 'device-access.env'
  )
    throw new Error('Invalid Windows setup invocation');
  const credentials = foundationCredentials(
    await jsonFile(join(toolsRoot, 'private/foundation-credentials.json')),
    branchId,
  );
  const state = await jsonFile(join(toolsRoot, 'private/foundation-state.json'));
  if (!state.complete || state.installId !== credentials.installId || state.branchId !== branchId)
    throw new Error('Wrong foundation');
  const backup = await jsonFile(backupPath, 1000000);
  await verifyBackupArchive(backupPath, backup, state);
  const { Client } = createRequire(join(resolve(toolsRoot), 'package.json'))('pg');
  const connect = async (user, password, database = 'pickchick_edge') => {
    const c = new Client({
      host: '127.0.0.1',
      port: 55433,
      user,
      password,
      database,
      ssl: false,
      connectionTimeoutMillis: 3000,
      statement_timeout: 60000,
      application_name: 'pickchick-device-access-setup',
    });
    c.on('error', () => {});
    await c.connect();
    return c;
  };
  let owner, admin, worker;
  try {
    admin = await connect(
      'pickchick_bootstrap',
      credentials.passwords.pickchick_bootstrap,
      'postgres',
    );
    await admin.query('BEGIN READ ONLY');
    const cluster = (
      await admin.query(
        "SELECT system_identifier::text id,current_setting('data_directory') directory FROM pg_control_system()",
      )
    ).rows[0];
    await admin.query('ROLLBACK');
    if (
      cluster.id !== state.systemIdentifier ||
      cluster.directory.replaceAll('\\', '/').toLowerCase() !==
        resolve(toolsRoot, '../../Postgres/18/data').replaceAll('\\', '/').toLowerCase()
    )
      throw new Error('Different PostgreSQL cluster');
    owner = await connect('pickchick_edge_owner', credentials.passwords.pickchick_edge_owner);
    const scope = { appRoot, branchId, deviceId, backup };
    const inspected = await upgradeTerminalAccess(owner, { ...scope, mode: 'inspect' });
    if (!inspected.migrationPending) await assertDeviceDatabaseConnect(owner, DEVICE_ACCESS_ROLE);
    if (mode === 'inspect') {
      console.log(JSON.stringify(inspected));
      return;
    }
    if (!inspected.migrationPending)
      throw new Error('Migration already committed; inspect partial state');
    let password;
    try {
      ({ password } = parseDeviceAccessEnv(await readFile(envPath, 'utf8'), {
        branchId,
        deviceId,
      }));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (inspected.roleExists) throw new Error('Role without protected credential', { cause: e });
      password = randomBytes(32).toString('hex');
      await writeFile(envPath, deviceAccessEnvText({ password, branchId, deviceId }), {
        flag: 'wx',
        mode: 0o600,
      });
    }
    const role = await ensureMenuSyncRole(admin, { role: DEVICE_ACCESS_ROLE, password });
    await ensureDeviceDatabaseConnect(owner, DEVICE_ACCESS_ROLE);
    // Prove the actual existing credential before the irreversible migration commit.
    worker = await connect(DEVICE_ACCESS_ROLE, password);
    if ((await worker.query('SELECT current_user role')).rows[0].role !== DEVICE_ACCESS_ROLE)
      throw new Error('Wrong worker login');
    const applied = await upgradeTerminalAccess(owner, { ...scope, mode: 'apply' });
    await worker.query('SELECT 1 FROM terminal_access_commands LIMIT 0');
    await worker.query('SELECT 1 FROM kitchen_password_reset_commands LIMIT 0');
    console.log(
      JSON.stringify({
        ...applied,
        roleCreated: role.created,
        loginVerified: true,
        envFile: 'preserved-or-created',
        serviceInstalled: false,
      }),
    );
  } finally {
    await Promise.allSettled([worker?.end(), admin?.end(), owner?.end()]);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error(
      JSON.stringify({
        event: 'device_access_upgrade_failed',
        detail: 'Inspect protected state; no automatic replay.',
      }),
    );
    process.exitCode = 1;
  });
