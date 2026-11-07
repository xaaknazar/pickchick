// Cutover 19.11.2026, integration (review R5; contracts 3.1, 6.1, 6.2 steps 2, 5, 8): the guarded
// owner step of the cloud, infra/staging/cutover-cloud-owner.mjs. Cloud 073/074 on an exact
// schema072 ledger in one transaction with every cutover flag off, the grants of each flag one at
// a time, all 32 switch combinations equal to provision.mjs's cutover:integration block, repeat
// and wrong-bytes refusals, and the guarded API environment step on a synthetic compose file.
// Lane bo-ui (CR bo-ui-1 sections 3-4, CR bo-ui-6 section 2, CR bo-ui-9): cloud 075 as its own
// step on an exact schema074 ledger with every P1 flag off, and p1-grants for every accepted P1
// flag list equal to provision.mjs's cutover:bo-ui block.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { migrate } from '@pickchick/database';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { backofficeGrants } from '../../infra/staging/backoffice-grants.mjs';
import {
  assertCloudPosSalesPrivileges,
  cloudPosSalesGrants,
} from '../../infra/staging/pos-sales-grants.mjs';
import {
  assertBackofficeCutoverPrivileges,
  backofficeCutoverGrants,
} from '../../infra/staging/backoffice-cutover-grants.mjs';
import {
  assertBackofficeP1Privileges,
  backofficeP1Grants,
} from '../../infra/staging/backoffice-p1-grants.mjs';
import { OwnerGuardError, runtimePrivileges } from '../../infra/staging/unified-menu-owner.mjs';
import {
  BASELINE,
  CHECKSUMS,
  COMPOSE_FLAGS,
  MIGRATIONS,
  NEW_TABLES,
  P1_CHECKSUM,
  P1_FLAGS,
  P1_MIGRATION,
  P1_TABLES,
  PROVISION_KEYS,
  composeCandidate,
  composeFlag,
  cutoverPrivileges,
  deployBackofficeP1,
  deployCutover,
  p1Privileges,
  parseArguments,
  setBackofficeP1,
  setCutoverFlag,
} from '../../infra/staging/cutover-cloud-owner.mjs';
import { loadConfig } from '../../packages/platform/dist/index.js';

const source = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));
const tool = fileURLToPath(new URL('../../infra/staging/cutover-cloud-owner.mjs', import.meta.url));
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const run = promisify(execFile);
const OFF = { posSalesSync: false, roles: false, stockV2: false, salesReport: false };

/** The reviewed cloud files accepted by `keep`, copied into a fresh directory. */
async function copyMigrations(prefix, keep) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  for (const f of await readdir(source))
    if (/^\d{3}_[a-z0-9_]+\.sql$/.test(f) && keep(f)) await copyFile(join(source, f), join(dir, f));
  return dir;
}
const number = (file) => Number(file.slice(0, 3));

// The cutover:integration block of provision.mjs, run as is for a twin role (as in
// cutover-staging-provision.test.mjs): what the full provision gives the same switches.
const provision = readFileSync(
  new URL('../../infra/staging/provision.mjs', import.meta.url),
  'utf8',
);
const block = provision.slice(
  provision.indexOf('// cutover:integration begin'),
  provision.indexOf('// cutover:integration end'),
);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
function provisionBlock(role, schema) {
  const body = block.replaceAll("'pickchick_app'", `'${role}'`);
  assert.ok(!body.includes('pickchick_app'));
  const fn = new AsyncFunction(
    'client',
    'config',
    'process',
    'cloudPosSalesGrants',
    'backofficeCutoverGrants',
    'assertCloudPosSalesPrivileges',
    'assertBackofficeCutoverPrivileges',
    body,
  );
  return (client, flags) =>
    fn(
      client,
      {
        ...(flags.receiver ? { posSalesSyncEnabled: true } : {}),
        ...(flags.backoffice ? { backofficeEnabled: true } : {}),
      },
      {
        env: {
          BACKOFFICE_ROLES_ENABLED: String(flags.roles),
          BACKOFFICE_STOCK_V2_ENABLED: String(flags.stockV2),
          BACKOFFICE_SALES_REPORT_ENABLED: String(flags.salesReport),
        },
      },
      (name, options) => cloudPosSalesGrants(name, options, schema),
      (name, options) => backofficeCutoverGrants(name, options, schema),
      (db, name, options) => assertCloudPosSalesPrivileges(db, name, options, schema),
      (db, name, options) => assertBackofficeCutoverPrivileges(db, name, options, schema),
    );
}

