import { UuidSchema } from '@pickchick/contracts';
import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { revokeTestActor } from '@pickchick/test-order-flow';

let pool;
try {
  if (process.argv.length !== 3) throw new Error('Expected one TEST actor UUID');
  const actorId = UuidSchema.parse(process.argv[2]);
  const config = loadConfig('api');
  if (
    config.environment === 'staging' &&
    new URL(config.databaseUrl).username !== 'pickchick_owner'
  )
    throw new Error('Trusted owner connection required');
  pool = createPool(config.databaseUrl);
  await revokeTestActor(
    pool,
    { enabled: config.testOrderFlowEnabled === true, environment: config.environment },
    actorId,
  );
  console.log('TEST access revoked (or already absent/revoked).');
} catch {
  console.error('TEST revocation failed. Check actor UUID, TEST gate and owner connection.');
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
