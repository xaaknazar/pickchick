/* global structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { URLSearchParams } from 'node:url';
import { OperationsModel } from '../../apps/backoffice/dist/operations-model.js';
import { ApiError } from '../../apps/backoffice/dist/api.js';
import { withCatalog, storage } from './helpers.mjs';
test('unknown HTTP outcome survives reload with the exact body; no duplicate stock record or audit', () =>
  withCatalog(async (c) => {
    const api = async (path, request) => {
      const response = await fetch(`${c.upstream}/v1/admin/backoffice/${path}`, {
        method: request?.method ?? 'GET',
        headers: { Authorization: `Bearer ${c.manager.token}`, 'Content-Type': 'application/json' },
        ...(request?.body ? { body: JSON.stringify(request.body) } : {}),
      });
      const body = await response.json();
      if (!response.ok) throw new ApiError(body.code, response.status);
      return body;
    };
    const bodies = [];
    let drop = true;
    const unreliable = async (path, request) => {
      const result = await api(path, request);
      if (request) {
        bodies.push(structuredClone(request.body));
        if (drop) {
          drop = false;
          throw new ApiError('NETWORK');
        }
      }
      return result;
    };
    const store = storage(),
      m = new OperationsModel(unreliable, store, () => {});
    await m.load(c.manager.actor_id, c.branch);
    assert.equal(
      await m.execute(
        {
          type: 'save',
          kind: 'ingredient',
          id: randomUUID(),
          expected_revision: 0,
          payload: { name: 'Synthetic recovered', unit: 'g', minimum: '0', active: true },
        },
        'Synthetic recovery',
      ),
      false,
    );
    assert.ok(m.pending);
    assert.equal((await c.backoffice.read(c.manager.token, c.branch)).audit.length, 1);
    await assert.rejects(m.execute({}, 'Another command'), /PENDING/);
    const reloaded = new OperationsModel(unreliable, store, () => {});
    await reloaded.load(c.manager.actor_id, c.branch);
    assert.ok(reloaded.pending);
    assert.equal(await reloaded.recover(), true);
    assert.deepEqual(bodies[0], bodies[1]);
    assert.equal(reloaded.pending, null);
    assert.equal((await c.backoffice.read(c.manager.token, c.branch)).audit.length, 1);
    const other = new OperationsModel(unreliable, store, () => {});
    await other.load(randomUUID(), c.branch);
    assert.equal(other.pending, null);
  }));
test('late responses cannot restore another branch or logged-out data; forbidden refresh clears sensitive snapshot', async () => {
  const branch = randomUUID(),
    actor = randomUUID();
  const snapshot = (branch) => ({
    schema_version: 1,
    branch_id: branch,
    as_of: new Date().toISOString(),
    role: 'manager',
    records: [],
    stock: [],
    orders: [],
    pos: [],
    chart: [],
    finance: [],
    refunds: [],
    issues: [],
    devices: [],
    kitchen: [],
    guests: [],
    audit: [],
    catalog_audit: [],
    documents: [],
    publications: [],
    metrics: {},
    capabilities: {},
  });
  let resolve;
  const m = new OperationsModel(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
    storage(),
    () => {},
  );
  const waiting = m.load(actor, branch);
  m.clear();
  resolve(snapshot(branch));
  await waiting;
  assert.equal(m.data, null);
  let deny = false;
  const n = new OperationsModel(
    async () => {
      if (deny) throw new ApiError('FORBIDDEN', 403);
      return snapshot(branch);
    },
    storage(),
    () => {},
  );
  await n.load(actor, branch);
  assert.ok(n.data);
  deny = true;
  await n.load(actor, branch);
  assert.equal(n.data, null);
});
test('storage failure prevents sending a mutation', async () => {
  let writes = 0;
  const m = new OperationsModel(
    async () => {
      writes++;
    },
    {
      getItem: () => null,
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {},
    },
    () => {},
  );
  m.data = { role: 'manager' };
  m.actor = randomUUID();
  m.branch = randomUUID();
  await assert.rejects(m.execute({ type: 'save' }, 'Synthetic'), /STORAGE/);
  assert.equal(writes, 0);
  assert.equal(m.pending, null);
});

test('calendar query preserves custom dates on refresh and clears stale data when period changes', async () => {
  const branch = randomUUID(),
    actor = randomUUID(),
    calls = [];
  let fail = false;
  const m = new OperationsModel(
    async (path) => {
      calls.push(path);
      if (fail) throw new ApiError('NETWORK');
      return {
        schema_version: 1,
        branch_id: branch,
        role: 'manager',
        as_of: new Date().toISOString(),
        records: [],
        stock: [],
        orders: [],
        pos: [],
        chart: [],
        finance: [],
        refunds: [],
        issues: [],
        devices: [],
        kitchen: [],
        guests: [],
        audit: [],
        catalog_audit: [],
        documents: [],
        publications: [],
        metrics: {},
        capabilities: {},
      };
    },
    storage(),
    () => {},
  );
  await m.load(actor, branch, 'custom', { startDate: '2026-09-01', endDate: '2026-09-30' });
  await m.load(actor, branch);
  assert.equal(calls[0], calls[1]);
  assert.equal(new URLSearchParams(calls[0].split('?')[1]).get('end_date'), '2026-09-30');
  fail = true;
  await m.load(actor, branch, 'year', {});
  assert.equal(m.data, null, 'old month totals must not appear under the new year filter');
  assert.equal(new URLSearchParams(calls[2].split('?')[1]).has('start_date'), false);
  m.clear();
  assert.deepEqual(m.filters, {});
  assert.equal(m.period, 'day');
});