// The cutover:bo-ui block of provision.mjs (lane bo-ui, the last statement of the transaction), run
// as is for a twin role with the config loadConfig('api') makes of the same P1 flags.
const p1Block = provision.slice(
  provision.indexOf('// cutover:bo-ui begin'),
  provision.indexOf('// cutover:bo-ui end'),
);
function provisionP1Block(role, schema) {
  const body = p1Block.replaceAll("'pickchick_app'", `'${role}'`);
  assert.ok(!body.includes('pickchick_app'));
  const fn = new AsyncFunction(
    'client',
    'config',
    'process',
    'backofficeP1Grants',
    'assertBackofficeP1Privileges',
    body,
  );
  return (client, backoffice, enabled) => {
    const env = {
      APP_ENV: 'local',
      CLOUD_DATABASE_URL: 'postgresql://pickchick_local:x@127.0.0.1:55432/pickchick_cloud',
      REDIS_URL: 'redis://127.0.0.1:56379/0',
      CATALOG_ADMIN_ENABLED: 'true',
      BACKOFFICE_ENABLED: String(backoffice),
      ...Object.fromEntries(
        Object.entries(P1_FLAGS).map(([name, [, key]]) => [key, String(enabled.includes(name))]),
      ),
    };
    return fn(
      client,
      loadConfig('api', env),
      { env },
      (name, options) => backofficeP1Grants(name, options, schema),
      (db, name, options) => assertBackofficeP1Privileges(db, name, options, schema),
    );
  };
}
/** Every P1 flag list p1-grants accepts (autoconsume only with stock-v2), in P1_FLAGS order. */
const P1_LISTS = (() => {
  const names = Object.keys(P1_FLAGS);
  const lists = [];
  for (let mask = 0; mask < 2 ** names.length; mask += 1) {
    const list = names.filter((_, i) => mask & (1 << i));
    if (!list.includes('autoconsume') || list.includes('stock-v2')) lists.push(list);
  }
  return lists;
})();
const p1Only = (privileges) => privileges.filter((p) => P1_TABLES.includes(p.split('|')[0]));

/** A cloud on exact schema072 (the VPS before Cloud-1) and an API role with backofficeGrants. */
async function withCloud072(backoffice, body) {
  const baseline = await copyMigrations('cutover-owner-072-', (f) => number(f) <= 72);
  try {
    await withSyncDatabases(
      async (ctx) => {
        const role = 'cutover_owner_' + randomUUID().replaceAll('-', '').slice(0, 20);
        await ctx.cloud.admin.query(`CREATE ROLE ${role} NOLOGIN`);
        try {
          await ctx.cloud.pool.query(backofficeGrants(role, backoffice));
          const client = await ctx.cloud.pool.connect();
          try {
            await body({ ctx, client, role, schema: ctx.cloud.schema });
          } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
          }
        } finally {
          await ctx.cloud.pool.query(`DROP OWNED BY ${role}`);
          await ctx.cloud.admin.query(`DROP ROLE ${role}`);
        }
      },
      { cloudMigrationDirectory: baseline },
    );
  } finally {
    await rm(baseline, { recursive: true, force: true });
  }
}
/** One owner transaction, committed (or rolled back for inspect and refusals). */
async function owner(client, operation, commit = true) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    const result = await operation();
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
const guardError = (pattern) => (error) =>
  error instanceof OwnerGuardError && pattern.test(error.message);
const cutoverOnly = (privileges) => privileges.filter((p) => NEW_TABLES.includes(p.split('|')[0]));

