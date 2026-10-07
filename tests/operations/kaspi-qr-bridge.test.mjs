import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createQrRouter } from '../../infra/payments/kaspi-bridge/qr-routes.mjs';

// Minimal routing fixture exercises the handlers over HTTP without upstream dependencies.
function Router() {
  const routes = new Map();
  let middleware;
  return {
    use(fn) {
      middleware = fn;
    },
    post(path, fn) {
      routes.set('POST ' + path, fn);
    },
    get(path, fn) {
      routes.set('GET ' + path, fn);
    },
    async handle(incoming, outgoing) {
      const url = new URL(incoming.url, 'http://localhost');
      let raw = '';
      for await (const chunk of incoming) raw += chunk;
      const req = {
        headers: incoming.headers,
        query: Object.fromEntries(url.searchParams),
        body: raw ? JSON.parse(raw) : undefined,
      };
      const res = {
        status(code) {
          outgoing.statusCode = code;
          return this;
        },
        json(value) {
          outgoing.setHeader('Content-Type', 'application/json');
          outgoing.end(JSON.stringify(value));
        },
      };
      return middleware(req, res, () => routes.get(incoming.method + ' ' + url.pathname)(req, res));
    },
  };
}

test('private QR HTTP contract validates schema and preserves raw bank token without tracking', async (t) => {
  const calls = [];
  let mode = 'ok';
  const router = createQrRouter({
    Router,
    bankUrl: 'https://synthetic-bank.invalid',
    decryptSecret(value) {
      if (value !== 'synthetic-secret') throw Error(value);
      return 'decrypted';
    },
    signedHeaders() {
      return { 'X-Synthetic-Signature': 'fixture' };
    },
    async fetcher(url, init) {
      calls.push({ url, init });
      if (mode === 'throw') throw Error('synthetic-secret');
      return new Response(
        JSON.stringify({
          StatusCode: 0,
          Data: {
            QrOperationId: 123,
            QrToken: 'https://qr.kaspi.kz/synthetic',
            Amount: 500,
            Status: 'Processed',
          },
        }),
      );
    },
  });
  const server = createServer((req, res) => router.handle(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Token-SN': 'synthetic-token',
    'X-Vtoken-Secret': 'synthetic-secret',
  };
  const create = (body, auth = headers) =>
    fetch(base + '/create', { method: 'POST', headers: auth, body: JSON.stringify(body) });
  const valid = { amount: 500, latitude: 0, longitude: 0 };
  for (const body of [
    { ...valid, amount: 0 },
    { ...valid, amount: 1.5 },
    { ...valid, amount: '500' },
    { ...valid, latitude: 91 },
    { amount: 500 },
    { ...valid, phone: 'forbidden' },
  ])
    assert.equal((await create(body)).status, 400);
  assert.equal((await create(valid, { 'Content-Type': 'application/json' })).status, 401);
  assert.equal(calls.length, 0);
  const answer = await (await create(valid)).json();
  assert.equal(answer.Data.QrToken, 'https://qr.kaspi.kz/synthetic');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    PaymentAmount: 500,
    DeviceInterface: 'Pos',
    Latitude: 0,
    Longitude: 0,
  });
  assert.equal(JSON.stringify(answer).includes('synthetic-secret'), false);
  assert.equal((await fetch(base + '/status?qrOperationId=123', { headers })).status, 200);
  assert.equal(
    calls[1].url,
    'https://synthetic-bank.invalid/v02/kaspi-qr/status?qrOperationId=123',
  );
  for (const id of ['0', '-1', '1%26x%3D2', '123456789012345678901'])
    assert.equal((await fetch(base + '/status?qrOperationId=' + id, { headers })).status, 400);
  mode = 'throw';
  const failed = await create(valid);
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: 'BANK_UNCERTAIN' });
  const source = await readFile(
    new URL('../../infra/payments/kaspi-bridge/qr-routes.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /trackPayment|writeFile|console\./);
});

test(
  'pinned optional overlay repeats exactly and rejects drift without caller mutations',
  {
    skip: !process.env.KASPI_TEST_UPSTREAM,
  },
  async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { execFileSync } = await import('node:child_process');
    const { installOverlays } =
      await import('../../infra/payments/kaspi-bridge/install-overlays.mjs');
    const { prepareContainer } =
      await import('../../infra/payments/kaspi-bridge/prepare-container.mjs');
    const temporary = await mkdtemp('/tmp/pickchick-qr-overlay-test-');
    try {
      for (const qr of [false, true]) {
        const checkout = temporary + '/checkout-' + qr;
        execFileSync('git', [
          'clone',
          '--quiet',
          '--no-checkout',
          process.env.KASPI_TEST_UPSTREAM,
          checkout,
        ]);
        execFileSync(
          'git',
          ['checkout', '--quiet', '--detach', '28c9167f9c72cd6758a25e254bc92bc610daa485'],
          { cwd: checkout },
        );
        await installOverlays(checkout, { qr });
        const first = execFileSync('git', ['diff'], { cwd: checkout });
        await installOverlays(checkout, { qr });
        assert.deepEqual(execFileSync('git', ['diff'], { cwd: checkout }), first);
        const context = temporary + '/context-' + qr;
        await prepareContainer(checkout, context, { qr });
        const manifest = JSON.parse(await readFile(context + '/manifest.json', 'utf8'));
        assert.equal(manifest.qr, qr);
        assert.equal(!!manifest.hashes['upstream/src/qr-routes.mjs'], qr);
        if (qr) {
          const path = checkout + '/src/routes/invoice.js';
          await writeFile(path, (await readFile(path, 'utf8')) + '\n// unexpected caller change\n');
          const drift = execFileSync('git', ['diff'], { cwd: checkout });
          await assert.rejects(installOverlays(checkout, { qr }), /OVERLAY_CONFLICT/);
          assert.deepEqual(execFileSync('git', ['diff'], { cwd: checkout }), drift);
        }
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
