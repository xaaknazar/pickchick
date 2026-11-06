import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as connectTcp } from 'node:net';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { desktopFile } from './support.mjs';

const {
  createProtocolHandler,
  validateConfig,
  APP_URL,
  isAllowedRendererURL,
  SALE_ROUTES,
  EDGE_READ_PATH,
  EDGE_WRITE_PATH,
} = await import(pathToFileURL(desktopFile('protocol.mjs')).href);
const request = (path, options) => new globalThis.Request(new URL(path, APP_URL), options);
const ID = '10000000-0000-4000-8000-000000000003';

async function fixture(run, { setup, ...options } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-pos-protocol-'));
  const upstream = [];
  try {
    await setup?.(directory);
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
    assert.ok(!csp.includes('unsafe-eval'));
    assert.match(csp, /script-src 'self';/);
    assert.match(csp, /style-src 'self' 'unsafe-inline';/); // Designer inline styles; inline scripts stay prohibited.
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

test('published hash photos come from the configured edge only after SHA-256 and WebP checks', async () => {
  // Two tiny real lossless WebP images: one is served under the other's name.
  const webp = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvB8ABAAdQrcLXo/+BiOh/AAA=', 'base64');
  const other = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvB8ABAAdQnlIUuf+BiOh/AAA=', 'base64');
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const good = hash(webp),
    swapped = hash(other),
    text = Buffer.from('plain text, not an image'),
    plain = hash(text),
    big = Buffer.alloc(1_500_001, 1);
  big.write('RIFF', 0, 'latin1');
  big.write('WEBP', 8, 'latin1');
  const huge = hash(big);
  const logo = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const upstream = [];
  const bodies = new Map([
    [good, webp],
    [swapped, webp],
    [plain, text],
    [huge, big],
  ]);
  await fixture(
    async (handler) => {
      assert.equal(isAllowedRendererURL(new URL(`/assets/menu/${good}.webp`, APP_URL).href), true);
      const photo = await handler(request(`/assets/menu/${good}.webp`));
      assert.equal(photo.status, 200);
      assert.equal(photo.headers.get('content-type'), 'image/webp');
      assert.equal(photo.headers.get('cache-control'), 'no-store');
      assert.match(photo.headers.get('content-security-policy'), /img-src 'self';/);
      assert.deepEqual(Buffer.from(await photo.arrayBuffer()), webp);
      assert.deepEqual(
        upstream.map((u) => u.url),
        [`http://127.0.0.1:3101/edge/v1/media/${good}.webp`],
      );
      assert.equal(upstream[0].options.redirect, 'error');
      assert.equal(upstream[0].options.headers, undefined, 'No staff credential is forwarded');
      await handler(request(`/assets/menu/${good}.webp`));
      assert.equal(upstream.length, 1, 'Verified immutable bytes are cached in memory');
      for (const name of [swapped, plain, huge, 'e'.repeat(64)]) {
        const fallback = await handler(request(`/assets/menu/${name}.webp`));
        assert.equal(fallback.status, 200, name);
        assert.equal(fallback.headers.get('content-type'), 'image/png');
        assert.deepEqual(Buffer.from(await fallback.arrayBuffer()), logo);
      }
      assert.equal(upstream.length, 5);
      await handler(request(`/assets/menu/${swapped}.webp`));
      assert.equal(upstream.length, 6, 'A rejected photo is asked for again later');
      for (const path of [
        `/assets/menu/${good.toUpperCase()}.webp`,
        `/assets/menu/${good}.png`,
        `/assets/menu/${good}0.webp`,
        `/assets/menu/${good.slice(2)}.webp`,
        `/assets/menu/${good}.webp?v=1`,
        `/assets/menu/g${good.slice(1)}.webp`,
      ]) {
        assert.ok((await handler(request(path))).status >= 400, path);
        assert.equal(isAllowedRendererURL(new URL(path, APP_URL).href), false, path);
      }
      assert.ok(
        (await handler(request(`/assets/menu/${good}.webp`, { method: 'POST', body: '{}' })))
          .status >= 400,
      );
      assert.equal(upstream.length, 6, 'Rejected names never reach the edge');
      // The live-menu poll route is a fixed staff read.
      assert.equal(isAllowedRendererURL(new URL('/edge/v1/menu/version', APP_URL).href), true);
      assert.equal((await handler(request('/edge/v1/menu/version'))).status, 200);
      assert.equal(upstream.at(-1).url, 'http://127.0.0.1:3101/edge/v1/menu/version');
      assert.ok((await handler(request('/edge/v1/menu/version?x=1'))).status >= 400);
      assert.ok(
        (await handler(request('/edge/v1/menu/version', { method: 'POST', body: '{}' }))).status >=
          400,
      );
      // The header's internet line (offline stand finding) is a fixed staff read as well.
      assert.equal((await handler(request('/edge/v1/cloud-link'))).status, 200);
      assert.equal(upstream.at(-1).url, 'http://127.0.0.1:3101/edge/v1/cloud-link');
      assert.ok(
        (await handler(request('/edge/v1/cloud-link', { method: 'POST', body: '{}' }))).status >=
          400,
      );
    },
    {
      fetchImpl: async (url, options) => {
        const name = /\/edge\/v1\/media\/([a-f0-9]{64})\.webp$/.exec(String(url))?.[1];
        upstream.push({ url: String(url), options });
        if (!name) return new Response('{"ok":true}', { status: 200 });
        const body = bodies.get(name);
        return body
          ? new Response(body, { headers: { 'Content-Type': 'image/webp' } })
          : new Response('{"code":"NOT_FOUND"}', { status: 404 });
      },
      setup: async (directory) => {
        await mkdir(join(directory, 'v2/assets'), { recursive: true });
        await writeFile(join(directory, 'v2/assets/logo.png'), logo);
      },
    },
  );
});

test('a wrong or foreign PIN in the close-shift dialog keeps the cashier journal (6.2)', async () => {
  const { createJournalStore } = await import(pathToFileURL(desktopFile('journal.mjs')).href);
  const id = (last) => `10000000-0000-4000-8000-${String(last).padStart(12, '0')}`;
  const cashier = {
    session_id: id(1),
    staff_id: id(2),
    terminal_id: ID,
    branch_id: id(4),
    role: 'cashier',
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  };
  const other = { ...cashier, session_id: id(11), staff_id: id(12) };
  const scope = `${cashier.branch_id}.${cashier.staff_id}.${cashier.terminal_id}`;
  const key = `pickchick.pos.journal.v1.${scope}`;
  const journal = (quantity) =>
    JSON.stringify({
      version: 1,
      scope,
      draft: {
        release_id: id(5),
        service_mode: 'takeaway',
        items: [{ variant_id: id(6), quantity }],
      },
      pending: null,
      known: [],
      selected: null,
    });
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-pin-journal-'));
  const store = createJournalStore({ directory });
  let answer;
  try {
    await fixture(
      async (handler) => {
        const call = (path, sessionId, method = 'POST') =>
          handler(
            request(path, {
              method,
              headers: {
                ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
                ...(sessionId
                  ? { Authorization: `Bearer ${'b'.repeat(64)}`, 'X-Staff-Session-Id': sessionId }
                  : {}),
              },
              ...(method === 'POST' ? { body: '{}' } : {}),
            }),
          );
        answer = () => new Response(JSON.stringify(cashier), { status: 200 });
        assert.equal((await call('/edge/v1/session', cashier.session_id, 'GET')).status, 200);
        store.setItem(key, journal(1));

        // Wrong PIN: 401 on the isolated PIN check.
        answer = () => new Response('{"code":"UNAUTHORIZED"}', { status: 401 });
        assert.equal((await call('/edge/v1/staff/pin')).status, 401);
        store.setItem(key, journal(2));

        // Another cashier's PIN: credential issued, then logged out with its own session.
        answer = () => new Response(JSON.stringify({ ...other, token: 'c'.repeat(64) }));
        assert.equal((await call('/edge/v1/staff/pin')).status, 200);
        answer = () => new Response(null, { status: 204 });
        assert.equal((await call('/edge/v1/staff/logout', other.session_id)).status, 204);
        answer = () => new Response('{"code":"UNAUTHORIZED"}', { status: 401 });
        assert.equal((await call('/edge/v1/session', other.session_id, 'GET')).status, 401);
        assert.throws(() => store.setItem(key, journal(3)), 'GET /session always re-checks');
        answer = () => new Response(JSON.stringify(cashier), { status: 200 });
        assert.equal((await call('/edge/v1/session', cashier.session_id, 'GET')).status, 200);
        answer = () => new Response('{"code":"FORBIDDEN"}', { status: 403 });
        assert.equal((await call('/edge/v1/ordering/close', other.session_id)).status, 403);
        store.setItem(key, journal(3));
        assert.equal(JSON.parse(store.getItem(key)).draft.items[0].quantity, 3);

        // The cashier's own session ending still revokes the journal at once.
        answer = () => new Response('{"code":"UNAUTHORIZED"}', { status: 401 });
        assert.equal((await call('/edge/v1/orders', cashier.session_id, 'GET')).status, 401);
        assert.throws(() => store.setItem(key, journal(4)));
        answer = () => new Response(JSON.stringify(cashier), { status: 200 });
        await call('/edge/v1/session', cashier.session_id, 'GET');
        store.setItem(key, journal(4));
        answer = () => new Response(null, { status: 204 });
        assert.equal((await call('/edge/v1/staff/logout', cashier.session_id)).status, 204);
        assert.throws(() => store.setItem(key, journal(5)));
        answer = () => new Response(JSON.stringify(cashier), { status: 200 });
        await call('/edge/v1/session', cashier.session_id, 'GET');
        answer = () => new Response('{"code":"AUTH_RATE_LIMITED"}', { status: 429 });
        await call('/edge/v1/staff/login');
        assert.throws(() => store.setItem(key, journal(5)), 'password login still revokes');
      },
      {
        config: { terminalId: ID },
        onSession: (value, sessionId) => store.setSession(value, sessionId),
        fetchImpl: async () => answer(),
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the desk hands its configured PIN pad length to the renderer, as the web POS does (6.5)', async () => {
  for (const [pinLength, expected] of [
    [undefined, undefined],
    [4, 4],
    [6, 6],
  ])
    await fixture(
      async (handler) => {
        const config = await (await handler(request('/config.json'))).json();
        assert.equal(config.pinLength, expected, String(pinLength));
        // Nothing else changes: without the key /config.json is exactly as before.
        if (pinLength === undefined)
          assert.deepEqual(config, { branchLabel: 'Synthetic desktop', categories: {} });
      },
      {
        config: validateConfig({
          edgePort: 3101,
          branchLabel: 'Synthetic desktop',
          categories: {},
          ...(pinLength === undefined ? {} : { pinLength }),
        }),
      },
    );
});

test('terminal config accepts a 6-digit PIN pad only as an explicit 4 or 6 (6.5)', () => {
  assert.equal(validateConfig({}).pinLength, undefined);
  assert.equal(validateConfig({ pinLength: 6 }).pinLength, 6);
  assert.equal(validateConfig({ pinLength: 4 }).pinLength, 4);
  for (const pinLength of [5, 8, '6', null, 0]) assert.throws(() => validateConfig({ pinLength }));
});

// ---- Cutover 19.11 (contracts section 5.5, CL-2): paid-sale routes of the cashier ----------

/** Exactly the paid routes of the section 5.5 `pos` profile (photos are fetched by main). */
const SALE_GET = [
  'pos/config',
  `pos/sales/${ID}`,
  'pos/fiscal-receipts/pending',
  `pos/fiscal-receipts/pending?shift_id=${ID}`,
  `cash-shifts/${ID}/x-report`,
  `cash-shifts/${ID}/z-report`,
];
const SALE_POST = [
  'staff/approvals',
  'pos/sales',
  `pos/sales/${ID}/void`,
  `pos/sales/${ID}/refunds`,
  `pos/fiscal-receipts/${ID}/record`,
];
const SALE_REFUSED = [
  ['POST', 'pos/config'],
  ['GET', 'pos/sales'],
  ['GET', `pos/sales/${ID}/void`],
  ['POST', `pos/sales/${ID}/payments`],
  ['POST', 'pos/fiscal-receipts/pending'],
  ['GET', 'pos/fiscal-receipts/pending?shift_id=not-a-shift'],
  ['GET', `pos/fiscal-receipts/pending?shift_id=${ID}&all=true`],
  ['GET', `pos/sales/${ID}?shift_id=${ID}`],
  ['GET', `cash-shifts/${ID}/y-report`],
  ['GET', 'cash-shifts/current/x-report'],
  ['POST', `staff/approvals?pin=1234`],
  ['POST', 'pos/fiscal'],
];
const saleRequest = (method) =>
  method === 'POST'
    ? { method, headers: { 'Content-Type': 'application/json' }, body: '{}' }
    : { method };

test('paid-sale routes of contracts 5.5 pass the desktop adapter and the browser server alike', async () => {
  await fixture(async (handler, upstream) => {
    for (const path of SALE_GET) {
      const url = `/edge/v1/${path}`;
      assert.equal(isAllowedRendererURL(new URL(url, APP_URL).href), true, path);
      assert.equal((await handler(request(url))).status, 200, path);
      assert.equal(upstream.at(-1).url, `http://127.0.0.1:3101${url}`);
    }
    for (const path of SALE_POST) {
      assert.equal((await handler(request(`/edge/v1/${path}`, saleRequest('POST')))).status, 200);
      assert.equal(upstream.at(-1).options.method, 'POST');
    }
    const forwarded = upstream.length;
    for (const [method, path] of SALE_REFUSED)
      assert.ok(
        (await handler(request(`/edge/v1/${path}`, saleRequest(method)))).status >= 400,
        method + ' ' + path,
      );
    assert.equal(upstream.length, forwarded, 'refused paths never reach the edge');
    // A manager PIN body is as small as a login body.
    const big = JSON.stringify({ pin: '1'.repeat(3000) });
    const response = await handler(
      request('/edge/v1/staff/approvals', { ...saleRequest('POST'), body: big }),
    );
    assert.equal(response.status, 413);
  });
  // The browser server of the same cashier forwards exactly the same set.
  const { createPosServer } = await import('../../apps/pos/server.mjs');
  const seen = [];
  const edge = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => edge.listen(0, '127.0.0.1', resolve));
  const pos = createPosServer({ edgePort: edge.address().port });
  await new Promise((resolve) => pos.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${pos.address().port}/edge/v1/`;
    for (const path of SALE_GET)
      assert.equal((await fetch(base + path)).status, 200, 'server GET ' + path);
    for (const path of SALE_POST)
      assert.equal((await fetch(base + path, saleRequest('POST'))).status, 200, 'server ' + path);
    for (const [method, path] of SALE_REFUSED)
      assert.ok((await fetch(base + path, saleRequest(method))).status >= 400, method + ' ' + path);
    assert.deepEqual(seen, [
      ...SALE_GET.map((path) => `GET /edge/v1/${path}`),
      ...SALE_POST.map((path) => `POST /edge/v1/${path}`),
    ]);
  } finally {
    await new Promise((resolve) => pos.close(resolve));
    await new Promise((resolve) => edge.close(resolve));
  }
});

test('the renderer bare logout reaches the edge bodyless on the desk and the browser server', async () => {
  const sessions = [];
  // The renderer's transport sends POST staff/logout without a body or Content-Type.
  const bare = {
    method: 'POST',
    headers: { Authorization: 'Bearer synthetic-fixture', 'X-Staff-Session-Id': ID },
  };
  const upstream = [];
  await fixture(
    async (handler) => {
      const response = await handler(request('/edge/v1/staff/logout', bare));
      assert.equal(response.status, 204, 'before: 415 on the desk, the edge session lived on');
      assert.equal(await response.text(), '');
      assert.equal(upstream.length, 1);
      assert.equal(upstream[0].url, 'http://127.0.0.1:3101/edge/v1/staff/logout');
      assert.equal(upstream[0].options.method, 'POST');
      assert.equal(upstream[0].options.body, undefined);
      assert.deepEqual(upstream[0].options.headers, {
        authorization: 'Bearer synthetic-fixture',
        'x-staff-session-id': ID,
      });
      // This session never held the journal (no GET session here), so the journal is untouched.
      assert.deepEqual(sessions, []);
      // A body the renderer might attach is not forwarded either.
      await handler(
        request('/edge/v1/staff/logout', {
          ...bare,
          headers: { ...bare.headers, 'Content-Type': 'application/json' },
          body: '{}',
        }),
      );
      assert.equal(upstream.length, 2);
      assert.equal(upstream[1].options.body, undefined);
      assert.equal(upstream[1].options.headers['Content-Type'], undefined);
      // Every other command still needs a JSON body.
      for (const path of ['/edge/v1/staff/pin', '/edge/v1/pos/sales', '/edge/v1/orders'])
        assert.equal((await handler(request(path, bare))).status, 415, path);
      assert.equal(upstream.length, 2);
    },
    {
      onSession: (value) => sessions.push(value),
      fetchImpl: async (url, options) => {
        upstream.push({ url: String(url), options });
        return new Response(null, { status: 204 });
      },
    },
  );
  const { createPosServer } = await import('../../apps/pos/server.mjs');
  const received = [];
  const edge = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({
      line: `${req.method} ${req.url}`,
      headers: req.headers,
      body: String(Buffer.concat(chunks)),
    });
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve) => edge.listen(0, '127.0.0.1', resolve));
  const pos = createPosServer({ edgePort: edge.address().port });
  await new Promise((resolve) => pos.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${pos.address().port}`;
    const response = await fetch(base + '/edge/v1/staff/logout', bare);
    assert.equal(response.status, 204);
    assert.equal(received.length, 1);
    assert.equal(received[0].line, 'POST /edge/v1/staff/logout');
    assert.equal(received[0].body, '');
    assert.equal(received[0].headers['content-type'], undefined);
    assert.equal(received[0].headers['x-staff-session-id'], ID);
    assert.equal((await fetch(base + '/edge/v1/pos/sales', bare)).status, 415);
    assert.equal(received.length, 1);
  } finally {
    await new Promise((resolve) => pos.close(resolve));
    await new Promise((resolve) => edge.close(resolve));
  }
});

test('the desk adds its own build to GET pos/config only; the renderer cannot', async () => {
  await fixture(
    async (handler, upstream) => {
      assert.equal((await handler(request('/edge/v1/pos/config'))).status, 200);
      assert.equal(
        upstream.at(-1).url,
        'http://127.0.0.1:3101/edge/v1/pos/config?client_version=pos-desktop-0.5.0',
      );
      assert.equal((await handler(request('/edge/v1/menu'))).status, 200);
      assert.equal(upstream.at(-1).url, 'http://127.0.0.1:3101/edge/v1/menu');
      assert.equal((await handler(request(`/edge/v1/orders?shift_id=${ID}`))).status, 200);
      assert.equal(upstream.at(-1).url, `http://127.0.0.1:3101/edge/v1/orders?shift_id=${ID}`);
      const before = upstream.length;
      for (const path of [
        '/edge/v1/pos/config?client_version=forged',
        '/edge/v1/pos/config?shift_id=' + ID,
      ])
        assert.equal((await handler(request(path))).status, 403, path);
      assert.equal(upstream.length, before);
    },
    { clientVersion: 'pos-desktop-0.5.0' },
  );
  // Without it (the default) pos/config is the plain route, as every other request.
  await fixture(async (handler, upstream) => {
    await handler(request('/edge/v1/pos/config'));
    assert.equal(upstream.at(-1).url, 'http://127.0.0.1:3101/edge/v1/pos/config');
  });
  for (const clientVersion of ['', 'pos desktop', 'pos+desktop', 'x'.repeat(65), 1])
    await assert.rejects(
      fixture(async () => {}, { clientVersion }),
      /INVALID_CLIENT_VERSION/,
      String(clientVersion),
    );
});

test('the desk publishes its installed version in /config.json for the lock screen (CR client-5)', async () => {
  const { desktopAppVersion, APP_VERSION } = await import(
    pathToFileURL(desktopFile('protocol.mjs')).href
  );
  const pkg = JSON.parse(await readFile(desktopFile('package.json'), 'utf8'));
  // app.getVersion() of the packaged app is the package version.
  assert.equal(desktopAppVersion(pkg.version), pkg.version);
  assert.match(pkg.version, APP_VERSION);
  for (const value of ['0.5', '0.5.0+build', '', 5, undefined, 'v0.5.0'])
    assert.equal(desktopAppVersion(value), undefined, String(value));
  await fixture(
    async (handler, upstream) => {
      const config = await (await handler(request('/config.json'))).json();
      assert.deepEqual(config, {
        branchLabel: 'Synthetic desktop',
        categories: {},
        appVersion: '0.5.0',
      });
      assert.equal(upstream.length, 0);
    },
    { appVersion: '0.5.0' },
  );
  // Without it (an older main, tests) /config.json is exactly as before.
  await fixture(async (handler) => {
    const config = await (await handler(request('/config.json'))).json();
    assert.deepEqual(config, { branchLabel: 'Synthetic desktop', categories: {} });
  });
  for (const appVersion of ['', '0.5', 'pos-desktop-0.5.0', 1])
    await assert.rejects(
      fixture(async () => {}, { appVersion }),
      /INVALID_APP_VERSION/,
      String(appVersion),
    );
});

test('a refused shift manager PIN on staff/approvals keeps the cashier journal', async () => {
  const { createJournalStore } = await import(pathToFileURL(desktopFile('journal.mjs')).href);
  const id = (last) => `10000000-0000-4000-8000-${String(last).padStart(12, '0')}`;
  const cashier = {
    session_id: id(1),
    staff_id: id(2),
    terminal_id: ID,
    branch_id: id(4),
    role: 'cashier',
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  };
  const scope = `${cashier.branch_id}.${cashier.staff_id}.${cashier.terminal_id}`;
  const key = `pickchick.pos.journal.v1.${scope}`;
  const journal = (n) =>
    JSON.stringify({ version: 1, scope, draft: null, pending: null, known: [], selected: n });
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-approval-journal-'));
  const store = createJournalStore({ directory });
  let answer;
  try {
    await fixture(
      async (handler) => {
        const call = (path, method = 'POST') =>
          handler(
            request(path, {
              ...saleRequest(method),
              headers: {
                ...saleRequest(method).headers,
                Authorization: `Bearer ${'b'.repeat(64)}`,
                'X-Staff-Session-Id': cashier.session_id,
              },
            }),
          );
        answer = () => new Response(JSON.stringify(cashier), { status: 200 });
        assert.equal((await call('/edge/v1/session', 'GET')).status, 200);
        store.setItem(key, journal(null));
        for (const status of [401, 403]) {
          answer = () => new Response('{"code":"UNAUTHORIZED"}', { status });
          assert.equal((await call('/edge/v1/staff/approvals')).status, status);
          store.setItem(key, journal(null));
        }
        // Any other route answering 401 for this session still revokes at once.
        answer = () => new Response('{"code":"UNAUTHORIZED"}', { status: 401 });
        assert.equal((await call(`/edge/v1/pos/sales/${ID}/void`)).status, 401);
        assert.throws(() => store.setItem(key, journal(null)));
        // After a 401 on staff/approvals the cashier asks GET cash-shifts/current once
        // (apps/pos model.ts sessionEnded): a lost answer there keeps the journal, the edge's
        // own 401 takes it away. GET session would not do: a lost answer to it leaves the
        // journal revoked although the session is alive.
        answer = () => new Response(JSON.stringify(cashier), { status: 200 });
        assert.equal((await call('/edge/v1/session', 'GET')).status, 200);
        store.setItem(key, journal(null));
        answer = () => {
          throw new TypeError('fetch failed');
        };
        assert.equal((await call('/edge/v1/cash-shifts/current', 'GET')).status, 504);
        store.setItem(key, journal(null));
        assert.equal((await call('/edge/v1/session', 'GET')).status, 504);
        assert.throws(() => store.setItem(key, journal(null)), 'a lost GET session revokes');
        answer = () => new Response(JSON.stringify(cashier), { status: 200 });
        assert.equal((await call('/edge/v1/session', 'GET')).status, 200);
        store.setItem(key, journal(null));
        answer = () => new Response('{"code":"UNAUTHORIZED"}', { status: 401 });
        assert.equal((await call('/edge/v1/cash-shifts/current', 'GET')).status, 401);
        assert.throws(() => store.setItem(key, journal(null)), 'the session ended');
      },
      {
        config: { terminalId: ID },
        onSession: (value, sessionId) => store.setSession(value, sessionId),
        fetchImpl: async () => answer(),
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the paid-sale allowlist is exactly the section 5.5 pos profile list', () => {
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  assert.deepEqual(SALE_ROUTES, {
    read: [
      'pos/config',
      `pos/sales/${uuid}`,
      'pos/fiscal-receipts/pending',
      `cash-shifts/${uuid}/x-report`,
      `cash-shifts/${uuid}/z-report`,
    ],
    write: [
      'staff/approvals',
      'pos/sales',
      `pos/sales/${uuid}/void`,
      `pos/sales/${uuid}/refunds`,
      `pos/fiscal-receipts/${uuid}/record`,
    ],
  });
  // The gateway profile (CL-4) imports these two expressions instead of copying them.
  assert.ok(EDGE_READ_PATH.test('/edge/v1/pos/config'));
  assert.ok(EDGE_WRITE_PATH.test(`/edge/v1/pos/sales/${ID}/refunds`));
  assert.ok(!EDGE_READ_PATH.test('/edge/v1/pos/sales'));
  assert.ok(!EDGE_WRITE_PATH.test('/edge/v1/pos/config'));
});

// ---- Cutover 19.11 (CL-2): a remote edge over pinned TLS -------------------------------------

/** The LAN address the synthetic certificates name; the listener itself is on loopback. */
const LAN_EDGE = '192.168.77.10';
async function certificate(directory, name, ip) {
  const config = join(directory, name + '.cnf'),
    cert = join(directory, name + '.pem'),
    key = join(directory, name + '.key');
  await writeFile(
    config,
    `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Synthetic POS edge TLS\n[ext]\nsubjectAltName=IP:${ip}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
    { mode: 0o600 },
  );
  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-config',
      config,
      '-out',
      cert,
      '-keyout',
      key,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, 'Synthetic certificate generation must succeed');
  return { cert: await readFile(cert, 'utf8'), key: await readFile(key, 'utf8') };
}
const tlsDirectory = await mkdtemp(join(tmpdir(), 'pickchick-pos-tls-'));
const trusted = await certificate(tlsDirectory, 'trusted', LAN_EDGE);
const impostor = await certificate(tlsDirectory, 'impostor', LAN_EDGE);
const foreign = await certificate(tlsDirectory, 'foreign', '10.255.254.253');
await rm(tlsDirectory, { recursive: true, force: true });
const remote = (extra = {}) => ({
  edgeHost: LAN_EDGE,
  edgePort: 3443,
  edgeCertificatePem: trusted.cert,
  ...extra,
});
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
async function stop(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}
/** Connects the pinned transport to a loopback listener instead of the LAN address. */
const dialTo = (port, dials) => (host, edgePort) => {
  dials.push(`${host}:${edgePort}`);
  return connectTcp(port, '127.0.0.1');
};
const neverHttp = async () => {
  throw new Error('a remote edge must never be asked over plain HTTP');
};

test('remote edge settings: both keys or none, a private IPv4 named by the pinned certificate', async () => {
  // Absent keys: the settings are exactly today's.
  assert.deepEqual(validateConfig({ edgePort: 3101 }), {
    edgePort: 3101,
    branchLabel: 'Локальная точка',
    categories: {},
  });
  const settings = validateConfig(remote());
  assert.equal(settings.edgeHost, LAN_EDGE);
  assert.equal(settings.edgePort, 3443);
  assert.equal(settings.edgeCertificatePem, trusted.cert.trim() + '\n');
  for (const bad of [
    { edgeHost: '8.8.8.8' },
    { edgeHost: '127.0.0.1' },
    { edgeHost: '169.254.1.1' },
    { edgeHost: 'localhost' },
    { edgeHost: 'edge.pickchick.invalid' },
    { edgeHost: '192.168.077.10' },
    { edgeHost: '::1' },
    { edgeHost: undefined },
    { edgeCertificatePem: undefined },
    { edgeCertificatePem: 'broken' },
    { edgeCertificatePem: trusted.key },
    { edgeCertificatePem: trusted.cert + trusted.cert },
    { edgeCertificatePem: trusted.cert + trusted.key },
    { edgeCertificatePem: foreign.cert },
    { edgeCertificatePem: 'x'.repeat(16385) },
    { edgeUrl: `https://${LAN_EDGE}:3443` },
  ])
    assert.throws(() => validateConfig(remote(bad)), /INVALID_POS_CONFIG/, JSON.stringify(bad));
  // The renderer never learns where the edge is or whom this desk trusts.
  await fixture(
    async (handler) => {
      const config = await (await handler(request('/config.json'))).json();
      assert.deepEqual(config, { branchLabel: 'Локальная точка', categories: {} });
      assert.ok(!JSON.stringify(config).includes(LAN_EDGE));
    },
    { config: remote(), fetchImpl: neverHttp },
  );
});

test('a loopback edge is asked exactly as before: same URL, same request options', async () => {
  await fixture(async (handler, upstream) => {
    await handler(request('/edge/v1/session'));
    await handler(
      request('/edge/v1/pos/sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': ID },
        body: '{}',
      }),
    );
    assert.equal(upstream[0].url, 'http://127.0.0.1:3101/edge/v1/session');
    assert.deepEqual(Object.keys(upstream[0].options), ['method', 'headers', 'redirect', 'signal']);
    assert.deepEqual(upstream[0].options.headers, {});
    assert.equal(upstream[1].url, 'http://127.0.0.1:3101/edge/v1/pos/sales');
    assert.deepEqual(Object.keys(upstream[1].options), [
      'method',
      'headers',
      'redirect',
      'signal',
      'body',
    ]);
    assert.deepEqual(upstream[1].options.headers, {
      'idempotency-key': ID,
      'Content-Type': 'application/json',
    });
  });
});

test('a remote edge is asked over HTTPS pinned to its certificate, with the same answers', async () => {
  const seen = [];
  const webp = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvB8ABAAdQrcLXo/+BiOh/AAA=', 'base64');
  const photo = createHash('sha256').update(webp).digest('hex');
  const edge = createHttpsServer(trusted, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    if (req.url === `/edge/v1/media/${photo}.webp`) {
      res.writeHead(200, { 'Content-Type': 'image/webp' });
      res.end(webp);
    } else if (req.url === '/edge/v1/staff/logout') {
      res.writeHead(204);
      res.end();
    } else if (req.url === '/edge/v1/staff/login') {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
      res.end('{"code":"AUTH_RATE_LIMITED"}');
    } else if (req.url === '/edge/v1/cloud-link') {
      res.writeHead(302, { Location: 'http://127.0.0.1:9/leak' });
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'edge=private' });
      res.end(JSON.stringify({ path: req.url }));
    }
  });
  const port = await listen(edge);
  const dials = [];
  try {
    await fixture(
      async (handler) => {
        let response = await handler(request(`/edge/v1/orders?shift_id=${ID}`));
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { path: `/edge/v1/orders?shift_id=${ID}` });
        assert.equal(response.headers.get('set-cookie'), null);
        const body = JSON.stringify({ quote_id: ID });
        response = await handler(
          request('/edge/v1/pos/sales', {
            method: 'POST',
            body,
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer synthetic-fixture',
              'X-Staff-Session-Id': ID,
              'Idempotency-Key': ID,
              Cookie: 'private-cookie=fixture',
            },
          }),
        );
        assert.equal(response.status, 200);
        const sale = seen.at(-1);
        assert.equal(sale.method, 'POST');
        assert.equal(sale.url, '/edge/v1/pos/sales');
        assert.equal(sale.body, body);
        assert.equal(sale.headers.host, `${LAN_EDGE}:3443`, 'the gateway checks its own Host');
        assert.equal(sale.headers.authorization, 'Bearer synthetic-fixture');
        assert.equal(sale.headers['x-staff-session-id'], ID);
        assert.equal(sale.headers['idempotency-key'], ID);
        assert.equal(sale.headers['content-type'], 'application/json');
        assert.equal(sale.headers.cookie, undefined);
        assert.equal(sale.headers.origin, undefined);
        response = await handler(
          request('/edge/v1/staff/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          }),
        );
        assert.equal(response.status, 204);
        assert.equal(await response.text(), '');
        response = await handler(
          request('/edge/v1/staff/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          }),
        );
        assert.equal(response.status, 429);
        assert.equal(response.headers.get('retry-after'), '60');
        // A redirect is refused, never followed.
        const before = seen.length;
        response = await handler(request('/edge/v1/cloud-link'));
        assert.equal(response.status, 502);
        assert.equal((await response.json()).code, 'INVALID_RESPONSE');
        assert.equal(seen.length, before + 1);
        // Menu photos come from the same pinned edge, without staff credentials.
        response = await handler(request(`/assets/menu/${photo}.webp`));
        assert.equal(response.headers.get('content-type'), 'image/webp');
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), webp);
        assert.equal(seen.at(-1).headers.authorization, undefined);
        assert.equal(seen.at(-1).headers.host, `${LAN_EDGE}:3443`);
        assert.equal(dials.length, seen.length, 'one pinned connection per request');
        assert.ok(dials.every((d) => d === `${LAN_EDGE}:3443`));
      },
      { config: remote(), fetchImpl: neverHttp, dial: dialTo(port, dials) },
    );
  } finally {
    await stop(edge);
  }
});

