/* global structuredClone */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { MenuSnapshotSchema } from '../../packages/contracts/dist/index.js';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';
import {
  CatalogPayloadSchema,
  publicCatalogPayload,
} from '../../packages/catalog-admin/dist/index.js';
import { projectCatalogMenu } from '../../packages/menu-sync/dist/index.js';
import { previewId } from '../../scripts/local-pos-draft.mjs';
import {
  EXPECTED_CHANGES_SCHEMA,
  allowReviewedChanges,
  catalogEdgeParity,
  catalogInput,
  edgePayloadHash,
  expectedEdgeChanges,
  parityRun,
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
  // Prep routes on two prep stations: a new prep route cannot be derived (cutover KDS-2 rule),
  // the publication would be rejected.
  const secondPrep = '30000000-0000-4000-8000-000000000003';
  const ambiguous = {
    routing: {
      ...routing,
      routes: [
        ...routing.routes.slice(1),
        { productId: 'other-prep', stationId: secondPrep, kind: 'prep' },
      ],
    },
    stations: [...stations, { id: secondPrep, kind: 'prep' }],
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

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
/** Every difference kind the gate knows, on top of the installed POS v2 menu (cutover shape). */
function everyDifference() {
  const payload = structuredClone(mockupCatalogDraft);
  const [combo, master] = payload.products;
  combo.price_minor = '369000';
  combo.name.ru = 'Finger Combo';
  combo.modifier_groups[0].options[1].price_delta_minor = '25000';
  combo.modifier_groups[0].options[4].available = false;
  combo.modifier_groups[1].min = 0;
  combo.modifier_groups[0].options.splice(3, 1);
  combo.modifier_groups[0].options.push({
    ...combo.modifier_groups[0].options[2],
    id: 'sprite-can',
    label: { ru: 'Спрайт жб', kk: '' },
    price_delta_minor: '10000',
  });
  master.modifier_groups.splice(2, 1);
  master.modifier_groups.push({
    ...structuredClone(master.modifier_groups[1]),
    id: 'sauce-paid-hot',
    min: 0,
    max: 3,
    options: master.modifier_groups[1].options.map((o) => ({
      ...o,
      default_quantity: 0,
      max_quantity: 3,
    })),
  });
  payload.products[2].image_asset_key = 'i7.jpg';
  payload.products[3].category_id = 'category-2';
  payload.products.at(-1).available = false;
  payload.products.push({
    ...structuredClone(payload.products[12]),
    id: 'chick-burger',
    sku: 'chick-burger',
    name: { ru: 'Chick Burger', kk: 'Chick Burger' },
    price_minor: '239000',
  });
  return payload;
}
const prep = '30000000-0000-4000-8000-000000000001',
  assembly = '30000000-0000-4000-8000-000000000002';
function routingFor(snapshot) {
  const projected = projectCatalogMenu(mockupCatalogDraft, branch, 3, snapshot.published_at);
  return {
    routing: {
      version: 2,
      assemblyStationId: assembly,
      routes: projected.items.map((item) => ({
        productId: item.product_id,
        stationId: item.kitchen.route === 'prep' ? prep : assembly,
        kind: item.kitchen.route,
      })),
    },
    stations: [
      { id: prep, kind: 'prep' },
      { id: assembly, kind: 'assembly' },
    ],
  };
}
/** The reviewed list exactly as catalog-menu-import build writes it, plus its file bytes. */
function reviewedList(payload, snapshot) {
  const report = catalogEdgeParity({ catalog: payload, snapshot }, { detailed: true });
  const expected = expectedEdgeChanges(report, edgePayloadHash(payload));
  const bytes = JSON.stringify(expected, null, 2) + '\n';
  return { expected, bytes, allow: { expected: JSON.parse(bytes), sha256: sha256(bytes) } };
}

test('without --allow the report is byte-identical to the script before the option existed', () => {
  // Hashes of JSON.stringify(report, null, 2) printed by the unmodified script (D0 5b212949).
  const snapshot = installedV2();
  const rich = catalogEdgeParity({
    catalog: everyDifference(),
    snapshot,
    routing: routingFor(snapshot),
  });
  assert.deepEqual(
    [...new Set([...rich.failures, ...rich.warnings].map((entry) => entry.code))].sort(),
    [
      'CATEGORY_CHANGED',
      'GROUP_ADDED',
      'GROUP_LIMITS_CHANGED',
      'GROUP_REMOVED',
      'IMAGE_CHANGED',
      'ITEM_ADDED',
      'ITEM_REMOVED',
      'NAME_CHANGED',
      'OPTION_ADDED',
      'OPTION_CHANGED',
      'OPTION_PRICE_CHANGED',
      'OPTION_REMOVED',
      'PRICE_CHANGED',
      'ROUTE_DERIVED_ON_APPLY',
    ],
  );
  assert.equal(
    sha256(JSON.stringify(rich, null, 2)),
    'e9fe5afdebe827349fc3ea4f4c4ac300abb37ecfd2e9d4bb6f91695f5e56edd1',
  );
  const clean = catalogEdgeParity({ catalog: mockupCatalogDraft, snapshot });
  assert.equal(
    sha256(JSON.stringify(clean, null, 2)),
    '399b0ae9c534c1c1c65d9071cc44a8c2dfba4b94a85c02168a95bfbf3abc2fb5',
  );
  // parityRun without a list is the same function call.
  assert.deepEqual(parityRun({ catalog: everyDifference(), snapshot }), {
    ...catalogEdgeParity({ catalog: everyDifference(), snapshot }),
  });
});

test('detailed form pins before/after values only where the historical entry has none', () => {
  const snapshot = installedV2();
  const plain = catalogEdgeParity({ catalog: everyDifference(), snapshot });
  const detailed = catalogEdgeParity({ catalog: everyDifference(), snapshot }, { detailed: true });
  const find = (report, code) =>
    [...report.failures, ...report.warnings].find((e) => e.code === code);
  assert.deepEqual(find(detailed, 'GROUP_LIMITS_CHANGED').edge, {
    min_selected: 1,
    max_selected: 1,
  });
  assert.deepEqual(find(detailed, 'GROUP_LIMITS_CHANGED').catalog, {
    min_selected: 0,
    max_selected: 1,
  });
  assert.equal(find(detailed, 'OPTION_CHANGED').edge.available, true);
  assert.equal(find(detailed, 'OPTION_CHANGED').catalog.available, false);
  assert.equal(find(detailed, 'OPTION_ADDED').catalog_minor, '10000');
  assert.deepEqual(find(detailed, 'GROUP_ADDED').catalog, { min_selected: 0, max_selected: 3 });
  assert.equal(find(detailed, 'ITEM_ADDED').catalog_minor, '239000');
  assert.equal(find(detailed, 'ITEM_ADDED').source_id, 'chick-burger');
  assert.ok(find(detailed, 'CATEGORY_CHANGED').catalog_category_id);
  for (const code of ['GROUP_LIMITS_CHANGED', 'OPTION_CHANGED', 'OPTION_ADDED', 'ITEM_ADDED'])
    for (const key of ['edge', 'catalog', 'catalog_minor', 'source_id'])
      assert.equal(key in find(plain, code), false, `${code}.${key}`);
  // Failures, summary and items are the same in both forms.
  assert.deepEqual(detailed.failures, plain.failures);
  assert.deepEqual(detailed.summary, plain.summary);
  assert.deepEqual(detailed.items, plain.items);
});

test('--allow passes only for exactly the reviewed differences of the same payload and edge menu', () => {
  const snapshot = installedV2();
  const payload = everyDifference();
  const { expected, allow } = reviewedList(payload, snapshot);
  assert.equal(expected.schema, EXPECTED_CHANGES_SCHEMA);
  assert.equal(expected.edge_release_id, snapshot.release_id);
  assert.ok(expected.changes.length > 10);
  assert.equal(
    expected.changes.some((entry) => entry.code === 'ROUTE_DERIVED_ON_APPLY'),
    false,
  );
  let report = parityRun({ catalog: payload, snapshot, routing: routingFor(snapshot), allow });
  assert.equal(report.ok, true);
  assert.equal(report.allow.ok, true);
  assert.equal(report.allow.matched, expected.changes.length);
  assert.equal(report.allow.file_sha256, allow.sha256);
  assert.ok(report.failures.length > 0, 'the raw differences stay visible');
  assert.equal(report.routing.derived_version, 3);
  // The saved (reviewed) copy is the same catalog for the edge.
  report = parityRun({ catalog: { ...payload, content_reviewed: true }, snapshot, allow });
  assert.equal(report.ok, true);
  // A price changed after review: one unexpected and one missing difference.
  const repriced = structuredClone(payload);
  repriced.products[0].price_minor = '359000';
  report = parityRun({ catalog: repriced, snapshot, allow });
  assert.equal(report.ok, false);
  assert.equal(report.allow.unexpected.length, 1);
  assert.equal(report.allow.missing.length, 1);
  assert.deepEqual(report.allow.stale, ['PAYLOAD_CHANGED']);
  // A difference the list does not have, and a listed one that no longer happens.
  const shorter = {
    ...allow,
    expected: { ...allow.expected, changes: allow.expected.changes.slice(1) },
  };
  report = parityRun({ catalog: payload, snapshot, allow: shorter });
  assert.deepEqual(
    [report.ok, report.allow.unexpected.length, report.allow.missing.length],
    [false, 1, 0],
  );
  const longer = {
    ...allow,
    expected: {
      ...allow.expected,
      changes: [...allow.expected.changes, allow.expected.changes[0]],
    },
  };
  report = parityRun({ catalog: payload, snapshot, allow: longer });
  assert.deepEqual(
    [report.ok, report.allow.unexpected.length, report.allow.missing.length],
    [false, 0, 1],
  );
  // The edge menu moved on (another publication applied): the list is stale.
  const moved = { ...snapshot, release_id: '20000000-0000-4000-8000-000000000003', version: 3 };
  report = parityRun({ catalog: payload, snapshot: MenuSnapshotSchema.parse(moved), allow });
  assert.equal(report.ok, false);
  assert.deepEqual(report.allow.stale, ['EDGE_MENU_CHANGED']);
});

test('--allow never accepts a publication the edge would reject, and refuses invalid lists', () => {
  const snapshot = installedV2();
  const { allow } = reviewedList(mockupCatalogDraft, snapshot);
  const channel = structuredClone(mockupCatalogDraft);
  channel.products[0].channel_prices_minor = { mobile: '100000' };
  const report = parityRun({ catalog: channel, snapshot, allow });
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.allow.blocking.map((entry) => entry.code),
    ['PROJECTION_FAILED'],
  );
  const rejected = catalogEdgeParity({ catalog: channel, snapshot }, { detailed: true });
  assert.throws(() => expectedEdgeChanges(rejected, edgePayloadHash(channel)), /reject/);
  for (const broken of [
    { ...allow.expected, schema: 'other' },
    { ...allow.expected, payload_sha256: 'x' },
    { ...allow.expected, edge_version: '2' },
    { ...allow.expected, changes: [{ code: 'PROJECTION_FAILED' }] },
    { ...allow.expected, changes: [{ code: 'ROUTE_DERIVED_ON_APPLY' }] },
    { ...allow.expected, changes: [1] },
    [],
  ])
    assert.throws(
      () => allowReviewedChanges(rejected, broken, { payloadSha256: 'a', fileSha256: 'b' }),
      /Expected changes file is invalid/,
    );
});

test('CLI --allow: exit 0 on the reviewed list, 1 on another difference, 2 on a broken list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-parity-allow-'));
  const run = (args) =>
    promisify(execFile)(process.execPath, [script, ...args], { maxBuffer: 50_000_000 }).then(
      (result) => ({ code: 0, ...result }),
      (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
    );
  try {
    const snapshot = installedV2();
    const payload = everyDifference();
    const { bytes } = reviewedList(payload, snapshot);
    const files = {
      edge: join(dir, 'edge.json'),
      catalog: join(dir, 'catalog.json'),
      expected: join(dir, 'expected.json'),
      changed: join(dir, 'changed.json'),
      broken: join(dir, 'broken.json'),
    };
    await writeFile(files.edge, JSON.stringify(snapshot));
    await writeFile(files.catalog, JSON.stringify(payload));
    await writeFile(files.expected, bytes);
    const changed = structuredClone(payload);
    changed.products[1].price_minor = '1';
    await writeFile(files.changed, JSON.stringify(changed));
    await writeFile(files.broken, '{"schema":"x"}');
    const ok = await run([
      '--catalog',
      files.catalog,
      '--edge',
      files.edge,
      '--allow',
      files.expected,
    ]);
    assert.equal(ok.code, 0);
    const report = JSON.parse(ok.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.allow.file_sha256, sha256(bytes));
    const plain = await run(['--catalog', files.catalog, '--edge', files.edge]);
    assert.equal(plain.code, 1);
    assert.equal('allow' in JSON.parse(plain.stdout), false);
    const diff = await run([
      '--catalog',
      files.changed,
      '--edge',
      files.edge,
      '--allow',
      files.expected,
    ]);
    assert.equal(diff.code, 1);
    assert.equal(JSON.parse(diff.stdout).allow.ok, false);
    const bad = await run([
      '--catalog',
      files.catalog,
      '--edge',
      files.edge,
      '--allow',
      files.broken,
    ]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /Expected changes file is invalid/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.deepEqual(parseArguments(['--catalog', 'c', '--edge', 'e', '--allow', 'a']), {
    catalog: 'c',
    edge: 'e',
    allow: 'a',
  });
  assert.throws(() => parseArguments(['--catalog', 'c', '--edge', 'e', '--allow']));
  assert.throws(() =>
    parseArguments(['--catalog', 'c', '--edge', 'e', '--allow', 'a', '--allow', 'b']),
  );
});

// Cutover CC-3: --aggregator-prices compares MenuItem.aggregator_prices_minor of an edge with the
// aggregator_prices feature against the catalog projected as the cloud publishes it with
// CATALOG_AGGREGATOR_PRICES_ENABLED. Synthetic prices only.
function aggregatorCatalog() {
  const catalog = structuredClone(mockupCatalogDraft);
  const product = (id) => catalog.products.find((p) => p.id === id);
  product('pick-combo').channel_prices_minor = { yandex_eda: '459000', glovo: '469000' };
  product('burger').channel_prices_minor = { yandex_eda: '269000' };
  return catalog;
}
/** The edge menu after it applied the aggregator form of a publication of this catalog. */
const appliedWithPrices = (catalog) =>
  projectCatalogMenu(catalog, branch, 3, '2026-11-16T05:00:00.000Z', undefined, {
    aggregatorPrices: true,
  });

test('--aggregator-prices: off ignores them as before; on compares every channel price', () => {
  const catalog = aggregatorCatalog();
  const edge = installedV2();
  // Without the switch the cloud projection refuses the keys, exactly as before.
  const off = catalogEdgeParity({ catalog, snapshot: edge });
  assert.deepEqual(off.failures, [
    { code: 'PROJECTION_FAILED', reason: 'CHANNEL_PRICES_NOT_SUPPORTED' },
  ]);
  assert.equal('aggregator_prices' in off || 'aggregator_price_changes' in off.summary, false);
  // An edge that already has them is not compared without the switch.
  const plain = catalogEdgeParity({
    catalog: mockupCatalogDraft,
    snapshot: appliedWithPrices(catalog),
  });
  assert.equal(plain.ok, true);
  // With the switch: the first publication adds the prices, each one is reviewed.
  const on = catalogEdgeParity({ catalog, snapshot: edge }, { aggregatorPrices: true });
  assert.equal(on.ok, false);
  assert.equal(on.aggregator_prices, true);
  assert.equal(on.summary.aggregator_price_changes, 3);
  assert.deepEqual(
    on.failures.map(({ code, channel, edge_minor: before, catalog_minor: after }) => [
      code,
      channel,
      before,
      after,
    ]),
    [
      ['AGGREGATOR_PRICE_CHANGED', 'yandex_eda', null, '459000'],
      ['AGGREGATOR_PRICE_CHANGED', 'glovo', null, '469000'],
      ['AGGREGATOR_PRICE_CHANGED', 'yandex_eda', null, '269000'],
    ],
  );
  // After the edge applied that publication: parity is clean.
  const applied = catalogEdgeParity(
    { catalog, snapshot: appliedWithPrices(catalog) },
    { aggregatorPrices: true },
  );
  assert.equal(applied.ok, true, JSON.stringify(applied.failures));
  assert.equal(applied.summary.aggregator_price_changes, 0);
  // A later change of one price or a channel dropped by the catalog is a failure.
  const changed = aggregatorCatalog();
  changed.products.find((p) => p.id === 'burger').channel_prices_minor = { glovo: '279000' };
  const next = catalogEdgeParity(
    { catalog: changed, snapshot: appliedWithPrices(catalog) },
    { aggregatorPrices: true },
  );
  assert.deepEqual(
    next.failures.map((entry) => [entry.channel, entry.edge_minor, entry.catalog_minor]),
    [
      ['yandex_eda', '269000', null],
      ['glovo', null, '279000'],
    ],
  );
  // Own-channel overrides stay a projection failure with the switch on.
  const own = aggregatorCatalog();
  own.products[3].channel_prices_minor = { pos: '1' };
  assert.deepEqual(
    catalogEdgeParity({ catalog: own, snapshot: edge }, { aggregatorPrices: true }).failures,
    [{ code: 'PROJECTION_FAILED', reason: 'CHANNEL_PRICES_NOT_SUPPORTED' }],
  );
});

test('--aggregator-prices with --allow: the reviewed list pins every aggregator price', () => {
  const catalog = aggregatorCatalog();
  const snapshot = installedV2();
  const detailed = catalogEdgeParity(
    { catalog, snapshot },
    { detailed: true, aggregatorPrices: true },
  );
  const expected = expectedEdgeChanges(detailed, edgePayloadHash(catalog));
  assert.equal(expected.counts.AGGREGATOR_PRICE_CHANGED, 3);
  const run = (input) =>
    parityRun({
      catalog: input,
      snapshot,
      aggregatorPrices: true,
      allow: { expected, sha256: 'f'.repeat(64) },
    });
  const passed = run(catalog);
  assert.equal(passed.ok, true, JSON.stringify(passed.allow));
  assert.equal(passed.aggregator_prices, true);
  // Another aggregator price is another payload and another difference: refused.
  const other = aggregatorCatalog();
  other.products.find((p) => p.id === 'burger').channel_prices_minor.yandex_eda = '279000';
  const refused = run(other);
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.allow.stale, ['PAYLOAD_CHANGED']);
  assert.deepEqual(
    refused.allow.unexpected.map((entry) => [entry.code, entry.catalog_minor]),
    [['AGGREGATOR_PRICE_CHANGED', '279000']],
  );
  // The same list without the switch: projection fails, the gate refuses.
  const without = parityRun({ catalog, snapshot, allow: { expected, sha256: 'f'.repeat(64) } });
  assert.equal(without.ok, false);
  assert.deepEqual(codes(without.allow.blocking), ['PROJECTION_FAILED']);
  // A new item pins its aggregator prices too.
  const burgerVariant = appliedWithPrices(catalog).items.find(
    (i) => i.source_id === 'burger',
  ).variant_id;
  const added = catalogEdgeParity(
    {
      catalog,
      snapshot: {
        ...snapshot,
        items: snapshot.items.filter((i) => i.variant_id !== burgerVariant),
      },
    },
    { detailed: true, aggregatorPrices: true },
  );
  const burger = added.warnings.find(
    (entry) => entry.code === 'ITEM_ADDED' && entry.source_id === 'burger',
  );
  assert.deepEqual(burger?.catalog_aggregator_prices_minor, { yandex_eda: '269000' });
});

