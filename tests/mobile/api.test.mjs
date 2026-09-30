import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as flush } from 'node:timers/promises';
import {
  API_URL,
  loadCatalog,
  loadTestCatalog,
  isRetryableCatalogError,
  parseCapabilities,
} from '../../apps/mobile/src/api.ts';

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

test('enabling a payment branch does not hide or replace the public storefront menu', async (t) => {
  const paymentBranch = {
    ...branch,
    id: '7a6f6d98-395d-4462-b5e4-b0364a4a8ec1',
    ordering_enabled: true,
  };
  const calls = [];
  let available = [paymentBranch, branch];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const body =
      path === '/v1/capabilities'
        ? capabilities
        : path === '/v1/branches'
          ? { branches: available }
          : menu;
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  });
  for (const requested of [null, branchId, paymentBranch.id]) {
    const result = await loadCatalog(requested);
    assert.equal(result.branch.id, branchId);
    assert.deepEqual(result.branches, [branch]);
    assert.equal(result.menu.branch_id, branchId);
  }
  assert.equal(calls.includes(`/v1/branches/${paymentBranch.id}/menu`), false);
  available = [paymentBranch];
  await assert.rejects(loadCatalog(null), /No branches/);
});

test('only transport failures and temporary HTTP statuses permit automatic catalog retries', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('Network request failed');
  });
  await assert.rejects(loadTestCatalog(), isRetryableCatalogError);
  for (const status of [408, 429, 500, 502, 503, 504]) {
    fetchMock.mock.mockImplementation(async () => new Response('maintenance', { status }));
    await assert.rejects(loadTestCatalog(), isRetryableCatalogError);
  }
  for (const status of [400, 401, 403, 404, 409]) {
    fetchMock.mock.mockImplementation(async () => new Response('{}', { status }));
    await assert.rejects(loadTestCatalog(), (error) => !isRetryableCatalogError(error));
  }
  for (const [body, contentType] of [
    ['<html>', 'text/html'],
    ['{', 'application/json'],
    ['{}', 'application/json'],
  ]) {
    fetchMock.mock.mockImplementation(
      async () => new Response(body, { headers: { 'content-type': contentType } }),
    );
    await assert.rejects(loadTestCatalog(), (error) => !isRetryableCatalogError(error));
  }
});

test('complete catalog stays a cancellable public GET with the exact version and strict schema', async (t) => {
  const catalog = {
    synthetic: true,
    namespace: 'pickchick-test',
    branch_id: branchId,
    catalog_version: 'mockup-v0.2',
    currency: 'KZT',
    products: [],
  };
  const calls = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push([url, options]);
    return new Response(JSON.stringify(catalog), {
      headers: { 'content-type': 'application/json' },
    });
  });
  assert.deepEqual(await loadTestCatalog(), catalog);
  assert.equal(calls[0][0], API_URL + '/v1/test/catalog?catalog_version=mockup-v0.3');
  assert.equal(calls[0][1].method, 'GET');
  assert.deepEqual(calls[0][1].headers, { Accept: 'application/json' });
  assert.equal(calls[0][1].credentials, 'omit');
  assert.equal(calls[0][1].redirect, 'error');
  const controller = new AbortController();
  let passedSignal;
  fetchMock.mock.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        passedSignal = options.signal;
        options.signal.addEventListener('abort', () => reject(new Error('Aborted')), {
          once: true,
        });
      }),
  );
  const pending = loadTestCatalog(controller.signal);
  controller.abort();
  await assert.rejects(pending);
  assert.equal(passedSignal.aborted, true);
});

test('failed parallel catalog read waits for its sibling before the attempt finishes', async (t) => {
  let finishBranches;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (new URL(url).pathname === '/v1/capabilities') return new Response('{}', { status: 503 });
    return new Promise((resolve) => {
      finishBranches = resolve;
    });
  });
  let finished = false;
  const pending = loadCatalog(null).finally(() => {
    finished = true;
  });
  const rejection = assert.rejects(pending, isRetryableCatalogError);
  await flush();
  assert.equal(finished, false);
  finishBranches(
    new Response(JSON.stringify({ branches: [branch] }), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  await rejection;
  assert.equal(finished, true);
});

test('a stalled full-catalog GET is aborted at its original ten-second deadline and is retryable', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let passedSignal;
  t.mock.method(
    globalThis,
    'fetch',
    (_url, options) =>
      new Promise((_resolve, reject) => {
        passedSignal = options.signal;
        options.signal.addEventListener('abort', () => reject(new Error('Timed out')), {
          once: true,
        });
      }),
  );
  const pending = assert.rejects(loadTestCatalog(), isRetryableCatalogError);
  t.mock.timers.tick(9999);
  assert.equal(passedSignal.aborted, false);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(passedSignal.aborted, true);
});

test('pilot capabilities expose phone identity while keeping commercial actions disabled', () => {
  const pilot = {
    ...capabilities,
    data_mode: 'pilot',
    features: { ...capabilities.features, phone_auth: true },
  };
  assert.equal(parseCapabilities(pilot).features.phone_auth, true);
  for (const flags of [{ phone_auth: false }, { payments: true }, { fiscal: true }])
    assert.throws(() => parseCapabilities({ ...pilot, features: { ...pilot.features, ...flags } }));
});
