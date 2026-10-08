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
  revokeDevice,
  canonicalJson,
  hashJson,
} from '../../packages/menu-sync/dist/index.js';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';
import { withSyncDatabases, authFor } from '../helpers/sync.mjs';

/** Writes a menu straight into the edge, like the operator-installed POS v2 (no sync state). */
async function installLocalMenu(edge, branch, version) {
  const menu = projectCatalogMenu(mockupCatalogDraft, branch, version, new Date().toISOString());
  await edge.pool.query(
    'INSERT INTO menu_snapshots(id,branch_id,version,schema_version,payload,checksum,published_at) VALUES($1,$2,$3,1,$4,$5,$6)',
    [menu.release_id, branch, version, canonicalJson(menu), hashJson(menu), menu.published_at],
  );
  await edge.pool.query(
    'INSERT INTO active_menu(branch_id,release_id) VALUES($1,$2) ON CONFLICT(branch_id) DO UPDATE SET release_id=EXCLUDED.release_id',
    [branch, menu.release_id],
  );
  return { active_release_id: menu.release_id, active_version: version };
}

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
    await pullMenu(cloud.pool, auth, await installLocalMenu(edge, branch, 2));
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
    assert.equal(state.edge_delivery.menu_version, 3);
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
      (e) => e.code === 'CONFLICT' && e.reason === 'EDGE_DEVICE_INACTIVE',
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

const count = async (pool, table) =>
  (await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;

/** Edge-published catalog with a bound active edge; `publish` saves a reviewed draft first. */
async function edgeCatalog(run, options = {}) {
  const { CatalogAdmin, provisionCatalogManager } =
    await import('../../packages/catalog-admin/dist/index.js');
  await withSyncDatabases(async (ctx) => {
    const { cloud, org, branch, device } = ctx;
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
      ...options,
    });
    await service.seed(manager.token, branch, { expected_revision: 0, request_id: randomUUID() });
    const read = () => service.read(manager.token, branch);
    const publish = async (mutate = () => undefined) => {
      let state = await read();
      const payload = structuredClone(state.draft.payload);
      payload.content_reviewed = true;
      mutate(payload);
      state = await service.save(manager.token, branch, {
        expected_revision: state.draft.revision,
        request_id: randomUUID(),
        payload,
      });
      return service.publish(manager.token, branch, {
        expected_revision: state.draft.revision,
        expected_published_version: state.published?.version ?? 0,
        request_id: randomUUID(),
        confirmation: 'publish_catalog',
      });
    };
    await run({ ...ctx, auth, manager, service, read, publish });
  });
}
const rejectedAck = (event, reason) => ({
  event_id: event.event_id,
  producer_id: event.producer_id,
  producer_sequence: event.producer_sequence,
  branch_id: event.branch_id,
  release_id: event.aggregate_id,
  checksum: event.payload.checksum,
  result: 'rejected',
  reason,
});

test('edge version bootstrap: unknown edge state refuses publication, reported local v2 publishes v3', async () =>
  edgeCatalog(async ({ cloud, edge, branch, auth, read, publish }) => {
    await assert.rejects(
      publish(),
      (e) => e.code === 'CONFLICT' && e.reason === 'EDGE_MENU_STATE_UNKNOWN',
    );
    assert.equal((await read()).published, null);
    for (const table of ['catalog_publications', 'menu_releases', 'outbox_events'])
      assert.equal(await count(cloud.pool, table), 0, table);
    // Older workers pull without a report: nothing is recorded.
    assert.deepEqual(await pullMenu(cloud.pool, auth), { event: null });
    assert.equal(await count(cloud.pool, 'edge_menu_state'), 0);
    const local = await installLocalMenu(edge, branch, 2);
    assert.deepEqual(
      await pullMenu(cloud.pool, auth, { ...local, active_version: '2' }),
      { event: null },
      'query strings are accepted',
    );
    const state = await publish();
    assert.equal(state.published.version, 1);
    assert.equal(state.edge_delivery.menu_version, 3);
    assert.equal(state.edge_delivery.status, 'pending');
    assert.equal(state.edge_delivery.edge_active_version, 2);
    assert.ok(Date.parse(state.edge_delivery.observed_at) > 0);
    assert.equal(state.edge_delivery.reject_reason, undefined);
    const event = (await pullMenu(cloud.pool, auth, local)).event;
    assert.equal(event.aggregate_version, 3);
    assert.equal(event.producer_sequence, '1');
    const ack = await applyMenu(edge.pool, branch, event);
    await acknowledgeMenu(cloud.pool, auth, ack);
    assert.equal(
      (
        await pullMenu(cloud.pool, auth, {
          active_release_id: event.aggregate_id,
          active_version: 3,
        })
      ).event,
      null,
    );
    const applied = (await read()).edge_delivery;
    assert.equal(applied.status, 'applied');
    assert.equal(applied.edge_active_version, 3);
    assert.deepEqual(
      (await cloud.pool.query('SELECT result,reason FROM catalog_menu_delivery_results')).rows,
      [{ result: 'applied', reason: null }],
    );
    // Cloud history is now ahead of nothing: the next release continues from 3.
    assert.equal(
      (await publish((p) => (p.products[0].price_minor = '777700'))).edge_delivery.menu_version,
      4,
    );
  }));

