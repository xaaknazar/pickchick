import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPool, migrate } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import {
  scramVerifier,
  watchdogApplySql,
  watchdogAssertSql,
  watchdogDisableSql,
} from '../../infra/staging/watchdog-grants.mjs';
import { readDatabaseFacts } from '../../infra/staging/watchdog/queries.mjs';
import { runWatchdog } from '../../infra/staging/watchdog/main.mjs';

const denied = (error) => error.code === '42501';
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** Temporary cloud schema at the current migration ledger with synthetic rows only. */
async function cloudSchema(run) {
  const config = loadConfig('api');
  const base = new URL(config.databaseUrl);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'local database only');
  const admin = createPool(base.href, 2);
  const suffix = randomUUID().replaceAll('-', '');
  const schema = `watchdog_${suffix}`;
  const role = `watchdog_${suffix.slice(0, 20)}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(base);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = createPool(url.href, 2);
  try {
    await migrate(
      pool,
      fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url)),
      'cloud',
    );
    await run({ admin, pool, schema, role, base, database: base.pathname.slice(1) });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  }
}

/** Runs multi-statement apply SQL on one session, rolling back an aborted transaction. */
async function applyAsAdmin(admin, sql) {
  const client = await admin.connect();
  try {
    await client.query(sql);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function roleUrl(base, role, password, schema) {
  const url = new URL(base);
  url.username = role;
  url.password = password;
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.href;
}

async function seed(pool) {
  const org = randomUUID(),
    legal = randomUUID(),
    ids = {};
  await pool.query("INSERT INTO organizations(id,name) VALUES ($1,'Watchdog synthetic')", [org]);
  await pool.query(
    "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES ($1,$2,'Watchdog synthetic','000000000000')",
    [legal, org],
  );
  const branch = async (code) => {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES ($1,$2,$3,$4,'Synthetic')",
      [id, org, legal, code],
    );
    return id;
  };
  ids.branchA = await branch('WDA');
  ids.branchB = await branch('WDB');
  const device = async (branchId, kind, name, status, expiresInMs) => {
    const id = randomUUID();
    await pool.query(
      'INSERT INTO devices(id,branch_id,organization_id,kind,name,status) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, branchId, org, kind, name, status],
    );
    if (expiresInMs !== null)
      await pool.query(
        `INSERT INTO device_credentials(device_id,token_hash,expires_at,issued_at)
         VALUES ($1,$2,clock_timestamp()+$3::bigint*interval '1 millisecond',clock_timestamp()-interval '40 days')`,
        [id, createHash('sha256').update(id).digest('hex'), expiresInMs],
      );
    return id;
  };
  ids.edgeA = await device(ids.branchA, 'edge', 'Касса A', 'active', 3 * DAY);
  ids.edgeB = await device(ids.branchB, 'edge', 'Касса B', 'active', 20 * DAY);
  ids.posExpired = await device(ids.branchA, 'pos', 'POS истёк', 'active', -2 * 60 * MIN);
  ids.revoked = await device(ids.branchB, 'pos', 'Отозван', 'revoked', -DAY);
  for (const [branchId, deviceId, ageMs] of [
    [ids.branchA, ids.edgeA, 25 * MIN],
    [ids.branchB, ids.edgeB, 2000],
  ]) {
    await pool.query(
      'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES ($1,$2,$3,$4)',
      [branchId, org, deviceId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO cloud_branch_availability(branch_id,device_id,revision,stopped_ids,observed_at)
       VALUES ($1,$2,1,'{}',clock_timestamp()-$3::bigint*interval '1 millisecond')`,
      [branchId, deviceId, ageMs],
    );
  }
  // Commerce rows are synthetic ledger fragments: foreign keys/triggers are bypassed only in
  // this disposable schema so the read-only queries can be exercised without a real checkout.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    const account = async (provider) => {
      const id = randomUUID();
      await client.query(
        "INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,legal_entity_id,kind,provider,external_reference,enabled) VALUES ($1,$2,$3,$4,'payment',$5,$6,true)",
        [id, org, ids.branchA, legal, provider, `synthetic-${id}`],
      );
      return id;
    };
    const remote = await account('kaspi-remote');
    const qr = await account('kaspi-qr');
    const order = async ({
      accountId,
      outboxAgeMs,
      acknowledged = false,
      attention = false,
      cancelled = false,
    }) => {
      const id = randomUUID(),
        attempt = randomUUID();
      await client.query(
        `INSERT INTO commerce_orders(id,organization_id,branch_id,principal_id,quote_id,fiscal_account_id,snapshot,total_minor,currency,quote_digest,attention_required)
         VALUES ($1,$2,$3,$4,$5,$6,'{}',1000,'KZT','synthetic',$7)`,
        [id, org, ids.branchA, randomUUID(), randomUUID(), accountId, attention],
      );
      await client.query(
        "INSERT INTO commerce_payment_attempts(id,intent_id,order_id,account_id,intended_minor,state) VALUES ($1,$2,$3,$4,1000,'pending')",
        [attempt, randomUUID(), id, accountId],
      );
      await client.query(
        `INSERT INTO commerce_outbox(id,order_id,effect_key,event_type,payload,created_at,acknowledged_at)
         VALUES ($1,$2,'payment:x','payment.submit_requested',$3,clock_timestamp()-$4::bigint*interval '1 millisecond',
           CASE WHEN $5 THEN clock_timestamp() END)`,
        [
          randomUUID(),
          id,
          JSON.stringify({ attemptId: attempt, accountId }),
          outboxAgeMs,
          acknowledged,
        ],
      );
      if (cancelled)
        await client.query(
          "INSERT INTO commerce_cancellation_intents(id,order_id,organization_id,branch_id,requested_by,reason,state) VALUES ($1,$2,$3,$4,$5,'synthetic','waiting_admission')",
          [randomUUID(), id, org, ids.branchA, randomUUID()],
        );
      return { id, attempt, accountId };
    };
    // Counted: 1 kaspi-remote (10 min) and 1 kaspi-qr (5 min).
    const stuckRemote = await order({ accountId: remote, outboxAgeMs: 10 * MIN });
    await order({ accountId: qr, outboxAgeMs: 5 * MIN });
    // Not counted: too new, cancelled, older than an hour, attention, acknowledged.
    await order({ accountId: remote, outboxAgeMs: MIN });
    await order({ accountId: remote, outboxAgeMs: 10 * MIN, cancelled: true });
    await order({ accountId: remote, outboxAgeMs: 120 * MIN });
    await order({ accountId: qr, outboxAgeMs: 5 * MIN, attention: true });
    await order({ accountId: qr, outboxAgeMs: 5 * MIN, acknowledged: true });
    // Unknown overdue: one remote invoice unknown for 10 min, one issuing for 2 min (not yet).
    await client.query(
      `INSERT INTO commerce_kaspi_invoices(attempt_id,order_id,account_id,amount_minor,state,reference,issue_started_at)
       VALUES ($1,$2,$3,1000,'unknown','ABCDEFGH23',clock_timestamp()-interval '10 minutes'),
              ($4,$2,$3,1000,'issuing','ABCDEFGH24',clock_timestamp()-interval '2 minutes')`,
      [stuckRemote.attempt, stuckRemote.id, remote, randomUUID()],
    );
    // Kitchen transport: one paid order not taken by the cashier for 10 min, one reservation
    // waiting 7 min; not counted: acknowledged, too new, attention, cancelled.
    const kitchen = async (eventType, ageMs, { acknowledged = false, attention = false } = {}) => {
      const { id } = await order({
        accountId: remote,
        outboxAgeMs: 0,
        acknowledged: true,
        attention,
      });
      await client.query(
        `INSERT INTO commerce_outbox(id,order_id,effect_key,event_type,payload,created_at,acknowledged_at)
         VALUES ($1,$2,$3,$4,'{}',clock_timestamp()-$5::bigint*interval '1 millisecond',
           CASE WHEN $6 THEN clock_timestamp() END)`,
        [randomUUID(), id, `kitchen:${randomUUID()}`, eventType, ageMs, acknowledged],
      );
      return id;
    };
    await kitchen('edge.kitchen_admission_requested', 10 * MIN);
    await kitchen('edge.admission_requested', 7 * MIN);
    await kitchen('edge.kitchen_admission_requested', 10 * MIN, { acknowledged: true });
    await kitchen('edge.kitchen_admission_requested', MIN);
    const reviewed = await kitchen('edge.kitchen_admission_requested', 10 * MIN, {
      attention: true,
    });
    // Manager review cases: two new ones (the paid order above went to review, plus a second
    // code) are counted; one older than the 6 hour window is not.
    for (const [code, ageMs] of [
      ['KITCHEN_ADMISSION_OVERDUE', 2 * MIN],
      ['PAID_AFTER_RESTAURANT_CANCEL', 20 * MIN],
      ['KITCHEN_ADMISSION_REFUSED', 7 * 60 * MIN],
    ])
      await client.query(
        `INSERT INTO commerce_reconciliation_issues(id,order_id,issue_key,code,details,created_at)
         VALUES ($1,$2,$3,$4,'{"synthetic":true}',clock_timestamp()-$5::bigint*interval '1 millisecond')`,
        [randomUUID(), reviewed, `synthetic:${code}`, code, ageMs],
      );
    const qrOrder = await order({ accountId: qr, outboxAgeMs: 0, acknowledged: true });
    await client.query(
      `INSERT INTO commerce_kiosk_kaspi_qr(attempt_id,order_id,account_id,amount_minor,state,issue_started_at,expires_at)
       VALUES ($1,$2,$3,1000,'issuing',clock_timestamp()-interval '10 minutes',clock_timestamp()-interval '9 minutes')`,
      [qrOrder.attempt, qrOrder.id, qr],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return ids;
}

