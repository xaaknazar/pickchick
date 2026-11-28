import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '@pickchick/database';
import { provisionStaff } from '@pickchick/local-orders';
import { applyEdgeRuntimeGrants } from '../../infra/windows/edge-runtime-grants.mjs';
import { assertKaspiPosRuntimePrivileges } from '../../infra/windows/kaspi-pos-grants.mjs';
import { assertKaspiPosReleaseRuntimePrivileges } from '../../infra/windows/kaspi-pos-release-grants.mjs';
import { kaspiPosMigration } from '../../infra/windows/kaspi-pos-upgrade-db.mjs';
import {
  KASPI_POS_RELEASE_SHA256,
  kaspiPosReleaseMigration,
  operatorMessage,
  unsoldPaymentsWarning,
} from '../../infra/windows/kaspi-pos-release-upgrade-db.mjs';
import { withSyncDatabases } from '../helpers/sync.mjs';

// Edge schema029 -> 030 operator tool (audit 28.11 P0-1, stage 2): inspect changes nothing, apply
// adds the pinned 030 and its runtime rights in one run, a second apply refuses. Real PostgreSQL;
// synthetic data only.
const migrations = fileURLToPath(new URL('../../db/edge/migrations/', import.meta.url));
const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const CERT = 'a'.repeat(64);

async function withEdge029(run) {
  const before = await mkdtemp(join(tmpdir(), 'pickchick-edge-029-'));
  try {
    for (const name of await readdir(migrations))
      if (/^\d{3}_[a-z_]+\.sql$/.test(name) && name < '030')
        await copyFile(join(migrations, name), join(before, name));
    await withSyncDatabases(run, { edgeMigrationDirectory: before });
  } finally {
    await rm(before, { recursive: true, force: true });
  }
}