test('the tool pins the reviewed 072/073/074 bytes, parses only its commands and refuses the runtime role before connecting', async () => {
  for (const [name, checksum] of Object.entries(CHECKSUMS))
    assert.equal(sha256(await readFile(join(source, name))), checksum, name);
  assert.deepEqual(Object.keys(CHECKSUMS), [BASELINE, ...MIGRATIONS]);
  const hex = 'a'.repeat(64);
  assert.equal(sha256(await readFile(join(source, P1_MIGRATION))), P1_CHECKSUM, P1_MIGRATION);
  assert.equal(P1_MIGRATION, '075_cloud_backoffice_ops.sql');
  assert.deepEqual(parseArguments(['inspect']), { command: 'inspect' });
  for (const command of ['inspect-075', 'deploy-075'])
    assert.deepEqual(parseArguments([command]), { command });
  assert.deepEqual(parseArguments(['p1-grants', 'none']), { command: 'p1-grants', enabled: [] });
  assert.deepEqual(parseArguments(['p1-grants', 'stock-v2,pos-day']), {
    command: 'p1-grants',
    enabled: ['stock-v2', 'pos-day'],
  });
  assert.deepEqual(parseArguments(['flag', 'pos-sales-sync', 'true']), {
    command: 'flag',
    flag: 'pos-sales-sync',
    enabled: true,
  });
  assert.deepEqual(
    parseArguments([
      'compose-flag',
      'aggregator-prices',
      'false',
      '--compose',
      'c',
      '--sha256',
      hex,
      '--out',
      'o',
    ]),
    {
      command: 'compose-flag',
      flag: 'aggregator-prices',
      enabled: false,
      compose: 'c',
      sha256: hex,
      out: 'o',
    },
  );
  for (const argv of [
    [],
    ['deploy', '--with-072'],
    ['flag', 'aggregator-prices', 'true'],
    ['flag', 'roles', 'yes'],
    ['flag', 'roles'],
    ['compose-candidate', '--compose', 'c', '--sha256', 'abc', '--out', 'o'],
    ['compose-candidate', '--compose', 'c', '--sha256', hex],
    ['compose-flag', 'bo-ui', 'true', '--compose', 'c', '--sha256', hex, '--out', 'o'],
    ['provision'],
    ['deploy-075', '--force'],
    ['p1-grants'],
    ['p1-grants', ''],
    ['p1-grants', 'pos-day,pos-day'],
    ['p1-grants', 'pos-day,bo-ui'],
    ['p1-grants', 'none', 'discounts'],
    ['flag', 'pos-day', 'true'],
  ])
    assert.throws(() => parseArguments(argv), OwnerGuardError, JSON.stringify(argv));
  for (const url of [
    'postgresql://pickchick_app:x@127.0.0.1:1/pickchick_cloud',
    'postgresql://pickchick_owner:x@127.0.0.1:1/other',
    'not a url',
  ])
    for (const command of [['deploy'], ['deploy-075'], ['p1-grants', 'none']])
      await assert.rejects(
        run(process.execPath, [tool, ...command], {
          env: { PATH: process.env.PATH, CLOUD_DATABASE_URL: url },
        }),
        (error) =>
          error.code === 1 &&
          error.stderr.trim() === 'Cutover cloud owner guard: Owner database required',
      );
  // The master runbook names the 075 step, its pinned hash and every refusal an operator can see.
  const runbook = await readFile(
    new URL('../../docs/operations/cutover-2026-11-19.md', import.meta.url),
    'utf8',
  );
  for (const text of [
    'owner inspect-075',
    'owner deploy-075',
    'owner p1-grants pos-day,stock-v2,manager-shifts,staff-positions',
    P1_CHECKSUM,
    'Cloud 075 is already applied: deploy-075 runs once',
    'Exact 075 candidate file required',
    `Reviewed migration bytes differ: ${P1_MIGRATION}`,
    'Run deploy-075 (075 with the reviewed bytes) first',
    'BACKOFFICE_ENABLED grants are required first',
    'autoconsume requires stock-v2',
    'Back-office P1 grants differ from every known flag state: run inspect-075',
  ])
    assert.ok(runbook.includes(text), text);
  const usage = await run(process.execPath, [tool, 'flag', 'roles'], {
    env: { PATH: process.env.PATH },
  }).catch((error) => error);
  assert.equal(usage.code, 1);
  assert.match(usage.stderr, /^Cutover cloud owner guard: Usage: cutover-cloud-owner\.mjs/);
});

