/**
 * A kitchen monoblock is a touch screen without a keyboard. This is the whole first evening of
 * such a screen against a real disposable PostgreSQL, the point server with device access on
 * and the kitchen gateway: the one-time code from «Устройства», the shared `kitchen` login and
 * its password are typed on the page's own keyboard, the half-typed password outlives the
 * pairing check that runs every 15 seconds, and the paired screen signs in. Never calls cloud.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setStaffPassword, TerminalAccess, terminalHash } from '@pickchick/local-orders';
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
// Upper and lower case, digits, a key of the bottom row and two of the symbols layout.
const password = 'Kitchen-Test_2026!';

for (const [width, height, mode] of [
  [1280, 800, 'journey'],
  [1024, 768, 'fit'],
  [1920, 1080, 'fit'],
])
  test(
    `paired kitchen screen by touch alone, ${mode} ${width}×${height}`,
    { timeout: 240000 },
    async () => {
      await fixture(async (ctx) => {
        const before = process.env.EDGE_DEVICE_ACCESS_ENABLED;
        process.env.EDGE_DEVICE_ACCESS_ENABLED = 'true';
        await setStaffPassword(ctx.pool, ctx.scope.branchId, ctx.cook.auth, 'kitchen', password);
        // What the back office does in «Устройства» → «Подключить экран»: a one-time code.
        const code = randomBytes(16).toString('hex'),
          issuedAt = new Date(),
          terminalId = randomUUID();
        assert.equal(
          await new TerminalAccess(ctx.pool, ctx.scope.branchId, ctx.scope.deviceId).receive({
            commandId: randomUUID(),
            branchId: ctx.scope.branchId,
            edgeDeviceId: ctx.scope.deviceId,
            terminalId,
            mode: 'prep',
            name: 'Synthetic prep screen',
            generation: 1,
            action: 'pair',
            codeHash: terminalHash(code),
            issuedAt: issuedAt.toISOString(),
            expiresAt: new Date(issuedAt.getTime() + 600000).toISOString(),
          }),
          'applied',
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
        let gateway, unlinked;
        const fixturePath = resolve(output, `fixture-keyboard-${width}-${mode}.json`);
        await mkdir(output, { recursive: true });
        try {
          await app.listen(0, '127.0.0.1');
          gateway = createKitchenServer({
            edgePort: Number(new URL(await app.getUrl()).port),
            terminalAccess: { key: randomBytes(32).toString('hex'), mode: 'prep', secure: false },
            branchLabel: 'Алматы · проверка экранной клавиатуры',
            assetDir: new URL('../../apps/kitchen/dist/', import.meta.url),
          });
          gateway.listen(0, '127.0.0.1');
          await once(gateway, 'listening');
          // A monoblock where the program is installed and nothing else was set up yet.
          unlinked = createKitchenServer({
            edgePort: Number(new URL(await app.getUrl()).port),
            assetDir: new URL('../../apps/kitchen/dist/', import.meta.url),
          });
          unlinked.listen(0, '127.0.0.1');
          await once(unlinked, 'listening');
          await writeFile(
            fixturePath,
            JSON.stringify({
              url: `http://127.0.0.1:${gateway.address().port}`,
              unlinked: `http://127.0.0.1:${unlinked.address().port}`,
              output,
              width,
              height,
              mode,
              // As the back office shows it: eight groups of four.
              code: code.match(/.{4}/g).join('-'),
              password,
              prep: ctx.prep,
            }),
            { mode: 0o600 },
          );
          const child = spawn(
            python,
            [resolve(repo, 'tests/kitchen/screen_keyboard.py'), fixturePath],
            { stdio: ['ignore', 'pipe', 'pipe'] },
          );
          let stdout = '',
            stderr = '';
          child.stdout.on('data', (b) => (stdout += b));
          child.stderr.on('data', (b) => (stderr += b));
          const [exit] = await once(child, 'exit');
          assert.equal(exit, 0, `${stdout}\n${stderr}`);
          // The screen was paired once, by the typed code, and the cook's session is on it.
          const registry = await ctx.pool.query(
            'SELECT terminal_id, mode, code_hash FROM terminal_access_registry',
          );
          assert.equal(registry.rows.length, 1);
          assert.equal(registry.rows[0].terminal_id, terminalId);
          assert.equal(registry.rows[0].mode, 'prep');
          assert.equal(registry.rows[0].code_hash, null, 'the code is spent');
          const sessions = await ctx.pool.query(
            'SELECT count(*)::int AS n FROM staff_sessions WHERE terminal_id=$1 AND staff_id=$2',
            [terminalId, ctx.cook.staff_id],
          );
          assert.ok(sessions.rows[0].n >= 1, 'password sign-in on the paired screen');
          assert.equal(await ctx.count('fulfillment_commands'), 0);
        } finally {
          await rm(fixturePath, { force: true });
          for (const server of [gateway, unlinked])
            if (server) {
              server.closeAllConnections();
              await new Promise((r) => server.close(r));
            }
          await app.close();
          if (before === undefined) delete process.env.EDGE_DEVICE_ACCESS_ENABLED;
          else process.env.EDGE_DEVICE_ACCESS_ENABLED = before;
        }
      });
    },
  );