/** A cash desk with a Kaspi terminal and attempts in the given states (as the 029 runtime writes them). */
async function seedAttempts(ctx, states) {
  const edge = ctx.edge.pool;
  const cashier = await provisionStaff(edge, ctx.branch, {
    staff_id: randomUUID(),
    terminal_id: randomUUID(),
    name: 'Синтетический кассир',
    role: 'cashier',
  });
  const device = randomUUID();
  await edge.query(
    `INSERT INTO kaspi_pos_devices(id,branch_id,terminal_id,host,certificate_sha256,integration_name,
     access_token,refresh_token,token_expires_at) VALUES($1,$2,$3,'192.168.2.50',$4,'PickChick-1',
     'access-token-0','refresh-token-0','2099-01-01T00:00:00Z')`,
    [device, ctx.branch, cashier.terminal_id, CERT],
  );
  for (const [state, amount] of states) {
    const id = randomUUID();
    await edge.query(
      `INSERT INTO kaspi_pos_attempts(id,branch_id,device_id,terminal_id,staff_id,quote_id,amount_minor)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [id, ctx.branch, device, cashier.terminal_id, cashier.staff_id, randomUUID(), amount],
    );
    const step = (set, ...params) =>
      edge.query(`UPDATE kaspi_pos_attempts SET ${set} WHERE id=$1`, [id, ...params]);
    if (state === 'created') continue;
    await step("state='sending'");
    await step("state='wait', process_id='p-1'");
    if (state === 'wait') continue;
    if (state === 'success')
      await step("state='success', transaction_id='SYN-TXN', finished_at=clock_timestamp()");
    else await step("state='fail', finished_at=clock_timestamp()");
  }
  return cashier;
}

async function runtimeRole(ctx, run) {
  const role = 'edge_runtime_' + randomUUID().replaceAll('-', '');
  await ctx.edge.admin.query(
    `CREATE ROLE ${role} LOGIN PASSWORD '${randomBytes(32).toString('hex')}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
  );
  try {
    // The 029 edge as the 029 tool left it: the runtime holds the 029 set only.
    await applyEdgeRuntimeGrants(ctx.edge.pool, role, {
      schema: ctx.edge.schema,
      fulfillment: true,
    });
    await run(role);
  } finally {
    await ctx.edge.admin.query(`DROP OWNED BY ${role}`);
    await ctx.edge.admin.query(`DROP ROLE ${role}`);
  }
}

const rowCounts = async (client) =>
  (
    await client.query(
      `SELECT (SELECT count(*) FROM kaspi_pos_attempts)::int AS attempts,
         (SELECT count(*) FROM kaspi_pos_devices)::int AS devices,
         (SELECT count(*) FROM local_staff)::int AS staff,
         (SELECT count(*) FROM schema_migrations)::int AS ledger,
         to_regclass('kaspi_pos_attempt_releases') IS NOT NULL AS releases`,
    )
  ).rows[0];

test('operator upgrade 029 -> 030: inspect changes nothing, apply adds 030 with the runtime rights once and keeps every paid attempt', async () => {
  await withEdge029(async (ctx) => {
    await seedAttempts(ctx, [
      ['success', '299000'],
      ['success', '100000'],
      ['fail', '50000'],
      ['wait', '40000'],
    ]);
    await runtimeRole(ctx, async (role) => {
      const client = await ctx.edge.pool.connect();
      try {
        const options = {
          appRoot,
          branchId: ctx.branch,
          schema: ctx.edge.schema,
          runtimeRole: role,
        };
        const start = await rowCounts(client);
        assert.deepEqual(start, { attempts: 4, devices: 1, staff: 1, ledger: 29, releases: false });

        const inspected = await kaspiPosReleaseMigration(client, { ...options, mode: 'inspect' });
        assert.equal(inspected.migrations, 29);
        assert.equal(inspected.applied, false);
        assert.equal(inspected.alreadyInstalled, false);
        assert.equal(inspected.runtimeRolePresent, true);
        assert.equal(inspected.runtimeGrantsVerified, false);
        // The operator learns what 030 will hold at the shift close: two paid payments, no order.
        assert.deepEqual(inspected.unsoldPayments, { count: 2, amountMinor: '399000' });
        assert.match(
          inspected.unsoldPaymentsWarning,
          /^2 paid Kaspi terminal payment\(s\) without an order, 399000 minor units/,
        );
        assert.deepEqual(await rowCounts(client), start);

        const applied = await kaspiPosReleaseMigration(client, { ...options, mode: 'apply' });
        assert.equal(applied.applied, true);
        assert.equal(applied.migrations, 30);
        assert.equal(applied.releases, 0);
        assert.equal(applied.runtimeGrantsVerified, true);
        assert.deepEqual(applied.unsoldPayments, { count: 2, amountMinor: '399000' });
        assert.ok(applied.unsoldPaymentsWarning);
        assert.deepEqual(await rowCounts(client), { ...start, ledger: 30, releases: true });
        const pinned = JSON.parse(
          await readFile(join(appRoot, 'infra/windows/native-edge-backup-ledger.json'), 'utf8'),
        );
        const ledger = (
          await client.query(
            'SELECT scope,version,checksum FROM schema_migrations ORDER BY version',
          )
        ).rows.map(({ scope, version, checksum }) => ({ version, checksum, scope }));
        assert.deepEqual(ledger, pinned.slice(0, 30));
        assert.equal(ledger[29].checksum, KASPI_POS_RELEASE_SHA256);
        // Paid attempts are exactly as they were.
        assert.deepEqual(
          (
            await client.query(
              `SELECT state,amount_minor::text AS amount,(order_id IS NULL) AS unsold
                 FROM kaspi_pos_attempts ORDER BY created_at`,
            )
          ).rows,
          [
            { state: 'success', amount: '299000', unsold: true },
            { state: 'success', amount: '100000', unsold: true },
            { state: 'fail', amount: '50000', unsold: true },
            { state: 'wait', amount: '40000', unsold: true },
          ],
        );
        // Granted in the same run: SELECT and INSERT on the releases table, 029 set untouched.
        assert.equal(
          (await assertKaspiPosReleaseRuntimePrivileges(client, role, ctx.edge.schema)).tables,
          1,
        );
        assert.equal(
          (await assertKaspiPosRuntimePrivileges(client, role, ctx.edge.schema)).tables,
          2,
        );

        await assert.rejects(
          kaspiPosReleaseMigration(client, { ...options, mode: 'apply' }),
          /already applied/,
        );
        assert.deepEqual(await rowCounts(client), { ...start, ledger: 30, releases: true });
        const again = await kaspiPosReleaseMigration(client, { ...options, mode: 'inspect' });
        assert.equal(again.alreadyInstalled, true);
        assert.equal(again.migrations, 30);
        assert.equal(again.applied, false);
        assert.equal(again.runtimeGrantsVerified, true);
        assert.deepEqual(again.unsoldPayments, { count: 2, amountMinor: '399000' });

        // The 029 tool on the upgraded edge: installed, never applied again.
        const old = await kaspiPosMigration(client, { ...options, mode: 'inspect' });
        assert.equal(old.alreadyInstalled, true);
        assert.equal(old.migrations, 30);
        await assert.rejects(
          kaspiPosMigration(client, { ...options, mode: 'apply' }),
          /already applied/,
        );
        await assert.rejects(
          kaspiPosReleaseMigration(client, { ...options, branchId: randomUUID(), mode: 'inspect' }),
          /Branch differs/,
        );
      } finally {
        client.release();
      }
    });
  });
});

test('operator upgrade 029 -> 030: no payments without an order means no warning; a missing runtime role is only reported', async () => {
  await withEdge029(async (ctx) => {
    await seedAttempts(ctx, [['fail', '50000']]);
    const client = await ctx.edge.pool.connect();
    try {
      const options = {
        appRoot,
        branchId: ctx.branch,
        schema: ctx.edge.schema,
        runtimeRole: 'no_such_runtime_role',
      };
      const applied = await kaspiPosReleaseMigration(client, { ...options, mode: 'apply' });
      assert.equal(applied.runtimeRolePresent, false);
      assert.equal(applied.runtimeGrantsVerified, false);
      assert.deepEqual(applied.unsoldPayments, { count: 0, amountMinor: '0' });
      assert.equal(applied.unsoldPaymentsWarning, null);
      assert.equal((await rowCounts(client)).ledger, 30);
    } finally {
      client.release();
    }
  });
  assert.equal(unsoldPaymentsWarning({ count: 0, amountMinor: '0' }), null);
  assert.equal(unsoldPaymentsWarning(null), null);
});

test('operator upgrade 029 -> 030: other bytes, a foreign ledger, a foreign branch, a running service or a drifted right refuse and change nothing', async () => {
  await withEdge029(async (ctx) => {
    await seedAttempts(ctx, [['success', '299000']]);
    await runtimeRole(ctx, async (role) => {
      const client = await ctx.edge.pool.connect();
      const temporary = await mkdtemp(join(tmpdir(), 'pickchick-release-tool-'));
      try {
        const options = {
          appRoot,
          branchId: ctx.branch,
          schema: ctx.edge.schema,
          runtimeRole: role,
        };
        const start = await rowCounts(client);
        const unchanged = async () => assert.deepEqual(await rowCounts(client), start);

        // Other bytes of 030 in the app root.
        const copy = join(temporary, 'app');
        await mkdir(join(copy, 'db/edge/migrations'), { recursive: true });
        await mkdir(join(copy, 'infra/windows'), { recursive: true });
        await copyFile(
          join(appRoot, 'infra/windows/native-edge-backup-ledger.json'),
          join(copy, 'infra/windows/native-edge-backup-ledger.json'),
        );
        const sql = await readFile(join(migrations, '030_edge_kaspi_pos_release.sql'), 'utf8');
        await writeFile(
          join(copy, 'db/edge/migrations/030_edge_kaspi_pos_release.sql'),
          sql + '\n-- x\n',
        );
        await assert.rejects(
          kaspiPosReleaseMigration(client, { ...options, appRoot: copy, mode: 'apply' }),
          /Expected the reviewed migration030 and its ledger/,
        );
        // Right bytes, but the pinned ledger lacks the 030 row.
        await writeFile(join(copy, 'db/edge/migrations/030_edge_kaspi_pos_release.sql'), sql);
        const ledgerFile = join(copy, 'infra/windows/native-edge-backup-ledger.json');
        const rows = JSON.parse(await readFile(ledgerFile, 'utf8'));
        await writeFile(ledgerFile, JSON.stringify(rows.slice(0, 29)));
        await assert.rejects(
          kaspiPosReleaseMigration(client, { ...options, appRoot: copy, mode: 'inspect' }),
          /Expected the reviewed migration030 and its ledger/,
        );
        await writeFile(
          ledgerFile,
          JSON.stringify([...rows.slice(0, 29), { ...rows[29], checksum: '0'.repeat(64) }]),
        );
        await assert.rejects(
          kaspiPosReleaseMigration(client, { ...options, appRoot: copy, mode: 'apply' }),
          /Expected the reviewed migration030 and its ledger/,
        );
        await unchanged();

        // A ledger that is not exactly the first 29 pinned rows: one changed checksum, one row short.
        await client.query(
          "UPDATE schema_migrations SET checksum=repeat('0',64) WHERE version LIKE '028%'",
        );
        await assert.rejects(
          kaspiPosReleaseMigration(client, { ...options, mode: 'apply' }),
          /Expected unchanged schema029 and only reviewed migration030/,
        );
        await client.query("UPDATE schema_migrations SET checksum=$1 WHERE version LIKE '028%'", [
          rows[27].checksum,
        ]);
        const shortRow = (
          await client.query(
            "DELETE FROM schema_migrations WHERE version LIKE '029%' RETURNING scope,version,checksum",
          )
        ).rows[0];
        await assert.rejects(
          kaspiPosReleaseMigration(client, { ...options, mode: 'apply' }),
          /Expected unchanged schema029 and only reviewed migration030/,
        );
        await client.query(
          'INSERT INTO schema_migrations(scope,version,checksum) VALUES($1,$2,$3)',
          [shortRow.scope, shortRow.version, shortRow.checksum],
        );
        await unchanged();

        // A foreign branch.
        await assert.rejects(
          kaspiPosReleaseMigration(client, { ...options, branchId: randomUUID(), mode: 'apply' }),
          /Branch differs/,
        );
        // Objects of 030 that exist without its ledger row.
        await client.query('CREATE TABLE kaspi_pos_attempt_releases(attempt_id uuid)');
        await assert.rejects(
          kaspiPosReleaseMigration(client, { ...options, mode: 'apply' }),
          /release objects already exist/,
        );
        await client.query('DROP TABLE kaspi_pos_attempt_releases');
        await unchanged();

        // A service of another role connected: services are not stopped.
        const url = new URL(ctx.edge.config.databaseUrl);
        const login = 'edge_other_' + randomUUID().replaceAll('-', '');
        const password = randomBytes(32).toString('hex');
        await ctx.edge.admin.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' NOSUPERUSER`);
        url.username = login;
        url.password = password;
        const busy = createPool(url.toString(), 1);
        try {
          await busy.query('SELECT 1');
          await assert.rejects(
            kaspiPosReleaseMigration(client, { ...options, mode: 'apply' }),
            /Edge services must be stopped/,
          );
        } finally {
          await busy.end();
          await ctx.edge.admin.query(`DROP ROLE ${login}`);
        }

        // A drifted 029 right on the runtime role stops the run and rolls 030 back as a whole.
        await client.query(`GRANT DELETE ON kaspi_pos_attempts TO ${role}`);
        await assert.rejects(
          kaspiPosReleaseMigration(client, { ...options, mode: 'apply' }),
          /Kaspi POS table privileges differ on kaspi_pos_attempts/,
        );
        await unchanged();
        await client.query(`REVOKE DELETE ON kaspi_pos_attempts FROM ${role}`);

        // After the refusals the same call still applies.
        assert.equal(
          (await kaspiPosReleaseMigration(client, { ...options, mode: 'apply' })).applied,
          true,
        );
      } finally {
        client.release();
        await rm(temporary, { recursive: true, force: true });
      }
    });
  });
});

test('operator upgrade 029 -> 030: only its own refusals reach the operator', () => {
  assert.equal(
    operatorMessage(Object.assign(new Error('Branch differs'), { refusal: true })),
    'Branch differs',
  );
  assert.equal(operatorMessage(new Error('connect ECONNREFUSED 127.0.0.1:55433')), '');
  assert.equal(
    operatorMessage(
      new Error('Kaspi POS release table privileges differ on kaspi_pos_attempt_releases'),
    ),
    'Kaspi POS release table privileges differ on kaspi_pos_attempt_releases',
  );
});

test('operator upgrade 029 -> 030: the command line refuses a bad call or a foreign database before any connection and prints no secret', async () => {
  const script = fileURLToPath(
    new URL('../../infra/windows/kaspi-pos-release-upgrade-db.mjs', import.meta.url),
  );
  const branch = randomUUID();
  const local = 'postgresql://pickchick_edge_owner:s3cret-pw@127.0.0.1:55433/pickchick_edge';
  for (const [env, args, message] of [
    [{ EDGE_DATABASE_URL: local }, ['apply'], 'Invalid Kaspi POS release migration invocation'],
    [
      { EDGE_DATABASE_URL: local },
      ['grant', 'tools', 'app', branch],
      'Invalid Kaspi POS release migration invocation',
    ],
    [
      { EDGE_DATABASE_URL: local },
      ['inspect', 'tools', 'app', 'not-a-branch'],
      'Invalid Kaspi POS release migration invocation',
    ],
    [
      { EDGE_DATABASE_URL: local },
      ['inspect', 'tools', 'app', branch, 'extra'],
      'Invalid Kaspi POS release migration invocation',
    ],
    [
      { EDGE_DATABASE_URL: local.replace('127.0.0.1', '10.0.0.5') },
      ['apply', 'tools', 'app', branch],
      'Expected local edge owner',
    ],
    [
      { EDGE_DATABASE_URL: local.replace('pickchick_edge_owner', 'pickchick_edge_runtime') },
      ['apply', 'tools', 'app', branch],
      'Expected local edge owner',
    ],
  ])
    await assert.rejects(
      promisify(execFile)(process.execPath, [script, ...args], {
        env: { PATH: process.env.PATH, ...env },
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, new RegExp(`stopped: ${message}; inspect protected state`));
        assert.doesNotMatch(error.stderr, /s3cret-pw|10\.0\.0\.5/);
        assert.equal(error.stdout, '');
        return true;
      },
    );
});
