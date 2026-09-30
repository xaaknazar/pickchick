import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac, randomUUID } from 'node:crypto';
import { createApi } from '../../services/api/dist/index.js';

test('Kaspi bridge webhook keeps raw JSON bytes and rejects unsigned, altered or disabled input', async () => {
  const names = [
    'KASPI_REMOTE_ENABLED',
    'KASPI_BRIDGE_URL',
    'KASPI_BRIDGE_WEBHOOK_SECRET',
    'KASPI_REMOTE_ACCOUNT_ID',
  ];
  const previous = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  const secret = 'synthetic_kaspi_http_webhook_secret_0001';
  try {
    for (const enabled of [false, true]) {
      Object.assign(process.env, {
        KASPI_REMOTE_ENABLED: String(enabled),
        KASPI_BRIDGE_URL: 'http://127.0.0.1:3931',
        KASPI_BRIDGE_WEBHOOK_SECRET: secret,
        KASPI_REMOTE_ACCOUNT_ID: randomUUID(),
      });
      const app = await createApi({
        service: 'api',
        environment: 'test',
        port: 0,
        databaseUrl: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic',
      });
      try {
        await app.listen(0, '127.0.0.1');
        const url = (await app.getUrl()) + '/v1/integrations/kaspi-remote/webhook';
        const send = (body, headers = {}) =>
          fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body,
          });
        // Deliberately non-canonical JSON: re-serialising parsed JSON would change the bytes.
        const body = '{ "paymentId" : "123456",\n "type":"invoice", "event":"payment.success" }';
        const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
        if (!enabled) {
          assert.equal((await send(body, { 'X-Webhook-Signature': signature })).status, 503);
          continue;
        }
        assert.equal((await send(body)).status, 401);
        assert.equal(
          (await send(body.replace('123456', '123457'), { 'X-Webhook-Signature': signature }))
            .status,
          401,
        );
        const junk = 'not json';
        const junkSignature = 'sha256=' + createHmac('sha256', secret).update(junk).digest('hex');
        assert.equal((await send(junk, { 'X-Webhook-Signature': junkSignature })).status, 400);
        assert.equal(
          (
            await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'text/plain' },
              body,
            })
          ).status,
          415,
        );
        // A valid signature over the exact bytes reaches the database step (unreachable here).
        const accepted = await send(body, { 'X-Webhook-Signature': signature });
        assert.ok(accepted.status >= 500, 'signature and body must pass verification');
        assert.equal(
          (
            await send('{"a":"' + 'x'.repeat(70 * 1024) + '"}', {
              'X-Webhook-Signature': signature,
            })
          ).status,
          413,
        );
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
