import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';

async function provision() {
  const config = loadConfig('api');
  if (config.environment !== 'staging') throw new Error('Staging only');
  const owner = new URL(config.databaseUrl);
  if (owner.username !== 'pickchick_owner') throw new Error('Owner role required');
  const adminPassword = process.env.DB_ADMIN_PASSWORD;
  const appPassword = process.env.DB_APP_PASSWORD;
  if (![adminPassword, appPassword].every((s) => /^[a-f0-9]{64}$/.test(s ?? '')))
    throw new Error('Invalid provisioning secrets');
  const adminUrl = new URL(owner);
  adminUrl.username = 'postgres';
  adminUrl.password = adminPassword;
  const admin = createPool(adminUrl.href);
  try {
    // Password interpolation is restricted to 64 hex characters, never printed.
    for (const [role, password] of [
      ['pickchick_owner', owner.password],
      ['pickchick_app', appPassword],
    ]) {
      if (!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount)
        await admin.query(
          `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
        );
    }
    await admin.query('REVOKE ALL ON DATABASE pickchick_cloud FROM PUBLIC');
    await admin.query(
      'GRANT CONNECT ON DATABASE pickchick_cloud TO pickchick_owner, pickchick_app',
    );
    await admin.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await admin.query('GRANT USAGE, CREATE ON SCHEMA public TO pickchick_owner');
    await admin.query('GRANT USAGE ON SCHEMA public TO pickchick_app');
  } finally {
    await admin.end();
  }
  const pool = createPool(config.databaseUrl);
  try {
    const applied = await migrate(
      pool,
      fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url)),
      'cloud',
    );
    // Runtime may read current cloud state and acknowledge menu delivery. It cannot
    // provision devices, publish menus, mutate the catalogue or execute DDL.
    await pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO pickchick_app;
      GRANT UPDATE (id) ON branches, devices TO pickchick_app;
      GRANT UPDATE (device_id) ON device_credentials TO pickchick_app;
      GRANT UPDATE (attempts, acknowledged_at) ON outbox_events TO pickchick_app;
      GRANT INSERT, UPDATE ON branch_menu_activations TO pickchick_app;
      GRANT INSERT ON inbox_messages TO pickchick_app;`);
    console.log(JSON.stringify({ event: 'staging_provisioned', applied }));
  } finally {
    await pool.end();
  }
}
try {
  await provision();
} catch {
  console.error(JSON.stringify({ event: 'staging_provision_failed' }));
  process.exitCode = 1;
}
