import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKUP_ROLE,
  CONFIG_FORMAT,
  backupCredential,
  backupLayout,
  createBackupKey,
  isUncPath,
  isWindowsDrivePath,
  parseBackupCredential,
  parseBackupKey,
  parseEdgeBackupConfig,
  verifiedSchema,
  writeFileAtomic,
} from './edge-backup-lib.mjs';

/**
 * Operator setup for the scheduled cashier backup, run by install-edge-backup.ps1 as an elevated
 * administrator with the protected foundation credentials of EdgeTools.
 *
 * - plan: read-only. Reports what install would create; nothing is written or granted.
 * - install: archive key (created once, never replaced), dedicated login role
 *   pickchick_edge_backup with a generated password in a protected file (created once; an existing
 *   role is verified, its password is never reset), CONNECT on pickchick_edge and membership in
 *   pg_read_all_data (INHERIT TRUE, SET FALSE), an exact privilege proof, a real login as the role
 *   at a reviewed schema and the matching branch, then the task configuration (replaced
 *   atomically, so a destination or retention change is a re-run of install).
 * - remove-role / plan-remove: drops only that role (revoking its grants); keys, copies and
 *   configuration are kept.
 * Passwords never enter arguments, SQL text (SCRAM verifier only) or output.
 */
export { BACKUP_ROLE };
export const BACKUP_CONNECTION_LIMIT = 3;
const ROLE = '"' + BACKUP_ROLE + '"';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const quoteName = (value) => {
  if (typeof value !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(value))
    throw new Error('Invalid identifier');
  return '"' + value + '"';
};

/** Pre-hashed SCRAM verifier: the plaintext password never reaches PostgreSQL. */
export function scramVerifier(password, salt = randomBytes(16)) {
  if (typeof password !== 'string' || !/^[a-f0-9]{64}$/.test(password) || salt.length !== 16)
    throw new Error('Invalid SCRAM input');
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const stored = createHash('sha256')
    .update(createHmac('sha256', salted).update('Client Key').digest())
    .digest('base64');
  const server = createHmac('sha256', salted).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
}

export async function readBackupRole(client) {
  return (
    (
      await client.query(
        `SELECT r.oid,r.rolcanlogin,r.rolinherit,r.rolsuper,r.rolcreatedb,r.rolcreaterole,
          r.rolreplication,r.rolbypassrls,r.rolconnlimit,r.rolvaliduntil,
          EXISTS(SELECT 1 FROM pg_db_role_setting s WHERE s.setrole=r.oid) AS settings,
          EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.roleid=r.oid) AS has_members,
          COALESCE((SELECT json_agg(json_build_object('role',g.rolname,'inherit',m.inherit_option,
            'set',m.set_option,'admin',m.admin_option) ORDER BY g.rolname)
            FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid WHERE m.member=r.oid),'[]'::json)
            AS memberships
         FROM pg_roles r WHERE r.rolname=$1`,
        [BACKUP_ROLE],
      )
    ).rows[0] ?? null
  );
}

/** Login role without any attribute beyond LOGIN; membership only pg_read_all_data. */
function restricted(row, { granted }) {
  const memberships = row.memberships ?? [];
  const reader = (m) => m.role === 'pg_read_all_data' && m.inherit === true && m.set === false;
  return (
    row.rolcanlogin === true &&
    row.rolinherit === false &&
    !row.rolsuper &&
    !row.rolcreatedb &&
    !row.rolcreaterole &&
    !row.rolreplication &&
    !row.rolbypassrls &&
    row.rolconnlimit === BACKUP_CONNECTION_LIMIT &&
    row.rolvaliduntil === null &&
    !row.settings &&
    !row.has_members &&
    memberships.every((m) => reader(m) && m.admin === false) &&
    (!granted || memberships.length === 1)
  );
}

/**
 * Creates the role when it is missing (superuser/CREATEROLE connection). An existing role is only
 * verified: its password is never reset and its attributes must already be restricted.
 */
export async function ensureBackupRole(admin, { password }) {
  let row = await readBackupRole(admin);
  let created = false;
  if (!row) {
    await admin.query(
      `CREATE ROLE ${ROLE} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${BACKUP_CONNECTION_LIMIT} PASSWORD '${scramVerifier(password)}'`,
    );
    row = await readBackupRole(admin);
    created = true;
  }
  if (!row || !restricted(row, { granted: false }))
    throw new Error('Existing backup role differs; credentials were not reset');
  return { created };
}

