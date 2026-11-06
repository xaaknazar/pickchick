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
  assertCloudPosSalesPrivileges,
  cloudPosSalesGrants,
} from '../../../infra/staging/pos-sales-grants.mjs';
import {
  AUTOCONSUME_READ_TABLES,
  BACKOFFICE_P1_RELATIONS,
  MIGRATION,
  POS_DAY_TABLES,
  assertBackofficeP1Privileges,
  backofficeP1Grants,
  backofficeP1Privileges,
  backofficeP1Reads,
} from '../../../infra/staging/backoffice-p1-grants.mjs';

/** infra/staging/backoffice-p1-grants.mjs (lane bo-ui, design-bo-ui.md section 3). */
const MIGRATIONS = fileURLToPath(new URL('../../../db/cloud/migrations/', import.meta.url));
const OFF = Object.freeze({
  backoffice: true,
  posDay: false,
  stockV2: false,
  autoconsume: false,
  managerShifts: false,
  discounts: false,
});
const ALL = Object.freeze({
  backoffice: true,
  posDay: true,
  stockV2: true,
  autoconsume: true,
  managerShifts: true,
  discounts: true,
});
const WRITE = ['SELECT', 'INSERT', 'UPDATE'];
/** Back-office options with every P1 flag (and stock v2, which autoconsume needs) on. */
const P1_ON = Object.freeze({
  stockV2Enabled: true,
  posDayEnabled: true,
  stockAutoconsumeEnabled: true,
  managerShiftsEnabled: true,
  staffPositionsEnabled: true,
  discountsEnabled: true,
});

test('the helper names the 075 file and exactly the relations it creates', async () => {
  const sql = await readFile(join(MIGRATIONS, MIGRATION), 'utf8');
  const created = [...sql.matchAll(/^CREATE TABLE (\w+)/gm)].map((m) => m[1]).sort();
  assert.deepEqual(Object.keys(BACKOFFICE_P1_RELATIONS).sort(), created);
});

test('privileges per flag: nothing without the back office, autoconsume only with stock v2', () => {
  assert.deepEqual(backofficeP1Privileges({ ...ALL, backoffice: false }), {});
  assert.deepEqual(backofficeP1Reads({ ...ALL, backoffice: false }), []);
  assert.deepEqual(backofficeP1Privileges(OFF), {});
  assert.deepEqual(backofficeP1Reads(OFF), []);
  assert.deepEqual(backofficeP1Privileges(ALL), {
    bo_menu_stock_links: WRITE,
    bo_stock_settings: WRITE,
    bo_consumption_items: WRITE,
    bo_manager_shifts: WRITE,
    bo_branch_templates: ['SELECT', 'INSERT'],
    bo_discounts: WRITE,
    bo_discount_revisions: ['SELECT'],
  });
  // Step 6: the branch lists are append-only, for the manager shift or the staff positions;
  // staffPositions is optional (the call of CR bo-ui-1 has no such key).
  assert.deepEqual(backofficeP1Privileges({ ...OFF, staffPositions: true }), {
    bo_branch_templates: ['SELECT', 'INSERT'],
  });
  assert.deepEqual(backofficeP1Privileges({ ...OFF, managerShifts: true }), {
    bo_manager_shifts: WRITE,
    bo_branch_templates: ['SELECT', 'INSERT'],
  });
  assert.deepEqual(backofficeP1Privileges({ ...OFF, staffPositions: false }), {});
  assert.throws(
    () => backofficeP1Privileges({ ...ALL, staffPositions: 'true' }),
    /Invalid backoffice P1 grants/,
  );
  assert.deepEqual(backofficeP1Privileges({ ...OFF, autoconsume: true }), {});
  assert.deepEqual(backofficeP1Reads({ ...OFF, autoconsume: true }), []);
  assert.deepEqual(backofficeP1Privileges({ ...OFF, stockV2: true }), {
    bo_menu_stock_links: WRITE,
  });
  assert.deepEqual(backofficeP1Reads({ ...OFF, posDay: true }), [...POS_DAY_TABLES]);
  // cloud_pos_sales is read by both: listed once.
  assert.deepEqual(backofficeP1Reads(ALL), [
    ...POS_DAY_TABLES,
    ...AUTOCONSUME_READ_TABLES.filter((t) => !POS_DAY_TABLES.includes(t)),
  ]);
  // Never a delete, never the history writes.
  for (const rights of Object.values(backofficeP1Privileges(ALL)))
    assert.deepEqual(
      rights.filter((r) => !['SELECT', 'INSERT', 'UPDATE'].includes(r)),
      [],
    );
  for (const bad of [{}, { ...ALL, discounts: 'true' }, { ...ALL, posDay: undefined }, null])
    assert.throws(() => backofficeP1Privileges(bad), /Invalid backoffice P1 grants/);
  assert.throws(() => backofficeP1Grants('Bad-Role', ALL), /Invalid backoffice P1 grants/);
  assert.throws(() => backofficeP1Grants('pickchick_app', ALL, 'bad schema'));
});

