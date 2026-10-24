/**
 * Offline stand worker process: the three cashier sync loops exactly as the Windows services pace
 * them (infra/windows/native-*-worker.mjs exports), but without the Windows-only service checks
 * (ACL script, fixed role/port). One process per loop, so the stand can kill one of them.
 *
 *   node tests/offline-stand/worker.mjs fulfillment|pos|menu
 *
 * Environment: the normal edge variables (APP_ENV, EDGE_DATABASE_URL, EDGE_BRANCH_ID,
 * EDGE_DEVICE_ID, EDGE_FULFILLMENT_ENABLED, EDGE_FULFILLMENT_TRANSPORT_ENABLED,
 * EDGE_POS_ORDER_SYNC_ENABLED) plus OFFLINE_STAND_CLOUD_ORIGIN (the WAN link) and
 * OFFLINE_STAND_IDENTITY (device identity JSON, mode 600).
 */
import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { DeviceIdentitySchema } from '@pickchick/contracts';
import * as transport from '@pickchick/fulfillment-transport';
import * as posSync from '@pickchick/pos-order-sync';
import * as menuSync from '@pickchick/menu-sync';
import {
  fulfillmentRetryDelay,
  workerProtocolVersion,
} from '../../infra/windows/native-fulfillment-worker.mjs';
import { runMenuSyncLoop, MENU_SYNC_SCHEMA } from '../../infra/windows/native-menu-sync-worker.mjs';
import { readWindowsIdentity } from '../../infra/windows/native-pos-sync-worker.mjs';

const kind = process.argv[2];
if (!['fulfillment', 'pos', 'menu'].includes(kind)) throw new Error('worker kind required');
const config = loadConfig('edge');
const origin = process.env.OFFLINE_STAND_CLOUD_ORIGIN;
const identityPath = process.env.OFFLINE_STAND_IDENTITY;
const branchId = config.branchId,
  deviceId = process.env.EDGE_DEVICE_ID;
if (!origin || !identityPath || !deviceId) throw new Error('stand worker environment incomplete');
const identity = () => readWindowsIdentity(identityPath, DeviceIdentitySchema, branchId, deviceId);
const log = (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));
const stop = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stop.abort());
const wait = (ms) =>
  delay(ms, undefined, { signal: stop.signal }).catch((error) => {
    if (error.name !== 'AbortError') throw error;
  });

const pool = createPool(config.databaseUrl, 2);
try {
  if (kind === 'fulfillment') await fulfillmentLoop();
  else if (kind === 'pos') await posLoop();
  else await menuLoop();
} finally {
  await pool.end();
}

/** native-fulfillment-worker.mjs main loop, protocol from FULFILLMENT_TRANSPORT_PROTOCOL. */
async function fulfillmentLoop() {
  const protocolVersion = workerProtocolVersion();
  let failures = 0;
  log({ event: 'worker_started', worker: kind, protocolVersion });
  do {
    let delivered = false;
    try {
      const result = await transport.syncFulfillmentOnce(pool, {
        enabled: true,
        branchId,
        origin,
        identity: await identity(),
        ...(protocolVersion === 4 ? { protocolVersion } : {}),
      });
      if (!['idle', 'busy', 'disabled'].includes(result.state))
        log({ event: 'fulfillment_transport', ...result });
      delivered = ['applied', 'acknowledged'].includes(result.state);
      if (['retry', 'blocked', 'parked'].includes(result.state))
        failures = Math.min(6, failures + 1);
      else failures = 0;
    } catch {
      failures = Math.min(6, failures + 1);
      log({ event: 'native_fulfillment_sync_failed' });
    }
    if (stop.signal.aborted) break;
    if (!delivered) await wait(fulfillmentRetryDelay(failures));
  } while (!stop.signal.aborted);
}

/** native-pos-sync-worker.mjs main loop: POS orders, then POS kitchen facts. */
async function posLoop() {
  log({ event: 'worker_started', worker: kind });
  do {
    let delivered = false;
    try {
      const id = await identity();
      for (const [event, work] of [
        ['pos_order_sync', posSync.syncPosOrdersOnce],
        ['pos_kitchen_sync', posSync.syncPosKitchenOnce],
      ]) {
        const result = await work(pool, { enabled: true, branchId, origin, identity: id });
        if (!['idle', 'busy', 'disabled'].includes(result.state))
          log({ event, state: result.state, ...(result.error ? { error: result.error } : {}) });
        if (result.state === 'delivered') delivered = true;
      }
    } catch {
      log({ event: 'native_pos_sync_failed' });
    }
    if (stop.signal.aborted) break;
    if (!delivered) await wait(1000 + Math.floor(Math.random() * 250));
  } while (!stop.signal.aborted);
}

/** native-menu-sync-worker.mjs runMenuSyncLoop in 'apply' mode. */
async function menuLoop() {
  const mediaAttempts = new Map();
  log({ event: 'worker_started', worker: kind });
  await runMenuSyncLoop({
    mode: 'apply',
    signal: stop.signal,
    log,
    schemaReady: async () =>
      (
        await pool.query("SELECT 1 FROM schema_migrations WHERE scope='edge' AND version=$1", [
          MENU_SYNC_SCHEMA,
        ])
      ).rowCount === 1,
    sync: async ({ applyEvents }) =>
      menuSync.syncMenuOnce(pool, branchId, origin, await identity(), {
        mediaAttempts,
        applyEvents,
      }),
  });
}
