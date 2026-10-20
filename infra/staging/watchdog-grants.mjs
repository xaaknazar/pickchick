/** Dedicated read-only role for the ops watchdog (infra/staging/watchdog/queries.mjs).
 *
 * Column-level SELECT only, on exactly the columns the watchdog queries reference: no
 * secrets (token_hash, phones, payloads, amounts), no INSERT/UPDATE/DELETE, no sequences,
 * no CREATE, no memberships. The role also defaults to read-only transactions with short
 * timeouts. Applied by the operator through psql as postgres in the cloud-db container:
 *
 *   docker run --rm -i --network none pickchick-api:<sha> \
 *     node infra/staging/watchdog-grants.mjs apply-sql < /opt/pickchick-staging/secrets/watchdog.env \
 *   | docker exec -i pickchick-staging-cloud-db-1 psql -X -q -v ON_ERROR_STOP=1 -U postgres -d pickchick_cloud
 *
 * Only a SCRAM-SHA-256 verifier reaches the SQL text; the password itself never does.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const WATCHDOG_ROLE = 'pickchick_watchdog';
export const WATCHDOG_DATABASE = 'pickchick_cloud';

/** table -> columns readable by the watchdog. Keep in sync with watchdog/queries.mjs. */
export const WATCHDOG_COLUMNS = Object.freeze({
  devices: Object.freeze(['id', 'kind', 'name', 'status']),
  device_credentials: Object.freeze(['device_id', 'expires_at']),
  fulfillment_transport_bindings: Object.freeze(['branch_id', 'device_id', 'active']),
  cloud_branch_availability: Object.freeze(['branch_id', 'device_id', 'observed_at']),
  commerce_kaspi_invoices: Object.freeze(['state', 'issue_started_at']),
  commerce_kiosk_kaspi_qr: Object.freeze(['state', 'issue_started_at']),
  commerce_outbox: Object.freeze(['order_id', 'event_type', 'created_at', 'acknowledged_at']),
  commerce_orders: Object.freeze(['id', 'attention_required']),
  commerce_payment_attempts: Object.freeze(['order_id', 'account_id', 'state']),
  commerce_provider_accounts: Object.freeze(['id', 'provider', 'kind', 'enabled']),
  commerce_cancellation_intents: Object.freeze(['order_id']),
});

function identifier(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw new Error('Invalid watchdog grant identifier');
  return value;
}
const literal = (value) => `'${identifier(value)}'`;

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

/** Creates the role if missing, then (re)sets restrictive attributes, settings and password. */
export function watchdogRoleSql(role, verifier) {
  identifier(role);
  if (
    !/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/.test(
      verifier,
    )
  )
    throw new Error('Invalid SCRAM verifier');
  return [
    `DO $watchdog$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(role)}) THEN
    CREATE ROLE ${role} NOLOGIN;
  END IF;
END $watchdog$;`,
    `ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 3 PASSWORD '${verifier}';`,
    `ALTER ROLE ${role} SET default_transaction_read_only = on;`,
    `ALTER ROLE ${role} SET statement_timeout = '5s';`,
    `ALTER ROLE ${role} SET idle_in_transaction_session_timeout = '15s';`,
  ].join('\n');
}

/** Removes every relation, column, sequence and schema privilege the role holds in the schema. */
export function watchdogRevokeSql(role, schema = 'public') {
  identifier(role);
  identifier(schema);
  return `DO $watchdog$
DECLARE relation record;
BEGIN
  FOR relation IN
    SELECT c.oid::regclass AS name, c.relkind,
      string_agg(quote_ident(a.attname), ',' ORDER BY a.attnum)
        FILTER (WHERE a.attnum > 0 AND NOT a.attisdropped) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = ${literal(schema)} AND c.relkind IN ('r','p','v','m','f','S')
    GROUP BY c.oid, c.relkind
  LOOP
    IF relation.relkind = 'S' THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I', relation.name, ${literal(role)});
    ELSE
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', relation.name, ${literal(role)});
      IF relation.columns IS NOT NULL THEN
        EXECUTE format('REVOKE SELECT(%1$s),INSERT(%1$s),UPDATE(%1$s),REFERENCES(%1$s) ON TABLE %2$s FROM %3$I',
          relation.columns, relation.name, ${literal(role)});
      END IF;
    END IF;
  END LOOP;
END $watchdog$;
REVOKE ALL ON SCHEMA ${identifier(schema)} FROM ${role};`;
}

/** Pure grant list; run after watchdogRevokeSql so repeated application is exact. */
export function watchdogGrantSql(role, { schema = 'public', database = WATCHDOG_DATABASE } = {}) {
  identifier(role);
  identifier(schema);
  identifier(database);
  return [
    `GRANT CONNECT ON DATABASE ${database} TO ${role};`,
    `GRANT USAGE ON SCHEMA ${schema} TO ${role};`,
    ...Object.entries(WATCHDOG_COLUMNS).map(
      ([table, columns]) =>
        `GRANT SELECT(${columns.map(identifier).join(', ')}) ON ${schema}.${identifier(table)} TO ${role};`,
    ),
  ].join('\n');
}

