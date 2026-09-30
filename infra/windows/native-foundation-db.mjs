import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const roles = ['pickchick_edge_owner', 'pickchick_edge_runtime'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function validateCredentials(value, branchId) {
  if (
    !value ||
    value.format !== 'pickchick-native-secrets-v1' ||
    value.branchId !== branchId ||
    !uuid.test(value.installId) ||
    !/^[a-f0-9-]{36}$/i.test(branchId) ||
    !value.passwords ||
    Object.keys(value.passwords).sort().join(',') !==
      'pickchick_bootstrap,pickchick_edge_owner,pickchick_edge_runtime' ||
    Object.values(value.passwords).some((password) => !/^[a-f0-9]{64}$/.test(password)) ||
    new Set(Object.values(value.passwords)).size !== 3
  )
    throw new Error('Invalid private setup credential');
  return value;
}

// PostgreSQL accepts a complete SCRAM verifier in CREATE ROLE. Plain passwords
// never enter SQL text, pg_stat_activity or PostgreSQL statement diagnostics.
export function scramVerifier(password, installId, role) {
  if (!/^[a-f0-9]{64}$/.test(password) || !uuid.test(installId) || !roles.includes(role))
    throw new Error('Invalid SCRAM input');
  const salt = createHash('sha256').update(`${installId}:${role}`).digest().subarray(0, 16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest('base64');
  const serverKey = createHmac('sha256', salted).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${storedKey}:${serverKey}`;
}

function requireSafeRole(row, role, verifier) {
  if (
    !row ||
    row.rolname !== role ||
    !row.rolcanlogin ||
    row.rolinherit ||
    row.rolsuper ||
    row.rolcreatedb ||
    row.rolcreaterole ||
    row.rolreplication ||
    row.rolbypassrls ||
    row.rolpassword !== verifier
  )
    throw new Error('Existing role differs from private setup');
}

export async function configureDatabase(
  Client,
  credentials,
  pgData,
  mode,
  expectedSystemIdentifier = '',
  port = 55433,
) {
  if (!['bootstrap', 'verify'].includes(mode)) throw new Error('Unknown operator mode');
  validateCredentials(credentials, credentials.branchId);
  if (expectedSystemIdentifier && !/^\d{10,20}$/.test(expectedSystemIdentifier))
    throw new Error('Invalid cluster identity');
  // The CLI always uses 55433. Tests may use a separately reserved disposable port.
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Invalid local PostgreSQL port');
  const config = {
    host: '127.0.0.1',
    port,
    ssl: false,
    database: 'postgres',
    user: 'pickchick_bootstrap',
    password: credentials.passwords.pickchick_bootstrap,
    connectionTimeoutMillis: 3000,
    statement_timeout: 30000,
    application_name: 'pickchick-native-setup',
  };
  const admin = new Client(config);
  let edge;
  let runtime;
  // Connection errors never escape as unhandled events containing driver details.
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
      server.version < 180006 ||
      server.version >= 190000 ||
      server.checksums !== 'on' ||
      server.encoding !== 'UTF8' ||
      server.listen !== '127.0.0.1' ||
      server.port !== port ||
      server.encryption !== 'scram-sha-256' ||
      server.directory.replaceAll('\\', '/').toLowerCase() !==
        pgData.replaceAll('\\', '/').toLowerCase()
    ) {
      throw new Error('Wrong PostgreSQL cluster or settings');
    }
    if (expectedSystemIdentifier && server.system_id !== expectedSystemIdentifier)
      throw new Error('PostgreSQL cluster identity changed');
    for (const role of roles) {
      const verifier = scramVerifier(credentials.passwords[role], credentials.installId, role);
      let row = (await admin.query('SELECT * FROM pg_authid WHERE rolname=$1', [role])).rows[0];
      if (!row && mode === 'bootstrap') {
        await admin.query(
          `CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${verifier}'`,
        );
        row = (await admin.query('SELECT * FROM pg_authid WHERE rolname=$1', [role])).rows[0];
      }
      requireSafeRole(row, role, verifier);
      if ((await admin.query('SELECT 1 FROM pg_auth_members WHERE member=$1', [row.oid])).rowCount)
        throw new Error('Role has unexpected membership');
    }
    let database = (
      await admin.query(
        "SELECT datname,pg_get_userbyid(datdba) AS owner,pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname='pickchick_edge'",
      )
    ).rows[0];
    if (!database && mode === 'bootstrap') {
      await admin.query(
        "CREATE DATABASE pickchick_edge OWNER pickchick_edge_owner TEMPLATE template0 ENCODING 'UTF8'",
      );
      database = (
        await admin.query(
          "SELECT datname,pg_get_userbyid(datdba) AS owner,pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname='pickchick_edge'",
        )
      ).rows[0];
    }
    if (!database || database.owner !== 'pickchick_edge_owner' || database.encoding !== 'UTF8')
      throw new Error('Dedicated edge database differs');
    if (mode === 'bootstrap') {
      await admin.query(`REVOKE ALL ON DATABASE pickchick_edge FROM PUBLIC;
        GRANT CONNECT ON DATABASE pickchick_edge TO pickchick_edge_runtime;
        REVOKE ALL ON DATABASE postgres FROM PUBLIC;
        REVOKE ALL ON DATABASE template1 FROM PUBLIC;`);
    }
    edge = new Client({ ...config, database: 'pickchick_edge' });
    edge.on('error', () => {});
    await edge.connect();
    const schemaOwner = (
      await edge.query(
        "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='public'",
      )
    ).rows[0]?.owner;
    if (!['pg_database_owner', 'pickchick_edge_owner'].includes(schemaOwner))
      throw new Error('Unexpected public schema owner');
    if (mode === 'bootstrap') {
      await edge.query(`ALTER SCHEMA public OWNER TO pickchick_edge_owner;
        REVOKE ALL ON SCHEMA public FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES FOR ROLE pickchick_edge_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;`);
      return { databaseConfigured: true, systemIdentifier: server.system_id };
    }
    const ownership =
      await edge.query(`SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass
      AND refobjid=(SELECT oid FROM pg_roles WHERE rolname='pickchick_edge_runtime') AND deptype='o'`);
    if (ownership.rowCount) throw new Error('Runtime owns database objects');
    const privilege = (
      await edge.query(`SELECT
      has_schema_privilege('pickchick_edge_runtime','public','CREATE') AS schema_create,
      has_database_privilege('pickchick_edge_runtime','pickchick_edge','TEMP') AS temporary,
      has_database_privilege('pickchick_edge_runtime','postgres','CONNECT') AS postgres_connect,
      has_table_privilege('pickchick_edge_runtime','fulfillment_config','SELECT') AS fulfillment`)
    ).rows[0];
    if (Object.values(privilege).some(Boolean))
      throw new Error('Runtime exceeds POS-only setup rights');
    runtime = new Client({
      ...config,
      database: 'pickchick_edge',
      user: 'pickchick_edge_runtime',
      password: credentials.passwords.pickchick_edge_runtime,
    });
    runtime.on('error', () => {});
    await runtime.connect();
    const ledger = (
      await runtime.query('SELECT version,scope FROM schema_migrations ORDER BY version')
    ).rows;
    if (
      ledger.length !== 9 ||
      ledger.some(
        (row, index) =>
          row.scope !== 'edge' || !row.version.startsWith(String(index + 1).padStart(3, '0') + '_'),
      )
    )
      throw new Error('Wrong migration ledger');
    const branches = (await runtime.query('SELECT id,ordering_enabled FROM branch_config')).rows;
    if (
      branches.length > 1 ||
      branches.some((row) => row.id !== credentials.branchId || row.ordering_enabled)
    )
      throw new Error('Branch binding differs or ordering is enabled');
    await runtime.query('SELECT id FROM local_orders LIMIT 0');
    await runtime.query('SELECT branch_id FROM active_menu LIMIT 0');
    return {
      databaseVerified: true,
      systemIdentifier: server.system_id,
      migrations: 9,
      branchBound: branches.length === 1,
      orderingEnabled: false,
      fulfillmentEnabled: false,
    };
  } finally {
    await Promise.allSettled([runtime?.end(), edge?.end(), admin.end()]);
  }
}

async function main() {
  const [mode, operatorRoot, branchId, pgData, expectedSystemIdentifier = '', ...extra] =
    process.argv.slice(2);
  if (extra.length || !operatorRoot || !pgData || !['bootstrap', 'verify'].includes(mode))
    throw new Error('Invalid operator invocation');
  const file = join(resolve(operatorRoot), 'private', 'foundation-credentials.json');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 10000)
    throw new Error('Invalid private credential file');
  const credentials = validateCredentials(JSON.parse(await readFile(file, 'utf8')), branchId);
  const { Client } = createRequire(join(resolve(operatorRoot), 'package.json'))('pg');
  console.log(
    JSON.stringify(
      await configureDatabase(Client, credentials, pgData, mode, expectedSystemIdentifier),
    ),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(JSON.stringify({ event: 'native_foundation_database_failed' }));
    process.exitCode = 1;
  });
}
