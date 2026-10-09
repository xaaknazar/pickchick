import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve, win32, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MENU_SYNC_ROLE,
  assertMenuSyncPrivileges,
  menuSyncWorkerGrants,
  revokeMenuSyncPrivileges,
} from './menu-sync-worker-grants.mjs';

/**
 * Guarded edge database phase for the Windows menu-sync worker (WP-D).
 *
 * - inspect: read-only checks, then ROLLBACK. Works before the role exists.
 * - apply: in one owner transaction under maintenance locks: applies edge migration 018 when
 *   the ledger stops at 017, resets and grants the dedicated worker role, adds SELECT on
 *   menu_media for the edge runtime, proves the exact privilege set and that no existing
 *   business row, sequence or other role's ACL changed. Re-running it is idempotent.
 *
 * A fresh, completed backup + restore proof whose ledger equals the current ledger is
 * required for both modes. Credentials never enter arguments, SQL text or output.
 */
export const MENU_SYNC_MIGRATION = '018_edge_menu_publication.sql';
export const MENU_SYNC_BACKUP_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const MENU_SYNC_ENV_FILE = 'menu-sync.env';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const identifier = (value) => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw new Error('Invalid identifier');
  return '"' + value + '"';
};

/** Reviewed edge migrations shipped with the candidate app, in ledger form. */
export async function readExpectedMigrations(appRoot) {
  const dir = join(appRoot, 'db', 'edge', 'migrations');
  const names = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  if (
    names.length < 18 ||
    names[17] !== MENU_SYNC_MIGRATION ||
    names.some(
      (name, index) =>
        !/^\d{3}_[a-z0-9_]+\.sql$/.test(name) ||
        !name.startsWith(String(index + 1).padStart(3, '0') + '_'),
    )
  )
    throw new Error('Expected reviewed edge migrations including 018');
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

/**
 * The backup must be the verified backup/restore rehearsal of this branch, finished within
 * the last six hours, and taken at exactly the current migration ledger.
 */
export function assertFreshBackup(manifest, { branchId, ledger, now = new Date() }) {
  const finished = Date.parse(manifest?.finishedAt ?? '');
  const age = now.getTime() - finished;
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    manifest.format !== 'pickchick-native-service-backup-v1' ||
    manifest.branchId !== branchId ||
    manifest.sourceDatabase !== 'pickchick_edge' ||
    manifest.backupVerified !== true ||
    manifest.restoreVerified !== true ||
    manifest.rehearsalDropped !== true ||
    manifest.completed !== true ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? '') ||
    !Number.isSafeInteger(manifest.archiveBytes) ||
    manifest.archiveBytes < 1 ||
    !Number.isFinite(finished) ||
    age < 0 ||
    age > MENU_SYNC_BACKUP_MAX_AGE_MS ||
    !Array.isArray(manifest.ledger) ||
    ledgerText(manifest.ledger) !== ledgerText(ledger)
  )
    throw new Error('Fresh matching backup and restore proof required');
  return { sha256: manifest.sha256, finishedAt: manifest.finishedAt };
}

/** Service environment for the worker. Mode starts off; the operator changes only that line. */
export function menuSyncEnvText({ password, branchId, deviceId, mode = 'off' }) {
  if (
    !/^[a-f0-9]{64}$/.test(password ?? '') ||
    !uuid.test(branchId ?? '') ||
    !uuid.test(deviceId ?? '') ||
    !['off', 'report', 'apply'].includes(mode)
  )
    throw new Error('Invalid menu sync environment input');
  return [
    'APP_ENV=local',
    `EDGE_BRANCH_ID=${branchId}`,
    `EDGE_DEVICE_ID=${deviceId}`,
    'EDGE_MENU_SYNC_CLOUD_ORIGIN=http://127.0.0.1:43100',
    `EDGE_MENU_SYNC_MODE=${mode}`,
    `EDGE_DATABASE_URL=postgresql://${MENU_SYNC_ROLE}:${password}@127.0.0.1:55433/pickchick_edge`,
    '',
  ].join('\n');
}