/** CONNECT on the edge database and read-only data access; no table ACL is changed. */
export async function grantBackupAccess(admin, { database }) {
  await admin.query(`GRANT CONNECT ON DATABASE ${quoteName(database)} TO ${ROLE}`);
  await admin.query(`GRANT pg_read_all_data TO ${ROLE} WITH INHERIT TRUE, SET FALSE`);
}

/**
 * Proves the role reads every relation of the schema and can change nothing: no write, sequence
 * advance, CREATE, owned object, extra membership, SECURITY DEFINER function or (when the
 * foundation revoked PUBLIC defaults) TEMP. Throws without naming secrets.
 */
export async function assertBackupPrivileges(
  client,
  { schema = 'public', databaseDefaultsRevoked = true } = {},
) {
  const row = await readBackupRole(client);
  if (!row || !restricted(row, { granted: true })) throw new Error('Backup role differs');
  if (
    (
      await client.query(
        `SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=$1 AND deptype='o' LIMIT 1`,
        [row.oid],
      )
    ).rowCount
  )
    throw new Error('Backup role owns objects');
  const database = (
    await client.query(
      `SELECT has_database_privilege($1,current_database(),'CONNECT') AS connect,
        has_database_privilege($1,current_database(),'CREATE') AS create,
        has_database_privilege($1,current_database(),'TEMP') AS temp,
        has_schema_privilege($1,$2,'USAGE') AS usage,
        has_schema_privilege($1,$2,'CREATE') AS schema_create`,
      [BACKUP_ROLE, schema],
    )
  ).rows[0];
  if (
    !database.connect ||
    database.create ||
    (databaseDefaultsRevoked && database.temp) ||
    !database.usage ||
    database.schema_create
  )
    throw new Error('Backup database privileges differ');
  const relations = (
    await client.query(
      `SELECT c.relkind,has_table_privilege($1,c.oid,'SELECT') AS read,
        CASE WHEN c.relkind='S' THEN has_sequence_privilege($1,c.oid,'USAGE,UPDATE')
          ELSE has_table_privilege($1,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_any_column_privilege($1,c.oid,'INSERT,UPDATE,REFERENCES') END AS write
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$2 AND c.relkind IN ('r','p','v','m','f','S')`,
      [BACKUP_ROLE, schema],
    )
  ).rows;
  if (
    !relations.some((relation) => relation.relkind === 'r') ||
    relations.some((relation) => !relation.read || relation.write)
  )
    throw new Error('Backup table privileges differ');
  const definers = (
    await client.query(
      `SELECT has_function_privilege($1,p.oid,'EXECUTE') AS execute
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$2 AND p.prosecdef`,
      [BACKUP_ROLE, schema],
    )
  ).rows;
  if (definers.some((definer) => definer.execute))
    throw new Error('Backup role may run owner functions');
  return { relations: relations.length, ownerFunctionsClosed: definers.length };
}

/** Drops only the dedicated role after revoking its two grants. Copies and keys stay. */
export async function removeBackupRole(admin, { database, dryRun = false }) {
  const row = await readBackupRole(admin);
  if (!row) return { removed: false, existed: false };
  if (row.rolsuper || row.has_members) throw new Error('Backup role differs; not removed');
  if (dryRun) return { removed: false, existed: true };
  if (row.memberships.length) await admin.query(`REVOKE pg_read_all_data FROM ${ROLE}`);
  await admin.query(`REVOKE ALL ON DATABASE ${quoteName(database)} FROM ${ROLE}`);
  await admin.query(`DROP ROLE ${ROLE}`);
  return { removed: true, existed: true };
}

async function readJsonIfPresent(path, limit) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error('Private backup file is unreadable', { cause: error });
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
    throw new Error('Private backup file is unsafe');
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('Private backup file is unreadable');
  }
}

async function writeExclusive(path, text) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The archive key is created once. Replacing it would orphan every existing copy. */
export async function prepareKey(path, { dryRun = false, now = new Date() } = {}) {
  const existing = await readJsonIfPresent(path, 4096);
  if (existing !== undefined) return { keyId: parseBackupKey(existing).keyId, created: false };
  if (dryRun) return { keyId: null, created: true };
  const key = createBackupKey(now);
  await writeExclusive(path, JSON.stringify(key, null, 2) + '\n');
  return { keyId: key.keyId, created: true };
}

