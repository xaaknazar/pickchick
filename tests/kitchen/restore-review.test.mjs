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
