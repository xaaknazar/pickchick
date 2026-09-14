import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { APP_URL } from '../security.mjs';

const base = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.KITCHEN_TEST_PYTHON ?? 'python3';
function playwrightPath() {
  if (process.env.KITCHEN_TEST_PLAYWRIGHT) return process.env.KITCHEN_TEST_PLAYWRIGHT;
  const result = spawnSync(
    python,
    [
      '-c',
      'from pathlib import Path; import playwright; print(Path(playwright.__file__).parent / "driver/package/index.mjs")',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(
    result.status,
    0,
    'Set KITCHEN_TEST_PYTHON to the existing Python Playwright interpreter',
  );
  return result.stdout.trim();
}
const { _electron } = await import(pathToFileURL(playwrightPath()).href);
const runtime =
  process.env.KITCHEN_ELECTRON_PATH ??
  join(
    base,
    'node_modules/electron/dist',
    process.platform === 'darwin'
      ? 'Electron.app/Contents/MacOS/Electron'
      : process.platform === 'win32'
        ? 'electron.exe'
        : 'electron',
  );
const closeServer = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
const visible = (page, selector) => page.locator(selector).waitFor({ state: 'visible' });
const keyFor = (c) => `pickchick.kitchen.pending.v1.${c.branch_id}.${c.staff_id}.${c.terminal_id}`;
async function eventually(read, expected) {
  const deadline = Date.now() + 10000;
  do {
    const result = await read();
    if (expected(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error('Expected local fixture state was not reached');
}
async function login(page, credential) {
  await visible(page, '#credential');
  await page.locator('#credential').setInputFiles({
    name: 'synthetic-kitchen.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(credential)),
  });
}
async function station(page, id) {
  const button = page.locator(`button[data-station="${id}"]`);
  if (await button.count()) await button.click();
  else await page.locator('#station').selectOption(id);
}

// This tests the real Electron wrapper and unchanged kitchen renderer against a
// synthetic HTTP boundary. It does not claim PostgreSQL/production acceptance.
test(
  'Electron preserves unknown commands across restart, scopes recovery and blocks external surfaces',
  { timeout: 120000 },
  async () => {
    const output = join(base, '.local/electron-smoke');
    await mkdir(output, { recursive: true });
    const temporary = await mkdtemp(join(output, 'run-'));
    const profile = join(temporary, 'profile');
    await mkdir(profile);
    const prep = randomUUID(),
      assembly = randomUUID();
    const credential = {
      session_id: randomUUID(),
      staff_id: randomUUID(),
      terminal_id: randomUUID(),
      branch_id: randomUUID(),
      role: 'kitchen',
      token: 'a'.repeat(64),
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    };
    const other = {
      ...credential,
      session_id: randomUUID(),
      staff_id: randomUUID(),
      token: 'b'.repeat(64),
    };
    const now = new Date().toISOString();
    const order = {
      orderId: randomUUID(),
      branchId: credential.branch_id,
      version: 1,
      state: 'accepted',
      displayNumber: '148',
      routingVersion: 1,
      createdAt: now,
      updatedAt: now,
      assemblyStationId: assembly,
      channel: 'mobile',
      serviceMode: 'takeaway',
      tasks: [
        {
          taskId: randomUUID(),
          stationId: prep,
          version: 1,
          state: 'queued',
          kind: 'prep',
          details: {
            lineId: randomUUID(),
            productId: 'synthetic-burger',
            title: 'Тестовый бургер',
            parentTitle: '',
            description: '',
            quantity: 1,
            modifiers: [],
          },
        },
      ],
    };
    const requests = [],
      posts = [],
      errors = [];
    let app,
      page,
      savedPending,
      escaped = 0,
      effects = 0;
    const edge = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        requests.push(url.pathname);
        res.setHeader('Content-Type', 'application/json');
        if (url.pathname === '/edge/v1/fulfillment/config') {
          res.end('{"enabled":true}');
          return;
        }
        const actor = [credential, other].find(
          (c) =>
            req.headers.authorization === 'Bearer ' + c.token &&
            req.headers['x-staff-session-id'] === c.session_id &&
            req.headers['x-terminal-id'] === c.terminal_id,
        );
        if (!actor) {
          res.writeHead(401).end(
            JSON.stringify({
              code: 'UNAUTHORIZED',
              message_key: 'auth.required',
              retryable: false,
              trace_id: randomUUID(),
            }),
          );
          return;
        }
        if (url.pathname.endsWith('/stations')) {
          res.end(
            JSON.stringify({
              branchId: actor.branch_id,
              items: [
                { id: prep, kind: 'prep', name: 'Фритюр' },
                { id: assembly, kind: 'assembly', name: 'Сборка' },
              ],
            }),
          );
          return;
        }
        if (url.pathname.endsWith('/kitchen')) {
          res.end(JSON.stringify({ items: [order], nextAfterOrderId: null }));
          return;
        }
        if (url.pathname.endsWith('/display')) {
          res.end(
            JSON.stringify({
              items: [{ number: '148', state: 'preparing' }],
              nextAfterNumber: null,
            }),
          );
          return;
        }
        if (
          req.method === 'POST' &&
          url.pathname === `/edge/v1/fulfillment/orders/${order.orderId}/actions`
        ) {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = Buffer.concat(chunks).toString('utf8');
          const key = req.headers['idempotency-key'];
          const pending = await page.evaluate(
            (key) => globalThis.localStorage.getItem(key),
            keyFor(actor),
          );
          assert.ok(pending, 'Journal must exist before the upstream receives a command');
          assert.equal(JSON.parse(pending).key, key);
          assert.deepEqual(JSON.parse(pending).body, JSON.parse(body));
          posts.push({ key, body });
          if (posts.length === 1) {
            savedPending = pending;
            effects++;
            order.state = 'in_production';
            order.version++;
            order.tasks[0].state = 'in_progress';
            order.tasks[0].version++;
            res.destroy();
            return;
          }
          assert.deepEqual(
            posts[1],
            posts[0],
            'Recovery must keep the exact command and idempotency key',
          );
          res.end(JSON.stringify(order));
          return;
        }
        res.writeHead(404).end('{}');
      } catch {
        errors.push('Synthetic boundary assertion failed');
        if (!res.destroyed) res.writeHead(500).end('{}');
      }
    });
    const trap = createServer((_req, res) => {
      escaped++;
      res.end('UNTRUSTED_FIXTURE');
    });
    trap.on('upgrade', (_req, socket) => {
      escaped++;
      socket.destroy();
    });
    await listen(edge);
    await listen(trap);
    const edgeURL = `http://127.0.0.1:${edge.address().port}`;
    const trapURL = `http://127.0.0.1:${trap.address().port}/untrusted`;
    const env = { ...process.env, PICKCHICK_KITCHEN_TEST_USER_DATA: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    await writeFile(
      join(profile, 'config.json'),
      JSON.stringify({
        edgePort: edge.address().port,
        branchLabel: 'Synthetic wrapper acceptance',
      }),
    );
    const launch = async () => {
      app = await _electron.launch({
        executablePath: runtime,
        args: [join(base, 'main.mjs')],
        env,
        timeout: 30000,
      });
      page = await app.firstWindow();
      page.on('pageerror', () => errors.push('Renderer exception'));
      await page.waitForURL(APP_URL);
      await visible(page, '#credential');
    };
    let stage = 'launch';
    try {
      await launch();
      stage = 'secure renderer';
      assert.deepEqual(
        await page.evaluate(() => ({
          secure: globalThis.isSecureContext,
          locks: typeof globalThis.navigator.locks?.request,
          require: typeof globalThis.require,
          process: typeof globalThis.process,
        })),
        { secure: true, locks: 'function', require: 'undefined', process: 'undefined' },
      );
      const preferences = await app.evaluate(({ BrowserWindow }) => {
        const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
        return {
          sandbox: p.sandbox,
          contextIsolation: p.contextIsolation,
          nodeIntegration: p.nodeIntegration,
          webSecurity: p.webSecurity,
          webviewTag: p.webviewTag,
        };
      });
      assert.deepEqual(preferences, {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
      });
      stage = 'credential gate';
      await login(page, { ...credential, token: '0'.repeat(64) });
      await visible(page, '[role="alert"]');
      assert.equal(await page.locator('[data-command]').count(), 0);
      await login(page, credential);
      await visible(page, `#task-${order.tasks[0].taskId}`);
      stage = 'stations and display';
      await station(page, assembly);
      await eventually(
        () => page.locator('h1').textContent(),
        (value) => value.includes('Сборка'),
      );
      await page.locator('#mode-display').click();
      await visible(page, '[data-testid="display"]');
      await page.locator('#mode-kitchen').click();
      await station(page, prep);
      await visible(page, `#task-${order.tasks[0].taskId}`);
      stage = 'blocked network and navigation';
      assert.deepEqual(
        await page.evaluate(
          async ({ trapURL, edgeURL }) => {
            const results = [];
            for (const url of [
              trapURL,
              edgeURL + '/edge/v1/fulfillment/config',
              'file:///etc/passwd',
              '/edge/v1/staff/sessions',
            ]) {
              try {
                await fetch(url);
                results.push('allowed');
              } catch {
                results.push('blocked');
              }
            }
            globalThis.window.open(trapURL);
            return results;
          },
          { trapURL, edgeURL },
        ),
        ['blocked', 'blocked', 'blocked', 'blocked'],
      );
      stage = 'lost response';
      await page.locator(`#task-${order.tasks[0].taskId}`).click();
      await visible(page, '.recovery');
      await eventually(
        () => posts.length,
        (count) => count === 1,
      );
      assert.ok(savedPending);
      assert.ok(await page.locator('#mode-display').isDisabled());
      await page.screenshot({ path: join(output, 'unknown-command.png'), fullPage: true });
      await app.close();
      app = null;
      stage = 'restart and actor scope';
      await launch();
      assert.equal(
        await page.evaluate((key) => globalThis.localStorage.getItem(key), keyFor(credential)),
        savedPending,
      );
      await login(page, other);
      await visible(page, `#task-${order.tasks[0].taskId}`);
      assert.equal(await page.locator('.recovery').count(), 0);
      assert.equal(posts.length, 1);
      await page.locator('#logout').click();
      await login(page, credential);
      await visible(page, '.recovery');
      assert.ok(await page.locator('#mode-kitchen').isDisabled());
      stage = 'same command retry';
      await page.locator('#retry').click();
      await page.locator('.recovery').waitFor({ state: 'detached' });
      assert.equal(posts.length, 2);
      assert.deepEqual(posts[1], posts[0]);
      assert.equal(effects, 1);
      assert.equal(
        await page.evaluate((key) => globalThis.localStorage.getItem(key), keyFor(credential)),
        null,
      );
      assert.equal(order.version, 2);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: join(output, 'recovered-kitchen.png'), fullPage: true });
      stage = 'blocked external navigation';
      await page.evaluate((url) => {
        globalThis.window.location.href = url;
      }, trapURL);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(page.url(), APP_URL);
      assert.equal(escaped, 0);
      assert.equal((await app.windows()).length, 1);
      await writeFile(
        join(output, 'verification.json'),
        JSON.stringify(
          {
            runtime: 'Electron 44.2.0',
            platform: process.platform,
            source: 'apps/kitchen/src',
            origin: APP_URL,
            secureContext: true,
            webLocks: true,
            sandbox: true,
            contextIsolation: true,
            externalRequests: escaped,
            unknownCommandSurvivesOrderlyRestart: true,
            crossActorRecoveryDenied: true,
            exactReplay: true,
            httpAttempts: posts.length,
            syntheticEffects: effects,
            windowsExecutionTested: false,
            physicalPowerLossTested: false,
            databaseIntegrationTested: false,
          },
          null,
          2,
        ) + '\n',
      );
    } catch (error) {
      throw new Error(`Electron acceptance failed at ${stage}: ${error.message}`, { cause: error });
    } finally {
      if (app) await app.close();
      await closeServer(edge);
      await closeServer(trap);
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
