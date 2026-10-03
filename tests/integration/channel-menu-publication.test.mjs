/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { transaction } from '@pickchick/database';
import {
  projectCatalogMenu,
  publishMenuInTransaction,
  publishMenu,
  pullMenu,
  applyMenu,
  acknowledgeMenu,
  provisionDevice,
} from '../../packages/menu-sync/dist/index.js';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';
import { withSyncDatabases, authFor } from '../helpers/sync.mjs';

test('catalog projection transaction rolls back release and outbox on failure', async () => {
  await withSyncDatabases(async ({ cloud, branch }) => {
    const menu = projectCatalogMenu(mockupCatalogDraft, branch, 1, new Date().toISOString());
    await assert.rejects(
      transaction(cloud.pool, async (db) => {
        await publishMenuInTransaction(db, menu);
        throw new Error('CMS_FAILED');
      }),
      /CMS_FAILED/,
    );
    assert.equal(
      (await cloud.pool.query('SELECT count(*)::int n FROM menu_releases')).rows[0].n,
      0,
    );
    assert.equal(
      (await cloud.pool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n,
      0,
    );
  });
});

test('durable projected menu redelivers until exact edge ACK, retains stable identities across versions', async () => {
  await withSyncDatabases(async ({ cloud, edge, branch, device }) => {
    const auth = authFor(await provisionDevice(cloud.pool, device));
    const menu = projectCatalogMenu(mockupCatalogDraft, branch, 1, new Date().toISOString());
    const event = await publishMenu(cloud.pool, menu);
    assert.deepEqual(await publishMenu(cloud.pool, menu), event);
    assert.equal(
      (await cloud.pool.query('SELECT count(*)::int n FROM branch_menu_activations')).rows[0].n,
      0,
    );
    assert.equal((await pullMenu(cloud.pool, auth)).event.event_id, event.event_id);
    assert.equal((await pullMenu(cloud.pool, auth)).event.event_id, event.event_id);
    await assert.rejects(applyMenu(edge.pool, randomUUID(), event));
    const ack = await applyMenu(edge.pool, branch, event);
    assert.deepEqual(await applyMenu(edge.pool, branch, event), ack);
    assert.equal(
      (await cloud.pool.query('SELECT count(*)::int n FROM branch_menu_activations')).rows[0].n,
      0,
    );
    await assert.rejects(acknowledgeMenu(cloud.pool, auth, { ...ack, checksum: 'a'.repeat(64) }));
    await acknowledgeMenu(cloud.pool, auth, ack);
    await acknowledgeMenu(cloud.pool, auth, ack);
    assert.equal((await pullMenu(cloud.pool, auth)).event, null);
    const payload = structuredClone(mockupCatalogDraft);
    payload.products[0].price_minor = '543200';
    const next = projectCatalogMenu(payload, branch, 2, new Date().toISOString());
    assert.equal(next.items[0].variant_id, menu.items[0].variant_id);
    const nextEvent = await publishMenu(cloud.pool, next);
    const nextAck = await applyMenu(edge.pool, branch, nextEvent);
    await acknowledgeMenu(cloud.pool, auth, nextAck);
    const active = (
      await edge.pool.query(
        'SELECT payload FROM active_menu a JOIN menu_snapshots m ON m.id=a.release_id WHERE a.branch_id=$1',
        [branch],
      )
    ).rows[0].payload;
    assert.equal(active.items[0].price_minor, '543200');
    assert.equal(
      (
        await cloud.pool.query(
          'SELECT release_id FROM branch_menu_activations WHERE branch_id=$1',
          [branch],
        )
      ).rows[0].release_id,
      next.release_id,
    );
  });
});

test('CMS publication atomically queues edge menu and reports applied only after active device ACK', async () => {
  const { CatalogAdmin, provisionCatalogManager } =
    await import('../../packages/catalog-admin/dist/index.js');
  const { readCatalogMenuDelivery, revokeDevice } =
    await import('../../packages/menu-sync/dist/index.js');
  await withSyncDatabases(async ({ cloud, edge, org, branch, device }) => {
    const auth = authFor(await provisionDevice(cloud.pool, device));
    const manager = await provisionCatalogManager(cloud.pool, {
      organization_id: org,
      name: 'Synthetic editor',
      branch_ids: [branch],
    });
    await cloud.pool.query(
      'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
      [branch, org, device, randomUUID()],
    );
    const service = new CatalogAdmin(cloud.pool, {
      enabled: true,
      edgePublicationBranchId: branch,
    });
    let state = await service.seed(manager.token, branch, {
      expected_revision: 0,
      request_id: randomUUID(),
    });
    const payload = structuredClone(state.draft.payload);
    payload.content_reviewed = true;
    state = await service.save(manager.token, branch, {
      expected_revision: state.draft.revision,
      request_id: randomUUID(),
      payload,
    });
    const request = {
      expected_revision: state.draft.revision,
      expected_published_version: 0,
      request_id: randomUUID(),
      confirmation: 'publish_catalog',
    };
    state = await service.publish(manager.token, branch, request);
    assert.equal(state.edge_delivery.status, 'pending');
    assert.equal(state.edge_delivery.catalog_version, 1);
    assert.deepEqual(await service.publish(manager.token, branch, request), state);
    assert.equal(
      (await cloud.pool.query('SELECT count(*)::int n FROM menu_releases')).rows[0].n,
      1,
    );
    const event = (await pullMenu(cloud.pool, auth)).event;
    await applyMenu(edge.pool, branch, event);
    assert.equal((await service.read(manager.token, branch)).edge_delivery.status, 'pending');
    await acknowledgeMenu(cloud.pool, auth, await applyMenu(edge.pool, branch, event));
    assert.equal((await service.read(manager.token, branch)).edge_delivery.status, 'applied');
    assert.equal((await readCatalogMenuDelivery(cloud.pool, branch, 1)).status, 'applied');
    await cloud.pool.query(
      'UPDATE fulfillment_transport_bindings SET active=false WHERE branch_id=$1',
      [branch],
    );
    assert.equal((await readCatalogMenuDelivery(cloud.pool, branch, 1)).status, 'unavailable');
    await cloud.pool.query(
      'UPDATE fulfillment_transport_bindings SET active=true WHERE branch_id=$1',
      [branch],
    );
    await revokeDevice(cloud.pool, device);
    assert.equal((await service.read(manager.token, branch)).edge_delivery.status, 'unavailable');
  });
});

test('CMS refuses edge publication with no active edge and rolls back the catalog head', async () => {
  const { CatalogAdmin, provisionCatalogManager } =
    await import('../../packages/catalog-admin/dist/index.js');
  await withSyncDatabases(async ({ cloud, org, branch }) => {
    const manager = await provisionCatalogManager(cloud.pool, {
      organization_id: org,
      name: 'Synthetic editor',
      branch_ids: [branch],
    });
    const service = new CatalogAdmin(cloud.pool, {
      enabled: true,
      edgePublicationBranchId: branch,
    });
    let state = await service.seed(manager.token, branch, {
      expected_revision: 0,
      request_id: randomUUID(),
    });
    const payload = structuredClone(state.draft.payload);
    payload.content_reviewed = true;
    state = await service.save(manager.token, branch, {
      expected_revision: state.draft.revision,
      request_id: randomUUID(),
      payload,
    });
    await assert.rejects(
      service.publish(manager.token, branch, {
        expected_revision: state.draft.revision,
        expected_published_version: 0,
        request_id: randomUUID(),
        confirmation: 'publish_catalog',
      }),
      (e) => e.code === 'CONFLICT',
    );
    assert.equal((await service.read(manager.token, branch)).published, null);
    assert.equal(
      (await cloud.pool.query('SELECT count(*)::int n FROM catalog_publications')).rows[0].n,
      0,
    );
    assert.equal(
      (await cloud.pool.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n,
      0,
    );
  });
});