/** Accepts only a file this helper wrote (any mode); returns its password and mode. */
export function parseMenuSyncEnv(text, { branchId, deviceId }) {
  const mode = /^EDGE_MENU_SYNC_MODE=(off|report|apply)$/m.exec(text)?.[1];
  const password = new RegExp(
    `^EDGE_DATABASE_URL=postgresql://${MENU_SYNC_ROLE}:([a-f0-9]{64})@127\\.0\\.0\\.1:55433/pickchick_edge$`,
    'm',
  ).exec(text)?.[1];
  if (!mode || !password || text !== menuSyncEnvText({ password, branchId, deviceId, mode }))
    throw new Error('Existing menu sync environment differs; it was not overwritten');
  return { password, mode };
}

/** Pre-hashed SCRAM verifier: the plaintext password never reaches PostgreSQL. */
export function scramVerifier(password, salt = randomBytes(16)) {
  if (!/^[a-f0-9]{64}$/.test(password ?? '') || salt.length !== 16)
    throw new Error('Invalid SCRAM input');
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const stored = createHash('sha256')
    .update(createHmac('sha256', salted).update('Client Key').digest())
    .digest('base64');
  const server = createHmac('sha256', salted).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
}

/**
 * Creates the login role when it is missing (CREATEROLE connection). An existing role is only
 * verified: its password is never reset and its attributes must already be restricted.
 */
export async function ensureMenuSyncRole(admin, { role = MENU_SYNC_ROLE, password }) {
  const target = identifier(role);
  const read = async () =>
    (
      await admin.query(
        `SELECT r.oid,r.rolcanlogin,r.rolinherit,r.rolsuper,r.rolcreatedb,r.rolcreaterole,
          r.rolreplication,r.rolbypassrls,r.rolconnlimit,r.rolvaliduntil,
          EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS membership,
          EXISTS(SELECT 1 FROM pg_db_role_setting s WHERE s.setrole=r.oid) AS settings
         FROM pg_roles r WHERE r.rolname=$1`,
        [role],
      )
    ).rows[0];
  let row = await read(),
    created = false;
  if (!row) {
    await admin.query(
      `CREATE ROLE ${target} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${scramVerifier(password)}'`,
    );
    row = await read();
    created = true;
  }
  if (
    !row ||
    !row.rolcanlogin ||
    row.rolinherit ||
    row.rolsuper ||
    row.rolcreatedb ||
    row.rolcreaterole ||
    row.rolreplication ||
    row.rolbypassrls ||
    row.rolconnlimit !== -1 ||
    row.rolvaliduntil ||
    row.membership ||
    row.settings
  )
    throw new Error('Existing menu sync role differs; credentials were not reset');
  return { role, created };
}

