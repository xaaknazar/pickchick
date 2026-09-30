import { mkdir, lstat, open, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { UuidSchema } from '@pickchick/contracts';
import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { provisionTestActor, revokeTestActor } from '@pickchick/test-order-flow';

const directory = new URL('../.local/test-flow-staff/', import.meta.url);
let pool;
try {
  const role = process.argv[2];
  if (process.argv.length !== 3 || !['prep', 'assembly', 'display', 'manager'].includes(role))
    throw new Error('Expected one TEST staff role');
  const config = loadConfig('api');
  const flow = {
    enabled: config.testOrderFlowEnabled === true,
    environment: config.environment,
  };
  if (!flow.enabled) throw new Error('TEST flow is not enabled');
  if (
    config.environment === 'staging' &&
    new URL(config.databaseUrl).username !== 'pickchick_owner'
  )
    throw new Error('Trusted owner connection required');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error('Private TEST staff directory required');

  pool = createPool(config.databaseUrl);
  const credential = await provisionTestActor(pool, flow, role);
  const actorId = UuidSchema.parse(credential.actor_id);
  const file = new URL(`${role}-${actorId}.json`, directory);
  let created = false;
  try {
    const handle = await open(file, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(`${JSON.stringify(credential)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await revokeTestActor(pool, flow, actorId);
    if (created) await rm(file, { force: true });
    throw error;
  }
  // The token is intentionally never printed; read the protected file locally.
  console.log(fileURLToPath(file));
} catch {
  console.error(
    'TEST staff setup failed. Check feature gate, owner database access, role and private directory permissions. Credential values are omitted.',
  );
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
