import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  APP_ORIGIN,
  APP_PORT,
  APP_URL,
  ASSETS,
  isAllowedRendererRequest,
  startGateway,
  validateConfig,
} from '../security.mjs';

const id = '00000000-0000-4000-8000-000000000001';
const endpoint = '/edge/v1/fulfillment';
const close = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });

test('configuration rejects arbitrary hosts, credentials, redirects and storage-changing ports', () => {
  assert.deepEqual(validateConfig({}), { edgePort: 3101, branchLabel: 'Локальная точка' });
  assert.deepEqual(validateConfig({ edgePort: 9999, branchLabel: 'Точка 1' }), {
    edgePort: 9999,
    branchLabel: 'Точка 1',
  });
  for (const config of [
    null,
    [],
    '127.0.0.1',
    { edgeURL: 'https://bad.example/' },
    { edgeHost: '192.168.1.2' },
    { token: 'synthetic' },
    { port: 4179 },
    { edgePort: APP_PORT },
    { edgePort: '3101' },
    { edgePort: null },
    { branchLabel: null },
    { edgePort: 0 },
    { edgePort: 65536 },
    { edgePort: 1.5 },
    { branchLabel: '' },
    { branchLabel: 'x'.repeat(121) },
    { branchLabel: 'newline\nlabel' },
  ])
    assert.throws(() => validateConfig(config), /INVALID_KITCHEN_CONFIG/);
});

test('renderer may load only packaged assets and existing fulfillment routes on its fixed origin', () => {
  assert.equal(APP_URL, 'http://127.0.0.1:4178/');
  for (const path of [
    '/',
    '/config.json',
    ...ASSETS.filter((name) => name !== 'index.html').map((name) => '/' + name),
  ])
    assert.ok(isAllowedRendererRequest(APP_ORIGIN + path), path);
  assert.ok(
    isAllowedRendererRequest(APP_ORIGIN + endpoint + '/kitchen?stationId=' + id + '&limit=100'),
  );
  assert.ok(isAllowedRendererRequest(APP_ORIGIN + endpoint + '/orders/' + id + '/actions', 'POST'));
  for (const url of [
    'https://example.invalid/',
    'http://127.0.0.1:3101' + endpoint + '/config',
    'http://localhost:4178/',
    'file:///etc/passwd',
    'data:text/html,unsafe',
    'javascript:void(0)',
    'ws://127.0.0.1:4178/',
    'http://127.0.0.1:4178@evil.invalid/',
    APP_URL + '?untrusted=1',
    APP_URL + 'index.html',
    APP_URL + '../config.json',
    APP_URL + '%2e%2e/config.json',
    APP_URL + '#x',
    APP_URL + '\\evil.invalid',
    APP_URL + 'asset-manifest.json',
    APP_URL + 'edge/v1/staff/sessions',
    APP_ORIGIN + endpoint + '/config?unknown=1',
  ])
    assert.equal(isAllowedRendererRequest(url), false, url);
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS'])
    assert.equal(isAllowedRendererRequest(APP_URL, method), false);
});

test('desktop gateway is the exact existing kitchen server source', async () => {
  assert.deepEqual(
    await readFile(new URL('../gateway.mjs', import.meta.url)),
    await readFile(new URL('../../kitchen/server.mjs', import.meta.url)),
  );
});

test('fixed loopback gateway serves local files and fails closed on occupied port without fallback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-kitchen-gateway-'));
  let gateway, blocker;
  try {
    await writeFile(join(directory, 'index.html'), '<h1>Local fixture</h1>');
    blocker = createServer((_req, res) => res.end('UNTRUSTED_FIXTURE'));
    await new Promise((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(APP_PORT, '127.0.0.1', resolve);
    });
    await assert.rejects(startGateway({ config: {}, assetDir: pathToFileURL(directory + '/') }), {
      code: 'EADDRINUSE',
    });
    await close(blocker);
    blocker = null;
    gateway = await startGateway({ config: {}, assetDir: pathToFileURL(directory + '/') });
    assert.equal(gateway.address().address, '127.0.0.1');
    assert.equal(gateway.address().port, APP_PORT);
    const response = await fetch(APP_URL);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '<h1>Local fixture</h1>');
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.equal(
      (await fetch(APP_URL, { headers: { Origin: 'https://external.invalid' } })).status,
      403,
    );
  } finally {
    if (gateway) await close(gateway);
    if (blocker) await close(blocker);
    await rm(directory, { recursive: true, force: true });
  }
});
