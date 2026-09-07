import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { syncFulfillmentOnce, cloudTransportOrigin } from '@pickchick/fulfillment-transport';
import { readIdentity } from './private-identity.mjs';

const config = loadConfig('edge');
if (!config.fulfillmentTransportEnabled) {
  console.log(JSON.stringify({ event: 'fulfillment_transport', state: 'disabled' }));
} else {
  const origin = cloudTransportOrigin(
    process.env.EDGE_FULFILLMENT_CLOUD_ORIGIN ?? 'http://127.0.0.1:3100',
  );
  const pool = createPool(config.databaseUrl);
  const stop = new AbortController(),
    once = process.argv.includes('--once');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());
  let failures = 0;
  try {
    do {
      let state = 'retry';
      try {
        const result = await syncFulfillmentOnce(pool, {
          enabled: true,
          branchId: config.branchId,
          origin,
          identity: await readIdentity(),
        });
        state = result.state;
        if (once || !['idle', 'busy'].includes(state))
          console.log(JSON.stringify({ event: 'fulfillment_transport', ...result }));
        if (state === 'retry' || state === 'blocked') {
          failures = Math.min(failures + 1, 6);
          if (once) process.exitCode = 1;
        } else failures = 0;
      } catch {
        failures = Math.min(failures + 1, 6);
        console.error(JSON.stringify({ event: 'fulfillment_transport_failed', retrying: !once }));
        if (once) process.exitCode = 1;
      }
      if (once || stop.signal.aborted) break;
      // Each turn claims one event and one reverse event. Drain successful work
      // immediately; only idle, contention or failure has bounded backoff/jitter.
      const wait = failures
        ? Math.min(60000, 1000 * 2 ** failures) + Math.floor(Math.random() * 500)
        : ['idle', 'busy'].includes(state)
          ? 1000
          : 0;
      if (wait)
        await delay(wait, undefined, { signal: stop.signal }).catch((error) => {
          if (error.name !== 'AbortError') throw error;
        });
    } while (!stop.signal.aborted);
  } finally {
    await pool.end();
  }
}
