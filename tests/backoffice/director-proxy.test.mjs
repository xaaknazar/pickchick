import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createBackofficeServer } from '../../apps/backoffice/server.mjs';

test('director proxy permits bounded report filters and prevents arbitrary upstream queries', async () => {
  const received = [];
  const api = createServer((req, res) => {
    received.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const ui = createBackofficeServer({ apiPort: api.address().port });
  ui.listen(0, '127.0.0.1');
  await once(ui, 'listening');
  const base = `http://127.0.0.1:${ui.address().port}`;
  const branch = '10000000-0000-4000-8000-000000000003';
  const route = `/v1/admin/backoffice/branches/${branch}`;
  const get = (path) =>
    fetch(base + path, { headers: { Authorization: 'Bearer ' + 'a'.repeat(64) } });
  try {
    for (const query of [
      '',
      '?period=day',
      '?period=today',
      '?period=yesterday',
      '?period=week',
      '?period=month',
      '?period=quarter',
      '?period=year',
      '?period=custom&start_date=2024-02-29&end_date=2024-03-01',
      `?shift_id=${branch}&period=year`,
    ]) {
      assert.equal((await get(route + query)).status, 200, query);
      assert.equal(received.at(-1), route + query);
    }
    const before = received.length;
    for (const query of [
      '?period=year&period=day',
      '?period=year&%70eriod=day',
      '?period=all',
      '?token=secret',
      '?period=custom',
      '?period=custom&start_date=2026-02-30&end_date=2026-03-01',
      '?period=custom&start_date=2026-03-02&end_date=2026-03-01',
      '?period=custom&start_date=2024-01-01&end_date=2026-01-01',
      '?period=day&start_date=2026-01-01',
      '?shift_id=bad',
      '?period=year?x=1',
      '?period=year&unknown=1',
      '?period=' + 'a'.repeat(401),
    ]) {
      assert.equal((await get(route + query)).status, 404, query);
    }
    for (const path of [
      `${route}/orders/${branch}?period=year`,
      '/v1/admin/other',
      '/v1/admin/catalog/branches?token=secret',
    ])
      assert.equal((await get(path)).status, 404);
    assert.equal(received.length, before);
  } finally {
    await Promise.all([
      new Promise((resolve) => ui.close(resolve)),
      new Promise((resolve) => api.close(resolve)),
    ]);
  }
});
