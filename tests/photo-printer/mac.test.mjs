import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { setImmediate } from 'node:timers';
import { sendMacUsb, validUsbUri } from '../../tools/photo-printer/mac-usb.mjs';
import { macPreviewHandler } from '../../tools/photo-printer/mac-preview.mjs';
import { createMacPreviewIO } from '../../apps/kiosk/src/photobooth/mac-preview.ts';
const uri = 'usb://Printer/POS-80?serial=TEST';

test('USB transfer pins a discovered ESC/POS device, writes once through stdin and never queues', async () => {
  let launches = 0;
  const bytes = Buffer.from([27, 64, 29, 118]);
  const launch = (path, args, options) => {
    launches++;
    assert.equal(path, '/usr/libexec/cups/backend/usb');
    assert.equal(args[3], '1');
    assert.equal(args.length, 5);
    assert.equal(options.env.DEVICE_URI, uri);
    const c = new EventEmitter();
    c.stdin = new PassThrough();
    const chunks = [];
    c.stdin.on('data', (b) => chunks.push(b));
    c.stdin.on('finish', () =>
      setImmediate(() => {
        assert.deepEqual(Buffer.concat(chunks), bytes);
        c.emit('close', 0);
      }),
    );
    c.kill = () => c.emit('close', null);
    setImmediate(() => c.emit('spawn'));
    return c;
  };
  assert.equal(await sendMacUsb(uri, bytes, { discover: async () => [uri], launch }), 'sent');
  assert.equal(await sendMacUsb(uri, bytes, { discover: async () => [], launch }), 'failed');
  assert.equal(launches, 1);
  for (const invalid of ['socket://1.2.3.4', 'usb://Printer/POS-80', uri + '&copies=2'])
    assert(!validUsbUri(invalid));
});
test('USB timeout after dispatch remains unknown and is not retried', async () => {
  let launches = 0;
  const launch = () => {
    launches++;
    const c = new EventEmitter();
    c.stdin = new PassThrough();
    c.stdin.resume();
    c.kill = () => c.emit('close', null);
    setImmediate(() => c.emit('spawn'));
    return c;
  };
  assert.equal(
    await sendMacUsb(uri, Buffer.from('x'), { discover: async () => [uri], launch, timeout: 10 }),
    'unknown',
  );
  assert.equal(launches, 1);
});
test('large USB image is paced in bounded bursts without truncation or duplicate bytes', async () => {
  const chunks = [],
    delays = [];
  let launches = 0;
  const bytes = Buffer.alloc(43200, 165);
  const launch = () => {
    launches++;
    const c = new EventEmitter();
    c.stdin = new PassThrough();
    c.stdin.on('data', (b) => chunks.push(b));
    c.stdin.on('finish', () => setImmediate(() => c.emit('close', 0)));
    c.kill = () => c.emit('close', null);
    setImmediate(() => c.emit('spawn'));
    return c;
  };
  assert.equal(
    await sendMacUsb(uri, bytes, {
      discover: async () => [uri],
      launch,
      delay: async (ms) => delays.push(ms),
    }),
    'sent',
  );
  assert.equal(launches, 1);
  assert(chunks.every((b) => b.length <= 1024));
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.equal(delays.length, chunks.length - 1);
  assert(delays.every((ms) => ms === 40));
});
test('loopback UI refuses foreign Origin, DNS rebind, pairing, traversal and unauthenticated API', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'photo-mac-'));
  writeFileSync(join(root, 'index.html'), '<html>test</html>');
  const service = {
    authenticate: () => {
      throw Error('UNAUTHORIZED');
    },
  };
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  server.on('request', macPreviewHandler({ service, root, origin }));
  t.after(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const rebound = await new Promise((resolve) => {
    http.get(origin, { headers: { Host: 'evil.example' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
  });
  assert.equal(rebound, 403);
  assert.equal((await fetch(origin, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(origin + '/v1/pair', { method: 'POST' })).status, 403);
  assert.notEqual((await fetch(origin + '/v1/status')).status, 200);
  assert.equal((await fetch(origin + '/%2e%2e%2fsecret')).status, 404);
});
function browser(origin = 'http://127.0.0.1:13441') {
  const location = new URL(origin + '/#photo-key=' + 'a'.repeat(64));
  const values = new Map();
  const calls = [];
  return {
    location,
    crypto: { randomUUID: () => 'id' },
    history: {
      replaceState: (_s, _t, url) => {
        location.href = origin + url;
      },
    },
    sessionStorage: {
      getItem: (k) => values.get(k) ?? null,
      setItem: (k, v) => values.set(k, v),
      removeItem: (k) => values.delete(k),
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ printingEnabled: true }) };
    },
    calls,
  };
}
test('Mac browser adapter allows only literal loopback and fixed photo routes; refresh retains pending identity', async () => {
  for (const origin of [
    'https://pickchick.kz',
    'http://192.168.3.33:13441',
    'http://localhost:13441',
  ])
    assert.equal(createMacPreviewIO(browser(origin)), null);
  const b = browser(),
    io = createMacPreviewIO(b),
    config = await io.readConfig();
  assert.equal(b.location.hash, '');
  await io.writePending('pending-id');
  assert.equal(await createMacPreviewIO(b).readPending(), 'pending-id');
  await io.request(config, '/v1/status');
  assert.equal(b.calls[0].options.redirect, 'error');
  await assert.rejects(
    () => io.request({ ...config, url: 'https://evil.example' }, '/v1/status'),
    /ADDRESS/,
  );
  await assert.rejects(() => io.request(config, '/v1/pair', {}), /ADDRESS/);
  await assert.rejects(() => io.request(config, '//evil.example'), /ADDRESS/);
  await io.writePending(null);
  assert.equal(await io.readPending(), null);
});