/** The role password is generated once; an existing role without its file is not reset. */
export async function prepareCredential(path, { roleExists, dryRun = false }) {
  const existing = await readJsonIfPresent(path, 4096);
  if (existing !== undefined)
    return { password: parseBackupCredential(existing).password, written: false, existed: true };
  if (roleExists)
    throw new Error('Existing backup role without its private credential; credentials not reset');
  const password = randomBytes(32).toString('hex');
  if (!dryRun)
    await writeExclusive(path, JSON.stringify(backupCredential(password), null, 2) + '\n');
  return { password, written: !dryRun, existed: false };
}

/** The task configuration (validated exactly as the task will read it). */
export function buildBackupConfig({
  stateRoot,
  toolsRoot,
  pgBin,
  branchId,
  systemIdentifier,
  destination,
  hourly,
  daily,
  maxAgeMinutes,
  reportInHeartbeat,
  timeZone,
}) {
  return parseEdgeBackupConfig({
    format: CONFIG_FORMAT,
    branchId,
    systemIdentifier,
    stateRoot,
    toolsRoot,
    pgBin,
    maintenanceLock: win32.join(win32.dirname(toolsRoot), 'unified-menu-maintenance.lock'),
    destination,
    retention: { hourly, daily },
    timeZone,
    maxAgeMinutes,
    reportInHeartbeat,
  });
}

/**
 * Logs in as the backup role and reads what a run needs: cluster identity, a reviewed ledger and
 * the one configured branch. Returns the reviewed schema name and the branch time zone.
 */
export async function verifyBackupLogin(
  backup,
  { branchId, systemIdentifier, pinned, schema = 'public' },
) {
  const ns = quoteName(schema);
  const who = (await backup.query('SELECT current_user AS role')).rows[0].role;
  const cluster = (
    await backup.query('SELECT system_identifier::text AS id FROM pg_control_system()')
  ).rows[0].id;
  if (who !== BACKUP_ROLE || cluster !== systemIdentifier)
    throw new Error('Backup login reached a different role or cluster');
  const ledger = (
    await backup.query(
      `SELECT version,checksum,scope FROM ${ns}.schema_migrations ORDER BY version`,
    )
  ).rows;
  const reviewed = verifiedSchema(ledger, pinned);
  const branches = (await backup.query(`SELECT id,timezone FROM ${ns}.branch_config`)).rows;
  if (branches.length !== 1 || branches[0].id !== branchId)
    throw new Error('Backup login sees a different branch');
  return { schema: reviewed, timeZone: branches[0].timezone };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (['install', 'plan'].includes(command)) {
    const [stateRoot, toolsRoot, pgBin, branchId, destination, hourly, daily, maxAge, report] =
      rest;
    if (
      rest.length !== 9 ||
      ![stateRoot, toolsRoot, pgBin].every(isWindowsDrivePath) ||
      !(isWindowsDrivePath(destination) || isUncPath(destination)) ||
      !uuid.test(branchId ?? '') ||
      ![hourly, daily, maxAge].every((value) => /^[1-9][0-9]{0,3}$/.test(value)) ||
      !['true', 'false'].includes(report)
    )
      throw new Error('Invalid edge backup setup invocation');
    return {
      command,
      stateRoot,
      toolsRoot,
      pgBin,
      branchId,
      destination,
      hourly: Number(hourly),
      daily: Number(daily),
      maxAgeMinutes: Number(maxAge),
      reportInHeartbeat: report === 'true',
    };
  }
  if (['remove-role', 'plan-remove'].includes(command)) {
    const [toolsRoot, branchId] = rest;
    if (rest.length !== 2 || !isWindowsDrivePath(toolsRoot) || !uuid.test(branchId ?? ''))
      throw new Error('Invalid edge backup setup invocation');
    return { command, toolsRoot, branchId };
  }
  throw new Error('Invalid edge backup setup invocation');
}

