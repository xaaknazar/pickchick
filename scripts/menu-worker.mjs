import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { syncMenuOnce, syncStationPlanOnce, localCloudOrigin } from '@pickchick/menu-sync';
import { readIdentity } from './private-identity.mjs';

const config = loadConfig('edge');
const origin = localCloudOrigin(process.env.EDGE_SYNC_ORIGIN ?? 'http://127.0.0.1:3100');
// Station plans (edge schema024): off (default), report or apply; isolated from menu sync.
const stationPlanMode = process.env.EDGE_STATION_PLAN_SYNC_MODE ?? 'off';
if (!['off', 'report', 'apply'].includes(stationPlanMode))
  throw new Error('EDGE_STATION_PLAN_SYNC_MODE must be off, report or apply');
const pool = createPool(config.databaseUrl);
const stop = new AbortController();
const once = process.argv.includes('--once');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());
let failures = 0;
// Photo download failures per menu event; after three, the publication is ACKed as rejected.
const mediaAttempts = new Map();
try {
  do {
    try {
      const result = await syncMenuOnce(pool, config.branchId, origin, await readIdentity(), {
        mediaAttempts,
      });
      failures = 0;
      if (once || result.state !== 'idle')
        console.log(JSON.stringify({ event: 'menu_sync', ...result }));
    } catch {
      failures = Math.min(failures + 1, 6);
      console.error(JSON.stringify({ event: 'menu_sync_failed', retrying: !once, failures }));
      if (once) process.exitCode = 1;
    }
    if (stationPlanMode !== 'off')
      try {
        const plan = await syncStationPlanOnce(
          pool,
          config.branchId,
          origin,
          await readIdentity(),
          { mode: stationPlanMode },
        );
        if (once || plan.state !== 'idle')
          console.log(JSON.stringify({ event: 'station_plan_sync', ...plan }));
      } catch {
        console.error(JSON.stringify({ event: 'station_plan_sync_failed', retrying: !once }));
        if (once) process.exitCode = 1;
      }
    if (once || stop.signal.aborted) break;
    const waitMs = failures
      ? Math.min(60000, 1000 * 2 ** failures) + Math.floor(Math.random() * 500)
      : 2000;
    await delay(waitMs, undefined, { signal: stop.signal }).catch((error) => {
      if (error.name !== 'AbortError') throw error;
    });
  } while (!stop.signal.aborted);
} finally {
  await pool.end();
}
