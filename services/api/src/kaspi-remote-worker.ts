import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import {
  KaspiBridgeClient,
  KaspiRemoteProcessor,
  kaspiRemoteConfig,
} from '@pickchick/commerce-core';
import {
  createCustomerIdentityOptions,
  readCustomerPaymentPhone,
} from '@pickchick/customer-identity';

// Issues Kaspi invoices for payment attempts of the kaspi-remote account and
// re-checks their status through the private local bridge. Logs never contain
// phones, amounts per customer or session values.
const kaspi = kaspiRemoteConfig(process.env);
if (!kaspi) {
  console.log(JSON.stringify({ event: 'kaspi_remote', state: 'disabled' }));
} else if (!kaspi.session) {
  console.error(JSON.stringify({ event: 'kaspi_remote', state: 'no_cashier_session' }));
  process.exitCode = 1;
} else {
  const config = loadConfig('api');
  const identity = createCustomerIdentityOptions(process.env);
  const pool = createPool(config.databaseUrl),
    stop = new AbortController(),
    once = process.argv.includes('--once');
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => stop.abort());
  const processor = new KaspiRemoteProcessor(
    pool,
    kaspi,
    new KaspiBridgeClient(kaspi),
    (customerId: string) => readCustomerPaymentPhone(pool, identity, customerId),
  );
  let lastSessionAlert = 0;
  try {
    do {
      let busy = false;
      try {
        const result = await processor.tick();
        busy = result.submitted + result.checked > 0;
        if (
          (result.sessionProblem || result.unknownOverdue > 0 || result.errors > 0) &&
          Date.now() - lastSessionAlert > 5 * 60_000
        ) {
          lastSessionAlert = Date.now();
          // session_rejected: re-login required. unknown_overdue: check Kaspi Pay by hand.
          console.error(
            JSON.stringify({
              event: 'kaspi_remote_attention',
              sessionRejected: result.sessionProblem,
              unknownOverdue: result.unknownOverdue,
              errors: result.errors,
            }),
          );
        }
        if (once || result.submitted)
          console.log(JSON.stringify({ event: 'kaspi_remote', ...result }));
      } catch {
        console.error(JSON.stringify({ event: 'kaspi_remote_failed', retrying: !once }));
        if (once) process.exitCode = 1;
      }
      if (once || stop.signal.aborted) break;
      await delay(busy ? 250 : 1000 + Math.floor(Math.random() * 250), undefined, {
        signal: stop.signal,
      }).catch(() => undefined);
    } while (!stop.signal.aborted);
  } finally {
    await pool.end();
  }
}
