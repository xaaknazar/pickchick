// Stage 2 (24.10.2026), lane pcs: two-step rollout of the cashier combo stop fields.
// The cloud stores the extended publication only behind CATALOG_EDGE_COMBO_STOPS_ENABLED and
// gives it only to an edge that sends menu_features=combo_stops; any other edge (the installed
// edge021 runtime) receives exactly the old publication and its checksum.
/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createApi } from '@pickchick/api';
import {
  acknowledgeMenu,
  applyMenu,
  canonicalJson,
  hashJson,
  projectCatalogMenu,
  provisionDevice,
  publishMenu,
  pullMenu,
  syncMenuOnce,
  withoutComboStopLinks,
} from '@pickchick/menu-sync';
import { MenuPullSchema } from '@pickchick/contracts';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';
import { withSyncDatabases, running, authFor, headersFor, request } from '../helpers/sync.mjs';

function ownerCatalog() {
  const catalog = structuredClone(mockupCatalogDraft);
  const product = (id) => catalog.products.find((p) => p.id === id);
  product('pick-combo').combo_components = [
    { product_id: 'fingers', quantity: 3 },
    { product_id: 'toast', quantity: 1 },
  ];
  for (const option of product('pick-combo').modifier_groups.find((g) => g.id === 'drink').options)
    if (option.id === 'cola-bottle') option.linked_product_id = 'cola';
  return catalog;
}
const at = '2026-10-24T00:00:00.000Z';
const fieldsIn = (value) =>
  /combo_component_variant_ids|linked_variant_id/.test(JSON.stringify(value));
const isConflict = { message: 'CONFLICT' };

