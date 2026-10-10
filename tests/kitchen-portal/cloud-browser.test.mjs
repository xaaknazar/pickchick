import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { setup } from './cloud-fixture.mjs';

// Real renderer + real portal + fake cashier edge + fake cloud API (no PostgreSQL needed):
// both streams, «Касса: нет связи», «Сервер: нет связи», both down.
test(
  'browser: one queue from cashier and server with per-stream status',
  { timeout: 120000 },
  async () => {
    const ctx = await setup();
    for (const mode of ['prep', 'assembly', 'display']) ctx.staff(mode, 'kitchen.synthetic');
    const control = createServer(async (req, res) => {
      if (req.url === '/edge-down') await ctx.edgeDown();
      else if (req.url === '/edge-up') ctx.edgeUp();
      else if (req.url === '/cloud-down') ctx.world.cloudDown = true;
      else if (req.url === '/cloud-up') ctx.world.cloudDown = false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          cloudCommands: ctx.world.cloudCalls.filter((c) => c.path === '/v1/kitchen/commands')
            .length,
          edgeActions: ctx.world.edgeCalls.filter((c) => c.path.includes('/actions')).length,
        }),
      );
    });
    await new Promise((r) => control.listen(0, '127.0.0.1', r));
    const directory = resolve('.local/kitchen-portal-cloud-browser'),
      path = directory + '/fixture.json';
    await mkdir(directory, { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        port: ctx.port,
        control: control.address().port,
        password: ctx.world.password,
        cloudOrder: ctx.world.order.orderId,
        edgeOrder: ctx.world.edgeOrder.orderId,
        output: directory,
      }),
      { mode: 0o600 },
    );
    try {
      const child = spawn(
        process.env.PICKCHICK_BROWSER_PYTHON ?? resolve('.local/design-venv/bin/python'),
        ['tests/kitchen-portal/cloud_browser_ui.py', path],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      child.stdout.on('data', (v) => (output += v));
      child.stderr.on('data', (v) => (output += v));
      const [code] = await once(child, 'exit');
      assert.equal(code, 0, output);
      assert.match(output, /PASS/);
    } finally {
      control.closeAllConnections();
      await new Promise((r) => control.close(r));
      await ctx.close();
      await rm(path, { force: true });
    }
  },
);
