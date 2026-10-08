import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSyncDatabases } from '../helpers/sync.mjs';
import {
  applyEdgeRuntimeGrants,
  edgeRuntimeGrantSql,
} from '../../infra/windows/edge-runtime-grants.mjs';
import { upgradeKioskPrepaid } from '../../infra/windows/kiosk-prepaid-upgrade-db.mjs';

test('kiosk schema015-017 upgrade preserves prior data, resumes without duplicate backfill and retains minimal roles', async () => {
  const appRoot = fileURLToPath(new URL('../../', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-cashier-upgrade-'));
  try {
    for (const name of (await readdir(join(appRoot, 'db/edge/migrations'))).filter(
      (n) => n.endsWith('.sql') && n < '016',
    ))
      await copyFile(join(appRoot, 'db/edge/migrations', name), join(dir, name));
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
            upgradeKioskPrepaid(c, { ...o, branchId: '00000000-0000-0000-0000-000000000000' }),
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
          const before = await upgradeKioskPrepaid(c, o);
          assert.equal(before.migrations, 15);
          const applied = await upgradeKioskPrepaid(c, { ...o, mode: 'apply' });
          assert.equal(applied.migrations, 17);
          assert.equal(applied.fingerprint, before.fingerprint);
          const constraint = (
            await c.query(
              "SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid='fulfillment_reservations'::regclass AND conname='fulfillment_admission_origin'",
            )
          ).rows[0].d;
          assert.match(constraint, /kiosk/);
          assert.match(constraint, /mobile/);
          assert.match(constraint, /unpaid_service/);
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
          const current = await upgradeKioskPrepaid(c, o);
          const resumed = await upgradeKioskPrepaid(c, { ...o, mode: 'apply' });
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
          await c.query(
            "UPDATE schema_migrations SET checksum='changed' WHERE version='017_edge_kiosk_prepaid.sql'",
          );
          await assert.rejects(upgradeKioskPrepaid(c, o), /ledger differs/);
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
