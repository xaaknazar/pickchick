import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readdir, readFile, copyFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSyncDatabases } from '../helpers/sync.mjs';
import {
  applyEdgeRuntimeGrants,
  edgeRuntimeGrantSql,
} from '../../infra/windows/edge-runtime-grants.mjs';
import {
  readCashierReportMigrations,
  reviewedCashierLedger,
  upgradeCashierReports,
} from '../../infra/windows/cashier-reports-upgrade-db.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const pinned = JSON.parse(
  await readFile(new URL('../../infra/windows/native-edge-backup-ledger.json', import.meta.url)),
);
/** A later candidate migration that must never be executed by the cashier upgrade. */
const UNREVIEWED_FUTURE = "DO $$ BEGIN RAISE EXCEPTION 'unreviewed migration executed'; END $$;\n";

/** Candidate app folder: the repo's edge migrations, edited by `change` (name -> bytes|null). */
async function candidate(root, change = {}) {
  const dir = join(root, 'db', 'edge', 'migrations');
  await mkdir(dir, { recursive: true });
  for (const name of (await readdir(join(repoRoot, 'db/edge/migrations'))).filter((n) =>
    n.endsWith('.sql'),
  ))
    if (!(name in change))
      await copyFile(join(repoRoot, 'db/edge/migrations', name), join(dir, name));
  for (const [name, bytes] of Object.entries(change))
    if (bytes !== null) await writeFile(join(dir, name), bytes);
  return root;
}

test('cashier upgrade pins 001-016 by name and checksum and tolerates later candidate files', async () => {
  const roots = await mkdtemp(join(tmpdir(), 'pickchick-cashier-candidates-'));
  try {
    const reviewed = pinned.slice(0, 16).map(({ scope, version, checksum }) => ({
      scope,
      version,
      checksum,
    }));
    assert.deepEqual(reviewedCashierLedger(pinned), reviewed);
    // The repo app folder already carries later reviewed migrations (017-019).
    const repo = await readCashierReportMigrations(repoRoot);
    assert.deepEqual(repo.expected, reviewed);
    assert.equal(
      repo.migrationSql,
      await readFile(join(repoRoot, 'db/edge/migrations/016_edge_cashier_reports.sql'), 'utf8'),
    );
    const future = await readCashierReportMigrations(
      await candidate(join(roots, 'future'), { '020_edge_future.sql': UNREVIEWED_FUTURE }),
    );
    assert.deepEqual(future.expected, reviewed);
    assert.ok(!future.migrationSql.includes('unreviewed'));
    for (const [name, change] of Object.entries({
      changed016: { '016_edge_cashier_reports.sql': '-- changed\n' },
      changed001: { '001_edge_foundation.sql': '-- changed\n' },
      renamed016: {
        '016_edge_cashier_reports.sql': null,
        '016_edge_cashier_report.sql': await readFile(
          join(repoRoot, 'db/edge/migrations/016_edge_cashier_reports.sql'),
        ),
      },
      only015: Object.fromEntries(pinned.slice(15).map(({ version }) => [version, null])),
      gap: { '017_edge_kiosk_prepaid.sql': null },
      badLaterName: { '020-future.sql': UNREVIEWED_FUTURE },
      skippedLater: { '021_edge_future.sql': UNREVIEWED_FUTURE },
    }))
      await assert.rejects(
        readCashierReportMigrations(await candidate(join(roots, name), change)),
        /Expected reviewed migrations 001-016/,
        name,
      );
    for (const broken of [
      pinned.slice(0, 15),
      pinned.map((row, index) => (index === 15 ? { ...row, version: '016_other.sql' } : row)),
      pinned.map((row, index) => (index === 3 ? { ...row, checksum: 'changed' } : row)),
      pinned.map((row, index) => (index === 17 ? { ...row, scope: 'cloud' } : row)),
      pinned.map((row, index) => (index === 0 ? { ...row, extra: true } : row)),
    ])
      assert.throws(() => reviewedCashierLedger(broken), /Pinned edge migration ledger is invalid/);
  } finally {
    await rm(roots, { recursive: true, force: true });
  }
});

