import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { desktopFile } from './support.mjs';

const { createProtocolHandler, validateConfig, APP_URL, isAllowedRendererURL } = await import(
  pathToFileURL(desktopFile('protocol.mjs')).href
);
const request = (path, options) => new globalThis.Request(new URL(path, APP_URL), options);
const ID = '10000000-0000-4000-8000-000000000003';

async function fixture(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-pos-protocol-'));
  const upstream = [];
  try {
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><title>Local POS fixture</title>',
    );
    await writeFile(join(directory, 'app.js'), 'globalThis.LOCAL_ASSET_FIXTURE = true;');
    await writeFile(join(directory, 'private.txt'), 'MUST_NOT_BE_PUBLIC');
    await mkdir(join(directory, 'assets/menu'), { recursive: true });
    await writeFile(join(directory, 'assets/menu/i0.jpg'), Buffer.from([255, 216, 255, 217]));
    const handler = createProtocolHandler({
      assetDir: pathToFileURL(directory + '/'),
      config: validateConfig({ edgePort: 3101, branchLabel: 'Synthetic desktop', categories: {} }),
      fetchImpl: async (url, options) => {
        upstream.push({ url: String(url), options });
        return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
      },
      ...options,
    });
    await run(handler, upstream);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('packaged origin exposes only local assets/config with restrictive document policy', async () => {
  await fixture(async (handler, upstream) => {
    const response = await handler(request('/'));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Local POS fixture/);
    const csp = response.headers.get('content-security-policy');
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
    ])
      assert.ok(csp?.includes(directive), `Missing ${directive}`);
    assert.ok(!csp.includes('unsafe-eval') && !csp.includes('unsafe-inline'));
    assert.equal((await handler(request('/app.js'))).status, 200);
    const config = await handler(request('/config.json'));
    assert.equal(config.status, 200);
    assert.equal((await config.json()).branchLabel, 'Synthetic desktop');
    for (const path of [
      '/private.txt',
      '/main.mjs',
      '/protocol.mjs',
      '/config.json?token=x',
      '/%2e%2e/private.txt',
      '/..%2fprivate.txt',
    ]) {
      const denied = await handler(request(path));
      assert.ok(denied.status >= 400, path);
      assert.ok(!(await denied.text()).includes('MUST_NOT_BE_PUBLIC'));
    }
    assert.equal(upstream.length, 0, 'Static assets must not need an edge or WAN');
  });
});

test('foreign origins, unsupported edge operations and query tricks never reach upstream', async () => {
  await fixture(async (handler, upstream) => {
    const urls = [
      'https://outside.invalid/edge/v1/session',
      'pickchick-pos://other/edge/v1/session',
    ];
    for (const url of urls) {
      assert.equal(isAllowedRendererURL(url), false);
      assert.ok((await handler(new globalThis.Request(url))).status >= 400);
    }
    assert.ok(
      (
        await handler(
          request('/edge/v1/session', {
            headers: { Origin: 'https://outside.invalid' },
          }),
        )
      ).status >= 400,
    );
    for (const [method, path] of [
      ['GET', '/edge/v1/session?token=not-a-token'],
      ['GET', '/edge/v1/orders?shift_id=invalid'],
      ['GET', `/edge/v1/orders?shift_id=${ID}&shift_id=${ID}`],
      ['GET', `/edge/v1/orders?shift_id=${ID}&all=true`],
      ['GET', `/edge/v1/cash-shifts?shift_id=${ID}`],
      ['POST', `/edge/v1/orders?shift_id=${ID}`],
      ['GET', '/edge/v1/http://127.0.0.1/'],
      ['POST', `/edge/v1/orders/${ID}/payments`],
      ['POST', '/edge/v1/fiscal/receipts'],
      ['DELETE', `/edge/v1/orders/${ID}`],
      ['POST', '/config.json'],
    ]) {
      assert.ok((await handler(request(path, { method }))).status >= 400, method + ' ' + path);
    }
    assert.equal(upstream.length, 0);
  });
});

