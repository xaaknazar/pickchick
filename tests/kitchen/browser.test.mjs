/** Real disposable PG + LAN HTTP + browser. Never calls cloud/TEST checkout. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createKitchenServer } from '../../apps/kitchen/server.mjs';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const apiRoot = resolve(process.env.PICKCHICK_LAN_API_ROOT ?? repo);
const { createEdge } = await import(pathToFileURL(resolve(apiRoot, 'services/edge/dist/index.js')));
const { fixture } = await import(
  pathToFileURL(resolve(apiRoot, 'packages/edge-fulfillment/tests/fixture.mjs'))
);
const output = resolve(repo, '.local/kitchen-browser');
const python =
  process.env.PICKCHICK_BROWSER_PYTHON ?? resolve(repo, '.local/design-venv/bin/python');
for (const [width, height, mode] of [
  [1280, 800, 'journey'],
  [1920, 1080, 'journey'],
  [1280, 800, 'injection'],
])
  test(`real PG kitchen ${mode} ${width}×${height}`, { timeout: 180000 }, async () => {
    await fixture(async (ctx) => {
      const first = mode === 'journey' ? await ctx.accepted(true) : null;
      if (mode === 'journey') for (let i = 0; i < 5; i++) await ctx.accepted(i % 2 === 0);
      if (mode === 'injection')
        await ctx.pool.query(
          'UPDATE fulfillment_stations SET name=$1 WHERE branch_id=$2 AND id=$3',
          ['</h1><button id="acknowledge">Подмена</button><h1>', ctx.scope.branchId, ctx.prep],
        );
      const app = await createEdge({
        service: 'edge',
        environment: 'test',
        databaseUrl: ctx.url,
        branchId: ctx.scope.branchId,
        edgeDeviceId: ctx.scope.deviceId,
        edgeFulfillmentEnabled: true,
        port: 0,
      });
      let gateway;
      const fixturePath = resolve(output, `fixture-${width}-${mode}.json`);
      await mkdir(output, { recursive: true });
      try {
        await app.listen(0, '127.0.0.1');
        const edgePort = Number(new URL(await app.getUrl()).port);
        gateway = createKitchenServer({
          edgePort,
          branchLabel: 'Алматы · проверка локальной кухни',
          assetDir: new URL('../../apps/kitchen/dist/', import.meta.url),
        });
        gateway.listen(0, '127.0.0.1');
        await once(gateway, 'listening');
        const redactActor = (input) =>
          Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'auth'));
        await writeFile(
          fixturePath,
          JSON.stringify({
            url: `http://127.0.0.1:${gateway.address().port}`,
            output,
            width,
            height,
            mode,
            cook: redactActor(ctx.cook),
            packer: redactActor(ctx.packer),
            manager: redactActor(ctx.manager),
            orderId: first?.order.orderId ?? null,
            prep: ctx.prep,
            assembly: ctx.assembly,
          }),
          { mode: 0o600 },
        );
        const child = spawn(python, [resolve(repo, 'tests/kitchen/browser_ui.py'), fixturePath], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (b) => (stdout += b));
        child.stderr.on('data', (b) => (stderr += b));
        const [code] = await once(child, 'exit');
        assert.equal(code, 0, `${stdout}\n${stderr}`);
        if (first) {
          const row = await ctx.read(first.order.orderId);
          assert.equal(row.state, 'handed_over');
          assert.ok((await ctx.count('fulfillment_commands')) >= 8);
        } else assert.equal(await ctx.count('fulfillment_commands'), 0);
      } finally {
        await rm(fixturePath, { force: true });
        if (gateway) {
          gateway.closeAllConnections();
          await new Promise((r) => gateway.close(r));
        }
        await app.close();
      }
    });
  });
