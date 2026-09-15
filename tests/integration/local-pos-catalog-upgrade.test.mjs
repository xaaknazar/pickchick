import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createPool, migrate } from '@pickchick/database';
import { provisionStaff, priceCart } from '@pickchick/local-orders';
import { prepareLocalDraft, provisionLocalDraft } from '../../scripts/local-pos-draft.mjs';
import {
  prepareLocalCatalogUpgrade,
  upgradeLocalCatalog,
} from '../../scripts/local-pos-catalog-upgrade.mjs';

// No default connection: the operator must explicitly provide a disposable test
// database. These tests never use the existing shared Mac development database.
test(
  'closed catalog upgrade on schema013 is atomic, rejects cloud state and retains immutable history/session/stop/quote data',
  { skip: !process.env.LOCAL_POS_CATALOG_UPGRADE_TEST_DATABASE_URL },
  async () => {
    const url = new URL(process.env.LOCAL_POS_CATALOG_UPGRADE_TEST_DATABASE_URL);
    assert.ok(['postgresql:', 'postgres:'].includes(url.protocol));
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/pickchick_test');
    assert.equal(url.search, '');
    const schema = 'catalog_upgrade_' + randomUUID().replaceAll('-', '');
    const admin = createPool(url.toString());
    let pool;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      url.searchParams.set('options', `-c search_path=${schema}`);
      pool = createPool(url.toString());
      await migrate(
        pool,
        fileURLToPath(new URL('../../db/edge/migrations/', import.meta.url)),
        'edge',
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM schema_migrations WHERE scope='edge' AND version='013_pos_kitchen_sync.sql'",
          )
        ).rows[0].count,
        '1',
        'Catalog upgrade is exercised after the complete service schema013 migration',
      );
      const oldBytes = await readFile(
        new URL('../../infra/windows/local-pos-draft-catalog.json', import.meta.url),
      );
      const newBytes = await readFile(
        new URL('../../infra/windows/local-pos-draft-catalog-v2.json', import.meta.url),
      );
      const setup = {
        format: 'pickchick-local-pos-draft-v1',
        confirmation: 'prepare_local_display_only',
        branch: {
          id: randomUUID(),
          code: 'ISOLATED-UPGRADE',
          name: 'Isolated upgrade test',
          timezone: 'Asia/Almaty',
          ordering_enabled: false,
        },
        staff: {
          staff_id: randomUUID(),
          terminal_id: randomUUID(),
          name: 'Isolated cashier',
          role: 'cashier',
        },
        release_id: randomUUID(),
      };
      const old = prepareLocalDraft(setup, oldBytes, setup.branch.id);
      const record = await provisionLocalDraft(pool, old);
      await provisionStaff(pool, setup.branch.id, setup.staff);
      await pool.query(
        'INSERT INTO local_stops(branch_id,variant_id,stopped,version,reason) VALUES($1,$2,true,1,$3)',
        [setup.branch.id, old.menu.items[0].variant_id, 'Synthetic test stop'],
      );
      const quoteId = randomUUID(),
        now = new Date(),
        pricing = priceCart(old.menu, {
          release_id: old.menu.release_id,
          service_mode: 'takeaway',
          items: [{ variant_id: old.menu.items[0].variant_id, quantity: 2 }],
        });
      const quote = {
        quote_id: quoteId,
        branch_id: setup.branch.id,
        release_id: old.menu.release_id,
        ...pricing,
      };
      await pool.query(
        'INSERT INTO checkout_quotes(id,branch_id,staff_id,terminal_id,release_id,total_minor,snapshot,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          quoteId,
          setup.branch.id,
          setup.staff.staff_id,
          setup.staff.terminal_id,
          old.menu.release_id,
          pricing.total_minor,
          quote,
          now,
          new Date(now.getTime() + 60000),
        ],
      );
      const preserved = {};
      for (const table of [
        'local_staff',
        'local_terminals',
        'staff_sessions',
        'local_stops',
        'checkout_quotes',
      ])
        preserved[table] = (await pool.query(`SELECT * FROM ${table}`)).rows;
      const input = {
        format: 'pickchick-local-pos-upgrade-v2',
        confirmation: 'upgrade_local_display_only',
        branch_id: setup.branch.id,
        previous_release_id: old.menu.release_id,
        expected_menu_checksum: record.menu_checksum,
        release_id: randomUUID(),
      };
      const prepared = prepareLocalCatalogUpgrade(
        input,
        Buffer.from(JSON.stringify(record)),
        oldBytes,
        newBytes,
        setup.branch.id,
      );
      await assert.rejects(
        upgradeLocalCatalog(pool, { ...prepared, auditId: 'bad-final-audit-uuid' }),
      );
      assert.equal((await pool.query('SELECT count(*) FROM menu_snapshots')).rows[0].count, '1');
      assert.equal(
        (await pool.query('SELECT release_id FROM active_menu')).rows[0].release_id,
        old.menu.release_id,
      );
      await pool.query('UPDATE branch_config SET ordering_enabled=true');
      await assert.rejects(upgradeLocalCatalog(pool, prepared), /remain closed/);
      await pool.query('UPDATE branch_config SET ordering_enabled=false');
      await pool.query(
        'INSERT INTO menu_sync_state(branch_id,producer_id,last_sequence) VALUES($1,$2,0)',
        [setup.branch.id, randomUUID()],
      );
      await assert.rejects(upgradeLocalCatalog(pool, prepared), /Cloud\/sync\/fulfillment/);
      await pool.query('DELETE FROM menu_sync_state');
      const result = await upgradeLocalCatalog(pool, prepared);
      assert.equal(result.ordering_enabled, false);
      assert.equal(result.cloud_published, false);
      assert.equal(result.content_reviewed, false);
      assert.equal(result.images_in_pos, 23);
      assert.equal(result.modifier_groups, 31);
      assert.equal((await pool.query('SELECT count(*) FROM menu_snapshots')).rows[0].count, '2');
      assert.equal(
        (await pool.query('SELECT release_id FROM active_menu')).rows[0].release_id,
        prepared.menu.release_id,
      );
      assert.deepEqual(
        (await pool.query('SELECT payload FROM menu_snapshots WHERE id=$1', [old.menu.release_id]))
          .rows[0].payload,
        old.menu,
      );
      for (const table of Object.keys(preserved))
        assert.deepEqual((await pool.query(`SELECT * FROM ${table}`)).rows, preserved[table]);
      for (const table of [
        'inbox_messages',
        'outbox_events',
        'menu_sync_state',
        'fulfillment_config',
        'pos_order_sync_state',
        'local_orders',
        'local_cash_shifts',
        'local_staff_passwords',
        'local_staff_login_limits',
        'local_pos_service_setup',
        'pos_kitchen_sync_state',
      ])
        assert.equal((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count, '0');
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM local_audit WHERE action='local.preview_catalog_upgraded_unreviewed'",
          )
        ).rows[0].count,
        '1',
      );
      await assert.rejects(upgradeLocalCatalog(pool, prepared), /exact recorded preview-v1/);
      await assert.rejects(
        pool.query('UPDATE menu_snapshots SET checksum=$1 WHERE id=$2', [
          '0'.repeat(64),
          old.menu.release_id,
        ]),
      );
      assert.equal(
        (await pool.query('SELECT ordering_enabled FROM branch_config')).rows[0].ordering_enabled,
        false,
      );
      assert.equal(
        (await pool.query('SELECT pos_service_mode FROM branch_config')).rows[0].pos_service_mode,
        'payment_required',
      );
    } finally {
      await pool?.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);
