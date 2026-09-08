import { createPool } from '@pickchick/database';
import { grantBackoffice } from '@pickchick/backoffice-core';
const args = process.argv.slice(2);
if (args.length !== 6 || args[0] !== '--actor' || args[2] !== '--branch' || args[4] !== '--role')
  throw new Error('Usage: --actor UUID --branch UUID --role manager|analyst');
const url = process.env.CLOUD_DATABASE_URL;
if (!url) throw new Error('CLOUD_DATABASE_URL required');
const pool = createPool(url);
try {
  await grantBackoffice(pool, args[1], args[3], args[5]);
  console.log(
    'Backoffice branch grant recorded. Existing private manager credential remains unchanged.',
  );
} finally {
  await pool.end();
}
