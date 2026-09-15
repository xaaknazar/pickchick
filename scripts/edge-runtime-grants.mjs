import { createPool } from '@pickchick/database';
import { edgeInstallConfig } from './edge-migrate.mjs';
import { applyEdgeRuntimeGrants } from '../infra/windows/edge-runtime-grants.mjs';

let pool;
try {
  const [role, flag, ...extra] = process.argv.slice(2);
  if (!role || extra.length || (flag && flag !== '--fulfillment')) throw new Error();
  pool = createPool(edgeInstallConfig().databaseUrl, 1);
  const result = await applyEdgeRuntimeGrants(pool, role, {
    fulfillment: flag === '--fulfillment',
  });
  console.log(JSON.stringify({ event: 'edge_runtime_granted', ...result }));
} catch {
  console.error(JSON.stringify({ event: 'edge_runtime_grant_failed' }));
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
