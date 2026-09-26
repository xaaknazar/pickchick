import { createPool } from '@pickchick/database';
import { CustomerIdentity } from '@pickchick/customer-identity';
import { createPhoneCodeDelivery } from '@pickchick/phone-verification';
import { loadConfig } from '@pickchick/platform';
import { UuidSchema } from '@pickchick/contracts';

// Trusted operator process: no public maintenance routes and no SMS delivery dependency.
async function main() {
  const [command, sessionId, extra] = process.argv.slice(2);
  if (
    extra ||
    !['cleanup', 'revoke-session'].includes(command) ||
    (command === 'cleanup' && sessionId) ||
    (command === 'revoke-session' && !UuidSchema.safeParse(sessionId).success)
  )
    throw new Error('Use cleanup or revoke-session <uuid>');
  const config = loadConfig('api');
  const pool = createPool(config.databaseUrl, 1);
  try {
    const identity = new CustomerIdentity(pool, { enabled: false }, createPhoneCodeDelivery({}));
    if (command === 'cleanup') await identity.cleanup();
    else await identity.revokeSession(sessionId);
    console.log(
      JSON.stringify({ event: 'customer_identity_maintenance_completed', operation: command }),
    );
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error(JSON.stringify({ event: 'customer_identity_maintenance_failed' }));
  process.exitCode = 1;
});