/** Fails the transaction unless the role holds exactly the reviewed privileges. */
export function watchdogAssertSql(role, { schema = 'public', database = WATCHDOG_DATABASE } = {}) {
  identifier(role);
  identifier(schema);
  identifier(database);
  const expected = Object.entries(WATCHDOG_COLUMNS)
    .flatMap(([table, columns]) =>
      columns.map((column) => `'${identifier(table)}.${identifier(column)}'`),
    )
    .join(',');
  const count = Object.values(WATCHDOG_COLUMNS).reduce((sum, columns) => sum + columns.length, 0);
  return `DO $watchdog$
DECLARE problem text; granted integer;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(role)} AND (rolsuper OR rolcreatedb
      OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit OR NOT rolcanlogin)) THEN
    RAISE EXCEPTION 'watchdog role attributes are not restricted';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
      WHERE r.rolname = ${literal(role)}) THEN
    RAISE EXCEPTION 'watchdog role must not be a member of other roles';
  END IF;
  SELECT string_agg(c.relname || '.' || a.attname, ', ') INTO problem
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = ${literal(schema)} AND c.relkind IN ('r','p','v','m','f')
      AND has_column_privilege(${literal(role)}, c.oid, a.attnum, 'SELECT')
        <> ((c.relname || '.' || a.attname) = ANY (ARRAY[${expected}]));
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'watchdog SELECT privileges differ from the reviewed list: %', problem;
  END IF;
  SELECT count(*) INTO granted
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = ${literal(schema)} AND c.relkind IN ('r','p','v','m','f')
      AND (c.relname || '.' || a.attname) = ANY (ARRAY[${expected}])
      AND has_column_privilege(${literal(role)}, c.oid, a.attnum, 'SELECT');
  IF granted <> ${count} THEN
    RAISE EXCEPTION 'watchdog relations are missing (expected % columns, found %)', ${count}, granted;
  END IF;
  SELECT string_agg(c.relname, ', ') INTO problem
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${literal(schema)} AND (
      (c.relkind IN ('r','p','v','m','f') AND (
        has_table_privilege(${literal(role)}, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(${literal(role)}, c.oid, 'INSERT,UPDATE,REFERENCES')))
      OR (c.relkind = 'S' AND has_sequence_privilege(${literal(role)}, c.oid, 'USAGE,SELECT,UPDATE')));
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'watchdog role can write or use sequences: %', problem;
  END IF;
  IF has_schema_privilege(${literal(role)}, ${literal(schema)}, 'CREATE')
      OR NOT has_schema_privilege(${literal(role)}, ${literal(schema)}, 'USAGE')
      OR has_database_privilege(${literal(role)}, ${literal(database)}, 'CREATE')
      OR NOT has_database_privilege(${literal(role)}, ${literal(database)}, 'CONNECT') THEN
    RAISE EXCEPTION 'watchdog schema/database privileges differ from the reviewed list';
  END IF;
END $watchdog$;`;
}

/** One transaction: create/rotate role, reset privileges, grant, prove. Safe to re-run. */
export function watchdogApplySql({
  password,
  role = WATCHDOG_ROLE,
  database = WATCHDOG_DATABASE,
  schema = 'public',
  salt,
}) {
  const verifier = scramVerifier(password, salt);
  return [
    'BEGIN;',
    `DO $watchdog$ BEGIN
  IF current_database() <> ${literal(database)} THEN
    RAISE EXCEPTION 'watchdog grants target another database';
  END IF;
END $watchdog$;`,
    watchdogRoleSql(role, verifier),
    watchdogRevokeSql(role, schema),
    watchdogGrantSql(role, { schema, database }),
    watchdogAssertSql(role, { schema, database }),
    'COMMIT;',
  ].join('\n');
}

/** Rollback: the role keeps no privileges and cannot log in; nothing else changes. */
export function watchdogDisableSql({
  role = WATCHDOG_ROLE,
  database = WATCHDOG_DATABASE,
  schema = 'public',
} = {}) {
  identifier(role);
  identifier(database);
  return [
    'BEGIN;',
    `ALTER ROLE ${role} NOLOGIN;`,
    watchdogRevokeSql(role, schema),
    `REVOKE ALL ON DATABASE ${database} FROM ${role};`,
    'COMMIT;',
  ].join('\n');
}

/** Reads only WATCHDOG_DB_* keys from the private env text; other secrets are ignored. */
export function readWatchdogDbEnv(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*(WATCHDOG_DB_(?:PASSWORD|USER|NAME))\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  if (!/^[a-f0-9]{64}$/.test(values.WATCHDOG_DB_PASSWORD ?? ''))
    throw new Error('WATCHDOG_DB_PASSWORD must be 64 lowercase hex characters');
  return {
    password: values.WATCHDOG_DB_PASSWORD,
    role: identifier(values.WATCHDOG_DB_USER || WATCHDOG_ROLE),
    database: identifier(values.WATCHDOG_DB_NAME || WATCHDOG_DATABASE),
  };
}

// psql treats empty input as success; a rejected input must still fail the pipeline.
const REJECT_SQL =
  "DO $watchdog$ BEGIN RAISE EXCEPTION 'watchdog grants input rejected'; END $watchdog$;";

async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['apply-sql', 'disable-sql'].includes(mode))
    throw new Error('Usage: watchdog-grants.mjs apply-sql|disable-sql < watchdog.env');
  let input = '';
  for await (const part of process.stdin) {
    input += part;
    if (input.length > 65_536) throw new Error('Input too large');
  }
  const env = readWatchdogDbEnv(input);
  process.stdout.write(
    (mode === 'apply-sql'
      ? watchdogApplySql(env)
      : watchdogDisableSql({ role: env.role, database: env.database })) + '\n',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stdout.write(REJECT_SQL + '\n');
    console.error(String(error?.message ?? 'watchdog grants failed').slice(0, 120));
    process.exitCode = 1;
  });
}
