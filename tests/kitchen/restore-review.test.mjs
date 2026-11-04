import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { allowedActions } from '../../apps/kitchen/dist/model.js';
import { order } from '../../apps/kitchen/dist/types.js';

test('restored tickets keep their review marker and cannot expose cooking or handoff actions', () => {
  const station = randomUUID(),
    branch = randomUUID();
  const ticket = {
    orderId: randomUUID(),
    branchId: branch,
    version: 2,
    state: 'ready',
    displayNumber: '15',
    routingVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    assemblyStationId: station,
    channel: 'pos',
    serviceMode: 'takeaway',
    tasks: [],
  };
  for (const status of ['pending', 'retire']) {
    const parsed = order({ ...ticket, restoreReview: { epoch: 2, status } }, branch);
    assert.deepEqual(parsed.restoreReview, { epoch: 2, status });
    assert.deepEqual(allowedActions(parsed, station), []);
    assert.deepEqual(allowedActions({ ...parsed, state: 'accepted' }, station, true), []);
  }
  assert.equal(
    allowedActions(
      order({ ...ticket, restoreReview: { epoch: 2, status: 'resume' } }, branch),
      station,
    )[0].action,
    'handoff',
  );
  assert.throws(() =>
    order({ ...ticket, restoreReview: { epoch: 2, status: 'unexpected' } }, branch),
  );
});

test('local HTTP requires manager, carries the restore marker and preserves repeat identity', async () => {
  const { fixture } = await import('../../packages/edge-fulfillment/tests/fixture.mjs');
  const { createEdge } = await import('@pickchick/edge');
  const { fenceRestoredEdge } = await import('@pickchick/local-orders');
  const { running } = await import('../helpers/sync.mjs');
  await fixture(async (c) => {
    const { order: o } = await c.accepted(true);
    await fenceRestoredEdge(c.pool, true);
    const server = await running(createEdge, {
      service: 'edge',
      environment: 'test',
      databaseUrl: c.url,
      branchId: c.scope.branchId,
      edgeDeviceId: c.scope.deviceId,
      edgeFulfillmentEnabled: true,
      port: 0,
    });
    const headers = (who) => ({
      Authorization: `Bearer ${who.token}`,
      'X-Staff-Session-Id': who.session_id,
      'X-Terminal-Id': who.terminal_id,
      'Content-Type': 'application/json',
    });
    const url = server.url + '/edge/v1/fulfillment/orders/' + o.orderId;
    try {
      const r = await fetch(url, { headers: headers(c.manager) });
      assert.equal(r.status, 200);
      const ticket = await r.json();
      assert.equal(ticket.restoreReview.status, 'pending');
      const body = {
        commandId: randomUUID(),
        epoch: ticket.restoreReview.epoch,
        expectedVersion: ticket.version,
        decision: 'retire',
        reason: 'Physically checked lost timeline',
      };
      const post = (who) =>
        fetch(url + '/restore-review', {
          method: 'POST',
          headers: headers(who),
          body: JSON.stringify(body),
        });
      const resume = await fetch(url + '/restore-review', {
        method: 'POST',
        headers: headers(c.manager),
        body: JSON.stringify({ ...body, decision: 'resume' }),
      });
      assert.notEqual(
        resume.status,
        200,
        'local manager cannot resume cloud-owned execution without cloud reconciliation',
      );
      assert.equal((await post(c.cook)).status, 403);
      assert.equal((await post(c.manager)).status, 200);
      assert.equal((await post(c.manager)).status, 200);
      const after = await (await fetch(url, { headers: headers(c.manager) })).json();
      assert.equal(after.restoreReview.status, 'retire');
      assert.equal(after.version, ticket.version);
    } finally {
      await server.app.close();
    }
  });
});

test('restore review gateway permits only the scoped POST', async () => {
  const { allowed } = await import('../../apps/kitchen/server.mjs');
  const p = `/edge/v1/fulfillment/orders/${randomUUID()}/restore-review`;
  assert.equal(allowed('POST', p), true);
  for (const method of ['GET', 'PUT', 'DELETE']) assert.equal(allowed(method, p), false);
  for (const suffix of ['?x=1', '#x', '/extra']) assert.equal(allowed('POST', p + suffix), false);
});

test(
  'actual kitchen UI: manual check, lost response and journal across reload',
  { timeout: 120000 },
  async () => {
    const { fixture } = await import('../../packages/edge-fulfillment/tests/fixture.mjs');
    const { createEdge } = await import('@pickchick/edge');
    const { fenceRestoredEdge } = await import('@pickchick/local-orders');
    const { createKitchenServer } = await import('../../apps/kitchen/server.mjs');
    const { once } = await import('node:events');
    const { mkdir, writeFile, rm } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const { spawn } = await import('node:child_process');
    await fixture(async (c) => {
      await c.accepted(true);
      await fenceRestoredEdge(c.pool, true);
      const app = await createEdge({
        service: 'edge',
        environment: 'test',
        databaseUrl: c.url,
        branchId: c.scope.branchId,
        edgeDeviceId: c.scope.deviceId,
        edgeFulfillmentEnabled: true,
        port: 0,
      });
      await app.listen(0, '127.0.0.1');
      const gateway = createKitchenServer({
        edgePort: Number(new URL(await app.getUrl()).port),
        assetDir: new URL('../../apps/kitchen/dist/', import.meta.url),
      });
      gateway.listen(0, '127.0.0.1');
      await once(gateway, 'listening');
      const output = resolve('.local/queue279/kitchen-browser');
      await mkdir(output, { recursive: true });
      const path = resolve(output, 'fixture.json');
      const actor = (a) => Object.fromEntries(Object.entries(a).filter(([key]) => key !== 'auth'));
      await writeFile(
        path,
        JSON.stringify({
          url: `http://127.0.0.1:${gateway.address().port}`,
          cook: actor(c.cook),
          manager: actor(c.manager),
          output,
        }),
        { mode: 0o600 },
      );
      try {
        const child = spawn(
          process.env.PICKCHICK_BROWSER_PYTHON ?? resolve('.local/design-venv/bin/python'),
          ['tests/kitchen/restore-review-browser.py', path],
          { stdio: 'inherit' },
        );
        const [code] = await once(child, 'exit');
        assert.equal(code, 0);
        assert.equal(
          (await c.pool.query('SELECT count(*)::int n FROM fulfillment_restore_decisions')).rows[0]
            .n,
          1,
        );
        assert.equal(
          (await c.pool.query('SELECT count(*)::int n FROM fulfillment_commands')).rows[0].n,
          0,
        );
      } finally {
        await rm(path, { force: true });
        gateway.closeAllConnections();
        await new Promise((r) => gateway.close(r));
        await app.close();
      }
    });
  },
);