test('cashier schema upgrade preserves prior data, resumes without duplicate backfill and retains minimal roles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-cashier-upgrade-'));
  try {
    // Newer candidate: every repo migration (001-019) plus a later file that fails if executed.
    const appRoot = await candidate(join(dir, 'candidate'), {
      '020_edge_future.sql': UNREVIEWED_FUTURE,
    });
    for (const name of (await readdir(join(repoRoot, 'db/edge/migrations'))).filter(
      (n) => n.endsWith('.sql') && n < '016',
    ))
      await copyFile(join(repoRoot, 'db/edge/migrations', name), join(dir, name));
    await withSyncDatabases(
      async (f) => {
        const c = await f.edge.pool.connect();
        const suffix = f.branch.replaceAll('-', '');
        const posRole = 'pos_' + suffix,
          workerRole = 'worker_' + suffix;
        try {
          await c.query(`CREATE ROLE ${posRole};CREATE ROLE ${workerRole}`);
          const o = {
            mode: 'inspect',
            appRoot,
            branchId: f.branch,
            schema: f.edge.schema,
            posRole,
            workerRole,
          };
          await assert.rejects(
            upgradeCashierReports(c, { ...o, branchId: '00000000-0000-0000-0000-000000000000' }),
            /Branch differs/,
          );
          const id = '11111111-1111-4111-8111-111111111111';
          await c.query(
            "INSERT INTO local_staff(id,branch_id,name,role,access_expires_at) VALUES($1,$2,'Synthetic','cashier',now()+interval '1 day')",
            [id, f.branch],
          );
          await c.query('INSERT INTO local_terminals(id,branch_id) VALUES($1,$2)', [id, f.branch]);
          await c.query(
            "INSERT INTO local_cash_shifts(id,branch_id,terminal_id,staff_id,opening_cash_minor,opened_at) VALUES($1,$2,$1,$1,1234,'2026-09-28T18:30:00Z')",
            [id, f.branch],
          );
          const before = await upgradeCashierReports(c, o);
          assert.equal(before.migrations, 15);
          assert.deepEqual(await upgradeCashierReports(c, { ...o, appRoot: repoRoot }), before);
          const applied = await upgradeCashierReports(c, { ...o, mode: 'apply' });
          assert.equal(applied.migrations, 16);
          assert.equal(applied.fingerprint, before.fingerprint);
          // Only 016 was applied; the later candidate migrations were not.
          assert.deepEqual(
            (await c.query('SELECT scope,version,checksum FROM schema_migrations ORDER BY version'))
              .rows,
            reviewedCashierLedger(pinned),
          );
          assert.ok(
            !edgeRuntimeGrantSql(posRole, { schema: f.edge.schema }).includes('cashier_report'),
          );
          assert.ok(
            edgeRuntimeGrantSql(posRole, { schema: f.edge.schema, cashierReports: true }).includes(
              'cashier_report_outbox_sequence_seq',
            ),
          );
          assert.throws(
            () => edgeRuntimeGrantSql(posRole, { cashierReports: 'true' }),
            /Invalid runtime grant flag/,
          );
          await applyEdgeRuntimeGrants(f.edge.pool, posRole, { schema: f.edge.schema });
          const reportRights = (
            await c.query(
              `SELECT has_table_privilege($1,'cashier_report_outbox','INSERT') writer,has_table_privilege($1,'cashier_report_outbox','SELECT') reader,has_table_privilege($1,'cashier_report_outbox','UPDATE') updater,has_sequence_privilege($1,'cashier_report_outbox_sequence_seq','USAGE') sequence_user`,
              [posRole],
            )
          ).rows[0];
          assert.deepEqual(reportRights, {
            writer: true,
            reader: false,
            updater: false,
            sequence_user: true,
          });
          await assert.rejects(
            applyEdgeRuntimeGrants(f.edge.pool, posRole, {
              schema: f.edge.schema,
              cashierReports: false,
            }),
            /flag differs/,
          );
          await c.query('BEGIN');
          await c.query(`SET LOCAL ROLE ${posRole}`);
          await c.query(
            "UPDATE local_cash_shifts SET state='closed',version=2,closed_at=now(),closed_by_staff_id=$1,counted_cash_minor=1234,discrepancy_minor=0,closing_reason='Synthetic',closed_report='{}' WHERE id=$1",
            [id],
          );
          await c.query('COMMIT');
          await c.query('BEGIN');
          await c.query(`SET LOCAL ROLE ${posRole}`);
          await assert.rejects(
            c.query('SELECT * FROM cashier_report_outbox'),
            (error) => error.code === '42501',
          );
          await c.query('ROLLBACK');
          const count = (await c.query('SELECT count(*)::text n FROM cashier_report_outbox'))
            .rows[0].n;
          const current = await upgradeCashierReports(c, o);
          const resumed = await upgradeCashierReports(c, { ...o, mode: 'apply' });
          assert.equal(resumed.resumed, true);
          assert.equal(resumed.fingerprint, current.fingerprint);
          assert.equal(
            (await c.query('SELECT count(*)::text n FROM cashier_report_outbox')).rows[0].n,
            count,
          );
          const grants = (
            await c.query(
              `SELECT has_table_privilege($1,'cashier_report_outbox','INSERT') writer,has_column_privilege($2,'cashier_report_outbox','acknowledged_at','UPDATE') acknowledger,has_table_privilege($2,'cashier_report_outbox','DELETE') deleter`,
              [posRole, workerRole],
            )
          ).rows[0];
          assert.deepEqual(grants, { writer: true, acknowledger: true, deleter: false });
          // The database ledger stays strict: a later migration in it is not this upgrade's step.
          await c.query('INSERT INTO schema_migrations(scope,version,checksum) VALUES($1,$2,$3)', [
            'edge',
            pinned[16].version,
            pinned[16].checksum,
          ]);
          await assert.rejects(upgradeCashierReports(c, o), /ledger differs/);
          await c.query('DELETE FROM schema_migrations WHERE version=$1', [pinned[16].version]);
          assert.equal((await upgradeCashierReports(c, o)).migrations, 16);
          await c.query(
            "UPDATE schema_migrations SET checksum='changed' WHERE version='016_edge_cashier_reports.sql'",
          );
          await assert.rejects(upgradeCashierReports(c, o), /ledger differs/);
        } finally {
          await c.query(
            `DROP OWNED BY ${posRole},${workerRole};DROP ROLE ${posRole};DROP ROLE ${workerRole}`,
          );
          c.release();
        }
      },
      { edgeMigrationDirectory: dir },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