test('deploy on exact schema072: 073 then 074 with every cutover flag off, data and ACL kept, provision-equal rights; repeat, wrong bytes and wrong ledger refused', () =>
  withCloud072(true, async ({ ctx, client, role, schema }) => {
    const candidate = await copyMigrations('cutover-owner-candidate-', (f) => number(f) <= 74);
    const tampered = await copyMigrations('cutover-owner-tampered-', (f) => number(f) <= 74);
    await writeFile(
      join(tampered, MIGRATIONS[0]),
      (await readFile(join(source, MIGRATIONS[0]), 'utf8')) + '\n-- changed\n',
    );
    const missing = await copyMigrations('cutover-owner-missing-', (f) => number(f) <= 73);
    const later = await copyMigrations('cutover-owner-later-', (f) => number(f) <= 74);
    await writeFile(join(later, '075_cloud_later_lane.sql'), 'SELECT 1;');
    try {
      const pool = ctx.cloud.pool;
      const acl = await runtimePrivileges(pool, role);
      const readSet = cutoverPrivileges({ receiver: false, backoffice: true, roles: false });
      assert.ok(readSet.length > 0 && readSet.every((p) => p.endsWith('|SELECT')));
      const inspect = (directory) =>
        owner(client, () => deployCutover(client, { directory, role, inspect: true }), false);
      await assert.rejects(inspect(tampered), guardError(/Reviewed migration bytes differ: 073_/));
      await assert.rejects(inspect(missing), guardError(/Exact 072, 073 and 074 candidate files/));
      const expectedInspect = {
        ledger: 'schema072',
        pending: [...MIGRATIONS],
        reviewedBytes: true,
        backofficeGrants: true,
        privilegesAdded: readSet,
        flags: { posSalesSync: false, roles: false },
      };
      assert.deepEqual(await inspect(candidate), expectedInspect);
      // A later lane file (cloud 075) is not part of this step and is not applied.
      assert.deepEqual(await inspect(later), expectedInspect);
      // Wrong ledgers: 072 missing (schema071) or 072 with other bytes.
      for (const change of [
        `DELETE FROM schema_migrations WHERE version='${BASELINE}'`,
        `UPDATE schema_migrations SET checksum='${'0'.repeat(64)}' WHERE version='${BASELINE}'`,
      ])
        await assert.rejects(
          owner(
            client,
            async () => {
              await client.query(change);
              return deployCutover(client, { directory: candidate, role });
            },
            false,
          ),
          guardError(/Exact schema072 ledger required/),
        );
      // Flags before deploy are refused.
      await assert.rejects(
        owner(client, () =>
          setCutoverFlag(client, { role, flag: 'pos-sales-sync', enabled: true }),
        ),
        guardError(/Run deploy/),
      );
      const ledgerBefore = (await pool.query('SELECT version FROM schema_migrations')).rows.length;

      assert.deepEqual(
        await owner(client, () => deployCutover(client, { directory: candidate, role })),
        {
          applied: [...MIGRATIONS],
          existingDataPreserved: true,
          backofficeGrants: true,
          privilegesAdded: readSet,
          privilegesRemoved: [],
          flags: OFF,
        },
      );
      const ledger = (
        await pool.query('SELECT version,checksum FROM schema_migrations ORDER BY version')
      ).rows;
      assert.equal(ledger.length, ledgerBefore + 2);
      assert.deepEqual(
        ledger.slice(-2),
        MIGRATIONS.map((version) => ({ version, checksum: CHECKSUMS[version] })),
      );
      // The standard runner accepts the ledger: nothing pending, nothing out of order.
      assert.deepEqual(await migrate(pool, candidate, 'cloud'), []);
      const deployed = await runtimePrivileges(pool, role);
      assert.deepEqual(deployed, [...new Set([...acl, ...readSet])].sort());
      assert.deepEqual(cutoverOnly(deployed), readSet);
      // provision.mjs with every cutover switch off grants exactly the same.
      await provisionBlock(role, schema)(pool, {
        receiver: false,
        backoffice: true,
        roles: false,
        stockV2: false,
        salesReport: false,
      });
      assert.deepEqual(await runtimePrivileges(pool, role), deployed);
      // Repeat refused; inspect sees the deployed state.
      await assert.rejects(
        owner(client, () => deployCutover(client, { directory: candidate, role })),
        guardError(/already applied/),
      );
      assert.deepEqual(await inspect(candidate), {
        ledger: 'schema074',
        pending: [],
        reviewedBytes: true,
        backofficeGrants: true,
        privilegesAdded: [],
        flags: { posSalesSync: false, roles: false },
      });

      // One flag at a time, exact delta; off again restores the deployed rights.
      const flag = (name, enabled) =>
        owner(client, () => setCutoverFlag(client, { role, flag: name, enabled }));
      const receiver = await flag('pos-sales-sync', true);
      assert.equal(receiver.environment, 'CLOUD_POS_SALES_SYNC_ENABLED');
      assert.deepEqual(receiver.privilegesRemoved, []);
      assert.ok(receiver.privilegesAdded.includes('cloud_pos_sale_inbox||INSERT'));
      assert.ok(receiver.privilegesAdded.includes('cloud_pos_sales|voided_at|UPDATE'));
      assert.deepEqual(
        cutoverOnly(await runtimePrivileges(pool, role)),
        cutoverPrivileges({ receiver: true, backoffice: true, roles: false }),
      );
      assert.deepEqual((await flag('roles', true)).privilegesAdded, [
        'bo_role_designations||SELECT',
      ]);
      for (const name of ['stock-v2', 'sales-report'])
        assert.deepEqual(await flag(name, true), {
          flag: name,
          enabled: true,
          privilegesAdded: [],
          privilegesRemoved: [],
          environment:
            name === 'stock-v2' ? 'BACKOFFICE_STOCK_V2_ENABLED' : 'BACKOFFICE_SALES_REPORT_ENABLED',
          order: 'grants done; now set the API environment and restart the API',
        });
      assert.deepEqual((await flag('pos-sales-sync', false)).privilegesAdded, []);
      assert.deepEqual((await flag('roles', false)).privilegesRemoved, [
        'bo_role_designations||SELECT',
      ]);
      assert.deepEqual(await runtimePrivileges(pool, role), deployed);
      // A stray grant on a cutover table is not a known state: refused until inspected.
      await pool.query(`GRANT DELETE ON ${schema}.cloud_pos_sales TO ${role}`);
      await assert.rejects(flag('roles', true), guardError(/differ from every known flag state/));
      await pool.query(`REVOKE DELETE ON ${schema}.cloud_pos_sales FROM ${role}`);
    } finally {
      for (const dir of [candidate, tampered, missing, later])
        await rm(dir, { recursive: true, force: true });
    }
  }));

