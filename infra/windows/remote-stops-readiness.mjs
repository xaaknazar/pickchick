/** Read-only schema020 continuation. Never delivers, acknowledges or applies a command. */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashJson } from '@pickchick/menu-sync';
import { foundationCredentials } from './menu-sync-upgrade-db.mjs';
import { assertRemoteStopPrivileges } from './remote-stops-upgrade-db.mjs';

export async function inspectRemoteStops(client, { branchId, deviceId, expectedLedger, ...roles }) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const ledger = (
      await client.query('SELECT scope,version,checksum FROM schema_migrations ORDER BY version')
    ).rows;
    if (expectedLedger.length !== 20 || JSON.stringify(ledger) !== JSON.stringify(expectedLedger))
      throw new Error('Exact schema020 ledger required');
    const binding = (
      await client.query(
        'SELECT b.id branch_id,f.device_id FROM branch_config b JOIN fulfillment_config f ON f.branch_id=b.id',
      )
    ).rows;
    if (
      binding.length !== 1 ||
      binding[0].branch_id !== branchId ||
      binding[0].device_id !== deviceId
    )
      throw new Error('Branch/device binding differs');
    await assertRemoteStopPrivileges(client, roles);
    const rows = (
      await client.query(
        `SELECT m.id,m.version,m.checksum,m.payload,r.result,r.version result_version,
      EXISTS(SELECT 1 FROM outbox_events o WHERE o.branch_id=a.branch_id AND o.aggregate_id=m.id
        AND o.event_type='menu.applied' AND o.acknowledged_at IS NOT NULL
        AND o.payload->>'release_id'=m.id::text AND o.payload->>'checksum'=m.checksum
        AND COALESCE(o.payload->>'result','applied')='applied') acked
      FROM active_menu a JOIN menu_snapshots m ON m.id=a.release_id AND m.branch_id=a.branch_id
      LEFT JOIN menu_apply_results r ON r.release_id=m.id AND r.branch_id=a.branch_id WHERE a.branch_id=$1`,
        [branchId],
      )
    ).rows;
    const menu = rows[0];
    if (
      rows.length !== 1 ||
      menu.result !== 'applied' ||
      menu.result_version !== menu.version ||
      !menu.acked ||
      hashJson(menu.payload) !== menu.checksum
    )
      throw new Error('A verified applied and acknowledged menu is required');
    const pending = (
      await client.query(
        `SELECT
      (SELECT count(*)::int FROM outbox_events WHERE branch_id=$1 AND event_type='menu.applied' AND acknowledged_at IS NULL) menu,
      (SELECT count(*)::int FROM remote_stop_commands WHERE branch_id=$1 AND state='received') stops`,
        [branchId],
      )
    ).rows[0];
    if (pending.menu !== 0 || pending.stops !== 0)
      throw new Error('Pending menu ACK or stop command; activation is not side-effect free');
    return {
      branch_id: branchId,
      edge_device_id: deviceId,
      schema: 20,
      grants_verified: true,
      menu_release_id: menu.id,
      menu_version: menu.version,
      menu_hash: menu.checksum,
      pending_menu_acks: 0,
      pending_stop_commands: 0,
      read_only: true,
    };
  } finally {
    await client.query('ROLLBACK');
  }
}
async function main() {
  const [toolsRoot, appRoot, branchId, deviceId, ...extra] = process.argv.slice(2);
  if (
    process.platform !== 'win32' ||
    extra.length ||
    ![toolsRoot, appRoot].every((x) => win32.isAbsolute(x ?? ''))
  )
    throw new Error('Windows setup invocation required');
  const credentials = foundationCredentials(
    JSON.parse(await readFile(join(toolsRoot, 'private/foundation-credentials.json'), 'utf8')),
    branchId,
  );
  const state = JSON.parse(
    await readFile(join(toolsRoot, 'private/foundation-state.json'), 'utf8'),
  );
  if (!state.complete || state.installId !== credentials.installId || state.branchId !== branchId)
    throw new Error('Foundation differs');
  const { Client } = createRequire(join(toolsRoot, 'package.json'))('pg');
  const connect = async (user) => {
    const c = new Client({
      host: '127.0.0.1',
      port: 55433,
      database: 'pickchick_edge',
      user,
      password: credentials.passwords[user],
      ssl: false,
      connectionTimeoutMillis: 3000,
      statement_timeout: 30000,
      application_name: 'pickchick-remote-stops-readiness',
    });
    c.on('error', () => {});
    await c.connect();
    return c;
  };
  let admin, owner;
  try {
    admin = await connect('pickchick_bootstrap');
    await admin.query('BEGIN READ ONLY');
    const cluster = (
      await admin.query(
        "SELECT system_identifier::text id,current_setting('data_directory') directory FROM pg_control_system()",
      )
    ).rows[0];
    await admin.query('ROLLBACK');
    if (
      cluster.id !== state.systemIdentifier ||
      cluster.directory.replaceAll('\\', '/').toLowerCase() !==
        resolve(toolsRoot, '../../Postgres/18/data').replaceAll('\\', '/').toLowerCase()
    )
      throw new Error('Cluster differs');
    const expectedLedger = [];
    for (const version of (await readdir(join(appRoot, 'db/edge/migrations')))
      .filter((x) => x.endsWith('.sql'))
      .sort())
      expectedLedger.push({
        scope: 'edge',
        version,
        checksum: createHash('sha256')
          .update(await readFile(join(appRoot, 'db/edge/migrations', version)))
          .digest('hex'),
      });
    owner = await connect('pickchick_edge_owner');
    console.log(
      JSON.stringify(await inspectRemoteStops(owner, { branchId, deviceId, expectedLedger })),
    );
  } finally {
    await Promise.allSettled([owner?.end(), admin?.end()]);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error('Remote stop readiness failed; inspect protected state. No command was sent.');
    process.exitCode = 1;
  });
