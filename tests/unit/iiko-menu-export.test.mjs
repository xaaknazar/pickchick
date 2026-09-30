import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, readdir, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  createIikoReader,
  collectExport,
  reviewMenu,
  minorPreview,
  saveExport,
  IIKO_ORIGIN,
} from '../../scripts/iiko-menu-export.mjs';

const org = '10000000-0000-4000-8000-000000000003';
const credentials = { apiKey: 'synthetic-key', appId: org, clientSecret: 'synthetic-secret' };
const source = () => ({
  id: 'menu#1',
  name: 'Synthetic source',
  products: [{ id: 'product', sku: '001', taxCategoryId: 'tax' }],
  modifiers: [],
  combos: [],
  taxCategories: [{ id: 'tax', name: 'Synthetic tax', percentage: 0 }],
  itemsGroups: [
    {
      id: 'group',
      name: 'Synthetic group',
      items: [
        {
          productId: 'product',
          name: 'Synthetic item',
          sizePrices: [{ sizeId: null, price: 123.45 }],
        },
      ],
    },
  ],
});
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function fakeReader(menu = source()) {
  const calls = [];
  return {
    calls,
    async read(path, body) {
      calls.push({ path, body });
      const data =
        path === '/api/1/organizations'
          ? { organizations: [{ id: org, name: 'Synthetic point' }] }
          : path === '/api/2/menu'
            ? { externalMenus: [{ id: menu.id, name: menu.name }], priceCategories: [] }
            : menu;
      return { data, raw: JSON.stringify(data) };
    },
  };
}

test('v2 auth uses three credentials once, only fixed-origin allowlisted reads reach transport', async () => {
  const calls = [];
  const reader = createIikoReader(credentials, {
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return reply(url.endsWith('access_token') ? { token: 'synthetic-token' } : {});
    },
  });
  await reader.read('/api/2/menu');
  await reader.read('/api/1/organizations', { returnAdditionalInfo: false });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, IIKO_ORIGIN + '/api/v2/access_token');
  assert.deepEqual(JSON.parse(calls[0].init.body), credentials);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer synthetic-token');
  assert.ok(calls.every((c) => c.init.redirect === 'error' && c.init.method === 'POST'));
  for (const path of [
    '/api/1/deliveries/create',
    '/api/1/access_token',
    'https://evil.invalid',
    '/api/2/menu?x=1',
  ])
    await assert.rejects(reader.read(path), { code: 'IIKO_METHOD_NOT_READ_ONLY' });
  assert.equal(calls.length, 3);
});

test('missing v2 credentials fail before any network request, without values in error', () => {
  assert.throws(() => createIikoReader({ apiKey: 'private' }), {
    code: 'IIKO_V2_CREDENTIALS_REQUIRED',
  });
});

test('provider failures and network errors cannot echo credentials', async () => {
  for (const fetcher of [
    async () => reply(credentials, 403),
    async () => {
      throw new Error(JSON.stringify(credentials));
    },
  ]) {
    const reader = createIikoReader(credentials, { fetcher });
    await assert.rejects(reader.read('/api/2/menu'), (error) => {
      assert.ok(!error.message.includes('synthetic'));
      assert.ok(!JSON.stringify(error).includes('synthetic'));
      return ['IIKO_HTTP_ERROR', 'IIKO_TRANSPORT_ERROR'].includes(error.code);
    });
  }
});

test('oversized chunked, non-JSON, malformed and redirected replies are rejected', async () => {
  const responses = [
    new Response('x'.repeat(100), { headers: { 'Content-Type': 'application/json' } }),
    new Response('html'),
    reply('not an auth object'),
    { ok: true, redirected: true },
  ];
  for (const response of responses) {
    const reader = createIikoReader(credentials, { fetcher: async () => response, maxBytes: 50 });
    await assert.rejects(reader.read('/api/2/menu'));
  }
});

test('transport is bounded by abort signal', async () => {
  const reader = createIikoReader(credentials, {
    timeoutMs: 5,
    fetcher: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('abort')), { once: true });
      }),
  });
  await assert.rejects(reader.read('/api/2/menu'), { code: 'IIKO_TRANSPORT_ERROR' });
});

