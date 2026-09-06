import { readFile, stat } from 'node:fs/promises';
import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { publishMenu } from '@pickchick/menu-sync';

const pool = createPool(loadConfig('api').databaseUrl);
try {
  const file = process.argv[2];
  if (!file || (await stat(file)).size > 2_000_000)
    throw new Error('Expected bounded menu JSON file');
  const event = await publishMenu(pool, JSON.parse(await readFile(file, 'utf8')));
  console.log(
    JSON.stringify({
      event: 'menu_queued',
      event_id: event.event_id,
      release_id: event.aggregate_id,
      version: event.aggregate_version,
      branch_id: event.branch_id,
      activation: 'requires_edge_ack',
    }),
  );
} catch {
  console.error(
    'Menu publication failed; check schema, release identity, next version and database.',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
