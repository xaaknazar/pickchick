/**
 * Cutover KDS-5 (contracts sections 2.3, 5.4): the six KDS screens of the real kitchen client
 * on a disposable PostgreSQL edge with the KDS layout on, at both monoblock resolutions.
 * Three kitchen terminals as on the point: 6+5 (prep tabs), table 1 + issue (morning tabs) and
 * table 2 + the courier counter 3 (owner decision: a tab on the table-2 screen). Synthetic
 * orders only: a cloud combo, a cashier hall order and two cashier aggregator orders.
 * Never calls the cloud, an aggregator or any network outside 127.0.0.1.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { provisionStaff } from '@pickchick/local-orders';
import { createKitchenServer } from '../../apps/kitchen/server.mjs';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const apiRoot = resolve(process.env.PICKCHICK_LAN_API_ROOT ?? repo);
const { createEdge } = await import(pathToFileURL(resolve(apiRoot, 'services/edge/dist/index.js')));
const { fixture } = await import(
  pathToFileURL(resolve(apiRoot, 'packages/edge-fulfillment/tests/fixture.mjs'))
);
const { assertStrictEvents, cashierDesk, kdsTestLayout, writeKdsLayout } = await import(
  pathToFileURL(resolve(apiRoot, 'packages/edge-fulfillment/tests/kds-fixture.mjs'))
);
const { grantStation, kdsStationId } = await import(
  pathToFileURL(resolve(apiRoot, 'packages/edge-fulfillment/dist/index.js'))
);
const output = resolve(repo, '.local/kitchen-browser');
const python =
  process.env.PICKCHICK_BROWSER_PYTHON ?? resolve(repo, '.local/design-venv/bin/python');
const redact = (actor) => Object.fromEntries(Object.entries(actor).filter(([k]) => k !== 'auth'));

for (const [width, height] of [
  [1280, 800],
  [1920, 1080],
])
  test(
    `real PG KDS screens 6, 5, table 1, table 2, issue 2 and courier 3 ${width}×${height}`,
    { timeout: 240000 },
    () =>
      fixture(async (ctx) => {
        const b = ctx.scope.branchId;
        const S = (fn) => kdsStationId(b, fn);
        const desk = await cashierDesk(ctx);
        const runner = await provisionStaff(ctx.pool, b, {
          staff_id: randomUUID(),
          terminal_id: randomUUID(),
          name: 'Synthetic runner',
          role: 'kitchen',
        });
        await writeKdsLayout(
          ctx.pool,
          b,
          kdsTestLayout(b, {
            terminals: {
              breading: [ctx.cook.terminal_id],
              toasts: [ctx.cook.terminal_id],
              assembly_hall: [ctx.packer.terminal_id],
              issue: [ctx.packer.terminal_id],
              assembly_delivery: [runner.terminal_id],
              delivery_handover: [runner.terminal_id],
            },
          }),
        );
        for (const [staff, fns] of [
          [ctx.cook.staff_id, ['breading', 'toasts']],
          [ctx.packer.staff_id, ['assembly_hall', 'issue']],
          [runner.staff_id, ['assembly_delivery', 'delivery_handover']],
        ])
          for (const fn of fns) await grantStation(ctx.pool, b, staff, S(fn));
        const cloud = (await ctx.accepted(true)).order;
        const hall = await desk.order({ comboQuantity: 1, burgers: 1 });
        const glovo = await desk.order({
          delivery: { provider: 'glovo', externalNumber: 'G-456' },
          comboQuantity: 1,
          burgers: 0,
        });
        const yandex = await desk.order({
          delivery: { provider: 'yandex_eda', externalNumber: 'Y-123' },
          comboQuantity: 0,
          burgers: 1,
        });
        const number = async (orderId) =>
          (
            await ctx.pool.query(
              'SELECT display_number::text AS n FROM fulfillment_reservations WHERE order_id=$1',
              [orderId],
            )
          ).rows[0].n;
        const app = await createEdge({
          service: 'edge',
          environment: 'test',
          databaseUrl: ctx.url,
          branchId: b,
          edgeDeviceId: ctx.scope.deviceId,
          edgeFulfillmentEnabled: true,
          port: 0,
        });
        let gateway;
        const fixturePath = resolve(output, `kds-fixture-${width}.json`);
        await mkdir(output, { recursive: true });
        try {
          await app.listen(0, '127.0.0.1');
          gateway = createKitchenServer({
            edgePort: Number(new URL(await app.getUrl()).port),
            branchLabel: 'Алматы · проверка KDS',
            assetDir: new URL('../../apps/kitchen/dist/', import.meta.url),
          });
          gateway.listen(0, '127.0.0.1');
          await once(gateway, 'listening');
          await writeFile(
            fixturePath,
            JSON.stringify({
              url: `http://127.0.0.1:${gateway.address().port}`,
              output,
              width,
              height,
              cook: redact(ctx.cook),
              packer: redact(ctx.packer),
              runner: redact(runner),
              stations: Object.fromEntries(
                [
                  'breading',
                  'toasts',
                  'assembly_hall',
                  'assembly_delivery',
                  'issue',
                  'delivery_handover',
                ].map((fn) => [fn, S(fn)]),
              ),
              orders: {
                cloud: { id: cloud.orderId, number: await number(cloud.orderId) },
                hall: { id: hall.order_id, number: await number(hall.order_id) },
                glovo: { id: glovo.order_id, number: await number(glovo.order_id) },
                yandex: { id: yandex.order_id, number: await number(yandex.order_id) },
              },
            }),
            { mode: 0o600 },
          );
          const child = spawn(
            python,
            [resolve(repo, 'tests/kitchen/kds_browser.py'), fixturePath],
            {
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          let stdout = '',
            stderr = '';
          child.stdout.on('data', (chunk) => (stdout += chunk));
          child.stderr.on('data', (chunk) => (stderr += chunk));
          const [code] = await once(child, 'exit');
          assert.equal(code, 0, `${stdout}\n${stderr}`);

          // What the screens did is exactly what PostgreSQL holds.
          const state = async (orderId) => (await ctx.read(orderId)).state;
          assert.equal(await state(hall.order_id), 'handed_over');
          assert.equal(await state(cloud.orderId), 'ready');
          assert.equal(await state(glovo.order_id), 'handed_over');
          assert.equal(await state(yandex.order_id), 'ready');
          const handovers = (await ctx.pool.query('SELECT * FROM delivery_handovers')).rows;
          assert.equal(handovers.length, 1);
          assert.deepEqual(
            [
              handovers[0].order_id,
              handovers[0].provider,
              handovers[0].external_number,
              handovers[0].number_matched,
              handovers[0].courier_accepted,
              handovers[0].photo_taken,
              handovers[0].station_id,
              handovers[0].staff_id,
              handovers[0].terminal_id,
            ],
            [
              glovo.order_id,
              'glovo',
              'G-456',
              true,
              true,
              true,
              S('delivery_handover'),
              runner.staff_id,
              runner.terminal_id,
            ],
          );
          const incidents = (await ctx.pool.query('SELECT * FROM courier_incidents')).rows;
          assert.equal(incidents.length, 1, 'the refusal is recorded once');
          assert.deepEqual(
            [
              incidents[0].order_id,
              incidents[0].provider,
              incidents[0].claimed_number,
              incidents[0].kind,
              incidents[0].terminal_id,
            ],
            [yandex.order_id, 'yandex_eda', 'Y-123', 'courier_refused', runner.terminal_id],
          );
          assert.doesNotMatch(incidents[0].description, /\d{10}/, 'no phone number was stored');
          // Toasts of the cloud combo were closed at 5, the other toasts by the table cascade.
          const open = (
            await ctx.pool.query(
              "SELECT count(*)::int AS n FROM fulfillment_tasks WHERE state<>'done' AND order_id = ANY($1::uuid[])",
              [[hall.order_id, glovo.order_id, cloud.orderId]],
            )
          ).rows[0].n;
          assert.equal(open, 0);
          const strict = await assertStrictEvents(ctx.pool);
          assert.ok(strict.pos > 0 && strict.cloud > 0, JSON.stringify(strict));
        } finally {
          await rm(fixturePath, { force: true });
          if (gateway) {
            gateway.closeAllConnections();
            await new Promise((r) => gateway.close(r));
          }
          await app.close();
        }
      }),
  );