test('reviewed menu photos are local and shift/order routes preserve only the allowed filter', async () => {
  await fixture(async (handler, upstream) => {
    const photo = await handler(request('/assets/menu/i0.jpg'));
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/jpeg');
    assert.equal((await photo.arrayBuffer()).byteLength, 4);
    for (const path of [
      '/assets/menu/unknown.jpg',
      '/assets/menu/../../private.txt',
      '/assets/menu/i0.jpg?x=1',
    ])
      assert.ok((await handler(request(path))).status >= 400);
    assert.equal(upstream.length, 0);
    for (const path of [
      'orders',
      `orders?shift_id=${ID}`,
      'cash-shifts',
      'cash-shifts/current',
      `cash-shifts/${ID}`,
    ]) {
      const url = `/edge/v1/${path}`;
      assert.equal(isAllowedRendererURL(new URL(url, APP_URL).href), true);
      assert.equal((await handler(request(url))).status, 200);
      assert.equal(upstream.at(-1).url, `http://127.0.0.1:3101${url}`);
    }
    for (const path of ['cash-shifts', `cash-shifts/${ID}/close`]) {
      assert.equal(
        (
          await handler(
            request(`/edge/v1/${path}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
            }),
          )
        ).status,
        200,
      );
      assert.equal(upstream.at(-1).options.method, 'POST');
    }
  });
});

test('allowed staff commands preserve identity/key/body without forwarding ambient headers', async () => {
  await fixture(async (handler, upstream) => {
    const body = JSON.stringify({ quote_id: ID });
    const response = await handler(
      request('/edge/v1/orders', {
        method: 'POST',
        body,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer synthetic-fixture',
          'X-Staff-Session-Id': ID,
          'Idempotency-Key': ID,
          Cookie: 'private-cookie=fixture',
          'X-Forwarded-Host': 'outside.invalid',
          'X-Untrusted-Header': 'must-not-pass',
        },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(upstream.length, 1);
    assert.equal(upstream[0].url, 'http://127.0.0.1:3101/edge/v1/orders');
    const headers = new globalThis.Headers(upstream[0].options.headers);
    assert.equal(headers.get('authorization'), 'Bearer synthetic-fixture');
    assert.equal(headers.get('x-staff-session-id'), ID);
    assert.equal(headers.get('idempotency-key'), ID);
    assert.equal(headers.get('content-type'), 'application/json');
    for (const name of ['cookie', 'x-forwarded-host', 'x-untrusted-header'])
      assert.equal(headers.get(name), null);
    assert.equal(upstream[0].options.body, body);
    assert.equal(upstream[0].options.redirect, 'error');
  });
});

test('malformed and oversized UTF-8 command bodies are rejected before edge access', async () => {
  await fixture(async (handler, upstream) => {
    const tooLarge = JSON.stringify({ note: 'я'.repeat(32000) });
    assert.ok(tooLarge.length < 64000 && Buffer.byteLength(tooLarge) > 64000);
    for (const [body, contentType] of [
      ['{', 'application/json'],
      ['{}', 'text/plain'],
      [tooLarge, 'application/json'],
    ]) {
      const response = await handler(
        request('/edge/v1/orders', {
          method: 'POST',
          body,
          headers: { 'Content-Type': contentType },
        }),
      );
      assert.ok(response.status >= 400, 'Invalid body must fail');
    }
    assert.equal(upstream.length, 0);
  });
});

test('oversized edge responses and untrusted response headers cannot cross the custom scheme', async () => {
  await fixture(
    async (handler) => {
      const response = await handler(request('/edge/v1/session'));
      assert.equal(response.status, 200);
      for (const name of ['set-cookie', 'location', 'access-control-allow-origin'])
        assert.equal(response.headers.get(name), null);
    },
    {
      fetchImpl: async () =>
        new Response('{"ok":true}', {
          headers: {
            'Set-Cookie': 'private=fixture',
            Location: 'https://outside.invalid/',
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json',
          },
        }),
    },
  );
  await fixture(
    async (handler) => {
      const response = await handler(request('/edge/v1/session'));
      assert.ok(response.status >= 400);
      assert.ok((await response.text()).length < 1000);
    },
    { fetchImpl: async () => new Response('x'.repeat(4000001)) },
  );
});

test('real HTTP redirect never follows the edge to an unconfigured listener', async () => {
  let escaped = 0;
  const trap = createServer((_req, res) => {
    escaped++;
    res.end('not allowed');
  });
  await new Promise((resolve) => trap.listen(0, '127.0.0.1', resolve));
  const redirect = createServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${trap.address().port}/leak` });
    res.end();
  });
  await new Promise((resolve) => redirect.listen(0, '127.0.0.1', resolve));
  try {
    await fixture(
      async (handler) => {
        assert.ok((await handler(request('/edge/v1/session'))).status >= 400);
        assert.equal(escaped, 0);
      },
      { config: validateConfig({ edgePort: redirect.address().port }), fetchImpl: fetch },
    );
  } finally {
    await new Promise((resolve) => redirect.close(resolve));
    await new Promise((resolve) => trap.close(resolve));
  }
});

test('port configuration is bounded and renderer navigation cannot choose arbitrary destinations', () => {
  for (const edgePort of [-1, 0, 65536, 1.5, '3101', 'https://outside.invalid'])
    assert.throws(() => validateConfig({ edgePort }));
  assert.equal(validateConfig({ edgePort: 3101 }).edgePort, 3101);
  assert.equal(isAllowedRendererURL(APP_URL), true);
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://outside.invalid/',
    'pickchick-pos://app.evil/',
    'pickchick-pos://user@app/',
  ])
    assert.equal(isAllowedRendererURL(url), false);
});

test('an unresponsive local edge is bounded by the transport timeout', async () => {
  const idle = createServer(() => {});
  await new Promise((resolve) => idle.listen(0, '127.0.0.1', resolve));
  try {
    await fixture(
      async (handler) => {
        const began = Date.now();
        const response = await handler(request('/edge/v1/session'));
        assert.equal(response.status, 504);
        assert.equal((await response.json()).code, 'EDGE_TIMEOUT');
        assert.ok(Date.now() - began < 2000, 'An idle edge must not hang the renderer request');
      },
      {
        config: validateConfig({ edgePort: idle.address().port }),
        fetchImpl: fetch,
        timeoutMs: 30,
      },
    );
  } finally {
    idle.closeAllConnections();
    await new Promise((resolve) => idle.close(resolve));
  }
});

test('password login has a small body, fixed terminal config and bounded retry hints; logout clears native authority', async () => {
  const sessions = [];
  await fixture(
    async (handler, upstream) => {
      assert.equal((await (await handler(request('/config.json'))).json()).terminalId, ID);
      const body = JSON.stringify({
        login: 'fixture.cashier',
        password: 'synthetic-password-only',
        terminal_id: ID,
      });
      const response = await handler(
        request('/edge/v1/staff/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }),
      );
      assert.equal(response.status, 429);
      assert.equal(response.headers.get('retry-after'), '60');
      assert.equal(response.headers.get('set-cookie'), null);
      assert.deepEqual(sessions, [null]);
      assert.equal(upstream.length, 0);
      assert.equal(
        (
          await handler(
            request('/edge/v1/staff/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ password: 'я'.repeat(1024) }),
            }),
          )
        ).status,
        413,
      );
    },
    {
      config: { terminalId: ID },
      onSession: (value) => sessions.push(value),
      fetchImpl: async () =>
        new Response('{}', {
          status: 429,
          headers: { 'Retry-After': '60', 'Set-Cookie': 'fixture=value' },
        }),
    },
  );
  await fixture(
    async (handler) => {
      const response = await handler(
        request('/edge/v1/staff/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }),
      );
      assert.equal(response.status, 204);
      assert.equal(await response.text(), '');
    },
    {
      onSession: (value) => sessions.push(value),
      fetchImpl: async () => new Response(null, { status: 204 }),
    },
  );
  assert.ok(sessions.every((value) => value === null));
  for (const terminalId of ['', 'invalid', null, 123])
    assert.throws(() => validateConfig({ terminalId }));
  for (const hint of ['0', '10000', 'soon', 'Wed, 21 Oct 2030 07:28:00 GMT']) {
    await fixture(
      async (handler) => {
        const response = await handler(request('/edge/v1/session'));
        assert.equal(response.headers.get('retry-after'), null);
      },
      {
        fetchImpl: async () =>
          new Response('{}', { status: 429, headers: { 'Retry-After': hint } }),
      },
    );
  }
});
