import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { provisionStaff, setStaffPassword } from '@pickchick/local-orders';
import { grantStation } from '@pickchick/edge-fulfillment';
import { createEdge } from '@pickchick/edge';
import { fixture } from '../../packages/edge-fulfillment/tests/fixture.mjs';
import { createPortal } from '../../infra/kitchen-portal/server.mjs';
import { executeJob } from '../../infra/kitchen-portal/agent.mjs';
test(
  'three browser screens share real PG edge, recover lost committed response and show handoff',
  { timeout: 120000 },
  async () => {
    await fixture(async (ctx) => {
      const first = await ctx.accepted(true),
        terminals = {},
        password = 'Synthetic-' + randomUUID();
      await grantStation(ctx.pool, ctx.scope.branchId, ctx.cook.staff_id, ctx.assembly);
      for (const mode of ['prep', 'assembly', 'display']) {
        terminals[mode] = randomUUID();
        await provisionStaff(ctx.pool, ctx.scope.branchId, {
          staff_id: ctx.cook.staff_id,
          terminal_id: terminals[mode],
          name: ctx.cook.name,
          role: 'kitchen',
        });
      }
      await setStaffPassword(
        ctx.pool,
        ctx.scope.branchId,
        ctx.cook.auth,
        'kitchen.synthetic',
        password,
      );
      const edge = await createEdge({
        service: 'edge',
        environment: 'test',
        databaseUrl: ctx.url,
        branchId: ctx.scope.branchId,
        edgeDeviceId: ctx.scope.deviceId,
        edgeFulfillmentEnabled: true,
        port: 0,
      });
      await edge.listen(0, '127.0.0.1');
      const edgePort = Number(new URL(await edge.getUrl()).port);
      const portal = await createPortal({
        origin: 'https://kitchen.example',
        key: 'a'.repeat(64),
        terminals,
        branchLabel: 'Synthetic office',
      });
      await new Promise((r) => portal.server.listen(0, '127.0.0.1', r));
      const stop = new AbortController();
      const worker = async () => {
        while (!stop.signal.aborted) {
          const job = await portal.link.poll(stop.signal);
          if (job) portal.link.reply(await executeJob(job, edgePort));
        }
      };
      const workers = Promise.all([worker(), worker()]);
      const directory = resolve('.local/kitchen-portal-browser'),
        path = directory + '/fixture.json';
      await mkdir(directory, { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          port: portal.server.address().port,
          password,
          orderId: first.order.orderId,
          prep: ctx.prep,
          assembly: ctx.assembly,
          output: directory,
        }),
        { mode: 0o600 },
      );
      try {
        const child = spawn(
          process.env.PICKCHICK_BROWSER_PYTHON ?? resolve('.local/design-venv/bin/python'),
          ['tests/kitchen-portal/browser_ui.py', path],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let output = '';
        child.stdout.on('data', (v) => (output += v));
        child.stderr.on('data', (v) => (output += v));
        const [code] = await once(child, 'exit');
        assert.equal(code, 0, output);
        assert.equal((await ctx.read(first.order.orderId)).state, 'handed_over');
      } finally {
        stop.abort();
        await workers;
        await portal.close();
        await edge.close();
        await rm(path, { force: true });
      }
    });
  },
);