/** Same contract as native-foundation-db.mjs validateCredentials and the foundation state. */
export function foundationBinding(state, credentials, branchId) {
  const passwords = credentials?.passwords;
  if (
    state?.format !== 'pickchick-native-state-v1' ||
    state.complete !== true ||
    state.branchId !== branchId ||
    typeof state.systemIdentifier !== 'string' ||
    !/^\d{10,20}$/.test(state.systemIdentifier) ||
    credentials?.format !== 'pickchick-native-secrets-v1' ||
    credentials.branchId !== branchId ||
    credentials.installId !== state.installId ||
    !passwords ||
    Object.keys(passwords).sort().join(',') !==
      'pickchick_bootstrap,pickchick_edge_owner,pickchick_edge_runtime' ||
    Object.values(passwords).some((password) => !/^[a-f0-9]{64}$/.test(password))
  )
    throw new Error('Completed matching native foundation required');
  return { systemIdentifier: state.systemIdentifier, bootstrap: passwords.pickchick_bootstrap };
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows operator invocation required');
  const args = parseArgs(process.argv.slice(2));
  const read = async (name) => {
    const value = await readJsonIfPresent(win32.join(args.toolsRoot, 'private', name), 10000);
    if (value === undefined) throw new Error('Foundation record missing');
    return value;
  };
  const foundation = foundationBinding(
    await read('foundation-state.json'),
    await read('foundation-credentials.json'),
    args.branchId,
  );
  const { Client } = createRequire(win32.join(args.toolsRoot, 'package.json'))('pg');
  const base = {
    host: '127.0.0.1',
    port: 55433,
    database: 'pickchick_edge',
    ssl: false,
    connectionTimeoutMillis: 5000,
    statement_timeout: 60000,
    application_name: 'pickchick-edge-backup-setup',
  };
  const connect = async (options) => {
    const client = new Client({ ...base, ...options });
    client.on('error', () => undefined);
    await client.connect();
    return client;
  };
  const admin = await connect({
    user: 'pickchick_bootstrap',
    password: foundation.bootstrap,
  });
  let backup;
  try {
    const dryRun = args.command.startsWith('plan');
    if (args.command === 'remove-role' || args.command === 'plan-remove') {
      console.log(
        JSON.stringify({
          mode: args.command,
          ...(await removeBackupRole(admin, { database: 'pickchick_edge', dryRun })),
        }),
      );
      return;
    }
    const pinned = JSON.parse(
      await readFile(new URL('./native-edge-backup-ledger.json', import.meta.url), 'utf8'),
    );
    const layout = backupLayout(args.stateRoot);
    // The configuration is validated before any key or password file is created.
    const zone = (
      await admin.query('SELECT timezone FROM branch_config WHERE id=$1', [args.branchId])
    ).rows[0]?.timezone;
    const config = buildBackupConfig({
      ...args,
      systemIdentifier: foundation.systemIdentifier,
      timeZone: zone,
    });
    const roleExists = Boolean(await readBackupRole(admin));
    const key = await prepareKey(layout.keyFile, { dryRun });
    const credential = await prepareCredential(layout.credentialFile, { roleExists, dryRun });
    if (dryRun) {
      const ledger = (
        await admin.query('SELECT version,checksum,scope FROM schema_migrations ORDER BY version')
      ).rows;
      console.log(
        JSON.stringify({
          mode: 'plan',
          changed: false,
          roleExists,
          keyExists: !key.created,
          keyId: key.keyId,
          credentialExists: credential.existed,
          // Install refuses an unreviewed schema; the plan names it instead of failing.
          schema: (() => {
            try {
              return verifiedSchema(ledger, pinned);
            } catch {
              return 'UNREVIEWED';
            }
          })(),
          destination: config.destination,
          retention: config.retention,
          timeZone: config.timeZone,
          maxAgeMinutes: config.maxAgeMinutes,
          reportInHeartbeat: config.reportInHeartbeat,
        }),
      );
      return;
    }
    const { created } = await ensureBackupRole(admin, { password: credential.password });
    await grantBackupAccess(admin, { database: 'pickchick_edge' });
    const proof = await assertBackupPrivileges(admin);
    backup = await connect({ user: BACKUP_ROLE, password: credential.password });
    const login = await verifyBackupLogin(backup, {
      branchId: args.branchId,
      systemIdentifier: foundation.systemIdentifier,
      pinned,
    });
    await writeFileAtomic(
      win32.join(args.stateRoot, 'private', 'edge-backup.json'),
      JSON.stringify(config, null, 2) + '\n',
    );
    console.log(
      JSON.stringify({
        mode: 'install',
        keyId: key.keyId,
        keyCreated: key.created,
        roleCreated: created,
        credentialWritten: credential.written,
        grantsVerified: true,
        relations: proof.relations,
        loginVerified: true,
        schema: login.schema,
        configWritten: true,
        destination: config.destination,
        retention: config.retention,
        timeZone: config.timeZone,
        maxAgeMinutes: config.maxAgeMinutes,
        reportInHeartbeat: config.reportInHeartbeat,
      }),
    );
  } finally {
    await Promise.allSettled([backup?.end(), admin.end()]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error(
      JSON.stringify({ event: 'edge_backup_setup_failed', detail: 'Inspect protected state.' }),
    );
    process.exitCode = 1;
  });
