/* global structuredClone */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { MenuSnapshotSchema } from '../../packages/contracts/dist/index.js';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';
import { projectCatalogMenu } from '../../packages/menu-sync/dist/index.js';
import { previewId } from '../../scripts/local-pos-draft.mjs';
import {
  catalogEdgeParity,
  catalogInput,
  parseArguments,
} from '../../scripts/catalog-edge-parity.mjs';

const branch = '10000000-0000-4000-8000-000000000003';
const script = fileURLToPath(new URL('../../scripts/catalog-edge-parity.mjs', import.meta.url));
const posV2 = JSON.parse(
  readFileSync(new URL('../../infra/windows/local-pos-draft-catalog-v2.json', import.meta.url)),
);

/** The installed cashier menu v2, rebuilt as scripts/local-pos-catalog-upgrade.mjs builds it. */
function installedV2(branchId = branch) {
  return MenuSnapshotSchema.parse({
    schema_version: 1,
    release_id: '20000000-0000-4000-8000-000000000002',
    branch_id: branchId,
    version: 2,
    published_at: '2026-10-01T00:00:00.000Z',
    items: posV2.products.map((product) => ({
      product_id: previewId(branchId, 'product', product.source_id),
      variant_id: previewId(branchId, 'base-preview', product.source_id),
      category_id: previewId(branchId, 'category', product.category),
      name: { ru: product.name_ru, kk: '-' },
      price_minor: product.price_minor,
      currency: 'KZT',
      ...(product.image_url ? { image_url: product.image_url } : {}),
      ...(product.modifier_groups.length
        ? {
            modifier_groups: product.modifier_groups.map((group) => ({
              id: previewId(branchId, 'modifier-group', `${product.source_id}:${group.source_id}`),
              name: { ru: group.name_ru, kk: '-' },
              min_selected: group.min_selected,
              max_selected: group.max_selected,
              options: group.options.map((option) => ({
                id: previewId(
                  branchId,
                  'modifier-option',
                  `${product.source_id}:${group.source_id}:${option.source_id}`,
                ),
                name: { ru: option.name_ru, kk: '-' },
                price_minor: option.price_minor,
                max_quantity: option.max_quantity,
                default_quantity: option.default_quantity,
                available: option.available,
              })),
            })),
          }
        : {}),
    })),
  });
}
const codes = (list) => list.map((entry) => entry.code);

test('seed catalog against the installed POS v2 menu has zero diffs on two branches', () => {
  for (const branchId of [branch, '10000000-0000-4000-8000-0000000000aa']) {
    const report = catalogEdgeParity({
      catalog: mockupCatalogDraft,
      snapshot: installedV2(branchId),
    });
    assert.equal(report.ok, true);
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.warnings, []);
    assert.equal(report.summary.matched, 24);
    assert.equal(report.summary.edge_items, 24);
    assert.equal(report.summary.catalog_items, 24);
    assert.equal(report.edge_version, 2);
  }
});

test('the three catalog export shapes are accepted and the branch must match', () => {
  const state = {
    branch: { id: branch, code: 'ABAY', name: 'Synthetic' },
    draft: null,
    published: {
      version: 7,
      published_at: '2026-10-05T00:00:00.000Z',
      published_by: '10000000-0000-4000-8000-000000000009',
      payload: mockupCatalogDraft,
    },
  };
  const publication = {
    branch_id: branch,
    version: 7,
    published_at: '2026-10-05T00:00:00.000Z',
    payload: mockupCatalogDraft,
  };
  for (const catalog of [state, publication])
    assert.equal(catalogEdgeParity({ catalog, snapshot: installedV2() }).catalog_version, 7);
  assert.equal(catalogInput(mockupCatalogDraft).branchId, null);
  assert.throws(
    () =>
      catalogEdgeParity({
        catalog: { ...publication, branch_id: '10000000-0000-4000-8000-0000000000aa' },
        snapshot: installedV2(),
      }),
    /different branches/,
  );
  assert.throws(() => catalogInput({ ...state, published: null }), /no publication/);
  assert.throws(() => catalogInput({ products: [] }), /payload is invalid/);
  assert.throws(
    () => catalogEdgeParity({ catalog: mockupCatalogDraft, snapshot: { items: [] } }),
    /snapshot is invalid/,
  );
});

test('a base or option price change and removed items or options fail the gate', () => {
  const payload = structuredClone(mockupCatalogDraft);
  payload.products[0].price_minor = String(BigInt(payload.products[0].price_minor) + 10000n);
  let report = catalogEdgeParity({ catalog: payload, snapshot: installedV2() });
  assert.equal(report.ok, false);
  assert.deepEqual(codes(report.failures), ['PRICE_CHANGED']);
  assert.equal(report.failures[0].catalog_minor, payload.products[0].price_minor);
  assert.equal(report.summary.price_changes, 1);

  const withOptions = structuredClone(mockupCatalogDraft);
  const product = withOptions.products.find((p) => p.modifier_groups.some((g) => g.options.length));
  const group = product.modifier_groups.find((g) => g.options.length);
  group.options[0].price_delta_minor = String(BigInt(group.options[0].price_delta_minor) + 5000n);
  report = catalogEdgeParity({ catalog: withOptions, snapshot: installedV2() });
  assert.deepEqual(codes(report.failures), ['OPTION_PRICE_CHANGED']);
  // Undo the price change, then drop a non-default option (defaults must stay satisfiable).
  group.options[0].price_delta_minor = mockupCatalogDraft.products
    .find((p) => p.id === product.id)
    .modifier_groups.find((g) => g.id === group.id).options[0].price_delta_minor;
  group.options.splice(1, 1);
  report = catalogEdgeParity({ catalog: withOptions, snapshot: installedV2() });
  assert.deepEqual(codes(report.failures), ['OPTION_REMOVED']);

  const removed = structuredClone(mockupCatalogDraft);
  // Unavailable products are left out of the publication, so the cashier would lose them.
  removed.products.at(-1).available = false;
  report = catalogEdgeParity({ catalog: removed, snapshot: installedV2() });
  assert.deepEqual(codes(report.failures), ['ITEM_REMOVED']);
  assert.equal(
    report.items.find((item) => item.status === 'removed').name,
    posV2.products.at(-1).name_ru,
  );
});