test('flag on, old edge: no menu_features gives the old publication and its ACK is accepted', async () => {
  await withSyncDatabases(async ({ cloud, edge, device, branch }) => {
    const identity = await provisionDevice(cloud.pool, device);
    const release = randomUUID();
    const extended = projectCatalogMenu(ownerCatalog(), branch, 1, at, release, {
      comboStops: true,
    });
    const legacy = projectCatalogMenu(ownerCatalog(), branch, 1, at, release);
    const published = await publishMenu(cloud.pool, extended);
    assert.equal(published.payload.checksum, hashJson(extended));
    const api = await running(createApi, cloud.config);
    try {
      const pull = async (query = '') => {
        const response = await request(`${api.url}/internal/v1/edge/sync/pull${query}`, {
          headers: headersFor(identity),
        });
        assert.equal(response.status, 200);
        const text = await response.text();
        return { text, body: MenuPullSchema.parse(JSON.parse(text)) };
      };
      // The installed edge021 worker: no menu_features (with and without its active menu).
      for (const query of ['', `?active_release_id=${randomUUID()}&active_version=1`]) {
        const old = await pull(query);
        assert.equal(fieldsIn(old.text), false);
        assert.deepEqual(old.body.event.payload.menu, legacy);
        assert.equal(old.body.event.payload.checksum, hashJson(legacy));
        assert.equal(old.body.event.event_id, published.event_id);
      }
      // Unknown or future features are ignored, never an error.
      assert.equal(fieldsIn((await pull('?menu_features=future_thing')).text), false);
      // A new edge gets the stored publication itself.
      const fresh = await pull('?menu_features=combo_stops');
      assert.deepEqual(fresh.body.event, published);
      // The old edge applies the old form; the cloud accepts that checksum, nothing else.
      const event = (await pull()).body.event;
      const ack = await applyMenu(edge.pool, branch, event);
      assert.equal(ack.checksum, hashJson(legacy));
      assert.equal(ack.result, undefined);
      await assert.rejects(
        acknowledgeMenu(cloud.pool, authFor(identity), { ...ack, checksum: 'a'.repeat(64) }),
        isConflict,
      );
      const response = await request(`${api.url}/internal/v1/edge/sync/ack`, {
        method: 'POST',
        headers: headersFor(identity),
        body: JSON.stringify(ack),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(
        (await cloud.pool.query('SELECT release_id FROM branch_menu_activations')).rows,
        [{ release_id: release }],
      );
      // A replay of the same ACK is idempotent; an ACK of the other form is not a second ACK.
      await acknowledgeMenu(cloud.pool, authFor(identity), ack);
      await assert.rejects(
        acknowledgeMenu(cloud.pool, authFor(identity), { ...ack, checksum: hashJson(extended) }),
        isConflict,
      );
      const stored = (await edge.pool.query('SELECT payload, checksum FROM menu_snapshots'))
        .rows[0];
      assert.equal(fieldsIn(stored.payload), false);
      assert.equal(stored.checksum, hashJson(legacy));
      // The public branch menu never shows the cashier fields.
      const publicMenu = await request(`${api.url}/v1/branches/${branch}/menu`);
      assert.equal(publicMenu.status, 200);
      assert.deepEqual(await publicMenu.json(), legacy);
    } finally {
      await api.app.close();
    }
  });
});

test('flag on, new edge: the worker sends menu_features and applies the cashier fields', async () => {
  await withSyncDatabases(async ({ cloud, edge, device, branch }) => {
    const identity = await provisionDevice(cloud.pool, device);
    const extended = projectCatalogMenu(ownerCatalog(), branch, 1, at, randomUUID(), {
      comboStops: true,
    });
    await publishMenu(cloud.pool, extended);
    const api = await running(createApi, cloud.config);
    try {
      assert.deepEqual(await syncMenuOnce(edge.pool, branch, api.url, identity), {
        state: 'applied',
      });
      assert.deepEqual(await syncMenuOnce(edge.pool, branch, api.url, identity), { state: 'idle' });
    } finally {
      await api.app.close();
    }
    const stored = (await edge.pool.query('SELECT payload, checksum FROM menu_snapshots')).rows[0];
    assert.equal(canonicalJson(stored.payload), canonicalJson(extended));
    assert.equal(stored.checksum, hashJson(extended));
    assert.equal(
      (await cloud.pool.query('SELECT release_id FROM branch_menu_activations')).rows[0].release_id,
      extended.release_id,
    );
    // The edge kept reporting its active menu next to the feature key.
    assert.equal(
      (await cloud.pool.query('SELECT active_version FROM edge_menu_state')).rows[0].active_version,
      1,
    );
  });
});

test('flag off (old cloud), new edge: the extra query key is ignored, old menus apply as before', async () => {
  await withSyncDatabases(async ({ cloud, edge, device, branch }) => {
    const identity = await provisionDevice(cloud.pool, device);
    const legacy = projectCatalogMenu(ownerCatalog(), branch, 1, at, randomUUID());
    const next = projectCatalogMenu(ownerCatalog(), branch, 2, at, randomUUID());
    const first = await publishMenu(cloud.pool, legacy);
    await publishMenu(cloud.pool, next);
    const api = await running(createApi, cloud.config);
    try {
      assert.deepEqual(await syncMenuOnce(edge.pool, branch, api.url, identity), {
        state: 'applied',
      });
      assert.deepEqual(await syncMenuOnce(edge.pool, branch, api.url, identity), {
        state: 'applied',
      });
    } finally {
      await api.app.close();
    }
    const stored = (
      await edge.pool.query('SELECT payload, checksum FROM menu_snapshots ORDER BY version')
    ).rows;
    assert.deepEqual(
      stored.map((row) => row.checksum),
      [first.payload.checksum, hashJson(next)],
    );
    assert.equal(fieldsIn(stored), false);
    // The stored release keeps its checksum: the cloud never rewrote the old publication.
    assert.deepEqual(
      (await cloud.pool.query('SELECT checksum FROM menu_releases ORDER BY version')).rows.map(
        (row) => row.checksum,
      ),
      [hashJson(legacy), hashJson(next)],
    );
    assert.equal(withoutComboStopLinks(legacy), legacy);
  });
});

test('direct pull without features downgrades only menus that carry the fields', async () => {
  await withSyncDatabases(async ({ cloud, device, branch }) => {
    const auth = authFor(await provisionDevice(cloud.pool, device));
    const legacy = projectCatalogMenu(ownerCatalog(), branch, 1, at, randomUUID());
    const event = await publishMenu(cloud.pool, legacy);
    // Byte-identical to the stored event for a menu without the fields, with or without features.
    assert.deepEqual((await pullMenu(cloud.pool, auth)).event, event);
    assert.deepEqual(
      (await pullMenu(cloud.pool, auth, undefined, { features: ['combo_stops'] })).event,
      event,
    );
  });
});

test('catalog publication projects the cashier fields only with the cloud flag', async () => {
  const { CatalogAdmin, provisionCatalogManager } =
    await import('../../packages/catalog-admin/dist/index.js');
  await withSyncDatabases(async ({ cloud, edge, org, branch, device }) => {
    const auth = authFor(await provisionDevice(cloud.pool, device));
    const manager = await provisionCatalogManager(cloud.pool, {
      organization_id: org,
      name: 'Synthetic editor',
      branch_ids: [branch],
    });
    // The edge reports an operator-installed v1 menu (publication bootstrap).
    const local = projectCatalogMenu(mockupCatalogDraft, branch, 1, at);
    await edge.pool.query(
      'INSERT INTO menu_snapshots(id,branch_id,version,schema_version,payload,checksum,published_at) VALUES($1,$2,1,1,$3,$4,$5)',
      [local.release_id, branch, canonicalJson(local), hashJson(local), local.published_at],
    );
    await pullMenu(cloud.pool, auth, { active_release_id: local.release_id, active_version: 1 });
    const off = new CatalogAdmin(cloud.pool, { enabled: true, edgePublicationBranchId: branch });
    const on = new CatalogAdmin(cloud.pool, {
      enabled: true,
      edgePublicationBranchId: branch,
      edgeComboStops: true,
    });
    let state = await off.seed(manager.token, branch, {
      expected_revision: 0,
      request_id: randomUUID(),
    });
    const publish = async (service) => {
      const payload = ownerCatalog();
      payload.content_reviewed = true;
      state = await service.save(manager.token, branch, {
        expected_revision: state.draft.revision,
        request_id: randomUUID(),
        payload,
      });
      state = await service.publish(manager.token, branch, {
        expected_revision: state.draft.revision,
        expected_published_version: state.published?.version ?? 0,
        request_id: randomUUID(),
        confirmation: 'publish_catalog',
      });
      return (
        await cloud.pool.query('SELECT payload FROM menu_releases ORDER BY version DESC LIMIT 1')
      ).rows[0].payload;
    };
    const plain = await publish(off);
    assert.equal(fieldsIn(plain), false);
    const flagged = await publish(on);
    assert.equal(fieldsIn(flagged), true);
    assert.equal(hashJson(withoutComboStopLinks(flagged)), hashJson({ ...plain, ...ids(flagged) }));
  });
});
/** Release identity fields differ between two publications; everything else must match. */
const ids = (menu) => ({
  release_id: menu.release_id,
  version: menu.version,
  published_at: menu.published_at,
});
