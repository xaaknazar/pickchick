import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { WebkassaCloudFiscalWorker, webkassaCloudConfig } from '@pickchick/commerce-core';

// Webkassa receipts of app and kiosk orders (docs/integrations/webkassa-api.md, stage 2).
const config = webkassaCloudConfig(process.env);
if (!config) console.log(JSON.stringify({ event: 'webkassa_cloud', state: 'disabled' }));
else {
  const pool = createPool(loadConfig('api').databaseUrl),
    stop = new AbortController(),
    once = process.argv.includes('--once');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
  const worker = new WebkassaCloudFiscalWorker(pool, config);
  try {
    do {
      try {
        const result = await worker.tick();
        if (once || result.issued || result.refused || result.errors)
          console.log(JSON.stringify({ event: 'webkassa_cloud', ...result }));
        if (once && result.errors) process.exitCode = 1;
      } catch {
        console.error(JSON.stringify({ event: 'webkassa_cloud_tick_failed' }));
        if (once) process.exitCode = 1;
      }
      if (once || stop.signal.aborted) break;
      await delay(2000, undefined, { signal: stop.signal }).catch(() => undefined);
    } while (!stop.signal.aborted);
  } finally {
    await pool.end();
  }
}
