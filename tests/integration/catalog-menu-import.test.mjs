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
