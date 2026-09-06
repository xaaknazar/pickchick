import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';

for (const [scope, service] of [
  ['cloud', 'api'],
  ['edge', 'edge'],
]) {
  const config = loadConfig(service);
  const pool = createPool(config.databaseUrl);
  try {
    const directory = fileURLToPath(new URL(`../db/${scope}/migrations/`, import.meta.url));
    const applied = await migrate(pool, directory, scope);
    console.log(JSON.stringify({ scope, applied }));
  } finally {
    await pool.end();
  }
}