test('read-only watchdog role answers every check and can do nothing else', async (t) => {
  await cloudSchema(async ({ admin, pool, schema, role, base, database }) => {
    const ids = await seed(pool);
    const password = randomBytes(32).toString('hex');
    await applyAsAdmin(admin, watchdogApplySql({ password, role, schema, database }));
    // Re-applying is exact and idempotent.
    await applyAsAdmin(admin, watchdogApplySql({ password, role, schema, database }));
    const attributes = (
      await admin.query(
        `SELECT rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconnlimit,
          (SELECT setconfig FROM pg_db_role_setting s WHERE s.setrole=r.oid AND s.setdatabase=0) settings
         FROM pg_roles r WHERE rolname=$1`,
        [role],
      )
    ).rows[0];
    assert.deepEqual(
      { ...attributes, settings: [...attributes.settings].sort() },
      {
        rolcanlogin: true,
        rolinherit: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
        rolconnlimit: 3,
        settings: [
          'default_transaction_read_only=on',
          'idle_in_transaction_session_timeout=15s',
          'statement_timeout=5s',
        ],
      },
    );
    const watchdog = createPool(roleUrl(base, role, password, schema), 1);
    try {
      assert.equal((await watchdog.query('SELECT current_user')).rows[0].current_user, role);
      const facts = await readDatabaseFacts(watchdog, { paymentBacklogMinutes: 3 });
      assert.deepEqual(
        facts.identities.map((row) => [row.deviceId, row.kind, row.name]),
        [
          [ids.posExpired, 'pos', 'POS истёк'],
          [ids.edgeA, 'edge', 'Касса A'],
          [ids.edgeB, 'edge', 'Касса B'],
        ],
      );
      assert.ok(facts.identities[0].remainingSeconds < 0);
      assert.ok(Math.abs(facts.identities[1].remainingSeconds - 3 * 86_400) < 120);
      const heartbeat = new Map(facts.heartbeats.map((row) => [row.deviceId, row]));
      assert.ok(heartbeat.get(ids.edgeA).ageSeconds >= 25 * 60 - 1);
      assert.ok(heartbeat.get(ids.edgeB).ageSeconds <= 60);
      assert.deepEqual(facts.unknownOverdue, { 'kaspi-remote-worker': 1, 'kiosk-qr-worker': 1 });
      assert.deepEqual(facts.paymentBacklog, { 'kaspi-remote-worker': 1, 'kiosk-qr-worker': 1 });
      assert.deepEqual(
        { ...facts.kitchenBacklog, oldestSeconds: facts.kitchenBacklog.oldestSeconds >= 599 },
        { kitchen: 1, admission: 1, oldestSeconds: true },
      );
      // newestAt is the database time of the newest case (about 2 minutes before facts.now).
      const newestLag = Date.parse(facts.now) - Date.parse(facts.reviews.newestAt);
      assert.deepEqual(
        {
          ...facts.reviews,
          newestSeconds: facts.reviews.newestSeconds >= 119,
          newestAt: newestLag >= 119_000 && newestLag < 180_000,
        },
        {
          total: 2,
          codes: { KITCHEN_ADMISSION_OVERDUE: 1, PAID_AFTER_RESTAURANT_CANCEL: 1 },
          newestSeconds: true,
          newestAt: true,
        },
      );
      assert.equal((await readDatabaseFacts(watchdog, { reviewWindowHours: 8 })).reviews.total, 3);
      // pg_stat_archiver needs no table grant; the local database does not archive.
      assert.equal(facts.archiver.mode, 'off');
      assert.equal(facts.archiver.failedCount, 0);

      // Secrets, whole rows, other tables, writes and DDL are all refused.
      for (const sql of [
        'SELECT token_hash FROM device_credentials',
        'SELECT * FROM devices',
        'SELECT snapshot FROM commerce_orders',
        'SELECT payload FROM commerce_outbox',
        'SELECT external_reference FROM commerce_provider_accounts',
        'SELECT reference, operation_id FROM commerce_kaspi_invoices',
        'SELECT qr_payload FROM commerce_kiosk_kaspi_qr',
        'SELECT details FROM commerce_reconciliation_issues',
        'SELECT order_id FROM commerce_reconciliation_issues',
        'SELECT id FROM organizations',
        'SELECT id FROM identity_customers',
        'SELECT id FROM kiosk_devices',
      ])
        await assert.rejects(watchdog.query(sql), denied, sql);
      const readOnly = (error) => error.code === '42501' || error.code === '25006';
      for (const sql of [
        "UPDATE device_credentials SET expires_at=clock_timestamp()+interval '1 year'",
        "INSERT INTO devices(id,branch_id,organization_id,kind,name) VALUES (gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'edge','x')",
        'DELETE FROM commerce_outbox',
        'TRUNCATE commerce_kaspi_invoices',
        'CREATE TABLE watchdog_probe(id int)',
      ])
        await assert.rejects(watchdog.query(sql), readOnly, sql);
      await assert.rejects(
        watchdog.query('BEGIN READ WRITE; UPDATE devices SET name=name; COMMIT'),
        denied,
      );
      await watchdog.query('ROLLBACK').catch(() => undefined);
    } finally {
      await watchdog.end();
    }

    // Privilege drift is caught by the apply-time assertion.
    await admin.query(`GRANT SELECT ON ${schema}.organizations TO ${role}`);
    await assert.rejects(
      admin.query(watchdogAssertSql(role, { schema, database })),
      /watchdog SELECT privileges differ from the reviewed list: organizations\.id/,
    );
    await admin.query(`REVOKE SELECT ON ${schema}.organizations FROM ${role}`);
    await admin.query(`GRANT UPDATE(name) ON ${schema}.devices TO ${role}`);
    await assert.rejects(admin.query(watchdogAssertSql(role, { schema, database })), /can write/);
    // A fresh apply removes the drift again.
    const rotated = randomBytes(32).toString('hex');
    await applyAsAdmin(admin, watchdogApplySql({ password: rotated, role, schema, database }));
    await admin.query(watchdogAssertSql(role, { schema, database }));
    // The stored SCRAM verifier belongs to the rotated password (independent of pg_hba).
    const stored = (await admin.query('SELECT rolpassword FROM pg_authid WHERE rolname=$1', [role]))
      .rows[0].rolpassword;
    const salt = Buffer.from(stored.split('$')[1].split(':')[1], 'base64');
    assert.equal(stored, scramVerifier(rotated, salt));
    assert.notEqual(stored, scramVerifier(password, salt));
    const old = createPool(roleUrl(base, role, password, schema), 1);
    // Local developer clusters may use pg_hba trust; CI/VPS use scram-sha-256.
    const enforced = await old.query('SELECT 1').then(
      () => false,
      (error) => error.code === '28P01',
    );
    if (!enforced) t.diagnostic('pg_hba trust: old-password rejection not observable here');
    await old.end();

    // End-to-end dry run against the real role: alerts printed, nothing sent or stored.
    const printed = [];
    const now = Date.now();
    const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const files = new Map([
      [
        '/facts.json',
        JSON.stringify({
          version: 1,
          collectedAt: iso(now - MIN),
          logWindowSeconds: 600,
          collectorErrors: [],
          containers: {
            'kaspi-bridge': {
              present: true,
              status: 'running',
              running: true,
              health: 'healthy',
              restarts: 0,
              startedAt: iso(now - DAY),
            },
            'kaspi-remote-worker': {
              present: true,
              status: 'running',
              running: true,
              health: null,
              restarts: 0,
              startedAt: iso(now - DAY),
            },
            'kiosk-qr-worker': {
              present: true,
              status: 'running',
              running: true,
              health: null,
              restarts: 0,
              startedAt: iso(now - DAY),
            },
          },
          workerEvents: { 'kaspi-remote-worker': [], 'kiosk-qr-worker': [] },
          disks: [{ path: '/', usedPercent: 40, sizeBytes: 100, availBytes: 60 }],
          backups: {
            files: [
              {
                name: 'cloud-20261009T021500Z.dump.age',
                mtime: iso(now - 60 * MIN),
                sizeBytes: 10,
                checksum: true,
              },
            ],
          },
          kaspiSessionProbe: null,
        }),
      ],
    ]);
    const code = await runWatchdog({
      argv: ['--facts', '/facts.json', '--state', '/state.json', '--dry-run'],
      env: { WATCHDOG_DB_PASSWORD: rotated, WATCHDOG_DB_USER: role, WATCHDOG_TIMEZONE: 'UTC' },
      now: () => now,
      fetcher: async () => new Response(JSON.stringify({ ready: true }), { status: 200 }),
      readText: async (path) => files.get(path) ?? Promise.reject(new Error('missing')),
      writeText: async () => assert.fail('dry run must not write state'),
      connect: async () => createPool(roleUrl(base, role, rotated, schema), 1),
      print: (record) => printed.push(record),
    });
    assert.equal(code, 0);
    const failing = printed
      .filter((record) => record.event === 'watchdog_finding' && record.status === 'fail')
      .map((record) => [record.key, record.severity])
      .sort();
    assert.deepEqual(
      failing,
      [
        [`device.identity.${ids.edgeA}`, 'warning'],
        [`device.identity.${ids.posExpired}`, 'critical'],
        [`edge.heartbeat.${ids.edgeA}`, 'critical'],
        ['kitchen.backlog', 'critical'],
        ['orders.review', 'critical'],
        ['worker.kaspi-remote-worker.backlog', 'critical'],
        ['worker.kaspi-remote-worker.unknown', 'critical'],
        ['worker.kiosk-qr-worker.backlog', 'critical'],
        ['worker.kiosk-qr-worker.unknown', 'critical'],
      ].sort(),
    );
    const message = printed.find((record) => record.event === 'watchdog_message').text;
    assert.match(message, /ТРЕВОГА \(критично\): Пульс кассы "Касса A"/);
    assert.doesNotMatch(JSON.stringify(printed), new RegExp(rotated));

    // The real CLI as the container runs it: node --env-file=<filled example> main.mjs.
    const api = createServer((request, response) => {
      response.writeHead(request.url === '/health/ready' ? 503 : 404, {
        'Content-Type': 'application/json',
      });
      response.end(
        JSON.stringify({
          service: 'api',
          ready: false,
          degraded: true,
          dependencies: { database: 'up', schema: 'down', redis: 'up' },
        }),
      );
    });
    await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
    const directory = await mkdtemp(join(tmpdir(), 'pickchick-watchdog-'));
    try {
      const example = await readFile(
        new URL('../../infra/staging/watchdog.env.example', import.meta.url),
        'utf8',
      );
      const overrides = {
        WATCHDOG_DB_PASSWORD: rotated,
        WATCHDOG_DB_USER: role,
        WATCHDOG_DB_NAME: database,
        WATCHDOG_DB_HOST: base.hostname,
        WATCHDOG_DB_PORT: base.port || '5432',
        WATCHDOG_API_READY_URL: `http://127.0.0.1:${api.address().port}/health/ready`,
      };
      const envText = example
        .split('\n')
        .map((line) => {
          const key = line.split('=')[0];
          return key in overrides ? `${key}=${overrides[key]}` : line;
        })
        .join('\n');
      await writeFile(join(directory, 'watchdog.env'), envText, { mode: 0o600 });
      await writeFile(join(directory, 'host-facts.json'), files.get('/facts.json'), {
        mode: 0o600,
      });
      const cli = (args) =>
        promisify(execFile)(
          process.execPath,
          [
            `--env-file=${join(directory, 'watchdog.env')}`,
            fileURLToPath(new URL('../../infra/staging/watchdog/main.mjs', import.meta.url)),
            '--facts',
            join(directory, 'host-facts.json'),
            '--state',
            join(directory, 'state.json'),
            ...args,
          ],
          // Only the schema selection comes from the environment; no inherited secrets.
          {
            env: { PATH: process.env.PATH, PGOPTIONS: `-c search_path=${schema}` },
            timeout: 30_000,
          },
        );
      const dry = await cli(['--dry-run']);
      const records = dry.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const apiFinding = records.find((record) => record.key === 'api.ready');
      assert.deepEqual(
        { status: apiFinding.status, detail: apiFinding.detail },
        { status: 'fail', detail: 'HTTP 503 (database=up, schema=down, redis=up)' },
      );
      assert.equal(records.find((record) => record.key === 'watchdog.database').status, 'ok');
      assert.equal(records.at(-1).delivery, 'print');
      await assert.rejects(stat(join(directory, 'state.json')), { code: 'ENOENT' });
      // Shadow mode (Telegram off by default) persists de-dup state as a private file.
      const shadow = await cli([]);
      assert.equal(JSON.parse(shadow.stdout.trim().split('\n').at(-1)).event, 'watchdog_run');
      assert.equal((await stat(join(directory, 'state.json'))).mode & 0o777, 0o600);
      assert.equal(
        JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).delivery,
        'print',
      );
      assert.doesNotMatch(
        dry.stdout + dry.stderr + shadow.stdout + shadow.stderr,
        new RegExp(rotated),
      );
    } finally {
      api.close();
      await rm(directory, { recursive: true, force: true });
    }

    // Rollback path: the role keeps nothing and cannot log in.
    await applyAsAdmin(admin, watchdogDisableSql({ role, database, schema }));
    const disabled = createPool(roleUrl(base, role, rotated, schema), 1);
    await assert.rejects(disabled.query('SELECT 1'), (error) =>
      ['28000', '28P01'].includes(error.code),
    );
    await disabled.end();
    const remaining = (
      await admin.query(
        `SELECT count(*)::int count FROM information_schema.column_privileges WHERE grantee=$1 AND table_schema=$2`,
        [role, schema],
      )
    ).rows[0].count;
    assert.equal(remaining, 0);
  });
});