test('new products, names and photos are warnings; projection errors fail', () => {
  const payload = structuredClone(mockupCatalogDraft);
  payload.products[1].name.ru = 'Новое название';
  payload.products[2].image = {
    asset_id: '10000000-0000-4000-8000-0000000000ff',
    sha256: 'c'.repeat(64),
    tile_color: '#FFAA00',
    cutout: false,
  };
  const extra = structuredClone(payload.products[0]);
  extra.id = 'synthetic-new-item';
  extra.sku = 'SYNTHETIC-NEW';
  payload.products.push(extra);
  const report = catalogEdgeParity({ catalog: payload, snapshot: installedV2() });
  assert.equal(report.ok, true);
  assert.deepEqual(codes(report.warnings).sort(), ['IMAGE_CHANGED', 'ITEM_ADDED', 'NAME_CHANGED']);
  assert.equal(report.summary.added, 1);

  const channel = structuredClone(mockupCatalogDraft);
  channel.products[0].channel_prices_minor = { mobile: '100000' };
  const refused = catalogEdgeParity({ catalog: channel, snapshot: installedV2() });
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.failures, [
    { code: 'PROJECTION_FAILED', reason: 'CHANNEL_PRICES_NOT_SUPPORTED' },
  ]);
});

test('routing coverage reports routes derived on apply and proves derivation with stations', () => {
  const snapshot = installedV2();
  const prep = '30000000-0000-4000-8000-000000000001',
    assembly = '30000000-0000-4000-8000-000000000002';
  const projected = projectCatalogMenu(mockupCatalogDraft, branch, 3, snapshot.published_at);
  // Routing v2 as installed: hashed POS ids only, cloud slugs missing.
  const routing = {
    version: 2,
    assemblyStationId: assembly,
    routes: projected.items.map((item) => ({
      productId: item.product_id,
      stationId: item.kitchen.route === 'prep' ? prep : assembly,
      kind: item.kitchen.route,
    })),
  };
  let report = catalogEdgeParity({ catalog: mockupCatalogDraft, snapshot, routing });
  assert.equal(report.ok, true);
  assert.equal(report.routing.items_needing_routes, 24);
  assert.ok(report.items.every((item) => item.routing.pos && !item.routing.cloud));
  assert.ok(report.warnings.every((w) => w.code === 'ROUTE_DERIVED_ON_APPLY'));
  const stations = [
    { id: prep, kind: 'prep' },
    { id: assembly, kind: 'assembly' },
  ];
  report = catalogEdgeParity({
    catalog: mockupCatalogDraft,
    snapshot,
    routing: { routing, stations },
  });
  assert.equal(report.ok, true);
  assert.equal(report.routing.derived_version, 3);
  // With two prep stations a new prep route cannot be derived: the publication would be rejected.
  const ambiguous = {
    routing: { ...routing, routes: routing.routes.slice(1) },
    stations: [...stations, { id: '30000000-0000-4000-8000-000000000003', kind: 'prep' }],
  };
  report = catalogEdgeParity({ catalog: mockupCatalogDraft, snapshot, routing: ambiguous });
  assert.equal(report.ok, false);
  assert.deepEqual(codes(report.failures), ['ROUTING_UNRESOLVED']);
});

test('CLI is read-only: exit 0 on parity, 1 on a price diff, 2 on bad input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-parity-'));
  const run = (args) =>
    promisify(execFile)(process.execPath, [script, ...args]).then(
      (result) => ({ code: 0, ...result }),
      (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
    );
  try {
    const edge = join(dir, 'edge.json'),
      catalog = join(dir, 'catalog.json'),
      changed = join(dir, 'changed.json');
    await writeFile(edge, JSON.stringify(installedV2()));
    await writeFile(catalog, JSON.stringify(mockupCatalogDraft));
    const payload = structuredClone(mockupCatalogDraft);
    payload.products[0].price_minor = '1';
    await writeFile(changed, JSON.stringify(payload));
    const ok = await run(['--catalog', catalog, '--edge', edge]);
    assert.equal(ok.code, 0);
    assert.equal(JSON.parse(ok.stdout).ok, true);
    const diff = await run(['--catalog', changed, '--edge', edge]);
    assert.equal(diff.code, 1);
    assert.equal(JSON.parse(diff.stdout).summary.price_changes, 1);
    const bad = await run(['--catalog', catalog]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /catalog_edge_parity_failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  for (const argv of [
    [],
    ['--catalog', 'a'],
    ['--catalog', 'a', '--edge'],
    ['--x', 'a', '--edge', 'b'],
    ['--catalog', 'a', '--catalog', 'b', '--edge', 'c'],
  ])
    assert.throws(() => parseArguments(argv));
  assert.deepEqual(parseArguments(['--edge', 'e', '--catalog', 'c', '--routing', 'r']), {
    edge: 'e',
    catalog: 'c',
    routing: 'r',
  });
});
