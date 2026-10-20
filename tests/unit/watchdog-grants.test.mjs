import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  WATCHDOG_COLUMNS,
  WATCHDOG_ROLE,
  readWatchdogDbEnv,
  scramVerifier,
  watchdogApplySql,
  watchdogAssertSql,
  watchdogDisableSql,
  watchdogGrantSql,
  watchdogRevokeSql,
} from '../../infra/staging/watchdog-grants.mjs';
import { WATCHDOG_SQL } from '../../infra/staging/watchdog/queries.mjs';

const PASSWORD = 'c0ffee'.repeat(10) + 'beef';
const script = fileURLToPath(new URL('../../infra/staging/watchdog-grants.mjs', import.meta.url));

test('grant SQL is exactly the reviewed column-level SELECT list', () => {
  assert.equal(
    watchdogGrantSql(WATCHDOG_ROLE),
    [
      'GRANT CONNECT ON DATABASE pickchick_cloud TO pickchick_watchdog;',
      'GRANT USAGE ON SCHEMA public TO pickchick_watchdog;',
      'GRANT SELECT(id, kind, name, status) ON public.devices TO pickchick_watchdog;',
      'GRANT SELECT(device_id, expires_at) ON public.device_credentials TO pickchick_watchdog;',
      'GRANT SELECT(branch_id, device_id, active) ON public.fulfillment_transport_bindings TO pickchick_watchdog;',
      'GRANT SELECT(branch_id, device_id, observed_at) ON public.cloud_branch_availability TO pickchick_watchdog;',
      'GRANT SELECT(state, issue_started_at) ON public.commerce_kaspi_invoices TO pickchick_watchdog;',
      'GRANT SELECT(state, issue_started_at) ON public.commerce_kiosk_kaspi_qr TO pickchick_watchdog;',
      'GRANT SELECT(order_id, event_type, created_at, acknowledged_at) ON public.commerce_outbox TO pickchick_watchdog;',
      'GRANT SELECT(id, attention_required) ON public.commerce_orders TO pickchick_watchdog;',
      'GRANT SELECT(order_id, account_id, state) ON public.commerce_payment_attempts TO pickchick_watchdog;',
      'GRANT SELECT(id, provider, kind, enabled) ON public.commerce_provider_accounts TO pickchick_watchdog;',
      'GRANT SELECT(order_id) ON public.commerce_cancellation_intents TO pickchick_watchdog;',
      'GRANT SELECT(code, created_at) ON public.commerce_reconciliation_issues TO pickchick_watchdog;',
    ].join('\n'),
  );
  const all = watchdogApplySql({ password: PASSWORD });
  assert.doesNotMatch(
    watchdogGrantSql(WATCHDOG_ROLE),
    /INSERT|UPDATE|DELETE|TRUNCATE|GRANT ALL|SEQUENCE|WITH GRANT OPTION|token_hash|phone|payload|snapshot|amount|external_reference|details|CREATE/,
  );
  assert.match(all, /^BEGIN;\n/);
  assert.match(all, /\nCOMMIT;$/);
  assert.match(all, /current_database\(\) <> 'pickchick_cloud'/);
  assert.match(
    all,
    /NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 3/,
  );
  assert.match(all, /SET default_transaction_read_only = on/);
  assert.match(all, /SET statement_timeout = '5s'/);
});

test('every granted column is used by the watchdog queries and every queried table is granted', () => {
  const sql = Object.values(WATCHDOG_SQL).join('\n');
  for (const [table, columns] of Object.entries(WATCHDOG_COLUMNS)) {
    assert.match(sql, new RegExp(`\\b${table}\\b`), `${table} unused`);
    for (const column of columns)
      assert.match(sql, new RegExp(`\\b${column}\\b`), `${table}.${column} unused`);
  }
  const tables = new Set(
    [...sql.matchAll(/\b(?:FROM|JOIN) ([a-z_]+)\b(?![.(])/g)].map((match) => match[1]),
  );
  // The only catalog view: pg_stat_archiver (PITR health), readable without table grants.
  assert.ok(tables.delete('pg_stat_archiver'));
  assert.deepEqual([...tables].sort(), Object.keys(WATCHDOG_COLUMNS).sort());
  assert.doesNotMatch(
    sql,
    /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|COPY|FOR UPDATE)\b/i,
  );
});