test('scope is explicit and exact; menu failure cannot produce a completed export', async () => {
  const reader = fakeReader();
  const result = await collectExport(reader, { organizationId: org });
  assert.equal(result.files.length, 1);
  assert.equal(result.review.publishable, false);
  assert.deepEqual(reader.calls.at(-1), {
    path: '/api/menu/v3/by_id',
    body: {
      externalMenuId: 'menu#1',
      organizationId: org,
      priceCategoryId: null,
    },
  });
  await assert.rejects(
    collectExport(fakeReader(), { organizationId: org, menuIds: ['unavailable'] }),
    { code: 'MENU_NOT_AVAILABLE' },
  );
  await assert.rejects(collectExport(fakeReader(), { organizationId: org, priceCategoryId: org }), {
    code: 'PRICE_CATEGORY_NOT_AVAILABLE',
  });
  await assert.rejects(collectExport(fakeReader(), {}), { code: 'INVALID_EXPORT_SCOPE' });
  const broken = fakeReader();
  const old = broken.read;
  broken.read = async (...args) => {
    if (args[0] === '/api/menu/v3/by_id') throw new Error('unavailable');
    return old(...args);
  };
  await assert.rejects(collectExport(broken, { organizationId: org }));
});

test('organization and menu mismatches never fall back to another source', async () => {
  const reader = fakeReader();
  const original = reader.read;
  reader.read = async (path, body) => {
    const result = await original(path, body);
    if (path === '/api/1/organizations') result.data.organizations[0].id = 'wrong';
    return result;
  };
  await assert.rejects(collectExport(reader, { organizationId: org }), {
    code: 'ORGANIZATION_MISMATCH',
  });
  const other = fakeReader();
  const read = other.read;
  other.read = async (path, body) => {
    const result = await read(path, body);
    if (path === '/api/menu/v3/by_id') result.data.id = 'other';
    return result;
  };
  await assert.rejects(collectExport(other, { organizationId: org }), { code: 'MENU_MISMATCH' });
});

test('prices preserve explicit zero; missing, sub-minor and negative values never round or become free', () => {
  assert.equal(minorPreview(4990), '499000');
  assert.equal(minorPreview(0), '0');
  assert.equal(minorPreview(0.29), '29');
  for (const value of [null, undefined, '', '10', NaN, Infinity, -1, 1.001, 1e20])
    assert.equal(minorPreview(value), null);
  const menu = source();
  menu.itemsGroups[0].items[0].sizePrices = [{ price: null }, { price: 0 }];
  const review = reviewMenu(menu);
  assert.equal(review.placements[0].sizes[0].priceMinorPreview, null);
  assert.equal(review.placements[0].sizes[1].priceMinorPreview, '0');
  assert.equal(review.issues.filter((x) => x.code === 'PRICE_MISSING_OR_UNSUPPORTED').length, 1);
});

test('combos, modifier restrictions, hidden items and broken links remain visible for review', () => {
  const menu = source();
  menu.combos = [{ id: 'combo', sku: 'C', priceStrategy: 'BY_COMPONENT', componentGroups: [] }];
  menu.itemsGroups[0].items.push({ itemType: 'COMBO', comboId: 'combo', name: 'Combo' });
  menu.itemsGroups[0].items[0].isHidden = true;
  menu.itemsGroups[0].items[0].modifierGroups = [
    {
      id: 'm',
      name: 'Choice',
      restrictions: { minQuantity: 1, freeQuantity: 1 },
      items: [{ id: 'missing' }],
    },
  ];
  const before = JSON.stringify(menu),
    review = reviewMenu(menu);
  assert.equal(JSON.stringify(menu), before);
  assert.equal(review.publishable, false);
  assert.equal(review.placements[0].hidden, true);
  for (const code of [
    'COMBO_PRICING_REQUIRES_MAPPING',
    'MODIFIER_RULES_REQUIRE_MAPPING',
    'MISSING_MODIFIER_REFERENCE',
  ])
    assert.ok(review.issues.some((x) => x.code === code));
  const duplicate = source();
  duplicate.products.push(duplicate.products[0]);
  assert.throws(() => reviewMenu(duplicate), { code: 'INVALID_SOURCE_RESPONSE' });
});

test('private immutable snapshots keep original bytes and SHA; manifests are written last', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pickchick-iiko-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await collectExport(fakeReader(), { organizationId: org });
  const directory = await saveExport(root, result);
  const again = await saveExport(root, result);
  assert.notEqual(directory, again);
  const raw = await readFile(join(directory, 'menu-1.json'), 'utf8');
  assert.equal(raw, result.files[0].raw);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, 'menu-1.json'))).mode & 0o777, 0o600);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files[0].sha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(manifest.publishable, false);
  assert.deepEqual((await readdir(directory)).sort(), [
    'manifest.json',
    'menu-1.json',
    'review.json',
  ]);
});

test('output cannot follow a .local symlink outside the repository', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pickchick-iiko-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'repo'));
  await mkdir(join(root, 'outside'));
  await symlink(join(root, 'outside'), join(root, 'repo', '.local'));
  const result = await collectExport(fakeReader(), { organizationId: org });
  await assert.rejects(saveExport(join(root, 'repo'), result), { code: 'UNSAFE_OUTPUT_DIRECTORY' });
  assert.deepEqual(await readdir(join(root, 'outside')), []);
});