test('rejected edge ACK unblocks the next publication and shows the reason without activating', async () =>
  edgeCatalog(async ({ cloud, edge, branch, auth, read, publish }) => {
    const local = await installLocalMenu(edge, branch, 2);
    await pullMenu(cloud.pool, auth, local);
    await publish();
    const first = (await pullMenu(cloud.pool, auth, local)).event;
    assert.equal(first.aggregate_version, 3);
    const reject = rejectedAck(first, 'ROUTING_UNRESOLVED');
    assert.deepEqual(await acknowledgeMenu(cloud.pool, auth, reject), {
      event_id: first.event_id,
      acknowledged: true,
    });
    // Lost-response retry is idempotent; changing the verdict for the same event is not.
    await acknowledgeMenu(cloud.pool, auth, reject);
    const applied = structuredClone(reject);
    delete applied.result;
    delete applied.reason;
    await assert.rejects(acknowledgeMenu(cloud.pool, auth, applied), (e) => e.code === 'CONFLICT');
    await assert.rejects(
      acknowledgeMenu(cloud.pool, auth, { ...reject, reason: 'MEDIA_UNAVAILABLE' }),
      (e) => e.code === 'CONFLICT',
    );
    assert.equal(await count(cloud.pool, 'branch_menu_activations'), 0);
    const rejected = (await read()).edge_delivery;
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.reject_reason, 'ROUTING_UNRESOLVED');
    assert.equal(rejected.acknowledged_at, null);
    assert.equal(rejected.edge_active_version, 2);
    await publish((p) => (p.products[0].price_minor = '654300'));
    const next = (await pullMenu(cloud.pool, auth, local)).event;
    assert.equal(next.aggregate_version, 4);
    assert.equal(next.producer_sequence, '2');
    const second = (await read()).edge_delivery;
    assert.equal(second.status, 'pending');
    assert.equal(second.menu_version, 4);
    assert.deepEqual(
      (
        await cloud.pool.query(
          'SELECT r.result,r.reason,m.version FROM catalog_menu_delivery_results r JOIN menu_releases m ON m.id=r.release_id',
        )
      ).rows,
      [{ result: 'rejected', reason: 'ROUTING_UNRESOLVED', version: 3 }],
    );
    await assert.rejects(
      cloud.pool.query("UPDATE catalog_menu_delivery_results SET reason='INVALID_MENU'"),
      (e) => e.code === '23514',
    );
  }));

