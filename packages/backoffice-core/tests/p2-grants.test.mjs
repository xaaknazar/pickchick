import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '@pickchick/database';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import { Backoffice, grantBackoffice } from '../dist/index.js';
import { backofficeGrants } from '../../../infra/staging/backoffice-grants.mjs';
import {
  assertBackofficeP1Privileges,
  backofficeP1Grants,
} from '../../../infra/staging/backoffice-p1-grants.mjs';
import {
  BACKOFFICE_SUPPLY_RELATIONS,
  MIGRATION,
  assertBackofficeSupplyPrivileges,
  backofficeSupplyGrants,
  backofficeSupplyPrivileges,
} from '../../../infra/staging/backoffice-supply-grants.mjs';

/** infra/staging/backoffice-supply-grants.mjs (lane bo-ui2, design-bo-ui.md «Вторая волна»). */
const MIGRATIONS = fileURLToPath(new URL('../../../db/cloud/migrations/', import.meta.url));
const OFF = Object.freeze({
  backoffice: true,
  supply: false,
  stockReports: false,
  staffAssignment: false,
});
const ALL = Object.freeze({
  backoffice: true,
  supply: true,
  stockReports: true,
  staffAssignment: true,
});
const P1_ALL = Object.freeze({
  backoffice: true,
  posDay: true,
  stockV2: true,
  autoconsume: true,
  managerShifts: true,
  discounts: true,
  staffPositions: true,
});
const WRITE = ['SELECT', 'INSERT', 'UPDATE'];
/** Back-office options with the second wave on (and the flags it builds on). */
const P2_ON = Object.freeze({
  stockV2Enabled: true,
  staffPositionsEnabled: true,
  supplyEnabled: true,
  stockReportsEnabled: true,
  staffAssignmentEnabled: true,
});
const capabilities = async (bo, token, branch) => {
  const caps = (await bo.read(token, branch)).capabilities;
  return {
    supply: caps.supply,
    stock_reports: caps.stock_reports,
    staff_assignment: caps.staff_assignment,
  };
};

test('the helper names the 076 file and exactly the relations it creates', async () => {
  const sql = await readFile(join(MIGRATIONS, MIGRATION), 'utf8');
  const created = [...sql.matchAll(/^CREATE TABLE (\w+)/gm)].map((m) => m[1]).sort();
  assert.deepEqual(Object.keys(BACKOFFICE_SUPPLY_RELATIONS).sort(), created);
});

test('privileges per flag: nothing without the back office, nothing for the stock reports', () => {
  assert.deepEqual(backofficeSupplyPrivileges({ ...ALL, backoffice: false }), {});
  assert.deepEqual(backofficeSupplyPrivileges(OFF), {});
  assert.deepEqual(backofficeSupplyPrivileges({ ...OFF, stockReports: true }), {});
  assert.deepEqual(backofficeSupplyPrivileges({ ...OFF, supply: true }), {
    bo_suppliers: WRITE,
    bo_supplier_price_imports: ['SELECT', 'INSERT'],
    bo_supplier_prices: WRITE,
    bo_supply_requests: WRITE,
  });
  assert.deepEqual(backofficeSupplyPrivileges({ ...OFF, staffAssignment: true }), {
    bo_staff_assignments: WRITE,
  });
  assert.deepEqual(
    Object.keys(backofficeSupplyPrivileges(ALL)).sort(),
    [...Object.keys(BACKOFFICE_SUPPLY_RELATIONS)].sort(),
  );
  // Never a delete, a truncate or a reference right.
  for (const rights of Object.values(backofficeSupplyPrivileges(ALL)))
    assert.deepEqual(
      rights.filter((r) => !['SELECT', 'INSERT', 'UPDATE'].includes(r)),
      [],
    );
  for (const bad of [{}, null, { ...ALL, supply: 'true' }, { ...ALL, stockReports: undefined }])
    assert.throws(() => backofficeSupplyPrivileges(bad), /Invalid backoffice supply grants/);
  assert.throws(() => backofficeSupplyGrants('Bad-Role', ALL), /Invalid backoffice supply grants/);
  assert.throws(() => backofficeSupplyGrants('pickchick_app', ALL, 'bad schema'));
});

