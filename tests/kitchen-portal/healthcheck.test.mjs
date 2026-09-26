import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { checkPortal } from '../../infra/kitchen-portal/healthcheck.mjs';

test('health probe preserves the public Host and rejects HTTP failure or stalled replies', async () => {
  let mode = 'healthy';
  const server = createServer((req, res) => {
    assert.equal(req.headers.host, 'kitchen.example');
    assert.equal(req.url, '/kitchen-live/health');
    if (mode === 'stall') return;
    res.writeHead(mode === 'healthy' ? 200 : 503);
    res.end(JSON.stringify({ edgeConnected: false }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const config = { origin: 'https://kitchen.example', port: server.address().port };
  try {
    await checkPortal(config);
    mode = 'failed';
    await assert.rejects(checkPortal(config), /PORTAL_UNHEALTHY/);
    mode = 'stall';
    await assert.rejects(checkPortal({ ...config, timeoutMs: 50 }));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
