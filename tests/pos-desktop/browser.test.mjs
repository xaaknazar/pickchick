import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createEdge } from '@pickchick/edge';
import { randomUUID } from 'node:crypto';
import { provisionFulfillment } from '@pickchick/edge-fulfillment';
import { setStaffPin } from '@pickchick/local-orders';
import { withOrderDesk } from '../helpers/orders.mjs';
import { running } from '../helpers/sync.mjs';
import { desktopFile, eventually } from './support.mjs';

// Reuse the repository's pinned Python Playwright installation instead of
// adding a second browser dependency to the shared workspace node_modules.
const python = process.env.POS_TEST_PYTHON ?? 'python3';
function playwrightModule() {
  if (process.env.POS_DESKTOP_PLAYWRIGHT) return process.env.POS_DESKTOP_PLAYWRIGHT;
  const result = spawnSync(
    python,
    [
      '-c',
      'from pathlib import Path; import playwright; print(Path(playwright.__file__).parent / "driver/package/index.mjs")',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, 'Install pinned Python Playwright or set POS_DESKTOP_PLAYWRIGHT');
  return result.stdout.trim();
}
const { _electron } = await import(pathToFileURL(playwrightModule()).href);
const runtime =
  process.env.POS_ELECTRON_PATH ??
  desktopFile(
    process.platform === 'darwin'
      ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
      : process.platform === 'win32'
        ? 'node_modules/electron/dist/electron.exe'
        : 'node_modules/electron/dist/electron',
  );

const button = (page, name) => page.getByRole('button', { name, exact: true });
async function pinLogin(page, pin = '1357') {
  for (const digit of pin) await button(page, digit).click();
}
async function addItems(page) {
  await button(page, 'ДОПЫ').click();
  const cards = page.locator('.catalog-pane [role="button"]').filter({ hasText: '3 490 ₸' });
  await cards.first().click();
  await cards.first().click();
}
async function quote(page, price) {
  await button(page, 'НА КУХНЮ · ' + price).click();
  await button(page, 'ПЕРЕДАТЬ БЕЗ ОПЛАТЫ').waitFor();
}
function environment(profile) {
  const env = { ...process.env, PICKCHICK_POS_TEST_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

test(
  'Electron survives a lost committed create and restart using only local edge and durable order state',
  { timeout: 180000 },
  async () => {
    for (const name of ['CLOUD_DATABASE_URL', 'EDGE_DATABASE_URL'])
      assert.ok(
        ['127.0.0.1', 'localhost'].includes(new URL(process.env[name]).hostname),
        'Desktop integration tests require local temporary PostgreSQL schemas',
      );
    await withOrderDesk(async (ctx) => {
      let edge, proxy, trap, temporary;
      const requests = [],
        creates = [],
        errors = [];
      let dropCreate = true,
        escaped = 0,
        app = null;
      try {
        const prep = randomUUID(),
          assembly = randomUUID();
        await provisionFulfillment(ctx.edge.pool, {
          branchId: ctx.branch,
          organizationId: ctx.org,
          deviceId: ctx.device,
          producerId: randomUUID(),
          stations: [
            { id: prep, kind: 'prep', name: 'Кухня' },
            { id: assembly, kind: 'assembly', name: 'Сборка' },
          ],
          routing: {
            version: 1,
            assemblyStationId: assembly,
            routes: ctx.release.items.map((i) => ({
              productId: i.product_id,
              stationId: prep,
              kind: 'prep',
            })),
          },
        });
        await ctx.edge.pool.query("UPDATE branch_config SET pos_service_mode='unpaid_service'");
        await setStaffPin(
          ctx.edge.pool,
          ctx.branch,
          { sessionId: ctx.cashier.session_id, token: ctx.cashier.token },
          '1357',
        );
        edge = await running(createEdge, {
          ...ctx.edge.config,
          edgeFulfillmentEnabled: true,
          edgeDeviceId: ctx.device,
        });
        const output = fileURLToPath(new URL('../../.local/pos-desktop-browser/', import.meta.url));
        await mkdir(output, { recursive: true, mode: 0o700 });
        temporary = await mkdtemp(join(output, 'run-'));
        const profile = join(temporary, 'profile');
        await mkdir(profile, { mode: 0o700 });

        // This proxy always forwards to the real fixture edge. Its only fault is
        // closing the first create response after edge has returned committed 201.
        proxy = createServer(async (req, res) => {
          const path = req.url ?? '';
          if (!path.startsWith('/edge/v1/')) {
            res.writeHead(404).end();
            return;
          }
          requests.push({ method: req.method, path });
          try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
            const headers = {};
            for (const name of [
              'authorization',
              'x-staff-session-id',
              'idempotency-key',
              'content-type',
            ])
              if (req.headers[name]) headers[name] = req.headers[name];
            const response = await fetch(edge.url + path, {
              method: req.method,
              headers,
              ...(body === undefined ? {} : { body }),
              redirect: 'error',
              signal: AbortSignal.timeout(10000),
            });
            const content = await response.text();
            if (req.method === 'POST' && path === '/edge/v1/orders') {
              creates.push({ key: req.headers['idempotency-key'], body, status: response.status });
              assert.equal(
                response.status,
                201,
                'The real edge must commit or idempotently replay the create',
              );
              if (dropCreate) {
                dropCreate = false;
                res.destroy();
                return;
              }
            }
            res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(content);
          } catch {
            errors.push('Local proxy did not receive the expected edge response');
            if (!res.destroyed) res.writeHead(502).end('{}');
          }
        });
        await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
        trap = createServer((_req, res) => {
          escaped++;
          res.end('UNTRUSTED_FIXTURE');
        });
        trap.on('upgrade', (_req, socket) => {
          escaped++;
          socket.destroy();
        });
        await new Promise((resolve) => trap.listen(0, '127.0.0.1', resolve));
        const trapURL = `http://127.0.0.1:${trap.address().port}/untrusted`;
        await writeFile(
          join(profile, 'config.json'),
          JSON.stringify({
            edgePort: proxy.address().port,
            branchLabel: 'Synthetic Electron acceptance',
            categories: {},
            terminalId: ctx.cashier.terminal_id,
          }),
          { mode: 0o600 },
        );
        let stage = 'launch';
        const launch = async () => {
          app = await _electron.launch({
            executablePath: runtime,
            args: [desktopFile('main.mjs')],
            env: environment(profile),
            timeout: 30000,
          });
          const page = await app.firstWindow();
          page.on('pageerror', () => errors.push('Renderer exception'));
          await page.waitForURL('pickchick-pos://app/');
          await page.locator('#app > *').first().waitFor();
          return page;
        };
        try {
          let page = await launch();
          await pinLogin(page, '9999');
          await page
            .getByText('Неверный PIN или рабочее место недоступно', { exact: true })
            .first()
            .waitFor();
          stage = 'secure renderer and single instance';
          const preferences = await app.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows()[0];
            const p = window.webContents.getLastWebPreferences();
            return {
              sandbox: p.sandbox,
              contextIsolation: p.contextIsolation,
              nodeIntegration: p.nodeIntegration,
              webSecurity: p.webSecurity,
              webviewTag: p.webviewTag,
            };
          });
          assert.equal(preferences.sandbox, true);
          assert.equal(preferences.contextIsolation, true);
          assert.equal(preferences.nodeIntegration, false);
          assert.equal(preferences.webSecurity, true);
          assert.equal(preferences.webviewTag, false);
          stage = 'isolated renderer globals';
          assert.deepEqual(
            await page.evaluate(() => ({
              secure: globalThis.isSecureContext,
              require: typeof globalThis.require,
              process: typeof globalThis.process,
              ipc: typeof globalThis.ipcRenderer,
              locks: typeof globalThis.navigator.locks?.request,
            })),
            {
              secure: true,
              require: 'undefined',
              process: 'undefined',
              ipc: 'undefined',
              locks: 'function',
            },
          );
          const journalKey = `pickchick.pos.journal.v1.${ctx.cashier.branch_id}.${ctx.cashier.staff_id}.${ctx.cashier.terminal_id}`;
          stage = 'narrow native journal interface';
          assert.deepEqual(
            await page.evaluate(() => Object.keys(globalThis.pickchickPosJournal).sort()),
            ['endSession', 'getItem', 'setItem'],
          );
          stage = 'native fullscreen controls';
          assert.deepEqual(
            await page.evaluate(() => Object.keys(globalThis.pickchickPosWindow).sort()),
            ['isFullscreen', 'onChange', 'toggleFullscreen'],
          );
          await app.evaluate(({ app, BrowserWindow }) => {
            app.focus({ steal: true });
            const w = BrowserWindow.getAllWindows()[0];
            w.show();
            w.focus();
          });
          stage = 'native fullscreen enter';
          const nativeState = await app.evaluate(({ BrowserWindow }) => {
            const w = BrowserWindow.getAllWindows()[0];
            return {
              fullscreenable: w.isFullScreenable(),
              visible: w.isVisible(),
              focused: w.isFocused(),
              minimized: w.isMinimized(),
              fullscreen: w.isFullScreen(),
            };
          });
          assert.equal(nativeState.fullscreenable, true);
          // macOS may still be animating a Space change after reporting focus.
          if (process.platform === 'darwin')
            await new Promise((resolve) => setTimeout(resolve, 1500));
          const initialFullscreen = await page.evaluate(() =>
            globalThis.pickchickPosWindow.isFullscreen(),
          );
          assert.equal(
            await page.evaluate(() => globalThis.pickchickPosWindow.toggleFullscreen()),
            !initialFullscreen,
          );
          await eventually(
            () =>
              app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()),
            (value) => value === !initialFullscreen,
            'Native fullscreen request must change the actual window',
          );
          stage = 'native fullscreen leave';
          await page.evaluate(() => globalThis.pickchickPosWindow.toggleFullscreen());
          await eventually(
            () =>
              app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()),
            (value) => value === initialFullscreen,
            'Fullscreen must be reversible',
          );
          assert.equal(
            await page.evaluate((key) => {
              try {
                globalThis.pickchickPosJournal.getItem(key);
                return false;
              } catch {
                return true;
              }
            }, journalKey),
            true,
            'Native journal requires a server-confirmed session',
          );
          stage = 'second instance';
          const second = spawn(runtime, [desktopFile('main.mjs')], {
            env: environment(profile),
            stdio: 'ignore',
          });
          try {
            await eventually(
              () => second.exitCode,
              (code) => code !== null,
              'A second Electron instance must exit without taking the journal',
              10000,
            );
            assert.equal(second.exitCode, 0);
            assert.equal(
              await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
              1,
            );
          } finally {
            if (second.exitCode === null) second.kill();
          }

          stage = 'external fetch denied';
          assert.equal(
            await page.evaluate(async (url) => {
              try {
                await fetch(url);
                return true;
              } catch {
                return false;
              }
            }, trapURL),
            false,
          );
          stage = 'popup denied';
          assert.equal(await page.evaluate((url) => globalThis.open(url) === null, trapURL), true);
          stage = 'packaged resource whitelist';
          const localAssets = await page.evaluate(async () => {
            let privateBlocked;
            try {
              privateBlocked = (await fetch('/main.mjs')).status >= 400;
            } catch {
              privateBlocked = true;
            }
            return {
              styles: (await fetch('/styles.css')).status,
              photo: (await fetch('/assets/menu/i0.jpg')).status,
              privateBlocked,
            };
          });
          assert.equal(localAssets.styles, 200);
          assert.equal(localAssets.photo, 200);
          assert.equal(localAssets.privateBlocked, true);

          stage = 'valid real staff authentication';
          await pinLogin(page);
          await button(page, 'ДОПЫ').waitFor();
          assert.equal(
            await page.evaluate((key) => {
              const store = globalThis.pickchickPosJournal;
              const original = store.getItem(key);
              const mutations = [
                ['../../config.json', '{}'],
                [key.replace(/\.[^.]+$/, '.10000000-0000-4000-8000-000000000003'), '{}'],
                [key, '{'],
                [key, 'я'.repeat(60000)],
              ];
              const denied = mutations.every(([candidate, raw]) => {
                try {
                  store.setItem(candidate, raw);
                  return false;
                } catch {
                  return true;
                }
              });
              return denied && store.getItem(key) === original;
            }, journalKey),
            true,
            'Narrow bridge rejects foreign scopes and invalid data without altering the journal',
          );
          stage = 'add and quote';
          await addItems(page);
          await quote(page, '6 980 ₸');
          stage = 'real commit followed by lost response';
          await button(page, 'ПЕРЕДАТЬ БЕЗ ОПЛАТЫ').click();
          await button(page, 'Проверить результат').waitFor();
          await eventually(
            () => creates.length,
            (v) => v === 1,
            'Expected committed create',
          );
          const before = (
            await ctx.edge.pool.query(
              'SELECT id,state,payment_state,fiscal_state,fulfillment_state FROM local_orders',
            )
          ).rows;
          assert.equal(before.length, 1);
          assert.deepEqual(
            { ...before[0], id: undefined },
            {
              id: undefined,
              state: 'awaiting_payment',
              payment_state: 'not_started',
              fiscal_state: 'not_requested',
              fulfillment_state: 'blocked',
            },
          );

          const journalFiles = await readdir(join(profile, 'journal-v1'));
          assert.equal(journalFiles.length, 1, 'Only the current scoped journal may be stored');
          for (const filename of journalFiles) {
            assert.match(filename, /^[0-9a-f]{64}\.json$/);
            const raw = await readFile(join(profile, 'journal-v1', filename), 'utf8');
            assert.equal(
              raw.includes(ctx.cashier.token),
              false,
              'Native journal must not store staff credentials',
            );
            assert.equal(/"(?:token|authorization|credential)"\s*:/.test(raw), false);
          }

          stage = 'abrupt process restart retains pending journal';
          const exited = once(app.process(), 'exit');
          app.process().kill('SIGKILL');
          await exited;
          app = null;
          page = await launch();
          await pinLogin(page);
          await button(page, 'Проверить результат').waitFor();
          assert.equal(creates.length, 1, 'Restart does not create automatically');
          await button(page, 'Проверить результат').click();
          await page.getByText('Заказ передан на кухню', { exact: true }).waitFor();
          assert.equal(creates.length, 2);
          assert.deepEqual(creates[1], creates[0], 'Identical durable command after crash');
          await page.screenshot({ path: join(output, 'electron-recovered-order.png') });
          stage = 'normal restart, history and cancellation';
          await app.close();
          app = null;
          page = await launch();
          await pinLogin(page);
          await button(page, 'ЗАКАЗЫ').click();
          await button(page, 'Открыть').click();
          await button(page, 'Отменить заказ').click();
          await button(page, 'Ошибка кассира').click();
          await eventually(
            () => ctx.edge.pool.query('SELECT state FROM local_orders'),
            (r) => r.rows[0]?.state === 'cancelled',
            'Cancellation must commit',
          );
          stage = 'native disk failure blocks HTTP';
          await button(page, 'ЗАКАЗ').click();
          await addItems(page);
          await quote(page, '6 980 ₸');
          const nativeDirectory = join(profile, 'journal-v1'),
            savedDirectory = join(profile, 'journal-v1.saved');
          await rename(nativeDirectory, savedDirectory);
          try {
            await writeFile(nativeDirectory, 'SYNTHETIC_DISK_FAULT', { mode: 0o600 });
            await button(page, 'ПЕРЕДАТЬ БЕЗ ОПЛАТЫ').click();
            await page
              .getByText(/Не удалось сохранить/)
              .first()
              .waitFor();
            assert.equal(creates.length, 2, 'No create before durable save');
          } finally {
            await rm(nativeDirectory, { force: true });
            await rename(savedDirectory, nativeDirectory);
          }
          stage = 'restart repaired storage';
          await app.close();
          app = null;
          page = await launch();
          await pinLogin(page);
          await button(page, 'НА КУХНЮ · 6 980 ₸').waitFor();
          assert.equal(creates.length, 2);
          // A denied navigation can leave Playwright's isolated utility world
          // waiting on a navigation that Electron prevented. Probe this last,
          // using ordinary main-world DOM events to prove the POS stays usable.
          stage = 'top-level navigation denied';
          await page.evaluate((url) => {
            globalThis.location.href = url;
          }, trapURL);
          await new Promise((resolve) => setTimeout(resolve, 200));
          assert.equal(page.url(), 'pickchick-pos://app/');
          assert.equal(escaped, 0, 'No unconfigured HTTP listener may receive renderer traffic');
          stage = 'normal POS interaction after denied navigation';
          await page.evaluate(() =>
            [...globalThis.document.querySelectorAll('[role="button"]')]
              .find((e) => e.textContent.trim() === 'Блокировать')
              ?.click(),
          );
          await eventually(
            () => page.evaluate(() => globalThis.document.body.textContent.includes('Личный PIN')),
            Boolean,
            'Document remains interactive',
          );
          assert.equal(
            await page.evaluate((key) => {
              try {
                globalThis.pickchickPosJournal.getItem(key);
                return false;
              } catch {
                return true;
              }
            }, journalKey),
            true,
            'Logout revokes journal authority',
          );
          stage = 'durable database and outbox invariants';
          const rows = (
            await ctx.edge.pool.query(
              'SELECT state,payment_state,fiscal_state,fulfillment_state FROM local_orders',
            )
          ).rows;
          assert.deepEqual(rows, [
            {
              state: 'cancelled',
              payment_state: 'not_started',
              fiscal_state: 'not_requested',
              fulfillment_state: 'blocked',
            },
          ]);
          const events = (
            await ctx.edge.pool.query(
              "SELECT event_type,count(*)::integer AS count FROM outbox_events WHERE event_type IN ('order.created','order.cancelled') GROUP BY event_type ORDER BY event_type",
            )
          ).rows;
          assert.deepEqual(events, [
            { event_type: 'order.cancelled', count: 1 },
            { event_type: 'order.created', count: 1 },
          ]);
          assert.equal(
            (await ctx.edge.pool.query('SELECT state FROM fulfillment_reservations')).rows[0].state,
            'cancelled',
          );
          assert.equal(escaped, 0);
          assert.deepEqual(errors, []);
          assert.deepEqual(
            creates.map((c) => c.status),
            [201, 201],
          );
          assert.ok(requests.every(({ path }) => path.startsWith('/edge/v1/')));
          assert.ok(!requests.some(({ path }) => /payment|fiscal/.test(path)));
        } catch {
          // Playwright call logs can include file-input data. Report only the
          // stage; neither temporary staff credentials nor profile data is logged.
          if (app) {
            const failedPage = await app.firstWindow().catch(() => null);
            if (failedPage) {
              await failedPage
                .screenshot({ path: join(output, 'last-failure.png') })
                .catch(() => {});
            }
          }
          throw new Error(
            `Desktop acceptance failed at: ${stage}; edgeRequests=${requests.length}; rendererErrors=${errors.length}`,
          );
        }
      } finally {
        if (app) await app.close().catch(() => {});
        if (proxy?.listening) await new Promise((resolve) => proxy.close(resolve));
        if (trap?.listening) await new Promise((resolve) => trap.close(resolve));
        if (edge) await edge.app.close();
        if (temporary) await rm(temporary, { recursive: true, force: true });
      }
    });
  },
);