test('the SQL is a guarded reset of the 076 relations and nothing else', () => {
  const off = backofficeSupplyGrants('pickchick_app', { ...OFF, backoffice: false });
  assert.doesNotMatch(off, /GRANT/);
  for (const name of Object.keys(BACKOFFICE_SUPPLY_RELATIONS))
    assert.match(
      off,
      new RegExp(
        `IF to_regclass\\('public\\.${name}'\\) IS NOT NULL THEN REVOKE ALL ON "public"\\."${name}" FROM "pickchick_app"; END IF;`,
      ),
    );
  const all = backofficeSupplyGrants('pickchick_app', ALL, 'sync_x');
  assert.match(
    all,
    /REVOKE ALL ON "sync_x"\."bo_supplier_price_imports" FROM "pickchick_app";GRANT SELECT, INSERT ON "sync_x"\."bo_supplier_price_imports" TO "pickchick_app";/,
  );
  assert.match(
    all,
    /GRANT SELECT, INSERT, UPDATE ON "sync_x"\."bo_staff_assignments" TO "pickchick_app";/,
  );
  assert.doesNotMatch(all, /DELETE|TRUNCATE/);
  // Only the 076 relations are named.
  const named = [...all.matchAll(/"sync_x"\."(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(named)].sort(), Object.keys(BACKOFFICE_SUPPLY_RELATIONS).sort());
});

async function people(c) {
  const manager = await provisionCatalogManager(c.cloud.pool, {
    organization_id: c.org,
    name: 'Синтетический управляющий',
    branch_ids: [c.branch],
  });
  await grantBackoffice(c.cloud.pool, manager.actor_id, c.branch, 'manager');
  return { manager };
}
/** A NOLOGIN role like pickchick_app with backofficeGrants, and a pool that acts as it. */
async function withRole(c, run) {
  const schema = c.cloud.schema;
  const role = 'bo_p2_' + randomUUID().replaceAll('-', '');
  let pool;
  await c.cloud.admin.query(
    `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
  );
  try {
    await c.cloud.pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await c.cloud.pool.query(backofficeGrants(role, true));
    const url = new URL(c.cloud.config.databaseUrl);
    url.searchParams.set('options', `-c search_path=${schema} -c role=${role}`);
    pool = createPool(url.toString());
    await run({ role, schema, pool });
  } finally {
    await pool?.end();
    // DROP OWNED also revokes every privilege of the role in this database.
    await c.cloud.admin.query(`DROP OWNED BY ${role}`);
    await c.cloud.admin.query(`DROP ROLE ${role}`);
  }
}
const denied = (error) => error?.code === '42501';

test('least privilege: the API role writes 076 only through the helper, never deletes, never rewrites an import', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const actor = manager.actor_id;
    // Owner-side data the role refers to: an ingredient, an employee and a stock receipt.
    const owner = new Backoffice(c.cloud.pool, true, {});
    const save = async (kind, payload) => {
      const id = randomUUID();
      await owner.command(manager.token, c.branch, {
        request_id: randomUUID(),
        reason: 'Синтетическая подготовка',
        command: { type: 'save', kind, id, expected_revision: 0, payload },
      });
      return id;
    };
    const bun = await save('ingredient', {
      name: 'Синтетическая булка',
      unit: 'pcs',
      minimum: '10',
      active: true,
    });
    const cook = await save('employee', {
      name: 'Синтетический повар',
      role: 'cook',
      active: true,
      note: '',
    });
    const receipt = (
      await owner.command(manager.token, c.branch, {
        request_id: randomUUID(),
        reason: 'Синтетическая поставка',
        command: {
          type: 'stock',
          kind: 'receipt',
          reference: 'НАК-1',
          lines: [
            { ingredient_id: bun, quantity: '30', value_minor: '30000', expected_revision: 0 },
          ],
        },
      })
    ).id;
    await withRole(c, async ({ role, schema, pool }) => {
      const p2 = new Backoffice(pool, true, P2_ON);
      // Without the helper the features that write 076 report false, the reports true.
      assert.deepEqual(await capabilities(p2, manager.token, c.branch), {
        supply: false,
        stock_reports: true,
        staff_assignment: false,
      });
      await assertBackofficeSupplyPrivileges(c.cloud.pool, role, OFF, schema);
      await assert.rejects(
        assertBackofficeSupplyPrivileges(c.cloud.pool, role, ALL, schema),
        /privileges of/,
      );
      // The bo-ui helper runs first (provision.mjs order, CR bo-ui2-1); this one never changes
      // what that one proves.
      await c.cloud.pool.query(backofficeP1Grants(role, P1_ALL, schema));
      await c.cloud.pool.query(backofficeSupplyGrants(role, ALL, schema));
      await assertBackofficeSupplyPrivileges(c.cloud.pool, role, ALL, schema);
      await assertBackofficeP1Privileges(c.cloud.pool, role, P1_ALL, schema);
      await assert.rejects(
        assertBackofficeSupplyPrivileges(c.cloud.pool, role, { ...ALL, supply: false }, schema),
        /bo_suppliers privileges/,
      );
      assert.deepEqual(await capabilities(p2, manager.token, c.branch), {
        supply: true,
        stock_reports: true,
        staff_assignment: true,
      });
      // Without the flags each one builds on, the key is false even with the rights.
      const lone = new Backoffice(pool, true, {
        supplyEnabled: true,
        staffAssignmentEnabled: true,
      });
      assert.deepEqual(await capabilities(lone, manager.token, c.branch), {
        supply: false,
        stock_reports: undefined,
        staff_assignment: false,
      });

      // The role writes every 076 table as the features need (triggers run as the role).
      const supplier = randomUUID();
      await pool.query(
        "INSERT INTO bo_suppliers(id,branch_id,name,kind,revision,created_by,updated_by) VALUES($1,$2,'Пекарня 1','bakery',1,$3,$3)",
        [supplier, c.branch, actor],
      );
      await pool.query("UPDATE bo_suppliers SET name='Пекарня 2',revision=2 WHERE id=$1", [
        supplier,
      ]);
      const batch = randomUUID();
      await pool.query(
        `INSERT INTO bo_supplier_price_imports(id,branch_id,source,file_sha256,plan_sha256,row_count,summary,actor_id)
         VALUES($1,$2,'csv',$3,$4,1,'{"prices_created":1}',$5)`,
        [batch, c.branch, 'a'.repeat(64), 'b'.repeat(64), actor],
      );
      await assert.rejects(
        pool.query('UPDATE bo_supplier_price_imports SET row_count=2 WHERE id=$1', [batch]),
        denied,
      );
      await pool.query(
        `INSERT INTO bo_supplier_prices(branch_id,supplier_id,ingredient_id,unit,price_minor,valid_from,source,import_batch_id,revision,updated_by)
         VALUES($1,$2,$3,'pcs',10000,'2026-11-19','import',$4,1,$5)`,
        [c.branch, supplier, bun, batch, actor],
      );
      await pool.query(
        "UPDATE bo_supplier_prices SET price_minor=11000,source='manual',import_batch_id=NULL,revision=2 WHERE supplier_id=$1",
        [supplier],
      );
      const request = randomUUID();
      const line = {
        ingredient_id: bun,
        unit: 'pcs',
        qty: '30',
        balance_at_request: '0',
        hint: '10',
        price_minor: '330000',
      };
      await pool.query(
        `INSERT INTO bo_supply_requests(id,branch_id,number,kind,supplier_id,lines,revision,created_by,updated_by)
         VALUES($1,$2,1,'bakery',$3,$4,1,$5,$5)`,
        [request, c.branch, supplier, JSON.stringify([line]), actor],
      );
      await pool.query(
        "UPDATE bo_supply_requests SET state='submitted',needed_by='2026-11-19',submitted_by=$2,submitted_at=clock_timestamp(),revision=2 WHERE id=$1",
        [request, actor],
      );
      await pool.query(
        "UPDATE bo_supply_requests SET state='received',receipt_document_id=$2,closed_by=$3,closed_at=clock_timestamp(),revision=3 WHERE id=$1",
        [request, receipt, actor],
      );
      const assignment = randomUUID();
      await pool.query(
        `INSERT INTO bo_staff_assignments(id,branch_id,business_date,employee_id,station_code,started_at,set_by,revision)
         VALUES($1,$2,'2026-11-19',$3,'fryer','2026-11-19T10:00:00+05:00',$4,1)`,
        [assignment, c.branch, cook, actor],
      );
      await pool.query(
        "UPDATE bo_staff_assignments SET ended_at='2026-11-19T13:30:00+05:00',ended_by=$2,revision=2 WHERE id=$1",
        [assignment, actor],
      );
      for (const table of Object.keys(BACKOFFICE_SUPPLY_RELATIONS))
        await assert.rejects(pool.query(`DELETE FROM ${table}`), denied, table);
      for (const table of Object.keys(BACKOFFICE_SUPPLY_RELATIONS))
        await assert.rejects(pool.query(`TRUNCATE ${table}`), denied, table);

      // The reset revokes again when the flags are switched off, and the P1 rights stay.
      await c.cloud.pool.query(backofficeSupplyGrants(role, { ...ALL, supply: false }, schema));
      await assertBackofficeSupplyPrivileges(c.cloud.pool, role, { ...ALL, supply: false }, schema);
      await assert.rejects(pool.query('SELECT 1 FROM bo_suppliers LIMIT 0'), denied);
      await pool.query('SELECT 1 FROM bo_staff_assignments LIMIT 0');
      await c.cloud.pool.query(backofficeSupplyGrants(role, OFF, schema));
      await assertBackofficeSupplyPrivileges(c.cloud.pool, role, OFF, schema);
      assert.deepEqual(await capabilities(p2, manager.token, c.branch), {
        supply: false,
        stock_reports: true,
        staff_assignment: false,
      });
      await assertBackofficeP1Privileges(c.cloud.pool, role, P1_ALL, schema);
      await c.cloud.pool.query(backofficeSupplyGrants(role, { ...OFF, backoffice: false }, schema));
      await assertBackofficeSupplyPrivileges(
        c.cloud.pool,
        role,
        { ...OFF, backoffice: false },
        schema,
      );
    });
  }));

test('on a cloud schema without 076 the helper is a no-op, its proof passes, the features report false', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-cloud-075-grants-'));
  try {
    for (const file of await readdir(MIGRATIONS))
      if (/^\d{3}_[a-z_]+\.sql$/.test(file) && file < '076')
        await cp(join(MIGRATIONS, file), join(directory, file));
    await withSyncDatabases(
      async (c) => {
        const { manager } = await people(c);
        await withRole(c, async ({ role, schema, pool }) => {
          await c.cloud.pool.query(backofficeSupplyGrants(role, ALL, schema));
          await assertBackofficeSupplyPrivileges(c.cloud.pool, role, ALL, schema);
          // The new runtime on 075 with every second-wave flag on: nothing breaks.
          assert.deepEqual(
            await capabilities(new Backoffice(pool, true, P2_ON), manager.token, c.branch),
            {
              supply: false,
              stock_reports: true,
              staff_assignment: false,
            },
          );
        });
        // The owner too: without 076 the relations are missing, not only the rights.
        assert.deepEqual(
          await capabilities(new Backoffice(c.cloud.pool, true, P2_ON), manager.token, c.branch),
          { supply: false, stock_reports: true, staff_assignment: false },
        );
      },
      { cloudMigrationDirectory: directory },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