test('the SQL is a guarded reset of the 075 relations plus additive reads', () => {
  const off = backofficeP1Grants('pickchick_app', { ...OFF, backoffice: false });
  assert.doesNotMatch(off, /GRANT/);
  for (const name of Object.keys(BACKOFFICE_P1_RELATIONS))
    assert.match(
      off,
      new RegExp(
        `IF to_regclass\\('public\\.${name}'\\) IS NOT NULL THEN REVOKE ALL ON "public"\\."${name}" FROM "pickchick_app"; END IF;`,
      ),
    );
  const all = backofficeP1Grants('pickchick_app', ALL, 'sync_x');
  assert.match(
    all,
    /REVOKE ALL ON "sync_x"\."bo_discounts" FROM "pickchick_app";GRANT SELECT, INSERT, UPDATE ON "sync_x"\."bo_discounts" TO "pickchick_app";/,
  );
  assert.match(all, /GRANT SELECT ON "sync_x"\."bo_discount_revisions" TO "pickchick_app";/);
  for (const table of [...POS_DAY_TABLES, ...AUTOCONSUME_READ_TABLES])
    assert.match(
      all,
      new RegExp(
        `IF to_regclass\\('sync_x\\.${table}'\\) IS NOT NULL THEN GRANT SELECT ON "sync_x"\\."${table}" TO "pickchick_app"; END IF;`,
      ),
    );
  // The reads are additive: never a REVOKE outside the 075 relations.
  assert.doesNotMatch(all, /REVOKE[^;]*(cloud_pos|catalog_)/);
  assert.doesNotMatch(all, /DELETE|TRUNCATE/);
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
  const role = 'bo_p1_' + randomUUID().replaceAll('-', '');
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

test('least privilege: the API role writes P1 only through the helper, never deletes, never forges history', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    await withRole(c, async ({ role, schema, pool }) => {
      const p1 = new Backoffice(pool, true, P1_ON);
      // Without the helper the features that need 075 rights report false, the others true.
      let caps = (await p1.read(manager.token, c.branch)).capabilities;
      assert.deepEqual(
        {
          pos_day: caps.pos_day,
          stock_autoconsume: caps.stock_autoconsume,
          manager_shifts: caps.manager_shifts,
          staff_positions: caps.staff_positions,
          discounts: caps.discounts,
        },
        {
          pos_day: true,
          stock_autoconsume: false,
          manager_shifts: false,
          staff_positions: true,
          discounts: false,
        },
      );
      await assertBackofficeP1Privileges(c.cloud.pool, role, OFF, schema);
      await assert.rejects(
        assertBackofficeP1Privileges(c.cloud.pool, role, ALL, schema),
        /privileges of|not readable/,
      );
      // The pos lane resets the 073 tables first; this helper only adds reads afterwards.
      await c.cloud.pool.query(
        cloudPosSalesGrants(role, { receiver: false, backoffice: true }, schema),
      );
      await c.cloud.pool.query(backofficeP1Grants(role, ALL, schema));
      await assertBackofficeP1Privileges(c.cloud.pool, role, ALL, schema);
      await assertCloudPosSalesPrivileges(
        c.cloud.pool,
        role,
        { receiver: false, backoffice: true },
        schema,
      );
      await assert.rejects(
        assertBackofficeP1Privileges(c.cloud.pool, role, { ...ALL, discounts: false }, schema),
        /bo_discounts privileges/,
      );
      caps = (await p1.read(manager.token, c.branch)).capabilities;
      assert.equal(caps.stock_autoconsume, true);
      assert.equal(caps.manager_shifts, true);
      assert.equal(caps.discounts, true);

      // Discounts: written by the role, history by the owner trigger only.
      const discount = randomUUID();
      const actor = manager.actor_id;
      await pool.query(
        `INSERT INTO bo_discounts(id,branch_id,name,kind,percent_bp,revision,created_by,updated_by)
         VALUES($1,$2,'Синтетическая',$3,1000,1,$4,$4)`,
        [discount, c.branch, 'percent', actor],
      );
      await pool.query(
        "UPDATE bo_discounts SET state='active',revision=2,updated_at=clock_timestamp() WHERE id=$1",
        [discount],
      );
      assert.deepEqual(
        (
          await pool.query(
            'SELECT revision FROM bo_discount_revisions WHERE discount_id=$1 ORDER BY revision',
            [discount],
          )
        ).rows,
        [{ revision: 1 }, { revision: 2 }],
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO bo_discount_revisions(discount_id,branch_id,revision,snapshot,changed_by,changed_at)
           VALUES($1,$2,3,'{}',$3,now())`,
          [discount, c.branch, actor],
        ),
        denied,
      );
      await assert.rejects(pool.query('DELETE FROM bo_discounts'), denied);
      // Every other P1 table is writable as the features need and never deletable.
      await pool.query(
        'INSERT INTO bo_stock_settings(branch_id,revision,updated_by) VALUES($1,1,$2)',
        [c.branch, actor],
      );
      await pool.query(
        `INSERT INTO bo_menu_stock_links(branch_id,catalog_key,product_slug,effect,lines,revision,updated_by)
         VALUES($1,'pick-water','pick-water','none','[]',1,$2)`,
        [c.branch, actor],
      );
      const sale = randomUUID();
      const document = randomUUID();
      await pool.query(
        `INSERT INTO bo_stock_documents(id,branch_id,actor_id,kind,reference,reason,source_ref)
         VALUES($1,$2,$3,'consumption','POS','Синтетическое списание по продаже',$4)`,
        [document, c.branch, actor, `pos:${sale}`],
      );
      await pool.query(
        `INSERT INTO bo_consumption_items(branch_id,source,order_id,sold_at,trigger_kind,revision)
         VALUES($1,'pos',$2,now(),'kitchen_started',1)`,
        [c.branch, sale],
      );
      await pool.query(
        "UPDATE bo_consumption_items SET state='applied',document_id=$2,revision=2 WHERE order_id=$1",
        [sale, document],
      );
      await pool.query(
        `INSERT INTO bo_manager_shifts(id,branch_id,business_date,opened_at,template_version,revision,opened_by)
         VALUES($1,$2,(now() AT TIME ZONE 'Asia/Almaty')::date,now(),1,1,$3)`,
        [randomUUID(), c.branch, actor],
      );
      // The branch lists are appended, never changed.
      await pool.query(
        `INSERT INTO bo_branch_templates(branch_id,kind,version,body,created_by)
         VALUES($1,'staff_positions',2,'{}',$2)`,
        [c.branch, actor],
      );
      await assert.rejects(pool.query("UPDATE bo_branch_templates SET body='{}'"), denied);
      for (const table of Object.keys(BACKOFFICE_P1_RELATIONS))
        await assert.rejects(pool.query(`DELETE FROM ${table}`), denied, table);
      // pos-day and the consumption worker read their tables outside 075.
      for (const table of [...POS_DAY_TABLES, ...AUTOCONSUME_READ_TABLES])
        await pool.query(`SELECT 1 FROM ${table} LIMIT 0`);

      // The reset revokes again when the flags are switched off.
      await c.cloud.pool.query(backofficeP1Grants(role, OFF, schema));
      await assertBackofficeP1Privileges(c.cloud.pool, role, OFF, schema);
      await assert.rejects(pool.query('SELECT 1 FROM bo_discounts LIMIT 0'), denied);
      caps = (await p1.read(manager.token, c.branch)).capabilities;
      assert.equal(caps.discounts, false);
      assert.equal(caps.manager_shifts, false);
      await c.cloud.pool.query(backofficeP1Grants(role, { ...OFF, backoffice: false }, schema));
      await assertBackofficeP1Privileges(c.cloud.pool, role, { ...OFF, backoffice: false }, schema);
    });
  }));

test('on a cloud schema without 075 the helper is a no-op and its proof passes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-cloud-074-grants-'));
  try {
    for (const file of await readdir(MIGRATIONS))
      if (/^\d{3}_[a-z_]+\.sql$/.test(file) && file < '075')
        await cp(join(MIGRATIONS, file), join(directory, file));
    await withSyncDatabases(
      async (c) => {
        const { manager } = await people(c);
        await withRole(c, async ({ role, schema, pool }) => {
          await c.cloud.pool.query(backofficeP1Grants(role, ALL, schema));
          await assertBackofficeP1Privileges(c.cloud.pool, role, ALL, schema);
          const caps = (await new Backoffice(pool, true, P1_ON).read(manager.token, c.branch))
            .capabilities;
          assert.equal(caps.manager_shifts, false);
          assert.equal(caps.discounts, false);
          assert.equal(caps.stock_autoconsume, false);
          assert.equal(caps.pos_day, true);
        });
      },
      { cloudMigrationDirectory: directory },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
