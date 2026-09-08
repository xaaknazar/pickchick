import { readFile } from 'node:fs/promises';
import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { provisionCloudPosSync, provisionEdgePosSync } from '@pickchick/pos-order-sync';

// Trusted operator with direct access to exactly one local database per invocation.
// Input contains binding IDs only, never device credentials. No remote setup call.
const side = process.argv[2],
  path = process.argv[3];
let pool;
try {
  if (!['edge', 'cloud'].includes(side) || !path || process.argv.length !== 4) throw new Error();
  const input = JSON.parse(await readFile(path, 'utf8')),
    config = loadConfig(side === 'cloud' ? 'api' : 'edge');
  if (side === 'edge' && input.branchId !== config.branchId) throw new Error();
  pool = createPool(config.databaseUrl);
  const result = await (side === 'edge' ? provisionEdgePosSync : provisionCloudPosSync)(
    pool,
    input,
  );
  console.log(JSON.stringify({ event: 'pos_order_sync_binding_saved', side, ...result }));
} catch {
  console.error(JSON.stringify({ event: 'pos_order_sync_setup_failed' }));
  process.exitCode = 1;
} finally {
  await pool?.end();
}
