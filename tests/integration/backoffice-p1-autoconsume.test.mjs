import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createApi } from '@pickchick/api';
import { Backoffice } from '../../packages/backoffice-core/dist/index.js';
import {
  consumptionDocuments,
  items,
  kitchen,
  linkFixture,
  people,
  posSale,
  publishMenuFixture,
  request as command,
  stockFixture,
} from '../../packages/backoffice-core/tests/consumption-fixture.mjs';
import { request, running, withSyncDatabases } from '../helpers/sync.mjs';

/**
 * Automatic consumption (lane bo-ui step 5, design-bo-ui.md 5.5): the worker process
 * (services/api/dist/stock-consumption-worker.js --once) and the HTTP views and commands. With
 * BACKOFFICE_STOCK_AUTOCONSUME_ENABLED off the worker exits without reading anything, the views
 * are the 404 of an unknown view and the commands are unknown; synthetic data only.
 */
const run = promisify(execFile);
const WORKER = fileURLToPath(
  new URL('../../services/api/dist/stock-consumption-worker.js', import.meta.url),
);
const V2 = { stockV2Enabled: true, rolesEnabled: true };
const ON = { ...V2, stockAutoconsumeEnabled: true };
const ago = (minutes) => new Date(Date.now() - minutes * 60000);
const worker = (c, extra) =>
  run(process.execPath, [WORKER, '--once'], {
    env: {
      PATH: process.env.PATH,
      APP_ENV: 'test',
      CLOUD_DATABASE_URL: c.cloud.config.databaseUrl,
      REDIS_URL: 'redis://127.0.0.1:56379',
      BACKOFFICE_ENABLED: 'true',
      CATALOG_ADMIN_ENABLED: 'true',
      ...extra,
    },
    timeout: 60000,
  });
async function branchWithSale(c) {
  const p = await people(c);
  const bo = new Backoffice(c.cloud.pool, true, ON);
  const { release } = await publishMenuFixture(c);
  const s = await stockFixture(bo, p.manager.token, c);
  await linkFixture(bo, p.manager.token, c, s);
  await bo.command(
    p.manager.token,
    c.branch,
    command({
      type: 'stock_settings',
      autoconsume_mode: 'on',
      start_at: ago(120).toISOString(),
      expected_revision: 0,
    }),
  );
  const sale = await posSale(c, release, { at: ago(10), number: 61, lines: [['fries', 1]] });
  await kitchen(c, sale, 'in_production');
  return { p, s, sale };
}

test('worker process: disabled without the flag, one tick with --once when on', () =>
  withSyncDatabases(async (c) => {
    const { sale } = await branchWithSale(c);
    for (const flags of [
      {},
      { BACKOFFICE_STOCK_V2_ENABLED: 'true' },
      { BACKOFFICE_STOCK_V2_ENABLED: 'true', BACKOFFICE_STOCK_AUTOCONSUME_ENABLED: 'false' },
    ]) {
      const out = await worker(c, flags);
      assert.deepEqual(out.stdout.trim().split('\n').map(JSON.parse), [
        { event: 'stock_consumption', state: 'disabled' },
      ]);
      assert.deepEqual(await items(c), []);
    }
    // loadConfig refuses the autoconsume flag without stock v2: the process fails, writes nothing.
    await assert.rejects(worker(c, { BACKOFFICE_STOCK_AUTOCONSUME_ENABLED: 'true' }));
    assert.deepEqual(await items(c), []);
    const on = {
      BACKOFFICE_STOCK_V2_ENABLED: 'true',
      BACKOFFICE_STOCK_AUTOCONSUME_ENABLED: 'true',
    };
    const first = await worker(c, on);
    const tick = JSON.parse(first.stdout.trim());
    assert.equal(tick.event, 'stock_consumption_tick');
    assert.equal(tick.ready, true);
    assert.equal(tick.enqueued, 1);
    assert.deepEqual(tick.states, { applied: 1 });
    assert.equal(tick.errors, 0);
    // The log carries counts only: no order id, no names.
    assert.equal(first.stdout.includes(sale), false);
    const again = JSON.parse((await worker(c, on)).stdout.trim());
    assert.equal(again.processed, 0);
    assert.deepEqual(
      (await consumptionDocuments(c)).map((d) => d.source_ref),
      [`pos:${sale}`],
    );
  }));

test('HTTP: the views and commands exist only with their flags', () =>
  withSyncDatabases(async (c) => {
    const { p } = await branchWithSale(c);
    const token = p.manager.token;
    const previous = process.env.BACKOFFICE_STOCK_V2_ENABLED;
    const call = async (config, v2, path, body) => {
      if (v2) process.env.BACKOFFICE_STOCK_V2_ENABLED = 'true';
      else delete process.env.BACKOFFICE_STOCK_V2_ENABLED;
      const api = await running(createApi, {
        ...c.cloud.config,
        backofficeEnabled: true,
        catalogAdminEnabled: true,
        ...config,
      });
      try {
        const response = await request(
          `${api.url}/v1/admin/backoffice/branches/${c.branch}${path}`,
          {
            method: body ? 'POST' : 'GET',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}),
          },
        );
        return { status: response.status, body: await response.json() };
      } finally {
        await api.app.close();
      }
    };
    const settings = command({
      type: 'stock_settings',
      autoconsume_mode: 'off',
      start_at: null,
      expected_revision: 1,
    });
    try {
      const bogus = await call({}, false, '/ops/bogus');
      for (const [config, v2] of [
        [{}, false],
        [{}, true],
      ]) {
        const consumption = await call(config, v2, '/ops/consumption');
        assert.equal(consumption.status, 404);
        assert.deepEqual(Object.keys(consumption.body).sort(), Object.keys(bogus.body).sort());
        assert.equal(consumption.body.error, undefined);
        assert.equal((await call(config, v2, '/commands', settings)).status, 400);
        const branch = await call(config, v2, '');
        assert.equal('stock_autoconsume' in branch.body.capabilities, false);
      }
      // Menu links ride stock v2 (stock P1) alone.
      assert.equal((await call({}, false, '/ops/menu-links')).status, 404);
      const links = await call({}, true, '/ops/menu-links');
      assert.equal(links.status, 200);
      assert.equal(links.body.catalog.version, 1);
      const on = { backofficeStockAutoconsumeEnabled: true };
      const view = await call(on, true, '/ops/consumption?state=applied');
      assert.equal(view.status, 200);
      assert.equal(view.body.settings.autoconsume_mode, 'on');
      assert.equal((await call(on, true, '/ops/consumption?state=bogus')).status, 400);
      const branch = await call(on, true, '');
      assert.equal(branch.body.capabilities.stock_autoconsume, true);
      const saved = await call(on, true, '/commands', settings);
      assert.equal(saved.status, 200);
      assert.equal(saved.body.autoconsume_mode, 'off');
      // The same settings at the old revision with a new request id: CONFLICT.
      const stale = await call(on, true, '/commands', { ...settings, request_id: randomUUID() });
      assert.equal(stale.status, 409);
    } finally {
      if (previous === undefined) delete process.env.BACKOFFICE_STOCK_V2_ENABLED;
      else process.env.BACKOFFICE_STOCK_V2_ENABLED = previous;
    }
  }));