const combinations = [];
for (let mask = 0; mask < 16; mask += 1)
  combinations.push({
    receiver: Boolean(mask & 1),
    roles: Boolean(mask & 2),
    stockV2: Boolean(mask & 4),
    salesReport: Boolean(mask & 8),
  });

for (const backoffice of [true, false])
  test(`every switch combination with BACKOFFICE_ENABLED=${backoffice}: the flag runs give exactly the provision.mjs rights, or are refused where provision refuses or grants nothing`, () =>
    withCloud072(backoffice, async ({ ctx, client, role, schema }) => {
      const candidate = await copyMigrations('cutover-owner-combo-', (f) => number(f) <= 74);
      try {
        await owner(client, () => deployCutover(client, { directory: candidate, role }));
        const deployed = await runtimePrivileges(ctx.cloud.pool, role);
        for (const combination of combinations) {
          const flags = { ...combination, backoffice };
          const label = JSON.stringify(flags);
          const order = [
            ['pos-sales-sync', flags.receiver],
            ['roles', flags.roles],
            ['stock-v2', flags.stockV2],
            ['sales-report', flags.salesReport],
          ].filter(([, on]) => on);
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          try {
            let refused = null;
            const done = [];
            for (const [name] of order) {
              await client.query('SAVEPOINT flag');
              try {
                await setCutoverFlag(client, { role, flag: name, enabled: true });
                done.push(name);
              } catch (error) {
                assert.ok(error instanceof OwnerGuardError, label);
                assert.match(error.message, /BACKOFFICE_ENABLED grants are required first/, label);
                await client.query('ROLLBACK TO SAVEPOINT flag');
                refused = name;
                break;
              }
            }
            // The twin: a fresh role with the same backofficeGrants and the provision block.
            const twin = 'cutover_twin_' + randomUUID().replaceAll('-', '').slice(0, 20);
            await client.query(`CREATE ROLE ${twin} NOLOGIN`);
            await client.query(backofficeGrants(twin, backoffice));
            await client.query('SAVEPOINT provision');
            const provisioned = await provisionBlock(twin, schema)(client, flags).then(
              () => true,
              (error) => {
                assert.match(String(error.message), /not writable|not readable/, label);
                return false;
              },
            );
            if (!provisioned) await client.query('ROLLBACK TO SAVEPOINT provision');
            if (refused) {
              // The tool refuses every back-office flag without BACKOFFICE_ENABLED; provision
              // then refuses too or grants nothing for it.
              assert.equal(backoffice, false, label);
              if (provisioned)
                assert.deepEqual(
                  cutoverOnly(await runtimePrivileges(client, twin)),
                  cutoverPrivileges({ receiver: flags.receiver, backoffice, roles: false }),
                  label,
                );
            } else {
              assert.ok(provisioned, label);
              assert.deepEqual(
                await runtimePrivileges(client, role),
                await runtimePrivileges(client, twin),
                label,
              );
            }
            // Off again, in reverse order: back to the deployed rights.
            for (const name of done.reverse())
              await setCutoverFlag(client, { role, flag: name, enabled: false });
            assert.deepEqual(await runtimePrivileges(client, role), deployed, label);
          } finally {
            await client.query('ROLLBACK');
          }
        }
      } finally {
        await rm(candidate, { recursive: true, force: true });
      }
    }));

