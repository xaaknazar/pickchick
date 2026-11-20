import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createApi } from '../../services/api/dist/index.js';

test('real HTTP boundary preserves form bytes, rejects JSON, invalid HMAC and disabled receiver', async () => {
  const names = [
    'TIPTOPPAY_WEBHOOKS_ENABLED',
    'TIPTOPPAY_MODE',
    'TIPTOPPAY_PUBLIC_ID',
    'TIPTOPPAY_API_SECRET',
    'TIPTOPPAY_ACCOUNT_ID',
  ];
  const previous = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  try {
    for (const enabled of [false, true]) {
      Object.assign(process.env, {
        TIPTOPPAY_WEBHOOKS_ENABLED: String(enabled),
        TIPTOPPAY_MODE: 'live',
        TIPTOPPAY_PUBLIC_ID: 'pk_synthetic',
        TIPTOPPAY_API_SECRET: 'synthetic-http-test-only-secret',
        TIPTOPPAY_ACCOUNT_ID: randomUUID(),
      });
      const app = await createApi({
        service: 'api',
        environment: 'test',
        port: 0,
        databaseUrl: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic',
      });
      try {
        await app.listen(0, '127.0.0.1');
        const url = (await app.getUrl()) + '/v1/integrations/tiptoppay/pay';
        const send = (type, body) =>
          fetch(url, { method: 'POST', headers: { 'Content-Type': type }, body });
        assert.equal((await send('application/json', '{"Amount":1}')).status, 415);
        assert.equal(
          (await send('application/x-www-form-urlencoded', 'Amount=1')).status,
          enabled ? 401 : 503,
        );
        assert.equal(
          (await send('application/x-www-form-urlencoded', 'a=' + 'x'.repeat(17000))).status,
          413,
        );
        assert.equal((await fetch(url)).status, 404);
        // TEST 3-D Secure page and TermUrl: static page, larger bank answer, back to the app.
        const base = (await app.getUrl()) + '/v1/integrations/tiptoppay/';
        const threeDs = await fetch(base + 'test-3ds');
        assert.equal(threeDs.status, 200);
        assert.equal(threeDs.headers.get('cache-control'), 'no-store');
        assert.equal(threeDs.headers.get('x-frame-options'), 'DENY');
        assert.match(await threeDs.text(), /test-3ds-return/);
        const back = await fetch(base + 'test-3ds-return', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'MD=123&PaRes=' + 'x'.repeat(20000),
        });
        assert.equal(back.status, 200);
        assert.match(await back.text(), /pickchick:\/\/tiptoppay-return\?state=pending/);
      } finally {
        await app.close();
      }
    }
  } finally {
    for (const n of names) {
      if (previous[n] === undefined) delete process.env[n];
      else process.env[n] = previous[n];
    }
  }
});
