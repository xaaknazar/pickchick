import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateCredentials } from './native-foundation-db.mjs';
import { posSyncWorkerGrants } from './pos-sync-worker-grants.mjs';

export const syncRole = 'pickchick_pos_sync';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function validateSyncSecret(secret, foundation) {
  validateCredentials(foundation, foundation.branchId);
  if (
    !secret ||
    Object.keys(secret).sort().join(',') !== 'branchId,format,installId,password,syncInstallId' ||
    secret.format !== 'pickchick-pos-sync-secrets-v1' ||
    secret.installId !== foundation.installId ||
    secret.branchId !== foundation.branchId ||
    !uuid.test(secret.syncInstallId) ||
    !/^[a-f0-9]{64}$/.test(secret.password) ||
    Object.values(foundation.passwords).includes(secret.password)
  )
    throw new Error('Private sync setup binding differs');
  return secret;
}
export function syncVerifier(secret) {
  if (!/^[a-f0-9]{64}$/.test(secret.password) || !uuid.test(secret.syncInstallId))
    throw new Error('Invalid SCRAM input');
  const salt = createHash('sha256')
    .update(`${secret.syncInstallId}:${syncRole}`)
    .digest()
    .subarray(0, 16);
  const salted = pbkdf2Sync(secret.password, salt, 4096, 32, 'sha256');
  const stored = createHash('sha256')
    .update(createHmac('sha256', salted).update('Client Key').digest())
    .digest('base64');
  const server = createHmac('sha256', salted).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
}
const updateColumns = {
  pos_order_sync_state:
    'lease_token,lease_until,pending_event_id,pending_envelope,pending_hash,failure_count,retry_after,last_error',
  pos_kitchen_sync_state:
    'lease_token,lease_until,pending_event_id,pending_envelope,pending_hash,failure_count,retry_after,last_error,dead_lettered_at',
  outbox_events: 'attempts,acknowledged_at',
  fulfillment_outbox: 'attempts,acknowledged_at',
};
async function assertRights(owner, requireGranted) {
  const relations = (
    await owner.query(
      `SELECT c.oid,c.relname,c.relkind,
    has_table_privilege($1,c.oid,'SELECT') AS sel,
    has_table_privilege($1,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS writes
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')`,
      [syncRole],
    )
  ).rows;
  for (const relation of relations) {
    const allowed = updateColumns[relation.relname];
    if (
      relation.writes ||
      (relation.sel && !allowed) ||
      (requireGranted && allowed && !relation.sel)
    )
      throw new Error('Sync role table privileges differ');
    const columns = (
      await owner.query(
        `SELECT attname,
      has_column_privilege($1,attrelid,attnum,'SELECT') AS sel,
      has_column_privilege($1,attrelid,attnum,'UPDATE') AS upd,
      has_column_privilege($1,attrelid,attnum,'INSERT,REFERENCES') AS extra
      FROM pg_attribute WHERE attrelid=$2 AND attnum>0 AND NOT attisdropped`,
        [syncRole, relation.oid],
      )
    ).rows;
    for (const column of columns) {
      const update = allowed?.split(',').includes(column.attname) ?? false;
      if (
        column.extra ||
        (column.sel && !allowed) ||
        (column.upd && !update) ||
        (requireGranted && update && !column.upd)
      )
        throw new Error('Sync role column privileges differ');
    }
  }
  if (
    requireGranted &&
    Object.keys(updateColumns).some((name) => !relations.some((r) => r.relname === name))
  )
    throw new Error('Sync migrations missing');
  const invalid = (
    await owner.query(
      `SELECT
    has_schema_privilege($1,'public','CREATE') OR has_database_privilege($1,current_database(),'CREATE,TEMP')
    OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND CASE WHEN c.relkind='S' THEN has_sequence_privilege($1,c.oid,'USAGE,SELECT,UPDATE') ELSE false END)
    OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND has_function_privilege($1,p.oid,'EXECUTE')) AS invalid`,
      [syncRole],
    )
  ).rows[0];
  if (invalid.invalid) throw new Error('Sync role exceeds reviewed rights');
}
// CREATE ROLE is the only bootstrap mutation. All schema grants and explicit
// binding use the existing owner; the running service receives only syncRole.
export async function configureSyncDatabase(Client, foundation, secret, options) {
  validateSyncSecret(secret, foundation);
  const { mode, pgData, systemIdentifier, port = 55433, bind } = options;
  if (
    !['prepare', 'verify', 'bind'].includes(mode) ||
    !/^\d{10,20}$/.test(systemIdentifier) ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !pgData
  )
    throw new Error('Invalid sync database invocation');
  const base = {
    host: '127.0.0.1',
    port,
    ssl: false,
    database: 'pickchick_edge',
    connectionTimeoutMillis: 3000,
    statement_timeout: 30000,
    application_name: 'pickchick-pos-sync-setup',
  };
  const admin = new Client({
    ...base,
    database: 'postgres',
    user: 'pickchick_bootstrap',
    password: foundation.passwords.pickchick_bootstrap,
  });
  let owner, worker;
  admin.on('error', () => {});
  try {
    await admin.connect();
    const server = (
      await admin.query(`SELECT current_setting('server_version_num')::int AS version,
      current_setting('data_directory') AS directory,current_setting('data_checksums') AS checksums,
      current_setting('server_encoding') AS encoding,current_setting('listen_addresses') AS listen,
      current_setting('password_encryption') AS encryption,inet_server_port() AS port,
      (SELECT system_identifier::text FROM pg_control_system()) AS system_id`)
    ).rows[0];
    if (
      server.system_id !== systemIdentifier ||
      server.version < 180006 ||
      server.version >= 190000 ||
      server.checksums !== 'on' ||
      server.encoding !== 'UTF8' ||
      server.listen !== '127.0.0.1' ||
      server.port !== port ||
      server.encryption !== 'scram-sha-256' ||
      server.directory.replaceAll('\\', '/').toLowerCase() !==
        pgData.replaceAll('\\', '/').toLowerCase()
    )
      throw new Error('PostgreSQL cluster identity or settings differ');
    const database = (
      await admin.query(
        "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname='pickchick_edge'",
      )
    ).rows[0];
    if (database?.owner !== 'pickchick_edge_owner') throw new Error('Edge database owner differs');
    const verifier = syncVerifier(secret);
    let row = (await admin.query('SELECT * FROM pg_authid WHERE rolname=$1', [syncRole])).rows[0];
    if (!row && mode === 'prepare') {
      await admin.query(
        `CREATE ROLE ${syncRole} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${verifier}'`,
      );
      row = (await admin.query('SELECT * FROM pg_authid WHERE rolname=$1', [syncRole])).rows[0];
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
      row.rolpassword !== verifier ||
      row.rolconnlimit !== -1 ||
      row.rolvaliduntil
    )
      throw new Error('Existing sync role differs; credentials were not reset');
    if (
      (await admin.query('SELECT 1 FROM pg_db_role_setting WHERE setrole=$1', [row.oid]))
        .rowCount ||
      (await admin.query('SELECT 1 FROM pg_auth_members WHERE member=$1 OR roleid=$1', [row.oid]))
        .rowCount ||
      (
        await admin.query(
          "SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=$1 AND deptype='o'",
          [row.oid],
        )
      ).rowCount
    )
      throw new Error('Sync role has unexpected membership or ownership');
    if (
      (
        await admin.query(
          "SELECT 1 FROM pg_database WHERE datallowconn AND datname <> 'pickchick_edge' AND has_database_privilege($1,oid,'CONNECT')",
          [syncRole],
        )
      ).rowCount
    )
      throw new Error('Sync role can connect outside its dedicated database');
    owner = new Client({
      ...base,
      user: 'pickchick_edge_owner',
      password: foundation.passwords.pickchick_edge_owner,
    });
    owner.on('error', () => {});
    await owner.connect();
    const ledger = (
      await owner.query('SELECT version,scope FROM schema_migrations ORDER BY version')
    ).rows;
    if (
      ledger.length < 13 ||
      ledger.some(
        (r, i) => r.scope !== 'edge' || !r.version.startsWith(String(i + 1).padStart(3, '0') + '_'),
      )
    )
      throw new Error('Edge migrations 001 through 013 are required');
    const branches = (await owner.query('SELECT id FROM branch_config')).rows;
    if (branches.length !== 1 || branches[0].id !== secret.branchId)
      throw new Error('Local branch binding differs');
    await assertRights(owner, false);
    if (mode === 'prepare') {
      await owner.query('BEGIN');
      try {
        await owner.query(
          `GRANT CONNECT ON DATABASE pickchick_edge TO ${syncRole};\n${posSyncWorkerGrants(syncRole)}`,
        );
        await assertRights(owner, true);
        await owner.query('COMMIT');
      } catch (error) {
        await owner.query('ROLLBACK');
        throw error;
      }
    } else await assertRights(owner, true);
    worker = new Client({ ...base, user: syncRole, password: secret.password });
    worker.on('error', () => {});
    await worker.connect();
    for (const table of Object.keys(updateColumns))
      await worker.query(`SELECT * FROM ${table} LIMIT 0`);
    let scope;
    if (mode === 'bind') {
      if (typeof bind !== 'function') throw new Error('Binding implementation is required');
      scope = await bind({
        ...base,
        user: 'pickchick_edge_owner',
        password: foundation.passwords.pickchick_edge_owner,
      });
      if (scope.branchId !== secret.branchId) throw new Error('Binding result differs');
    }
    return {
      format: 'pickchick-pos-sync-database-v1',
      branchId: secret.branchId,
      role: syncRole,
      verified: true,
      ...(scope ? { scope } : {}),
    };
  } finally {
    await Promise.allSettled([worker?.end(), owner?.end(), admin.end()]);
  }
}
async function readJson(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16384)
    throw new Error('Unsafe operator file');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function main() {
  const [
    mode,
    runtimeRoot,
    foundationPrivate,
    syncPrivate,
    pgData,
    systemIdentifier,
    bindingPath,
    ...extra
  ] = process.argv.slice(2);
  if (extra.length || !systemIdentifier || (mode === 'bind') !== Boolean(bindingPath))
    throw new Error('Invalid arguments');
  const require = createRequire(join(resolve(runtimeRoot), 'package.json'));
  const { Client, Pool } = createRequire(require.resolve('@pickchick/database'))('pg');
  const foundation = await readJson(join(foundationPrivate, 'foundation-credentials.json'));
  const secret = await readJson(join(syncPrivate, 'sync-secrets.json'));
  const state = await readJson(join(syncPrivate, 'sync-state.json'));
  if (
    state.format !== 'pickchick-native-pos-sync-v1' ||
    state.syncInstallId !== secret.syncInstallId ||
    state.installId !== foundation.installId ||
    state.branchId !== foundation.branchId
  )
    throw new Error('Private checkpoint binding differs');
  const binding = bindingPath ? await readJson(bindingPath) : undefined;
  if (
    binding &&
    (binding.branchId !== secret.branchId ||
      Object.keys(binding).sort().join(',') !== 'branchId,deviceId,organizationId')
  )
    throw new Error('Invalid branch sync input');
  if (binding) {
    const { DeviceIdentitySchema } = await import(
      pathToFileURL(require.resolve('@pickchick/contracts')).href
    );
    const identity = DeviceIdentitySchema.parse(
      await readJson(join(syncPrivate, '..', 'service', 'device-identity.json')),
    );
    if (
      identity.branch_id !== binding.branchId ||
      identity.device_id !== binding.deviceId ||
      Date.parse(identity.expires_at) <= Date.now()
    )
      throw new Error('Device identity differs from binding');
  }
  const result = await configureSyncDatabase(Client, foundation, secret, {
    mode,
    pgData,
    systemIdentifier,
    ...(binding
      ? {
          bind: async (config) => {
            const { provisionEdgePosSync } = await import(
              pathToFileURL(require.resolve('@pickchick/pos-order-sync')).href
            );
            const pool = new Pool(config);
            pool.on('error', () => {});
            try {
              return await provisionEdgePosSync(pool, binding);
            } finally {
              await pool.end();
            }
          },
        }
      : {}),
  });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(JSON.stringify({ event: 'native_pos_sync_database_failed' }));
    process.exitCode = 1;
  });
}
