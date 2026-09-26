import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';

/** Explicit edge-only install command. Never reads cloud configuration or seeds data. */
export function edgeInstallConfig(env = process.env) {
  const config = loadConfig('edge', env);
  const url = new URL(config.databaseUrl);
  if (url.search || url.hash || !url.username || !url.password)
    throw new Error('Dedicated edge owner connection without URL overrides required');
  return config;
}

export async function migrateEdge(env = process.env) {
  const pool = createPool(edgeInstallConfig(env).databaseUrl, 1);
  try {
    return await migrate(
      pool,
      fileURLToPath(new URL('../db/edge/migrations/', import.meta.url)),
      'edge',
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('No arguments accepted');
    console.log(JSON.stringify({ event: 'edge_migrated', applied: await migrateEdge() }));
  } catch {
    console.error(JSON.stringify({ event: 'edge_migration_failed' }));
    process.exitCode = 1;
  }
}
