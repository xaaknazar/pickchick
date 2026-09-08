import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { syncPosOrdersOnce, posCloudOrigin } from '@pickchick/pos-order-sync';
import { readIdentity } from './private-identity.mjs';

const config = loadConfig('edge');
if (!config.posOrderSyncEnabled) {
  console.log(JSON.stringify({ event: 'pos_order_sync', state: 'disabled' }));
} else {
  const origin = posCloudOrigin(
    process.env.EDGE_POS_ORDER_SYNC_CLOUD_ORIGIN ?? 'http://127.0.0.1:3100',
  );
  const pool = createPool(config.databaseUrl),
    stop = new AbortController(),
    once = process.argv.includes('--once');
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stop.abort());
  try {
    do {
      let state = 'retry';
      try {
        const identity = await readIdentity();
        if (identity.device_id !== config.edgeDeviceId) throw new Error();
        const result = await syncPosOrdersOnce(pool, {
          enabled: true,
          branchId: config.branchId,
          origin,
          identity,
        });
        state = result.state;
        if (once || !['idle', 'busy'].includes(state))
          console.log(JSON.stringify({ event: 'pos_order_sync', ...result }));
        if (once && state === 'retry') process.exitCode = 1;
      } catch {
        console.error(JSON.stringify({ event: 'pos_order_sync_failed', retrying: !once }));
        if (once) process.exitCode = 1;
      }
      if (once || stop.signal.aborted) break;
      // The durable database retry_after is authoritative across restarts.
      // Jitter avoids synchronized idle/retry polling across restaurant edges.
      if (state !== 'delivered')
        await delay(1000 + Math.floor(Math.random() * 250), undefined, {
          signal: stop.signal,
        }).catch(() => undefined);
    } while (!stop.signal.aborted);
  } finally {
    await pool.end();
  }
}