test('identifiers are validated before any SQL is produced', () => {
  for (const value of [
    '',
    'Role',
    'x;DROP ROLE y',
    'a b',
    'x"',
    '1role',
    'a'.repeat(64),
    null,
    {},
  ]) {
    assert.throws(() => watchdogGrantSql(value));
    assert.throws(() => watchdogGrantSql('ok_role', { schema: value }));
    assert.throws(() => watchdogGrantSql('ok_role', { database: value }));
    assert.throws(() => watchdogRevokeSql(value));
    assert.throws(() => watchdogAssertSql(value));
    assert.throws(() => watchdogDisableSql({ role: value }));
  }
});

test('only a SCRAM verifier reaches SQL; the password never does', () => {
  const salt = Buffer.alloc(16, 7);
  const verifier = scramVerifier(PASSWORD, salt);
  assert.match(
    verifier,
    /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/,
  );
  assert.equal(scramVerifier(PASSWORD, salt), verifier);
  assert.notEqual(scramVerifier(PASSWORD), scramVerifier(PASSWORD));
  const sql = watchdogApplySql({ password: PASSWORD, salt });
  assert.ok(sql.includes(verifier));
  assert.ok(!sql.includes(PASSWORD));
  for (const bad of ['', 'short', PASSWORD.toUpperCase(), PASSWORD + '0', "x' OR '1"])
    assert.throws(() => watchdogApplySql({ password: bad }));
  assert.doesNotMatch(watchdogDisableSql(), /GRANT|PASSWORD/);
  assert.match(watchdogDisableSql(), /ALTER ROLE pickchick_watchdog NOLOGIN;/);
});

test('env reader takes only WATCHDOG_DB_* keys and errors never contain values', () => {
  const env = readWatchdogDbEnv(
    `# comment\nWATCHDOG_TELEGRAM_BOT_TOKEN=123:secret\nWATCHDOG_DB_PASSWORD=${PASSWORD}\nWATCHDOG_DB_USER=\n`,
  );
  assert.deepEqual(env, {
    password: PASSWORD,
    role: 'pickchick_watchdog',
    database: 'pickchick_cloud',
  });
  assert.throws(
    () => readWatchdogDbEnv('WATCHDOG_DB_PASSWORD=not-hex-secret-value'),
    (error) => !error.message.includes('not-hex-secret-value'),
  );
  assert.throws(() =>
    readWatchdogDbEnv(`WATCHDOG_DB_PASSWORD=${PASSWORD}\nWATCHDOG_DB_USER=x;drop`),
  );
});

test('CLI writes SQL to stdout only, and a rejected input still fails psql', () => {
  const input = `WATCHDOG_TELEGRAM_BOT_TOKEN=123456:topsecrettoken\nWATCHDOG_DB_PASSWORD=${PASSWORD}\n`;
  const ok = spawnSync(process.execPath, [script, 'apply-sql'], { input, encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(ok.stderr, '');
  assert.match(ok.stdout, /^BEGIN;\n[\s\S]*SCRAM-SHA-256\$4096:[\s\S]*\nCOMMIT;\n$/);
  assert.doesNotMatch(ok.stdout + ok.stderr, new RegExp(`${PASSWORD}|topsecrettoken`));
  const disable = spawnSync(process.execPath, [script, 'disable-sql'], { input, encoding: 'utf8' });
  assert.equal(disable.status, 0);
  assert.match(disable.stdout, /NOLOGIN/);
  const rejected = spawnSync(process.execPath, [script, 'apply-sql'], {
    input: 'WATCHDOG_DB_PASSWORD=leaked-value-123',
    encoding: 'utf8',
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stdout, /RAISE EXCEPTION 'watchdog grants input rejected'/);
  assert.doesNotMatch(rejected.stdout + rejected.stderr, /leaked-value-123/);
  const usage = spawnSync(process.execPath, [script, 'drop-everything'], {
    input,
    encoding: 'utf8',
  });
  assert.equal(usage.status, 1);
  assert.doesNotMatch(usage.stdout, /GRANT/);
});

test('runbook and env example describe the role without real secrets', () => {
  const example = readFileSync(
    new URL('../../infra/staging/watchdog.env.example', import.meta.url),
    'utf8',
  );
  for (const name of [
    'WATCHDOG_TELEGRAM_BOT_TOKEN',
    'WATCHDOG_TELEGRAM_CHAT_ID',
    'WATCHDOG_DB_PASSWORD',
  ])
    assert.match(example, new RegExp(`^${name}=$`, 'm'));
  assert.match(example, /^WATCHDOG_TELEGRAM_ENABLED=false$/m);
  assert.match(example, /^WATCHDOG_KASPI_SESSION_PROBE_HOURS=0$/m);
  assert.match(example, /^WATCHDOG_DAILY_SUMMARY=false$/m);
});
