import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import {
  kioskKaspiQrConfig,
  KioskKaspiQrBridgeClient,
  KioskKaspiQrProcessor,
} from '@pickchick/commerce-core';

const qr = kioskKaspiQrConfig(process.env);
if (!qr) console.log(JSON.stringify({ event: 'kiosk_kaspi_qr', state: 'disabled' }));
else if (!qr.session) {
  console.error(JSON.stringify({ event: 'kiosk_kaspi_qr', state: 'no_cashier_session' }));
  process.exitCode = 1;
} else {
  const pool = createPool(loadConfig('api').databaseUrl),
    stop = new AbortController(),
    once = process.argv.includes('--once');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
  const processor = new KioskKaspiQrProcessor(pool, qr, new KioskKaspiQrBridgeClient(qr));
  let lastAlert = 0;
  try {
    do {
      try {
        const result = await processor.tick();
        if (
          (result.sessionProblem || result.errors || result.unknownOverdue) &&
          Date.now() - lastAlert > 300000
        ) {
          lastAlert = Date.now();
          console.error(JSON.stringify({ event: 'kiosk_kaspi_qr_attention', ...result }));
        }
        if (once || result.submitted)
          console.log(JSON.stringify({ event: 'kiosk_kaspi_qr', ...result }));
        if (once && result.errors) process.exitCode = 1;
      } catch {
        console.error(JSON.stringify({ event: 'kiosk_kaspi_qr_failed' }));
        if (once) process.exitCode = 1;
      }
      if (once || stop.signal.aborted) break;
      await delay(1000, undefined, { signal: stop.signal }).catch(() => undefined);
    } while (!stop.signal.aborted);
  } finally {
    await pool.end();
  }
}
