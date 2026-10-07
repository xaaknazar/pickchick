import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withCatalog } from './helpers.mjs';
test('HTTP and private proxy expose finance with authentication and replay', () =>
  withCatalog(async (c) => {
    const base = c.url + '/v1/admin/backoffice/branches/' + c.branch + '/finance';
    const get = await fetch(base + '?start_date=2026-10-01&end_date=2026-10-31');
    assert.equal(get.status, 401);
    const headers = {
      Authorization: 'Bearer ' + c.manager.token,
      'Content-Type': 'application/json',
    };
    const account = {
      request_id: randomUUID(),
      reason: 'Synthetic account',
      command: {
        type: 'account',
        id: randomUUID(),
        name: 'Synthetic browser cash',
        kind: 'cash',
        opening_date: '2026-10-01',
        opening_minor: '10000',
      },
    };
    const send = (body) =>
      fetch(base + '/commands', { method: 'POST', headers, body: JSON.stringify(body) });
    const response = await send(account);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), await (await send(account)).json());
    const result = await fetch(base + '?start_date=2026-10-01&end_date=2026-10-31', { headers });
    assert.equal(result.status, 200);
    const data = await result.json();
    assert.equal(data.accounts[0].after_minor, '10000');
    assert.equal(data.branch_id, c.branch);
    const bad = await send({
      ...account,
      request_id: randomUUID(),
      command: { ...account.command, opening_minor: '1.5' },
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, 'INVALID_REQUEST');
    assert.equal(
      (await fetch(base + '?start_date=2026-10-01&end_date=2026-10-31&token=bad', { headers }))
        .status,
      404,
    );
    assert.equal((await fetch(base + '/commands', { method: 'DELETE', headers })).status, 404);
  }));