async function fingerprint(client, schema, tables) {
  const ns = identifier(schema);
  const rows = {};
  for (const table of tables)
    rows[table] = (
      await client.query(
        `SELECT count(*)::text AS count,md5(COALESCE(string_agg(h,'' ORDER BY h),'')) AS hash
         FROM (SELECT md5(to_jsonb(t)::text) h FROM ${ns}.${identifier(table)} t) r`,
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

/** Table and column ACL entries per grantee role name, for delta checks. The owner's own
 * implicit privileges are left out: the first GRANT on a new table materializes them. */
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

const sorted = (values) => [...new Set(values)].sort();

export async function upgradeMenuSync(
  client,
  {
    mode,
    appRoot,
    branchId,
    deviceId,
    backup,
    now = new Date(),
    schema = 'public',
    role = MENU_SYNC_ROLE,
    runtimeRole = 'pickchick_edge_runtime',
    databaseDefaultsRevoked = true,
  },
) {
  if (
    !['inspect', 'apply'].includes(mode) ||
    !uuid.test(branchId ?? '') ||
    !uuid.test(deviceId ?? '') ||
    role === runtimeRole
  )
    throw new Error('Invalid menu sync upgrade scope');
  const ns = identifier(schema);
  identifier(role);
  identifier(runtimeRole);
  const expected = await readExpectedMigrations(appRoot);
  await client.query(
    mode === 'apply' ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  );
  try {
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('SET LOCAL search_path TO ' + ns);
    if (mode === 'apply')
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('pickchick-menu-sync-018',0))",
      );
    const tables = (
      await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [
        schema,
      ])
    ).rows.map((row) => row.tablename);
    if (!tables.includes('schema_migrations')) throw new Error('Missing edge schema');
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
    if (ledger.length < 17 || ledgerText(ledger) !== ledgerText(expected.slice(0, ledger.length)))
      throw new Error('Edge migration ledger differs; schema017 from this release is required');
    const pending = ledger.length === 17;
    const branches = (await client.query('SELECT id FROM branch_config')).rows;
    if (branches.length !== 1 || branches[0].id !== branchId) throw new Error('Branch differs');
    // The worker uses the fulfillment worker's device identity; routing needs its config.
    const binding = (
      await client.query('SELECT device_id FROM fulfillment_config WHERE branch_id=$1', [branchId])
    ).rows;
    if (binding.length !== 1 || binding[0].device_id !== deviceId)
      throw new Error('Device differs from the fulfillment binding');
    const backupProof = assertFreshBackup(backup, { branchId, ledger, now });
    const roles = (
      await client.query(
        `SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
         FROM pg_roles WHERE rolname=ANY($1)`,
        [[role, runtimeRole]],
      )
    ).rows;
    const runtime = roles.find((row) => row.rolname === runtimeRole);
    const worker = roles.find((row) => row.rolname === role);
    if (
      !runtime ||
      roles.some(
        (row) =>
          row.rolsuper ||
          row.rolcreatedb ||
          row.rolcreaterole ||
          row.rolreplication ||
          row.rolbypassrls,
      )
    )
      throw new Error('Restricted existing runtime role required');
    if (mode === 'apply' && !worker) throw new Error('Menu sync login role must exist first');
    const existing = tables.filter((table) => table !== 'schema_migrations');
    const before = await fingerprint(client, schema, existing);
    let migrationApplied = false,
      grantsVerified = false;
    if (mode === 'apply') {
      const otherAcl = (entries) =>
        sorted(entries.filter((entry) => !entry.startsWith(`${role}|`)));
      const aclBefore = await aclEntries(client, schema);
      if (pending) {
        await client.query(
          await readFile(join(appRoot, 'db', 'edge', 'migrations', MENU_SYNC_MIGRATION), 'utf8'),
        );
        await client.query(
          'INSERT INTO schema_migrations(scope,version,checksum) VALUES($1,$2,$3)',
          ['edge', MENU_SYNC_MIGRATION, expected[17].checksum],
        );
        migrationApplied = true;
      }
      await client.query(
        `GRANT CONNECT ON DATABASE ${identifier(
          (await client.query('SELECT current_database() AS name')).rows[0].name,
        )} TO ${identifier(role)}`,
      );
      await revokeMenuSyncPrivileges(client, role, schema);
      await client.query(menuSyncWorkerGrants(role, schema));
      await client.query(`GRANT SELECT ON ${ns}."menu_media" TO ${identifier(runtimeRole)}`);
      await assertMenuSyncPrivileges(client, role, schema, { databaseDefaultsRevoked });
      grantsVerified = true;
      // Only the worker's grants and the runtime's menu_media SELECT may change.
      const allowed = sorted([...otherAcl(aclBefore), `${runtimeRole}|menu_media||SELECT`]);
      if (JSON.stringify(otherAcl(await aclEntries(client, schema))) !== JSON.stringify(allowed))
        throw new Error('Unexpected privilege change for another role');
      const runtimeRights = (
        await client.query(
          `SELECT has_table_privilege($1,'menu_media','SELECT') AS media_read,
            has_table_privilege($1,'menu_media','INSERT,UPDATE,DELETE,TRUNCATE') AS media_write,
            has_any_column_privilege($1,'menu_apply_results','SELECT,INSERT,UPDATE') AS results`,
          [runtimeRole],
        )
      ).rows[0];
      if (!runtimeRights.media_read || runtimeRights.media_write || runtimeRights.results)
        throw new Error('Edge runtime menu media rights differ');
      if ((await fingerprint(client, schema, existing)) !== before)
        throw new Error('Existing business rows or sequences changed');
    } else if (worker && !pending) {
      try {
        await assertMenuSyncPrivileges(client, role, schema, { databaseDefaultsRevoked });
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
      roleExists: Boolean(worker),
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

/** Same contract as native-foundation-db.mjs validateCredentials (not shipped in the runtime). */
export function foundationCredentials(value, branchId) {
  const passwords = value?.passwords;
  if (
    !value ||
    value.format !== 'pickchick-native-secrets-v1' ||
    value.branchId !== branchId ||
    !uuid.test(value.installId ?? '') ||
    !passwords ||
    Object.keys(passwords).sort().join(',') !==
      'pickchick_bootstrap,pickchick_edge_owner,pickchick_edge_runtime' ||
    Object.values(passwords).some((password) => !/^[a-f0-9]{64}$/.test(password)) ||
    new Set(Object.values(passwords)).size !== 3
  )
    throw new Error('Invalid private setup credential');
  return value;
}

async function readSmallJson(path, limit) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
    throw new Error('Unsafe operator file');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main() {
  const [mode, toolsRoot, appRoot, branchId, deviceId, backupPath, envPath, ...extra] =
    process.argv.slice(2);
  const absolute = (path) => win32.isAbsolute(path ?? '') || posix.isAbsolute(path ?? '');
  if (
    extra.length ||
    !['inspect', 'apply'].includes(mode) ||
    ![toolsRoot, appRoot, backupPath, envPath].every(absolute) ||
    win32.basename(envPath) !== MENU_SYNC_ENV_FILE ||
    !uuid.test(branchId ?? '') ||
    !uuid.test(deviceId ?? '')
  )
    throw new Error('Invalid menu sync upgrade invocation');
  const credentials = foundationCredentials(
    await readSmallJson(join(toolsRoot, 'private', 'foundation-credentials.json'), 10000),
    branchId,
  );
  const backup = await readSmallJson(backupPath, 1_000_000);
  const { Client } = createRequire(join(resolve(toolsRoot), 'package.json'))('pg');
  const base = {
    host: '127.0.0.1',
    port: 55433,
    ssl: false,
    connectionTimeoutMillis: 3000,
    statement_timeout: 60000,
    application_name: 'pickchick-menu-sync-setup',
  };
  const connect = async (options) => {
    const client = new Client({ ...base, ...options });
    client.on('error', () => {});
    await client.connect();
    return client;
  };
  const scope = { appRoot, branchId, deviceId, backup };
  const owner = await connect({
    database: 'pickchick_edge',
    user: 'pickchick_edge_owner',
    password: credentials.passwords.pickchick_edge_owner,
  });
  let admin, worker;
  try {
    const inspected = await upgradeMenuSync(owner, { ...scope, mode: 'inspect' });
    if (mode === 'inspect') {
      console.log(JSON.stringify(inspected));
      return;
    }
    let password,
      envFile = 'existing';
    try {
      ({ password } = parseMenuSyncEnv(await readFile(envPath, 'utf8'), { branchId, deviceId }));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (inspected.roleExists)
        throw new Error('Existing role without its private environment; credentials not reset', {
          cause: error,
        });
      password = randomBytes(32).toString('hex');
      // The installer pre-creates the directory with its protected NTFS ACL; never overwrite.
      await writeFile(envPath, menuSyncEnvText({ password, branchId, deviceId }), {
        flag: 'wx',
        mode: 0o600,
      });
      envFile = 'written';
    }
    admin = await connect({
      database: 'postgres',
      user: 'pickchick_bootstrap',
      password: credentials.passwords.pickchick_bootstrap,
    });
    const { created } = await ensureMenuSyncRole(admin, { password });
    const applied = await upgradeMenuSync(owner, { ...scope, mode: 'apply' });
    worker = await connect({ database: 'pickchick_edge', user: MENU_SYNC_ROLE, password });
    const login = (await worker.query('SELECT current_user AS role')).rows[0].role;
    await worker.query('SELECT 1 FROM menu_snapshots LIMIT 0');
    await worker.query('SELECT 1 FROM menu_media LIMIT 0');
    if (login !== MENU_SYNC_ROLE) throw new Error('Menu sync login differs');
    console.log(JSON.stringify({ ...applied, roleCreated: created, envFile, loginVerified: true }));
  } finally {
    await Promise.allSettled([worker?.end(), admin?.end(), owner.end()]);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error(
      JSON.stringify({ event: 'menu_sync_upgrade_failed', detail: 'Inspect protected state.' }),
    );
    process.exitCode = 1;
  });
