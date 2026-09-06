import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { revokeStaff } from '@pickchick/local-orders';
const config = loadConfig('edge'),
  pool = createPool(config.databaseUrl);
try {
  await revokeStaff(pool, config.branchId, process.argv[2] ?? '');
  console.log('Local staff access revoked (or already absent/revoked).');
} catch {
  console.error('Staff revocation failed.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
