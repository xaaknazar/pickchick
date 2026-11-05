/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MenuSnapshotSchema } from '../../packages/contracts/dist/index.js';
import { CatalogAdmin, provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';
import { withPikoFlavors } from '../../packages/catalog-admin/dist/piko-flavors.js';
import {
  acknowledgeMenu,
  applyMenu,
  canonicalJson,
  hashJson,
  projectCatalogMenu,
  provisionDevice,
  pullMenu,
} from '../../packages/menu-sync/dist/index.js';
import { parityRun } from '../../scripts/catalog-edge-parity.mjs';
import {
  loadManifest,
  payloadHash,
  runBuild,
  runPublish,
  runSave,
} from '../../scripts/catalog-menu-import.mjs';
import { withSyncDatabases, authFor } from '../helpers/sync.mjs';

const FIXTURE = fileURLToPath(
  new URL('../../packages/catalog-admin/fixtures/real-menu-2026-11/', import.meta.url),
);

/** The operator-installed POS v2 menu written straight into the edge (no sync state yet). */
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
const activeMenu = async (edge, branch) =>
  MenuSnapshotSchema.parse(
    (
      await edge.pool.query(
        'SELECT m.payload FROM active_menu a JOIN menu_snapshots m ON m.id=a.release_id WHERE a.branch_id=$1',
        [branch],
      )
    ).rows[0].payload,
  );
/** One cycle of the edge menu worker: pull, apply, ack, then report the active menu on the next pull. */
async function deliver(cloud, edge, auth, branch) {
  const { event } = await pullMenu(cloud.pool, auth);
  const ack = await applyMenu(edge.pool, branch, event);
  await acknowledgeMenu(cloud.pool, auth, ack);
  const active = await activeMenu(edge, branch);
  await pullMenu(cloud.pool, auth, {
    active_release_id: active.release_id,
    active_version: active.version,
  });
  return ack;
}

test('the real CMS saves and publishes the built menu and the edge applies all 54 items', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-menu-import-pg-'));
  try {
    await withSyncDatabases(async ({ cloud, edge, org, branch, device }) => {
      const auth = authFor(await provisionDevice(cloud.pool, device));
      const manager = await provisionCatalogManager(cloud.pool, {
        organization_id: org,
        name: 'Synthetic catalog editor',
        branch_ids: [branch],
      });
      await cloud.pool.query(
        'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
        [branch, org, device, randomUUID()],
      );
      // Flags as installed: edge publication on, no stage-2 combo stops.
      const service = new CatalogAdmin(cloud.pool, {
        enabled: true,
        edgePublicationBranchId: branch,
      });
      await pullMenu(cloud.pool, auth, await installLocalMenu(edge, branch, 2));
      // The published v11 menu (synthetic copy of the mockup with Piko flavours).
      let state = await service.seed(manager.token, branch, {
        expected_revision: 0,
        request_id: randomUUID(),
      });
      state = await service.save(manager.token, branch, {
        expected_revision: state.draft.revision,
        request_id: randomUUID(),
        payload: withPikoFlavors({
          ...structuredClone(state.draft.payload),
          content_source: 'operator',
          content_reviewed: true,
        }),
      });
      await service.publish(manager.token, branch, {
        expected_revision: state.draft.revision,
        expected_published_version: 0,
        request_id: randomUUID(),
        confirmation: 'publish_catalog',
      });
      await deliver(cloud, edge, auth, branch);
      state = await service.read(manager.token, branch);
      assert.equal(state.edge_delivery.status, 'applied');
      const installed = await activeMenu(edge, branch);
      assert.equal(installed.items.length, 24);
      // M1 flow: build from the sheets against the live state and edge menu, review, parity, save, publish.
      const current = join(dir, 'state.json'),
        edgeFile = join(dir, 'edge-menu.json'),
        out = join(dir, 'out');
      await writeFile(current, JSON.stringify(state));
      await writeFile(edgeFile, JSON.stringify(installed));
      const build = await runBuild({ dir: FIXTURE, out, current, edge: edgeFile });
      assert.deepEqual(build.manifest.errors, []);
      const loaded = await loadManifest(join(out, 'manifest.json'));
      const api = {
        read: (id) => service.read(manager.token, id),
        save: (id, body) => service.save(manager.token, id, body),
        publish: (id, body) => service.publish(manager.token, id, body),
      };
      const saved = await runSave({ loaded, branch, reviewedBy: 'Синтетический Управляющий', api });
      assert.equal(saved.status, 'saved');
      // Saving again is a no-op even though the server would refuse the old expected_revision.
      assert.equal(
        (await runSave({ loaded, branch, reviewedBy: 'Синтетический Управляющий', api })).status,
        'already_saved',
      );
      const { readFile } = await import('node:fs/promises');
      const parity = parityRun({
        catalog: JSON.parse(await readFile(join(out, 'payload.json'), 'utf8')),
        snapshot: installed,
        allow: {
          expected: JSON.parse(await readFile(join(out, 'expected-edge-changes.json'), 'utf8')),
          sha256: loaded.expected.sha256,
        },
      });
      assert.equal(parity.ok, true);
      const published = await runPublish({ loaded, branch, parity, api });
      assert.deepEqual([published.status, published.published_version], ['published', 2]);
      assert.equal(published.edge_delivery.status, 'pending');
      assert.equal(published.payload_sha256, payloadHash(loaded.reviewed));
      await deliver(cloud, edge, auth, branch);
      state = await service.read(manager.token, branch);
      assert.equal(state.edge_delivery.status, 'applied');
      assert.equal(state.published.payload.content_reviewed, true);
      const applied = await activeMenu(edge, branch);
      assert.equal(applied.items.length, 54);
      // Every cashier price is the reviewed hall price; installed identities are unchanged.
      const prices = new Map(loaded.reviewed.products.map((p) => [p.id, p.price_minor]));
      for (const item of applied.items) assert.equal(item.price_minor, prices.get(item.source_id));
      for (const item of installed.items)
        assert.ok(
          applied.items.some((next) => next.variant_id === item.variant_id),
          item.name.ru,
        );
      assert.equal(applied.items.find((i) => i.source_id === 'pick-combo').price_minor, '369000');
      // A repeat of publish only reports; nothing new is queued.
      assert.equal((await runPublish({ loaded, branch, parity, api })).status, 'already_published');
      assert.equal((await pullMenu(cloud.pool, auth)).event ?? null, null);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** One worker cycle of a new edge that advertises its menu features (cutover runtime). */
async function deliverWithFeatures(cloud, edge, auth, branch, features) {
  const { event } = await pullMenu(cloud.pool, auth, undefined, { features });
  const ack = await applyMenu(edge.pool, branch, event);
  await acknowledgeMenu(cloud.pool, auth, ack);
  const active = await activeMenu(edge, branch);
  await pullMenu(
    cloud.pool,
    auth,
    { active_release_id: active.release_id, active_version: active.version },
    { features },
  );
  return ack;
}

test('CC-3: after М1 the hall-fallback build publishes aggregator prices only with the flag', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-menu-import-pg-'));
  const { readFile } = await import('node:fs/promises');
  try {
    await withSyncDatabases(async ({ cloud, edge, org, branch, device }) => {
      const auth = authFor(await provisionDevice(cloud.pool, device));
      const manager = await provisionCatalogManager(cloud.pool, {
        organization_id: org,
        name: 'Synthetic catalog editor',
        branch_ids: [branch],
      });
      await cloud.pool.query(
        'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
        [branch, org, device, randomUUID()],
      );
      const options = { enabled: true, edgePublicationBranchId: branch };
      const off = new CatalogAdmin(cloud.pool, options);
      const on = new CatalogAdmin(cloud.pool, { ...options, edgeAggregatorPrices: true });
      const features = ['combo_stops', 'aggregator_prices'];
      await pullMenu(cloud.pool, auth, await installLocalMenu(edge, branch, 2), { features });
      // М1 with the flag off: the real menu at hall prices (as in the test above).
      let state = await off.seed(manager.token, branch, {
        expected_revision: 0,
        request_id: randomUUID(),
      });
      const apiOf = (service) => ({
        read: (id) => service.read(manager.token, id),
        save: (id, body) => service.save(manager.token, id, body),
        publish: (id, body) => service.publish(manager.token, id, body),
      });
      const cycle = async (name, service, aggregatorPrices) => {
        state = await service.read(manager.token, branch);
        const installed = await activeMenu(edge, branch);
        const current = join(dir, `${name}-state.json`),
          edgeFile = join(dir, `${name}-edge.json`),
          out = join(dir, name);
        await writeFile(current, JSON.stringify(state));
        await writeFile(edgeFile, JSON.stringify(installed));
        const build = await runBuild({
          dir: FIXTURE,
          out,
          current,
          edge: edgeFile,
          aggregatorPrices,
        });
        assert.deepEqual(build.manifest.errors, []);
        const loaded = await loadManifest(join(out, 'manifest.json'));
        const api = apiOf(service);
        await runSave({ loaded, branch, reviewedBy: 'Синтетический Управляющий', api });
        const parity = parityRun({
          catalog: JSON.parse(await readFile(join(out, 'payload.json'), 'utf8')),
          snapshot: installed,
          allow: {
            expected: JSON.parse(await readFile(join(out, 'expected-edge-changes.json'), 'utf8')),
            sha256: loaded.expected.sha256,
          },
          aggregatorPrices: aggregatorPrices !== 'off',
        });
        assert.equal(parity.ok, true, JSON.stringify(parity.allow));
        return { loaded, parity, api };
      };
      // The installed v1 seed publication first (М1 compares against a published head).
      state = await off.save(manager.token, branch, {
        expected_revision: state.draft.revision,
        request_id: randomUUID(),
        payload: { ...structuredClone(state.draft.payload), content_reviewed: true },
      });
      await off.publish(manager.token, branch, {
        expected_revision: state.draft.revision,
        expected_published_version: 0,
        request_id: randomUUID(),
        confirmation: 'publish_catalog',
      });
      await deliverWithFeatures(cloud, edge, auth, branch, features);
      const m1 = await cycle('m1', off, 'off');
      assert.equal((await runPublish({ ...m1, branch })).status, 'published');
      await deliverWithFeatures(cloud, edge, auth, branch, features);
      const hall = await activeMenu(edge, branch);
      assert.equal(hall.items.length, 54);
      assert.equal(
        hall.items.some((i) => i.aggregator_prices_minor),
        false,
      );
      // CC-3 build, flag still off on the cloud: the tool refuses before any request.
      const cc3 = await cycle('cc3', off, 'hall-fallback');
      await assert.rejects(
        runPublish({ ...cc3, branch }),
        (e) => e.code === 'AGGREGATOR_PRICES_DISABLED',
      );
      // Flag on: published, delivered to the new edge with aggregator_prices_minor.
      const published = await runPublish({ ...cc3, api: apiOf(on), branch });
      assert.equal(published.status, 'published');
      await deliverWithFeatures(cloud, edge, auth, branch, features);
      state = await on.read(manager.token, branch);
      assert.equal(state.edge_delivery.status, 'applied');
      assert.equal(state.publication_support.aggregator_prices, true);
      const priced = await activeMenu(edge, branch);
      assert.equal(priced.items.length, 54);
      for (const item of priced.items)
        assert.deepEqual(item.aggregator_prices_minor, {
          yandex_eda: item.price_minor,
          glovo: item.price_minor,
        });
      // Hall prices and identities did not move.
      for (const item of hall.items) {
        const next = priced.items.find((i) => i.variant_id === item.variant_id);
        assert.equal(next.price_minor, item.price_minor);
      }
      // Parity after apply (contracts 6.2 step 5) is clean with --aggregator-prices.
      const after = parityRun({
        catalog: state,
        snapshot: priced,
        aggregatorPrices: true,
      });
      assert.equal(after.ok, true, JSON.stringify(after.failures));
      assert.equal(after.summary.aggregator_price_changes, 0);
      // An installed edge pulling the same release would get the hall form (other test file).
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
