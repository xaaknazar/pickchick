import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '@pickchick/platform';
import {
  posCloudOrigin,
  posRetryDelayMs,
  syncPosOrdersOnce,
  syncPosKitchenOnce,
  sendPosEvent,
} from '../dist/index.js';

const identity = {
  device_id: randomUUID(),
  branch_id: randomUUID(),
  token: 'a'.repeat(64),
  expires_at: '2030-01-01T00:00:00.000Z',
};
test('default-disabled worker never needs a database, identity or network', async () => {
  assert.deepEqual(await syncPosOrdersOnce(null, { enabled: false }), { state: 'disabled' });
  assert.deepEqual(await syncPosKitchenOnce(null, { enabled: false }), { state: 'disabled' });
  const env = {
    APP_ENV: 'test',
    CLOUD_DATABASE_URL: 'postgresql://127.0.0.1/pickchick_cloud',
    EDGE_DATABASE_URL: 'postgresql://127.0.0.1/pickchick_edge',
    REDIS_URL: 'redis://127.0.0.1',
    EDGE_BRANCH_ID: identity.branch_id,
  };
  assert.equal(loadConfig('api', env).posOrderSyncEnabled, undefined);
  assert.equal(loadConfig('edge', env).posOrderSyncEnabled, undefined);
  assert.throws(() => loadConfig('edge', { ...env, EDGE_POS_ORDER_SYNC_ENABLED: 'true' }));
  assert.throws(() => loadConfig('api', { ...env, EDGE_POS_ORDER_SYNC_ENABLED: 'true' }));
  assert.equal(
    loadConfig('edge', {
      ...env,
      EDGE_DEVICE_ID: identity.device_id,
      EDGE_POS_ORDER_SYNC_ENABLED: 'true',
    }).edgeDeviceId,
    identity.device_id,
  );
  assert.equal(
    loadConfig('api', { ...env, CLOUD_POS_ORDER_SYNC_ENABLED: 'true' }).posOrderSyncEnabled,
    true,
  );
});
test('private origin is pinned HTTPS or explicit loopback HTTP with no redirect/path/credentials', () => {
  for (const invalid of [
    'http://example.com',
    'http://localhost:3100',
    'https://example.com/path',
    'https://user:pass@example.com',
    'https://example.com?token=x',
    'https://example.com#x',
    'file:///tmp/x',
  ])
    assert.throws(() => posCloudOrigin(invalid));
  assert.equal(posCloudOrigin('https://edge.example.com/'), 'https://edge.example.com');
  assert.equal(posCloudOrigin('http://127.0.0.1:1234'), 'http://127.0.0.1:1234');
  assert.equal(posRetryDelayMs(1), 2000);
  assert.equal(posRetryDelayMs(2), 4000);
  assert.equal(posRetryDelayMs(1000), 60000);
});
test('HTTP transport limits time/size, preserves identity headers and redacts upstream text', async () => {
  const failure = (code) => (error) =>
    error.code === code && !error.message.includes(identity.token);
  let request;
  assert.deepEqual(
    await sendPosEvent(
      'https://example.com',
      identity,
      { synthetic: true },
      {
        fetch: async (url, options) => {
          request = { url, options };
          return Response.json({ ok: true });
        },
      },
    ),
    { ok: true },
  );
  assert.equal(request.url, 'https://example.com/internal/v1/edge/pos-orders/events');
  await assert.rejects(
    sendPosEvent(
      'https://example.com',
      identity,
      {},
      { fetch: async () => Response.json({ ok: true }, { status: 202 }) },
    ),
    failure('INVALID_RESPONSE'),
  );
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers.Authorization, `Bearer ${identity.token}`);
  await assert.rejects(
    sendPosEvent(
      'https://example.com',
      identity,
      {},
      { fetch: async () => new Response(identity.token, { status: 502 }) },
    ),
    failure('INVALID_RESPONSE'),
  );
  await assert.rejects(
    sendPosEvent(
      'https://example.com',
      identity,
      {},
      {
        fetch: async () =>
          new Response('x'.repeat(9000), { headers: { 'content-type': 'application/json' } }),
      },
    ),
    failure('INVALID_RESPONSE'),
  );
  await assert.rejects(
    sendPosEvent(
      'https://example.com',
      identity,
      {},
      {
        fetch: async () =>
          Response.json(
            {
              code: 'FORBIDDEN',
              trace_id: randomUUID(),
              message_key: 'FORBIDDEN',
              retryable: false,
            },
            { status: 403 },
          ),
      },
    ),
    failure('HTTP_REJECTED'),
  );
  await assert.rejects(
    sendPosEvent(
      'https://example.com',
      identity,
      {},
      { timeoutMs: 10, fetch: async () => new Promise(() => {}) },
    ),
    failure('NETWORK_UNKNOWN'),
  );
  await assert.rejects(
    sendPosEvent(
      'https://example.com',
      identity,
      { padding: 'x'.repeat(100000) },
      {
        fetch: async () => {
          assert.fail('oversized request reached network');
        },
      },
    ),
    failure('INVALID_RESPONSE'),
  );
});
test('public staging route allowlist never forwards private POS ingress', async () => {
  const config = await readFile(
    new URL('../../../infra/public-staging/gateway.Caddyfile', import.meta.url),
    'utf8',
  );
  const lines = config.split('\n').map((line) => line.trim());
  const blockAt = (index) => {
    let depth = 1;
    const body = [];
    for (let i = index + 1; i < lines.length; i++) {
      if (lines[i].endsWith(' {')) depth++;
      if (lines[i] === '}') depth--;
      if (depth === 0) return body;
      body.push(lines[i]);
    }
    assert.fail('Unclosed gateway block');
  };
  const endpoint = '/internal/v1/edge/pos-orders/events';
  let proxies = 0;
  for (let i = 0; i < lines.length; i++) {
    const handle = lines[i].match(/^handle (@[a-z_]+) \{$/);
    if (!handle) continue;
    const body = blockAt(i);
    if (!body.some((line) => line.startsWith('reverse_proxy '))) continue;
    proxies++;
    const matcher = blockAt(lines.indexOf(handle[1] + ' {'));
    const paths = matcher.filter(
      (line) => line.startsWith('path ') || line.startsWith('path_regexp '),
    );
    assert.ok(
      paths.length > 0,
      'Every upstream handler requires an explicit positive path matcher',
    );
    for (const line of paths) {
      if (line.startsWith('path_regexp '))
        assert.equal(new RegExp(line.split(' ').slice(2).join(' ')).test(endpoint), false);
      else
        for (const path of line.split(' ').slice(1))
          assert.equal(new RegExp('^' + path.replaceAll('*', '.*') + '$').test(endpoint), false);
    }
  }
  assert.equal(proxies, lines.filter((line) => line.startsWith('reverse_proxy ')).length);
  assert.ok(proxies > 0);
  const fallback = blockAt(lines.indexOf('handle {'));
  assert.ok(fallback.some((line) => line.startsWith('respond ') && line.endsWith(' 404')));
  assert.ok(!fallback.some((line) => line.startsWith('reverse_proxy ')));
});
