import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { retryPosKitchenDelivery } from '@pickchick/pos-order-sync';
let pool;
try {
  if (process.argv.length !== 3) throw new Error('Event UUID required');
  const config = loadConfig('edge');
  pool = createPool(config.databaseUrl);
  const result = await retryPosKitchenDelivery(pool, config.branchId, process.argv[2]);
  console.log(JSON.stringify({ event: 'pos_kitchen_retry_scheduled', ...result }));
} catch {
  console.error(JSON.stringify({ event: 'pos_kitchen_retry_failed' }));
  process.exitCode = 1;
} finally {
  await pool?.end();
}
