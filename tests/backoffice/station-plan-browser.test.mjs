// Stage 2 lane cfg: station plan delivery state and kitchen station binding in a real browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  applyStationPlan,
  provisionDevice,
  stationPlanReport,
} from '../../packages/menu-sync/dist/index.js';
import {
  pullStationPlan,
  recordStationPlanReceipt,
} from '../../packages/backoffice-core/dist/index.js';
import { withCatalog } from './helpers.mjs';

test('station plans page: edge-confirmed version, rejection reason, binding and resend', () =>
  withCatalog(
    async (c) => {
      const prep = randomUUID(),
        assembly = randomUUID();
      for (const [id, kind, name] of [
        [prep, 'prep', 'Фритюр'],
        [assembly, 'assembly', 'Сборка'],
      ])
        await c.edge.pool.query(
          'INSERT INTO fulfillment_stations(branch_id,id,kind,name) VALUES($1,$2,$3,$4)',
          [c.branch, id, kind, name],
        );
      const identity = await provisionDevice(c.cloud.pool, c.device);
      const auth = { deviceId: identity.device_id, token: identity.token };
      const command = (value) =>
        c.backoffice.command(c.manager.token, c.branch, {
          request_id: randomUUID(),
          reason: 'Синтетический план станций',
          command: value,
        });
      const station = async (id, payload) => {
        await command({ type: 'save', kind: 'station', id, expected_revision: 0, payload });
        await command({ type: 'publish', kind: 'station', id, expected_revision: 1 });
        const { delivery } = await pullStationPlan(
          c.cloud.pool,
          auth,
          await stationPlanReport(c.edge.pool, c.branch),
        );
        await recordStationPlanReceipt(
          c.cloud.pool,
          auth,
          await applyStationPlan(c.edge.pool, c.branch, delivery),
        );
      };
      const base = { device_id: null, active: true, product_ids: [], target_seconds: 180 };
      await station(randomUUID(), { ...base, name: 'Фритюр', role: 'prep', edge_station_id: prep });
      const drinks = randomUUID();
      await station(drinks, {
        ...base,
        name: 'Напитки',
        role: 'prep',
        edge_station_id: randomUUID(),
      });
      // The next pull reports the edge state again (active version 1).
      await pullStationPlan(c.cloud.pool, auth, {
        ...(await stationPlanReport(c.edge.pool, c.branch)),
        report_only: true,
      });
      const output = new URL('../../.local/backoffice-station-plans/', import.meta.url);
      await mkdir(output, { recursive: true, mode: 0o700 });
      const temp = await mkdtemp(fileURLToPath(new URL('run-', output)));
      const fixture = temp + '/fixture.json';
      try {
        await writeFile(
          fixture,
          JSON.stringify({
            url: c.url + '/backoffice/',
            manager: c.manager,
            branch: c.branch,
            drinks,
            output: fileURLToPath(output),
          }),
          { mode: 0o600 },
        );
        const exit = await new Promise((resolve, reject) => {
          const child = spawn(
            process.env.BACKOFFICE_TEST_PYTHON ?? 'python3',
            [fileURLToPath(new URL('station_plan_ui.py', import.meta.url)), fixture],
            { stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform !== 'win32' },
          );
          const timer = setTimeout(() => {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              child.kill('SIGKILL');
            }
          }, 120000);
          child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once('exit', (code, signal) => {
            clearTimeout(timer);
            resolve(signal ? signal : code);
          });
        });
        assert.equal(exit, 0, 'Station plan browser flow must pass');
        const plans = (
          await c.cloud.pool.query(
            'SELECT version,publication_id IS NULL AS resend FROM bo_station_plans ORDER BY version',
          )
        ).rows;
        assert.deepEqual(plans, [
          { version: 1, resend: false },
          { version: 2, resend: false },
          { version: 3, resend: true },
        ]);
        const latest = (
          await c.cloud.pool.query('SELECT payload FROM bo_station_plans WHERE version=3')
        ).rows[0].payload;
        const bound = latest.stations.find((s) => s.id === drinks);
        // Saved but not published: the resent plan still carries the published revision.
        assert.equal(bound.revision, 1);
        const record = (
          await c.cloud.pool.query('SELECT payload FROM bo_records WHERE id=$1', [drinks])
        ).rows[0].payload;
        assert.equal(record.edge_station_id, assembly);
        assert.equal(record.role, 'assembly');
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },
    { staticPrefix: '/backoffice', stationPlans: true },
  ));
