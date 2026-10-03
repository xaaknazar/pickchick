/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  CatalogAdmin,
  CatalogAdminError,
  provisionCatalogManager,
} from '../../packages/catalog-admin/dist/index.js';
import { withSyncDatabases } from '../helpers/sync.mjs';

test('channel price drafts persist and rejected publication has no durable effects', async () => {
  await withSyncDatabases(async ({ cloud, org, branch }) => {
    const manager = await provisionCatalogManager(cloud.pool, {
      organization_id: org,
      name: 'Synthetic director pricing',
      branch_ids: [branch],
    });
    const service = new CatalogAdmin(cloud.pool, { enabled: true });
    let state = await service.seed(manager.token, branch, {
      expected_revision: 0,
      request_id: randomUUID(),
    });
    const payload = structuredClone(state.draft.payload);
    payload.content_reviewed = true;
    payload.products[0].channel_prices_minor = { mobile: '219900', pos: '229900', kiosk: '239900' };
    state = await service.save(manager.token, branch, {
      expected_revision: state.draft.revision,
      request_id: randomUUID(),
      payload,
    });
    const saved = await new CatalogAdmin(cloud.pool, { enabled: true }).read(manager.token, branch);
    assert.deepEqual(
      saved.draft.payload.products[0].channel_prices_minor,
      payload.products[0].channel_prices_minor,
    );
    assert.equal(saved.published, null);
    const snapshot = async () => {
      const result = {};
      for (const table of [
        'catalog_publications',
        'catalog_draft_versions',
        'catalog_audit',
        'catalog_command_receipts',
        'outbox_events',
      ])
        result[table] = (
          await cloud.pool.query(`SELECT count(*)::int AS count FROM ${table}`)
        ).rows[0].count;
      result.head = (
        await cloud.pool.query(
          'SELECT draft_revision,published_version FROM catalog_branch_heads WHERE branch_id=$1',
          [branch],
        )
      ).rows[0];
      return result;
    };
    const before = await snapshot();
    await assert.rejects(
      service.publish(manager.token, branch, {
        expected_revision: state.draft.revision,
        expected_published_version: 0,
        request_id: randomUUID(),
        confirmation: 'publish_catalog',
      }),
      (error) => error instanceof CatalogAdminError && error.code === 'CONFLICT',
    );
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await service.read(manager.token, branch), saved);
    delete payload.products[0].channel_prices_minor;
    state = await service.save(manager.token, branch, {
      expected_revision: state.draft.revision,
      request_id: randomUUID(),
      payload,
    });
    const published = await service.publish(manager.token, branch, {
      expected_revision: state.draft.revision,
      expected_published_version: 0,
      request_id: randomUUID(),
      confirmation: 'publish_catalog',
    });
    assert.equal(published.published.version, 1);
    assert.equal(
      published.published.payload.products[0].price_minor,
      payload.products[0].price_minor,
    );
  });
});
