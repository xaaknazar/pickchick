import { createPool } from '@pickchick/database';
import { edgeInstallConfig } from './edge-migrate.mjs';
import {
  applyEdgeRuntimeGrants,
  runtimeGrantCliOptions,
} from '../infra/windows/edge-runtime-grants.mjs';

let pool;
try {
  // <role> [--fulfillment]. --cloud-link is refused: on a live cashier use the additive
  // infra/windows/cloud-link-grant.mjs. On schema020+ a role that already holds rights is refused.
  const { role, options } = runtimeGrantCliOptions(process.argv.slice(2));
  pool = createPool(edgeInstallConfig().databaseUrl, 1);
  const result = await applyEdgeRuntimeGrants(pool, role, options);
  console.log(JSON.stringify({ event: 'edge_runtime_granted', ...result }));
} catch {
  console.error(JSON.stringify({ event: 'edge_runtime_grant_failed' }));
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