test('deploy-075 on exact schema074: 075 with every P1 flag off, data and ACL kept, provision-equal; wrong ledger, bytes and repeat refused; p1-grants exact deltas', () =>
  withCloud072(true, async ({ ctx, client, role, schema }) => {
    const candidate = await copyMigrations('cutover-owner-p1-', (f) => number(f) <= 75);
    const tampered = await copyMigrations('cutover-owner-p1-tampered-', (f) => number(f) <= 75);
    await writeFile(
      join(tampered, P1_MIGRATION),
      (await readFile(join(source, P1_MIGRATION), 'utf8')) + '\n-- changed\n',
    );
    const without = await copyMigrations('cutover-owner-p1-missing-', (f) => number(f) <= 74);
    await writeFile(join(candidate, '076_cloud_later_lane.sql'), 'SELECT 1;');
    try {
      const pool = ctx.cloud.pool;
      const inspect = (directory) =>
        owner(client, () => deployBackofficeP1(client, { directory, role, inspect: true }), false);
      const grants = (enabled) => owner(client, () => setBackofficeP1(client, { role, enabled }));
      // Before Cloud-1's deploy: schema072 is not the ledger 075 needs.
      await assert.rejects(inspect(candidate), guardError(/Exact schema074 ledger required/));
      await owner(client, () => deployCutover(client, { directory: candidate, role }));
      const deployed = await runtimePrivileges(pool, role);
      await assert.rejects(grants([]), guardError(/Run deploy-075/));
      await assert.rejects(inspect(tampered), guardError(/Reviewed migration bytes differ: 075_/));
      await assert.rejects(inspect(without), guardError(/Exact 075 candidate file required/));
      assert.deepEqual(await inspect(candidate), {
        ledger: 'schema074',
        pending: [P1_MIGRATION],
        reviewedBytes: true,
        backofficeGrants: true,
        privilegesAdded: [],
        p1Privileges: [],
      });
      const ledgerBefore = (await pool.query('SELECT version FROM schema_migrations')).rows.length;
      assert.deepEqual(
        await owner(client, () => deployBackofficeP1(client, { directory: candidate, role })),
        {
          applied: [P1_MIGRATION],
          existingDataPreserved: true,
          backofficeGrants: true,
          privilegesAdded: [],
          privilegesRemoved: [],
          p1Flags: [],
        },
      );
      const ledger = (
        await pool.query('SELECT version,checksum FROM schema_migrations ORDER BY version')
      ).rows;
      assert.equal(ledger.length, ledgerBefore + 1);
      assert.deepEqual(ledger.at(-1), { version: P1_MIGRATION, checksum: P1_CHECKSUM });
      for (const table of P1_TABLES)
        assert.equal(
          (await pool.query('SELECT to_regclass($1) IS NOT NULL AS ok', [table])).rows[0].ok,
          true,
        );
      // The standard runner accepts the ledger through 075; 076 (lane bo-ui2) is not applied here.
      const through075 = await copyMigrations('cutover-owner-p1-runner-', (f) => number(f) <= 75);
      try {
        assert.deepEqual(await migrate(pool, through075, 'cloud'), []);
      } finally {
        await rm(through075, { recursive: true, force: true });
      }
      assert.deepEqual(await runtimePrivileges(pool, role), deployed);
      // provision.mjs's cutover:bo-ui block with every P1 flag off grants exactly the same.
      await provisionP1Block(role, schema)(pool, true, []);
      assert.deepEqual(await runtimePrivileges(pool, role), deployed);
      await assert.rejects(
        owner(client, () => deployBackofficeP1(client, { directory: candidate, role })),
        guardError(/already applied/),
      );
      assert.deepEqual(await inspect(candidate), {
        ledger: 'schema075',
        pending: [],
        reviewedBytes: true,
        backofficeGrants: true,
        privilegesAdded: [],
        p1Privileges: [],
      });
      // The 073/074 step is untouched by 075: its repeat is still refused, a flag still works.
      await assert.rejects(
        owner(client, () => deployCutover(client, { directory: candidate, role })),
        guardError(/already applied/),
      );

      await assert.rejects(grants(['autoconsume']), guardError(/autoconsume requires stock-v2/));
      const day = ['pos-day', 'stock-v2', 'manager-shifts', 'staff-positions'];
      const first = await grants(day);
      assert.deepEqual(first.p1Flags, day);
      assert.deepEqual(first.environment, [
        'BACKOFFICE_POS_DAY_ENABLED',
        'BACKOFFICE_STOCK_V2_ENABLED',
        'BACKOFFICE_MANAGER_SHIFTS_ENABLED',
        'BACKOFFICE_STAFF_POSITIONS_ENABLED',
      ]);
      assert.deepEqual(first.privilegesRemoved, []);
      assert.deepEqual(first.privilegesAdded, p1Privileges(true, day));
      assert.ok(first.privilegesAdded.includes('bo_branch_templates||INSERT'));
      assert.ok(
        !first.privilegesAdded.some(
          (p) => /UPDATE|DELETE|TRUNCATE/.test(p) && p.startsWith('bo_branch_templates'),
        ),
      );
      // A cutover flag keeps the P1 grants (it resets only the 073/074 tables).
      const roles = await owner(client, () =>
        setCutoverFlag(client, { role, flag: 'roles', enabled: true }),
      );
      assert.deepEqual(roles.privilegesAdded, ['bo_role_designations||SELECT']);
      assert.deepEqual(p1Only(await runtimePrivileges(pool, role)), p1Privileges(true, day));
      await owner(client, () => setCutoverFlag(client, { role, flag: 'roles', enabled: false }));
      const consume = await grants([...day, 'autoconsume']);
      assert.deepEqual(consume.privilegesRemoved, []);
      assert.deepEqual(
        p1Only(consume.privilegesAdded),
        ['bo_consumption_items', 'bo_stock_settings'].flatMap((t) =>
          ['INSERT', 'SELECT', 'UPDATE'].map((p) => `${t}||${p}`),
        ),
      );
      // Outside 075 only the helper's declared SELECTs (the worker's catalog reads) are added.
      assert.ok(
        consume.privilegesAdded
          .filter((p) => !p1Only([p]).length)
          .every((p) => p.endsWith('||SELECT')),
      );
      const off = await grants([]);
      assert.deepEqual(off.privilegesAdded, []);
      assert.deepEqual(off.privilegesRemoved, p1Privileges(true, [...day, 'autoconsume']));
      const now = await runtimePrivileges(pool, role);
      assert.deepEqual(p1Only(now), []);
      assert.deepEqual(
        now,
        [
          ...new Set([...deployed, ...consume.privilegesAdded.filter((p) => !p1Only([p]).length)]),
        ].sort(),
      );
      // A stray grant on a 075 relation is not a known state: refused until inspected.
      await pool.query(`GRANT DELETE ON ${schema}.bo_discounts TO ${role}`);
      await assert.rejects(grants(['discounts']), guardError(/differ from every known flag state/));
      assert.ok((await inspect(candidate)).p1Privileges.includes('bo_discounts||DELETE'));
      await pool.query(`REVOKE DELETE ON ${schema}.bo_discounts FROM ${role}`);
    } finally {
      for (const dir of [candidate, tampered, without])
        await rm(dir, { recursive: true, force: true });
    }
  }));

