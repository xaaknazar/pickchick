// Cutover 19.11.2026, integration (review R5; contracts 3.1, 6.1, 6.2 steps 2, 5, 8): the guarded
// owner step of the cloud, infra/staging/cutover-cloud-owner.mjs. Cloud 073/074 on an exact
// schema072 ledger in one transaction with every cutover flag off, the grants of each flag one at
// a time, all 32 switch combinations equal to provision.mjs's cutover:integration block, repeat
// and wrong-bytes refusals, and the guarded API environment step on a synthetic compose file.
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
import { OwnerGuardError, runtimePrivileges } from '../../infra/staging/unified-menu-owner.mjs';
import {
  BASELINE,
  CHECKSUMS,
  COMPOSE_FLAGS,
  MIGRATIONS,
  NEW_TABLES,
  PROVISION_KEYS,
  composeCandidate,
  composeFlag,
  cutoverPrivileges,
  deployCutover,
  parseArguments,
  setCutoverFlag,
} from '../../infra/staging/cutover-cloud-owner.mjs';

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
  assert.deepEqual(parseArguments(['inspect']), { command: 'inspect' });
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
  ])
    assert.throws(() => parseArguments(argv), OwnerGuardError, JSON.stringify(argv));
  for (const url of [
    'postgresql://pickchick_app:x@127.0.0.1:1/pickchick_cloud',
    'postgresql://pickchick_owner:x@127.0.0.1:1/other',
    'not a url',
  ])
    await assert.rejects(
      run(process.execPath, [tool, 'deploy'], {
        env: { PATH: process.env.PATH, CLOUD_DATABASE_URL: url },
      }),
      (error) =>
        error.code === 1 &&
        error.stderr.trim() === 'Cutover cloud owner guard: Owner database required',
    );
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
