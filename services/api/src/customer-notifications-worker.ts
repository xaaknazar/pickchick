import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { CustomerCheckout, customerCheckoutOptions } from '@pickchick/commerce-core';
import {
  CustomerNotifications,
  PushProviders,
  pushOptions,
  type OrderNotificationKind,
} from '@pickchick/customer-notifications';
const options = pushOptions(process.env);
if (!options.enabled) console.log(JSON.stringify({ event: 'customer_push', state: 'disabled' }));
else {
  const checkoutOptions = customerCheckoutOptions(process.env);
  if (!checkoutOptions) throw new Error('Customer push requires configured checkout read access');
  const pool = createPool(loadConfig('api').databaseUrl),
    stop = new AbortController(),
    once = process.argv.includes('--once');
  const checkout = new CustomerCheckout(pool, checkoutOptions),
    notifications = new CustomerNotifications(pool, options),
    providers = new PushProviders(options);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => stop.abort());
  try {
    do {
      try {
        // A bounded durable order scan survives worker restarts. It does not consume kitchen outboxes.
        const orders = await pool.query<{ id: string; customer_id: string }>(
          `SELECT o.id,o.customer_id FROM commerce_orders o JOIN customer_notification_preferences p ON p.customer_id=o.customer_id JOIN identity_customers c ON c.id=o.customer_id WHERE o.organization_id=$1 AND o.branch_id=$2 AND o.principal_id=o.customer_id AND o.snapshot->>'channel'='mobile' AND p.orders AND c.deleted_at IS NULL AND o.created_at>=p.orders_enabled_at AND o.created_at>clock_timestamp()-interval '24 hours' ORDER BY o.created_at,o.id`,
          [checkoutOptions.organizationId, checkoutOptions.branchId],
        );
        let errors = 0;
        for (const order of orders.rows) {
          if (stop.signal.aborted) break;
          try {
            const current = await checkout.read(order.customer_id, order.id);
            if (['paid', 'preparing', 'ready', 'handed_over'].includes(current.phase))
              await notifications.observe(
                order.customer_id,
                order.id,
                current.phase as OrderNotificationKind,
              );
          } catch {
            errors++;
          }
        }
        const processed = await notifications.deliver((target, message) =>
          providers.send(target, message),
        );
        if (processed || errors || once)
          console.log(JSON.stringify({ event: 'customer_push_tick', processed, errors }));
      } catch {
        console.error(JSON.stringify({ event: 'customer_push_tick_failed' }));
        if (once) process.exitCode = 1;
      }
      if (once || stop.signal.aborted) break;
      await delay(10000, undefined, { signal: stop.signal }).catch(() => undefined);
    } while (!stop.signal.aborted);
  } finally {
    await pool.end();
  }
}
