/* global structuredClone */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { provisionFulfillment } from '@pickchick/edge-fulfillment';
import {
  acknowledgeMenu,
  applyMenu,
  canonicalJson,
  hashJson,
  projectCatalogMenu,
  provisionDevice,
  pullMenu,
} from '../../packages/menu-sync/dist/index.js';
import { CatalogAdmin, provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { catalogDigest } from '../../packages/catalog-admin/dist/bar-drinks.js';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';
import { authFor, withSyncDatabases } from '../helpers/sync.mjs';

const SCRIPT = fileURLToPath(
  new URL('../../infra/staging/catalog-add-drinks.mjs', import.meta.url),
);
const DATA = fileURLToPath(new URL('../../infra/staging/catalog-add-drinks.json', import.meta.url));

/** The real API controller over HTTP, as the gateway exposes it to the bearer catalog route. */
async function catalogHttp(config, service, run) {
  const require = createRequire(new URL('../../services/api/package.json', import.meta.url));
  const { Module } = require('@nestjs/common');
  const { createHttpApplication, RESOURCE } = await import('@pickchick/platform');
  const { CatalogAdminController } =
    await import('../../services/api/dist/catalog-admin-controller.js');
  const { CATALOG_ADMIN } = await import('../../packages/catalog-admin/dist/index.js');
  class DrinksTestModule {}
  Module({
    controllers: [CatalogAdminController],
    providers: [
      { provide: CATALOG_ADMIN, useValue: service },
      {
        provide: RESOURCE,
        useValue: { config, admission: { intercept: (_ctx, next) => next.handle() } },
      },
    ],
  })(DrinksTestModule);
  const app = await createHttpApplication(DrinksTestModule);
  try {
    await app.listen(0, '127.0.0.1');
    await run(await app.getUrl());
  } finally {
    await app.close();
  }
}

/** The cashier PC before the first cloud publication: operator-installed local menu v2. */
async function installLocalMenu(edge, branch, version) {
  const menu = projectCatalogMenu(mockupCatalogDraft, branch, version, new Date().toISOString());
  await edge.pool.query(
    'INSERT INTO menu_snapshots(id,branch_id,version,schema_version,payload,checksum,published_at) VALUES($1,$2,$3,1,$4,$5,$6)',
    [menu.release_id, branch, version, canonicalJson(menu), hashJson(menu), menu.published_at],
  );
  await edge.pool.query('INSERT INTO active_menu(branch_id,release_id) VALUES($1,$2)', [
    branch,
    menu.release_id,
  ]);
  return { active_release_id: menu.release_id, active_version: version };
}

test('operator script adds the bar drinks to a real draft, publishes to cashier and storefront, and rolls back', async () =>
  withSyncDatabases(async ({ cloud, edge, org, branch, device }) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'drinks-integration-'));
    try {
      const owner = await provisionCatalogManager(cloud.pool, {
        organization_id: org,
        name: 'Synthetic owner',
        branch_ids: [branch],
      });
      const reader = await provisionCatalogManager(cloud.pool, {
        organization_id: org,
        name: 'Synthetic analyst',
        branch_ids: [branch],
      });
      await cloud.pool.query(
        "INSERT INTO bo_access_grants(actor_id,branch_id,role) VALUES($1,$3,'manager'),($2,$3,'analyst')",
        [owner.actor_id, reader.actor_id, branch],
      );
      // Cashier: active device, local menu v2 reported, two stations and routing v1.
      const auth = authFor(await provisionDevice(cloud.pool, device));
      await cloud.pool.query(
        'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
        [branch, org, device, randomUUID()],
      );
      await pullMenu(cloud.pool, auth, await installLocalMenu(edge, branch, 2));
      const prep = randomUUID(),
        assembly = randomUUID();
      await provisionFulfillment(edge.pool, {
        organizationId: org,
        branchId: branch,
        deviceId: device,
        producerId: randomUUID(),
        stations: [
          { id: prep, kind: 'prep', name: 'Кухня' },
          { id: assembly, kind: 'assembly', name: 'Сборка' },
        ],
        routing: {
          version: 1,
          assemblyStationId: assembly,
          routes: [{ productId: 'installed', stationId: prep, kind: 'prep' }],
        },
      });
      const deliver = async () => {
        const { event } = await pullMenu(cloud.pool, auth);
        await acknowledgeMenu(cloud.pool, auth, await applyMenu(edge.pool, branch, event));
      };
      const service = new CatalogAdmin(cloud.pool, {
        enabled: true,
        enforceRoles: true,
        edgePublicationBranchId: branch,
      });
      // Live-like start: the reviewed operator catalog is published once (version 1).
      let state = await service.seed(owner.token, branch, {
        expected_revision: 0,
        request_id: randomUUID(),
      });
      state = await service.save(owner.token, branch, {
        expected_revision: state.draft.revision,
        request_id: randomUUID(),
        payload: { ...state.draft.payload, content_source: 'operator', content_reviewed: true },
      });
      state = await service.publish(owner.token, branch, {
        expected_revision: state.draft.revision,
        expected_published_version: 0,
        request_id: randomUUID(),
        confirmation: 'publish_catalog',
      });
      const v1 = state.published.payload;
      await deliver();
      assert.equal((await service.read(owner.token, branch)).edge_delivery.status, 'applied');

      const approved = path.join(dir, 'approved.json');
      await writeFile(
        approved,
        JSON.stringify({
          ...JSON.parse(await readFile(DATA, 'utf8')),
          approved_by_owner: true,
          approval_note: 'synthetic test approval',
        }),
      );
      const evidence = path.join(dir, 'evidence');
      const outputs = [];
      await catalogHttp(cloud.config, service, async (base) => {
        const cli = (args, token = owner.token) =>
          new Promise((resolve) =>
            execFile(
              process.execPath,
              [
                SCRIPT,
                '--auth',
                'token',
                '--base-url',
                base,
                '--branch-id',
                branch,
                '--evidence-dir',
                evidence,
                ...args,
              ],
              { env: { ...process.env, PICKCHICK_CATALOG_TOKEN: token }, timeout: 60000 },
              (error, stdout, stderr) => {
                outputs.push(stdout, stderr);
                resolve({
                  code: error ? 1 : 0,
                  stdout,
                  stderr,
                  result: error ? null : JSON.parse(stdout.trim().split('\n').at(-1)),
                });
              },
            ),
          );
        const dry = async (args = [], token) => {
          const run = await cli(['--combo-options', ...args], token);
          assert.equal(run.code, 0, run.stderr);
          return run.result.plan_sha256;
        };
        const revision = async () => (await service.read(owner.token, branch)).draft.revision;
        const before = await revision();

        // Repository data is not approved: dry-run works, publication is refused, nothing written.
        const unapproved = await dry();
        let run = await cli(['--combo-options', '--publish', '--plan-sha256', unapproved]);
        assert.equal(run.code, 1);
        assert.match(run.stderr, /approved_by_owner is false/);
        assert.equal(await revision(), before);

        // An analyst may read the plan but not write it.
        const analystPlan = await dry(['--data', approved], reader.token);
        run = await cli(
          ['--data', approved, '--combo-options', '--save', '--plan-sha256', analystPlan],
          reader.token,
        );
        assert.equal(run.code, 1);
        assert.match(run.stderr, /no manager role/);

        // A concurrent edit after review invalidates the plan; foreign edits need explicit consent.
        const reviewed = await dry(['--data', approved]);
        const edited = structuredClone(v1);
        edited.products.find((p) => p.id === 'toast').price_minor = '29000';
        state = await service.save(owner.token, branch, {
          expected_revision: await revision(),
          request_id: randomUUID(),
          payload: edited,
        });
        run = await cli([
          '--data',
          approved,
          '--combo-options',
          '--publish',
          '--plan-sha256',
          reviewed,
        ]);
        assert.equal(run.code, 1);
        assert.match(run.stderr, /Plan changed since review/);
        const withForeign = await dry(['--data', approved]);
        run = await cli([
          '--data',
          approved,
          '--combo-options',
          '--publish',
          '--plan-sha256',
          withForeign,
        ]);
        assert.match(run.stderr, /unpublished edits/);
        assert.match(run.stdout, /~ toast «Тост, 1 шт»: цена 390 ₸ -> 290 ₸/);
        await service.save(owner.token, branch, {
          expected_revision: await revision(),
          request_id: randomUUID(),
          payload: v1,
        });

        // --save stores an unreviewed draft only.
        const toSave = await dry(['--data', approved]);
        run = await cli(['--data', approved, '--combo-options', '--save', '--plan-sha256', toSave]);
        assert.equal(run.code, 0, run.stderr);
        state = await service.read(owner.token, branch);
        assert.equal(state.published.version, 1);
        assert.equal(state.draft.payload.products.length, 37);
        assert.equal(state.draft.payload.content_reviewed, false);

        // Publication from the saved draft: same plan semantics, reviewed and published.
        const toPublish = await dry(['--data', approved]);
        run = await cli([
          '--data',
          approved,
          '--combo-options',
          '--publish',
          '--plan-sha256',
          toPublish,
        ]);
        assert.equal(run.code, 0, run.stderr);
        assert.equal(run.result.published_version, 2);
        assert.match(run.stdout, /Cashier delivery: pending \(menu 4\)/);
        const published = await fetch(`${base}/v1/catalog/branches/${branch}`).then((r) =>
          r.json(),
        );
        assert.equal(published.version, 2);
        const products = new Map(published.payload.products.map((p) => [p.id, p]));
        assert.equal(products.size, 37);
        assert.equal(products.get('cola-zero-can').price_minor, '79000');
        assert.equal(products.get('fuse-lemon').available, true);
        assert.equal(products.get('fuse-watermelon').available, false);
        for (const combo of ['pick-combo', 'finger-duo'])
          assert.equal(
            products.get(combo).modifier_groups.find((g) => g.id === 'drink').options.length,
            20,
          );
        const rollbackFile = path.join(run.result.evidence, 'published-before.json');

        // Cashier applies the release; the new drinks get assembly routes on the edge.
        await deliver();
        state = await service.read(owner.token, branch);
        assert.equal(state.edge_delivery.status, 'applied');
        const routing = (
          await edge.pool.query(
            'SELECT r.payload FROM fulfillment_config c JOIN fulfillment_routing r ON r.branch_id=c.branch_id AND r.version=c.active_routing_version',
          )
        ).rows[0].payload;
        for (const id of ['cola-bottle', 'sprite-can', 'fuse-mango-pineapple'])
          assert.deepEqual(
            routing.routes.find((r) => r.productId === id),
            { productId: id, stationId: assembly, kind: 'assembly_item' },
          );
        assert.equal(
          routing.routes.find((r) => r.productId === 'fuse-watermelon'),
          undefined,
        );

        // Re-running is a no-op.
        const again = await cli(['--data', approved, '--combo-options']);
        assert.equal(again.result.live, true);
        run = await cli([
          '--data',
          approved,
          '--combo-options',
          '--publish',
          '--plan-sha256',
          again.result.plan_sha256,
        ]);
        assert.equal(run.code, 0, run.stderr);
        assert.match(run.stdout, /Nothing to do/);
        assert.equal((await service.read(owner.token, branch)).published.version, 2);

        // Rollback: republish the saved version 1 as version 3.
        run = await cli(['--restore-from', rollbackFile]);
        assert.equal(run.code, 0, run.stderr);
        assert.match(run.stdout, /- sprite-can «Sprite 0.5 л, банка» 790 ₸/);
        run = await cli([
          '--restore-from',
          rollbackFile,
          '--publish',
          '--plan-sha256',
          run.result.plan_sha256,
        ]);
        assert.equal(run.code, 0, run.stderr);
        assert.equal(run.result.published_version, 3);
        state = await service.read(owner.token, branch);
        assert.equal(catalogDigest(state.published.payload), catalogDigest(v1));
        await deliver();
        assert.equal((await service.read(owner.token, branch)).edge_delivery.status, 'applied');
      });

      // No token in any output or evidence file; evidence is private.
      const files = [];
      const walk = async (folder) => {
        for (const entry of await readdir(folder, { withFileTypes: true }))
          if (entry.isDirectory()) await walk(path.join(folder, entry.name));
          else files.push(path.join(folder, entry.name));
      };
      await walk(evidence);
      assert.ok(files.length > 10);
      for (const file of files) {
        const { mode } = await stat(file);
        assert.equal(mode & 0o077, 0, file);
        outputs.push(await readFile(file, 'utf8'));
      }
      for (const text of outputs)
        for (const token of [owner.token, reader.token]) assert.ok(!text.includes(token));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }));
