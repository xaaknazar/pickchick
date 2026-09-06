import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { API_URL, loadCatalog, parseCapabilities } from '../../apps/mobile/src/api.ts';

const capabilities = {
  schema_version: 1,
  environment: 'staging',
  data_mode: 'synthetic',
  ordering_enabled: false,
  features: { phone_auth: false, payments: false, fiscal: false, checkout: false, loyalty: false },
};
const branchId = '10000000-0000-4000-8000-000000000003';
const branch = {
  id: branchId,
  code: 'test',
  name: 'Synthetic',
  timezone: 'Asia/Almaty',
  ordering_enabled: false,
};
const menu = {
  schema_version: 1,
  release_id: '10000000-0000-4000-8000-000000000004',
  branch_id: branchId,
  version: 1,
  published_at: '2026-09-06T00:00:00.000Z',
  items: [],
};

test('release config and client URL are identical and keep transactions disabled', async () => {
  const { expo } = JSON.parse(
    await readFile(new URL('../../apps/mobile/app.json', import.meta.url)),
  );
  assert.equal(expo.extra.apiUrl, API_URL);
  assert.equal(expo.extra.customerOperationsEnabled, false);
  assert.equal(expo.ios.bundleIdentifier, 'kz.pickchick.app');
  assert.equal(expo.ios.infoPlist.NSAppTransportSecurity, undefined);
});

test('unknown environments or new feature flags fail closed', () => {
  assert.deepEqual(parseCapabilities(capabilities), capabilities);
  for (const changes of [
    { environment: 'production' },
    { schema_version: 2 },
    { data_mode: 'live' },
    { ordering_enabled: true },
    { features: {} },
    { features: { ...capabilities.features, payments: true } },
  ]) {
    assert.throws(() => parseCapabilities({ ...capabilities, ...changes }));
  }
});

test('catalog reads only public GET routes without cookies or auth; validates branch ownership', async (t) => {
  const calls = [];
  let responseMenu = menu;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push([url, options]);
    const path = new URL(url).pathname;
    const body =
      path === '/v1/capabilities'
        ? capabilities
        : path === '/v1/branches'
          ? { branches: [branch] }
          : responseMenu;
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  });
  const result = await loadCatalog(null);
  assert.equal(result.branch.id, branchId);
  assert.equal(result.menu.release_id, menu.release_id);
  assert.deepEqual(
    calls.map(([url]) => new URL(url).pathname).sort(),
    ['/v1/capabilities', '/v1/branches', `/v1/branches/${branchId}/menu`].sort(),
  );
  for (const [url, options] of calls) {
    assert.equal(new URL(url).origin, API_URL);
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { Accept: 'application/json' });
  }
  responseMenu = { ...menu, branch_id: '20000000-0000-4000-8000-000000000003' };
  await assert.rejects(loadCatalog(null), /Branch mismatch/);
});

test('HTTP failure and malformed data never produce a successful catalog', async (t) => {
  const fetchMock = t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }),
  );
  await assert.rejects(loadCatalog(null));
  fetchMock.mock.mockImplementation(
    async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
  );
  await assert.rejects(loadCatalog(null));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadCatalog(null, controller.signal), /Aborted/);
});