test('an impostor certificate or a plain HTTP listener gets no request: no fallback to HTTP', async () => {
  let reached = 0;
  const impostorEdge = createHttpsServer(impostor, (_req, res) => {
    reached++;
    res.end('{}');
  });
  const plainEdge = createServer((_req, res) => {
    reached++;
    res.end('{}');
  });
  const impostorPort = await listen(impostorEdge);
  const plainPort = await listen(plainEdge);
  try {
    for (const port of [impostorPort, plainPort]) {
      const dials = [];
      let http = 0;
      await fixture(
        async (handler) => {
          for (const [path, init] of [
            ['/edge/v1/session', {}],
            [
              '/edge/v1/staff/login',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ login: 'synthetic', password: 'synthetic-only' }),
              },
            ],
          ]) {
            const response = await handler(request(path, init));
            assert.equal(response.status, 504);
            assert.equal((await response.json()).code, 'EDGE_TIMEOUT');
          }
          const photo = await handler(request(`/assets/menu/${'a'.repeat(64)}.webp`));
          assert.equal(photo.status, 404, 'no photo and no bundled logo in this fixture');
        },
        {
          config: remote(),
          fetchImpl: async () => {
            http++;
            return new Response('{}');
          },
          dial: dialTo(port, dials),
        },
      );
      assert.equal(http, 0, 'the HTTP client is never used for a remote edge');
      assert.equal(dials.length, 3, 'one attempt per request, never retried');
    }
    assert.equal(reached, 0, 'no HTTP request reached an untrusted listener');
  } finally {
    await stop(impostorEdge);
    await stop(plainEdge);
  }
});

test('an unresponsive remote edge is bounded by the transport timeout', async () => {
  const idle = createHttpsServer(trusted, () => {});
  const port = await listen(idle);
  try {
    await fixture(
      async (handler) => {
        const began = Date.now();
        const response = await handler(request('/edge/v1/session'));
        assert.equal(response.status, 504);
        assert.ok(Date.now() - began < 2000);
      },
      { config: remote(), fetchImpl: neverHttp, dial: dialTo(port, []), timeoutMs: 200 },
    );
  } finally {
    await stop(idle);
  }
});
