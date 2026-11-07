import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import {
  backofficeOptions,
  backofficeP1Options,
  runStockConsumption,
} from '@pickchick/backoffice-core';

/**
 * Automatic stock consumption by sales (Ск2; lane bo-ui, design-bo-ui.md 5.5): a separate process
 * under the API role, like customer-notifications-worker. It runs only with
 * BACKOFFICE_ENABLED=true and BACKOFFICE_STOCK_AUTOCONSUME_ENABLED=true (loadConfig also requires
 * BACKOFFICE_STOCK_V2_ENABLED); otherwise it logs `disabled` and exits without touching the
 * database. Every tick (30 s, `--once` for one tick) handles the branches whose mode is dry_run or
 * on (bo_stock_settings); a branch in off, or without a settings row, is never read.
 * Logs carry counts only: no order, no name, no amount.
 */
const config = loadConfig('api');
if (config.backofficeEnabled !== true || config.backofficeStockAutoconsumeEnabled !== true)
  console.log(JSON.stringify({ event: 'stock_consumption', state: 'disabled' }));
else {
  const options = { ...backofficeOptions(process.env), ...backofficeP1Options(config) };
  const pool = createPool(config.databaseUrl),
    stop = new AbortController(),
    once = process.argv.includes('--once');
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => stop.abort());
  try {
    do {
      try {
        const tick = await runStockConsumption(pool, options, () => new Date());
        if (!tick.ready)
          console.log(JSON.stringify({ event: 'stock_consumption', state: 'not_ready' }));
        else if (tick.enqueued || tick.processed || tick.errors || once)
          console.log(JSON.stringify({ event: 'stock_consumption_tick', ...tick }));
        if (once && tick.errors) process.exitCode = 1;
      } catch {
        console.error(JSON.stringify({ event: 'stock_consumption_tick_failed' }));
        if (once) process.exitCode = 1;
      }
      if (once || stop.signal.aborted) break;
      await delay(30000, undefined, { signal: stop.signal }).catch(() => undefined);
    } while (!stop.signal.aborted);
  } finally {
    await pool.end();
  }
}
