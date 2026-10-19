import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import {
  KaspiAttention,
  KaspiBridgeClient,
  KaspiRemoteProcessor,
  kaspiRemoteConfig,
  KioskSessions,
  kioskPiiKey,
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
  const guestKey = kioskPiiKey(process.env);
  const guests = guestKey ? new KioskSessions(pool, { piiKey: guestKey }) : null;
  const processor = new KaspiRemoteProcessor(
    pool,
    kaspi,
    new KaspiBridgeClient(kaspi),
    (customerId: string) => readCustomerPaymentPhone(pool, identity, customerId),
    undefined,
    guests ? (orderId: string) => guests.readOrderPhone(orderId) : undefined,
  );
  const attention = new KaspiAttention();
  let lastGuestCleanup = 0;
  try {
    do {
      let busy = false;
      try {
        const result = await processor.tick();
        if (guests && Date.now() - lastGuestCleanup > 60 * 60_000) {
          await guests.purgeExpiredPhones();
          lastGuestCleanup = Date.now();
        }
        busy = result.submitted + result.checked + result.notSent > 0;
        // session_*: re-login or bridge restart required. unknown_overdue: check Kaspi Pay by
        // hand. invoice_not_sent: customers wait for an invoice. Rate-limited, plus recovery.
        const signal = attention.next(result);
        if (signal?.recovered) console.log(JSON.stringify(signal));
        else if (signal) console.error(JSON.stringify(signal));
        if (once || result.submitted || result.notSent)
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