for (const backoffice of [true, false])
  test(`p1-grants with BACKOFFICE_ENABLED=${backoffice}: every accepted P1 flag list gives exactly the provision.mjs rights, or is refused where provision grants nothing`, () =>
    withCloud072(backoffice, async ({ ctx, client, role, schema }) => {
      const candidate = await copyMigrations('cutover-owner-p1-combo-', (f) => number(f) <= 75);
      try {
        await owner(client, () => deployCutover(client, { directory: candidate, role }));
        await owner(client, () => deployBackofficeP1(client, { directory: candidate, role }));
        const deployed = await runtimePrivileges(ctx.cloud.pool, role);
        assert.equal(P1_LISTS.length, 48);
        for (const list of P1_LISTS) {
          const label = JSON.stringify({ backoffice, list });
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          try {
            await client.query('SAVEPOINT grants');
            const refused = await setBackofficeP1(client, { role, enabled: list }).then(
              () => false,
              (error) => {
                assert.ok(error instanceof OwnerGuardError, label);
                assert.match(error.message, /BACKOFFICE_ENABLED grants are required first/, label);
                return true;
              },
            );
            if (refused) await client.query('ROLLBACK TO SAVEPOINT grants');
            assert.equal(refused, !backoffice && list.length > 0, label);
            // The twin: a fresh role, backofficeGrants, the cutover block, then the P1 block.
            const twin = 'cutover_twin_' + randomUUID().replaceAll('-', '').slice(0, 20);
            await client.query(`CREATE ROLE ${twin} NOLOGIN`);
            await client.query(backofficeGrants(twin, backoffice));
            await client.query('SAVEPOINT twin');
            const twinRun = await provisionBlock(twin, schema)(client, {
              receiver: false,
              backoffice,
              roles: false,
              stockV2: list.includes('stock-v2'),
              salesReport: false,
            }).catch((error) => {
              // Stock v2 without the back office: provision refuses before the P1 block.
              assert.ok(!backoffice && list.includes('stock-v2'), label);
              assert.match(error.message, /not writable|not readable/, label);
              return 'refused';
            });
            if (twinRun === 'refused') await client.query('ROLLBACK TO SAVEPOINT twin');
            if (backoffice) {
              await provisionP1Block(twin, schema)(client, backoffice, list);
              assert.deepEqual(
                await runtimePrivileges(client, role),
                await runtimePrivileges(client, twin),
                label,
              );
              assert.deepEqual(
                p1Only(await runtimePrivileges(client, role)),
                p1Privileges(true, list),
                label,
              );
            } else assert.deepEqual(await runtimePrivileges(client, role), deployed, label);
          } finally {
            await client.query('ROLLBACK');
          }
        }
      } finally {
        await rm(candidate, { recursive: true, force: true });
      }
    }));

const COMPOSE = [
  'services:',
  '  api:',
  '    image: pickchick-api:synthetic',
  '    environment:',
  '      BACKOFFICE_ENABLED: "true"',
  '      CLOUD_POS_ORDER_SYNC_ENABLED: "true"',
  '      CLOUD_DATABASE_URL: postgresql://pickchick_app:${DB_APP_PASSWORD}@cloud-db:5432/pickchick_cloud',
  '  provision:',
  '    environment:',
  '      BACKOFFICE_ENABLED: "true"',
  '      CLOUD_DATABASE_URL: postgresql://pickchick_owner:${DB_OWNER_PASSWORD}@cloud-db:5432/pickchick_cloud',
  '',
].join('\n');

