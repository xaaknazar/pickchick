import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '@pickchick/database';
import { fixture } from '../../fulfillment-transport/tests/cloud-fixture.mjs';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import { Backoffice, grantBackoffice } from '../dist/index.js';
import { backofficeGrants } from '../../../infra/staging/backoffice-grants.mjs';
test('restricted runtime reads scoped operations and requests refunds without capture, credential or grant provisioning powers', () =>
  fixture(async (f) => {
    const role = 'bo_runtime_' + randomUUID().replaceAll('-', '');
    let pool;
    await f.admin.query(
      `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    try {
      await f.pool.query(`GRANT USAGE ON SCHEMA ${f.schema} TO ${role}`);
      await f.pool.query(backofficeGrants(role, true));
      const url = new URL(f.url);
      url.searchParams.set('options', `-c search_path=${f.schema} -c role=${role}`);
      pool = createPool(url.toString());
      const manager = await provisionCatalogManager(f.pool, {
        organization_id: f.scope.organizationId,
        name: 'Synthetic restricted BO',
        branch_ids: [f.scope.branchId],
      });
      await grantBackoffice(f.pool, manager.actor_id, f.scope.branchId, 'manager');
      const bo = new Backoffice(pool, true),
        command = (command) => ({
          request_id: randomUUID(),
          reason: 'Synthetic permissions check',
          command,
        });
      await bo.read(manager.token, f.scope.branchId);
      await bo.command(
        manager.token,
        f.scope.branchId,
        command({
          type: 'save',
          kind: 'ingredient',
          id: randomUUID(),
          expected_revision: 0,
          payload: { name: 'Synthetic', unit: 'g', minimum: '0', active: true },
        }),
      );
      const v = await f.reserve();
      await f.confirm(v);
      const captured = await f.capture(v);
      const refunded = await bo.command(
        manager.token,
        f.scope.branchId,
        command({
          type: 'refund',
          id: v.orderId,
          capture_id: captured.captures[0].id,
          amount_minor: '100',
        }),
      );
      assert.equal(refunded.state, 'pending');
      const unpaid = await f.reserve();
      await f.confirm(unpaid);
      const detail = await bo.order(manager.token, f.scope.branchId, unpaid.orderId);
      assert.equal(
        (
          await bo.command(
            manager.token,
            f.scope.branchId,
            command({
              type: 'cancel_order',
              id: unpaid.orderId,
              expected_version: Number(detail.order.version),
            }),
          )
        ).state,
        'release_pending',
      );
      for (const table of [
        'cloud_branch_availability',
        'products',
        'product_variants',
        'commerce_captures',
        'commerce_refund_effects',
        'bo_access_grants',
        'bo_access_audit',
        'catalog_managers',
        'device_credentials',
      ])
        assert.equal(
          (
            await pool.query("SELECT has_table_privilege(current_user,$1,'INSERT') allowed", [
              table,
            ])
          ).rows[0].allowed,
          false,
          table,
        );
      await assert.rejects(pool.query("UPDATE catalog_managers SET name='Forged'"), {
        code: '42501',
      });
      await assert.rejects(pool.query("UPDATE bo_access_grants SET role='manager'"), {
        code: '42501',
      });
      await f.pool.query(backofficeGrants(role, false));
      await assert.rejects(bo.read(manager.token, f.scope.branchId), { code: '42501' });
    } finally {
      await pool?.end();
      await f.pool.query(`DROP OWNED BY ${role}`);
      await f.admin.query(`DROP ROLE ${role}`);
    }
  }));