test('stale or other-device edge state reports are ignored', async () =>
  edgeCatalog(async ({ cloud, org, branch, device, auth, publish }) => {
    const state = async () =>
      (
        await cloud.pool.query(
          'SELECT device_id,active_release_id,active_version FROM edge_menu_state WHERE branch_id=$1',
          [branch],
        )
      ).rows[0];
    const v5 = { active_release_id: randomUUID(), active_version: 5 };
    await pullMenu(cloud.pool, auth, v5);
    await pullMenu(cloud.pool, auth, { active_release_id: randomUUID(), active_version: 4 });
    assert.deepEqual(await state(), { device_id: device, ...v5 });
    for (const invalid of [
      { active_release_id: v5.active_release_id },
      { active_release_id: 'x', active_version: 6 },
      { ...v5, active_version: 0 },
      { ...v5, active_version: '-1' },
      { ...v5, active_version: '6.5' },
      { ...v5, active_version: ['6'] },
      { ...v5, extra: true },
    ])
      await assert.rejects(
        pullMenu(cloud.pool, auth, invalid),
        (e) => e.code === 'INVALID_REQUEST',
      );
    await assert.rejects(
      pullMenu(cloud.pool, { ...auth, token: 'f'.repeat(64) }, { ...v5, active_version: 9 }),
      (e) => e.code === 'UNAUTHORIZED',
    );
    assert.deepEqual(await state(), { device_id: device, ...v5 });
    // A replacement edge cannot claim the old edge's row without a fencing protocol.
    await revokeDevice(cloud.pool, device);
    const replacement = randomUUID();
    await cloud.pool.query(
      "INSERT INTO devices(id,branch_id,organization_id,kind,name) VALUES ($1,$2,$3,'edge','Replacement')",
      [replacement, branch, org],
    );
    const other = authFor(await provisionDevice(cloud.pool, replacement));
    await pullMenu(cloud.pool, other, { active_release_id: randomUUID(), active_version: 7 });
    assert.deepEqual(await state(), { device_id: device, ...v5 });
    await assert.rejects(
      publish(),
      (e) => e.code === 'CONFLICT' && e.reason === 'EDGE_MENU_STATE_UNKNOWN',
    );
  }));

test('projection failures map to precise publication reasons and roll back', async () =>
  edgeCatalog(async ({ cloud, edge, branch, auth, read, publish }) => {
    await pullMenu(cloud.pool, auth, await installLocalMenu(edge, branch, 2));
    await assert.rejects(
      publish((p) => (p.products[0].channel_prices_minor = { pos: '100' })),
      (e) => e.code === 'CONFLICT' && e.reason === 'CHANNEL_PRICES_NOT_SUPPORTED',
    );
    await assert.rejects(
      publish((p) => {
        delete p.products[0].channel_prices_minor;
        const parent = p.products.find((product) =>
          product.modifier_groups.some((g) => g.options.some((o) => o.available)),
        );
        assert.ok(parent, 'seed has an available modifier option');
        const linked = p.products.find((product) => product.id !== parent.id);
        parent.modifier_groups
          .find((g) => g.options.some((o) => o.available))
          .options.find((o) => o.available).linked_product_id = linked.id;
        linked.available = false;
      }),
      (e) => e.code === 'CONFLICT' && e.reason === 'UNAVAILABLE_LINKED_PRODUCT',
    );
    assert.equal((await read()).published, null);
    for (const table of ['catalog_publications', 'menu_releases', 'outbox_events'])
      assert.equal(await count(cloud.pool, table), 0, table);
  }));

test('publication support reflects the configured edge and kiosk branches', async () => {
  const { CatalogAdmin, provisionCatalogManager } =
    await import('../../packages/catalog-admin/dist/index.js');
  await withSyncDatabases(async ({ cloud, org, branch }) => {
    const manager = await provisionCatalogManager(cloud.pool, {
      organization_id: org,
      name: 'Synthetic editor',
      branch_ids: [branch],
    });
    const read = (options) =>
      new CatalogAdmin(cloud.pool, { enabled: true, ...options }).read(manager.token, branch);
    assert.deepEqual((await read({})).publication_support, {
      mobile: false,
      pos: false,
      kiosk: false,
    });
    assert.deepEqual((await read({ kioskBranchId: branch })).publication_support, {
      mobile: false,
      pos: false,
      kiosk: true,
    });
    assert.deepEqual(
      (await read({ kioskBranchId: randomUUID(), edgePublicationBranchId: branch }))
        .publication_support,
      { mobile: false, pos: true, kiosk: false },
    );
  });
});