test('API environment step: the candidate adds only the cutover keys, all off; each run flips one key; wrong hash, repeats and other states refused', async () => {
  const candidate = composeCandidate(COMPOSE, sha256(COMPOSE));
  const added = candidate.split('\n').filter((line) => !COMPOSE.split('\n').includes(line));
  assert.deepEqual(added, [
    ...Object.values(COMPOSE_FLAGS).map((key) => `      ${key}: "false"`),
    ...PROVISION_KEYS.map((key) => `      ${key}: "false"`),
  ]);
  assert.ok(
    candidate.indexOf('CATALOG_AGGREGATOR_PRICES_ENABLED') < candidate.indexOf('  provision:'),
    'aggregator prices only in the api service',
  );
  assert.throws(() => composeCandidate(COMPOSE, 'f'.repeat(64)), /reviewed hash/);
  assert.throws(() => composeCandidate(candidate, sha256(candidate)), /already mentions/);
  assert.throws(
    () =>
      composeCandidate(
        COMPOSE.replace('pickchick_owner', 'someone'),
        sha256(COMPOSE.replace('pickchick_owner', 'someone')),
      ),
    /anchors differ/,
  );
  let current = candidate;
  for (const [flag, key] of Object.entries(COMPOSE_FLAGS)) {
    const next = composeFlag(current, sha256(current), flag, true);
    const changed = next.split('\n').filter((line, i) => line !== current.split('\n')[i]);
    assert.deepEqual(
      changed,
      Array(PROVISION_KEYS.includes(key) ? 2 : 1).fill(`      ${key}: "true"`),
    );
    assert.throws(() => composeFlag(next, sha256(next), flag, true), /not in the expected state/);
    assert.equal(composeFlag(next, sha256(next), flag, false), current);
    current = next;
  }
  assert.throws(
    () => composeFlag(COMPOSE, sha256(COMPOSE), 'roles', true),
    /not in the expected state/,
  );
  assert.throws(() => composeFlag(candidate, sha256(COMPOSE), 'roles', true), /reviewed hash/);

  // The command line: a new output file only, both hashes printed, no other output.
  const dir = await mkdtemp(join(tmpdir(), 'cutover-owner-compose-'));
  try {
    const installed = join(dir, 'compose.yaml');
    await writeFile(installed, COMPOSE);
    const out = join(dir, 'compose.candidate.yaml');
    const args = ['--compose', installed, '--sha256', sha256(COMPOSE), '--out', out];
    const first = await run(process.execPath, [tool, 'compose-candidate', ...args], {
      env: { PATH: process.env.PATH },
    });
    assert.deepEqual(JSON.parse(first.stdout), {
      composeBefore: sha256(COMPOSE),
      composeAfter: sha256(candidate),
    });
    assert.equal(await readFile(out, 'utf8'), candidate);
    const again = await run(process.execPath, [tool, 'compose-candidate', ...args], {
      env: { PATH: process.env.PATH },
    }).catch((error) => error);
    assert.equal(again.code, 1);
    assert.equal(
      again.stderr.trim(),
      'Cutover cloud owner guard: Output file exists or is not writable',
    );
    const flagged = join(dir, 'compose.flag.yaml');
    const flip = await run(
      process.execPath,
      [
        tool,
        'compose-flag',
        'pos-sales-sync',
        'true',
        '--compose',
        out,
        '--sha256',
        sha256(candidate),
        '--out',
        flagged,
      ],
      { env: { PATH: process.env.PATH } },
    );
    const expected = composeFlag(candidate, sha256(candidate), 'pos-sales-sync', true);
    assert.deepEqual(JSON.parse(flip.stdout), {
      composeBefore: sha256(candidate),
      composeAfter: sha256(expected),
      environment: 'CLOUD_POS_SALES_SYNC_ENABLED',
      enabled: true,
    });
    assert.equal(await readFile(flagged, 'utf8'), expected);
    const wrong = await run(
      process.execPath,
      [
        tool,
        'compose-flag',
        'roles',
        'true',
        '--compose',
        installed,
        '--sha256',
        sha256(candidate),
        '--out',
        join(dir, 'x.yaml'),
      ],
      { env: { PATH: process.env.PATH } },
    ).catch((error) => error);
    assert.equal(wrong.code, 1);
    assert.equal(
      wrong.stderr.trim(),
      'Cutover cloud owner guard: Installed compose differs from the reviewed hash',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