test('CLI: --aggregator-prices is a switch without a value, accepted once', () => {
  assert.deepEqual(parseArguments(['--catalog', 'c', '--aggregator-prices', '--edge', 'e']), {
    catalog: 'c',
    aggregatorPrices: true,
    edge: 'e',
  });
  assert.deepEqual(parseArguments(['--catalog', 'c', '--edge', 'e', '--aggregator-prices']), {
    catalog: 'c',
    edge: 'e',
    aggregatorPrices: true,
  });
  for (const argv of [
    ['--catalog', 'c', '--edge', 'e', '--aggregator-prices', '--aggregator-prices'],
    ['--aggregator-prices'],
    ['--catalog', 'c', '--edge', '--aggregator-prices'],
  ])
    assert.throws(() => parseArguments(argv), JSON.stringify(argv));
});

test('--aggregator-prices refuses the public catalog route, which never carries aggregator prices', () => {
  const catalog = aggregatorCatalog();
  const edge = appliedWithPrices(catalog);
  const admin = {
    branch: { id: branch, code: 'SYN', name: 'Synthetic' },
    published: { version: 3, published_at: '2026-11-16T05:00:00.000Z', payload: catalog },
  };
  // The public answer of the same publication (GET /v1/catalog/branches/:id, cutover R5).
  const open = {
    branch_id: branch,
    version: 3,
    published_at: '2026-11-16T05:00:00.000Z',
    payload: publicCatalogPayload(CatalogPayloadSchema.parse(catalog)),
  };
  assert.deepEqual(
    [catalogInput(admin).form, catalogInput(open).form, catalogInput(catalog).form],
    ['admin', 'public', 'payload'],
  );
  assert.throws(
    () => catalogEdgeParity({ catalog: open, snapshot: edge }, { aggregatorPrices: true }),
    /--aggregator-prices needs the admin catalog/,
  );
  assert.throws(
    () => parityRun({ catalog: open, snapshot: edge, aggregatorPrices: true }),
    /--aggregator-prices needs the admin catalog/,
  );
  // The admin state and the bare payload of that publication pass; without the switch the
  // public form is read as before.
  for (const input of [admin, catalog])
    assert.equal(
      catalogEdgeParity({ catalog: input, snapshot: edge }, { aggregatorPrices: true }).ok,
      true,
    );
  assert.equal(catalogEdgeParity({ catalog: open, snapshot: edge }).ok, true);
});
