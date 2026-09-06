import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { revokeDevice } from '@pickchick/menu-sync';

const pool = createPool(loadConfig('api').databaseUrl);
try {
  await revokeDevice(pool, process.argv[2] ?? '');
  console.log('Device access revoked (or already absent/revoked). Local menu is retained.');
} catch {
  console.error('Device revocation failed; check UUID and database.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
