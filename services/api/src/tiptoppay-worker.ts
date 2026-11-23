import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { TipTopPayCheckout, tipTopPayCheckoutOptions } from '@pickchick/commerce-core';

/**
 * TipTopPay LIVE worker (tiptoppay-checkout.ts): settles open attempts with payments/find and
 * sends managers' refunds to payments/refund. Off (exits) unless TIPTOPPAY_CHECKOUT_ENABLED=true.
 * Late open attempts also keep reconciling after the checkout is switched off: run it with the
 * same keys until no attempt of the account is pending or unknown.
 */
const options = tipTopPayCheckoutOptions(process.env);
if (!options) console.log(JSON.stringify({ event: 'tiptoppay_worker', state: 'disabled' }));
else {
  const pool = createPool(loadConfig('api').databaseUrl),
    stop = new AbortController(),
    once = process.argv.includes('--once');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
  const checkout = new TipTopPayCheckout(pool, options);
  let lastAlert = 0;
  try {
    do {
      try {
        const settled = await checkout.reconcile();
        const refunds = await checkout.refunds();
        const errors = settled.errors + refunds.errors;
        if (errors && Date.now() - lastAlert > 300000) {
          lastAlert = Date.now();
          console.error(JSON.stringify({ event: 'tiptoppay_worker_attention', settled, refunds }));
        }
        if (once || settled.settled || refunds.sent)
          console.log(JSON.stringify({ event: 'tiptoppay_worker', settled, refunds }));
        if (once && errors) process.exitCode = 1;
      } catch {
        console.error(JSON.stringify({ event: 'tiptoppay_worker_failed' }));
        if (once) process.exitCode = 1;
      }
      if (once || stop.signal.aborted) break;
      await delay(2000, undefined, { signal: stop.signal }).catch(() => undefined);
    } while (!stop.signal.aborted);
  } finally {
    await pool.end();
  }
}
