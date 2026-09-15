import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MenuSnapshotSchema, UuidSchema } from '@pickchick/contracts';
import { createPool, transaction } from '@pickchick/database';
import {
  SetupSchema,
  digest,
  provisionFulfillmentInTransaction,
  grantStationInTransaction,
} from '@pickchick/edge-fulfillment';
import { edgeInstallConfig } from './edge-migrate.mjs';
import { assertPrivateStaffPath } from './staff-file-permissions.mjs';

const keys = (value, allowed) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === allowed.slice().sort().join(',');
export function localPosServiceInput(input) {
  if (
    !keys(input, [
      'format',
      'confirmation',
      'branch_id',
      'menu_release_id',
      'operator_staff_id',
      'expected_ordering_version',
      'fulfillment',
      'station_grants',
    ]) ||
    input.format !== 'pickchick-local-pos-service-v1' ||
    input.confirmation !== 'owner_authorized_unpaid_service'
  )
    throw new Error('Explicit local unpaid service setup required');
  const result = JSON.parse(JSON.stringify(input));
  for (const field of ['branch_id', 'menu_release_id', 'operator_staff_id'])
    UuidSchema.parse(result[field]);
  if (
    !Number.isInteger(result.expected_ordering_version) ||
    result.expected_ordering_version < 1 ||
    result.expected_ordering_version >= 2147483647
  )
    throw new Error('Expected ordering version required');
  result.fulfillment = SetupSchema.parse(result.fulfillment);
  if (
    result.fulfillment.branchId !== result.branch_id ||
    !Array.isArray(result.station_grants) ||
    !result.station_grants.length ||
    result.station_grants.length > 200
  )
    throw new Error('Matching local fulfillment and explicit station grants required');
  const stations = new Set(result.fulfillment.stations.map((s) => s.id)),
    grants = new Set();
  for (const grant of result.station_grants) {
    if (!keys(grant, ['staff_id', 'station_id'])) throw new Error('Invalid station grant');
    UuidSchema.parse(grant.staff_id);
    UuidSchema.parse(grant.station_id);
    const key = grant.staff_id + ':' + grant.station_id;
    if (!stations.has(grant.station_id) || grants.has(key))
      throw new Error('Invalid station grant');
    grants.add(key);
  }
  if ([...stations].some((id) => !result.station_grants.some((g) => g.station_id === id)))
    throw new Error('Every station needs an explicitly assigned kitchen employee');
  return result;
}

/** Owner-only prepare/enable. The web service never calls this provisioning port.
 * Prepare never opens ordering or changes mode. Enable is a separate invocation. */
export async function configureLocalPosService(pool, action, raw) {
  if (!['prepare', 'enable'].includes(action)) throw new Error('Expected prepare or enable');
  const input = localPosServiceInput(raw),
    hash = digest(input),
    branchId = input.branch_id;
  return transaction(pool, async (client) => {
    const ledger = await client.query(
      "SELECT 1 FROM schema_migrations WHERE scope='edge' AND version='012_edge_pos_unpaid_fulfillment.sql'",
    );
    if (ledger.rowCount !== 1) throw new Error('Edge migration 012 required');
    const branches = (await client.query('SELECT * FROM branch_config FOR UPDATE')).rows;
    const branch = branches.find((b) => b.id === branchId);
    if (branches.length !== 1 || !branch) throw new Error('Dedicated branch binding required');
    const actor = await client.query(
      "SELECT 1 FROM local_staff WHERE id=$1 AND branch_id=$2 AND role='shift_manager' AND active AND access_expires_at>clock_timestamp() FOR SHARE",
      [input.operator_staff_id, branchId],
    );
    if (!actor.rowCount) throw new Error('Existing active local manager required');
    const menuRow = (
      await client.query(
        'SELECT s.payload FROM active_menu a JOIN menu_snapshots s ON s.id=a.release_id AND s.branch_id=a.branch_id WHERE a.branch_id=$1 AND a.release_id=$2',
        [branchId, input.menu_release_id],
      )
    ).rows[0];
    if (!menuRow) throw new Error('Exact existing reviewed menu release required');
    const menu = MenuSnapshotSchema.parse(menuRow.payload),
      routes = new Set(input.fulfillment.routing.routes.map((r) => r.productId));
    if (menu.items.some((item) => !routes.has(item.product_id)))
      throw new Error('Routing must cover every active menu product');
    const saved = (
      await client.query('SELECT * FROM local_pos_service_setup WHERE branch_id=$1 FOR UPDATE', [
        branchId,
      ])
    ).rows[0];
    if (saved && saved.setup_hash !== hash)
      throw new Error('A different local preparation already exists');
    const verifyPreparation = async () => {
      const config = (
        await client.query('SELECT * FROM fulfillment_config WHERE branch_id=$1 FOR SHARE', [
          branchId,
        ])
      ).rows[0];
      if (
        !config ||
        config.organization_id !== input.fulfillment.organizationId ||
        config.device_id !== input.fulfillment.deviceId ||
        config.cloud_producer_id !== input.fulfillment.producerId ||
        config.active_routing_version !== input.fulfillment.routing.version
      )
        throw new Error('Prepared fulfillment binding changed');
      const routing = (
        await client.query(
          'SELECT payload_hash FROM fulfillment_routing WHERE branch_id=$1 AND version=$2',
          [branchId, config.active_routing_version],
        )
      ).rows[0];
      if (routing?.payload_hash !== digest(input.fulfillment.routing))
        throw new Error('Prepared routing changed');
      for (const grant of input.station_grants) {
        const assigned = await client.query(
          `SELECT 1 FROM fulfillment_station_grants g JOIN local_staff s ON s.id=g.staff_id AND s.branch_id=g.branch_id
          WHERE g.branch_id=$1 AND g.staff_id=$2 AND g.station_id=$3 AND s.role='kitchen' AND s.active AND s.access_expires_at>clock_timestamp() FOR SHARE OF g,s`,
          [branchId, grant.staff_id, grant.station_id],
        );
        if (!assigned.rowCount) throw new Error('Prepared kitchen staff or station access changed');
      }
    };
    if (saved?.enabled_at) {
      await verifyPreparation();
      if (
        branch.pos_service_mode !== 'unpaid_service' ||
        !branch.ordering_enabled ||
        branch.ordering_version !== input.expected_ordering_version + 1
      )
        throw new Error('Already enabled setup has since changed; do not reopen it automatically');
      return {
        stage: 'enabled',
        branch_id: branchId,
        setup_hash: hash,
        replayed: true,
        ordering_enabled: true,
      };
    }
    if (
      branch.ordering_enabled ||
      branch.ordering_version !== input.expected_ordering_version ||
      branch.pos_service_mode !== 'payment_required'
    )
      throw new Error('Closed unchanged ordering required');
    if (
      (
        await client.query(
          "SELECT 1 FROM fulfillment_reservations WHERE branch_id=$1 AND state NOT IN('handed_over','cancelled','released') LIMIT 1",
          [branchId],
        )
      ).rowCount
    )
      throw new Error('Finish existing kitchen work before preparing local service');
    if (action === 'prepare') {
      if (!saved) {
        await provisionFulfillmentInTransaction(client, input.fulfillment);
        for (const grant of input.station_grants)
          await grantStationInTransaction(client, branchId, grant.staff_id, grant.station_id);
        await client.query(
          'INSERT INTO local_pos_service_setup(branch_id,setup_hash,menu_release_id,routing_version,expected_ordering_version,operator_staff_id) VALUES($1,$2,$3,$4,$5,$6)',
          [
            branchId,
            hash,
            input.menu_release_id,
            input.fulfillment.routing.version,
            input.expected_ordering_version,
            input.operator_staff_id,
          ],
        );
        await client.query(
          "INSERT INTO local_audit(id,branch_id,staff_id,action,resource_id) VALUES(gen_random_uuid(),$1,$2,'local.unpaid_service_prepared',$1)",
          [branchId, input.operator_staff_id],
        );
      }
      await verifyPreparation();
      return {
        stage: 'prepared',
        branch_id: branchId,
        setup_hash: hash,
        replayed: !!saved,
        ordering_enabled: false,
      };
    }
    if (!saved) throw new Error('Run prepare with the same reviewed file first');
    await verifyPreparation();
    await client.query(
      "UPDATE branch_config SET pos_service_mode='unpaid_service',ordering_enabled=true,ordering_version=ordering_version+1 WHERE id=$1",
      [branchId],
    );
    await client.query(
      'UPDATE local_pos_service_setup SET enabled_at=clock_timestamp() WHERE branch_id=$1',
      [branchId],
    );
    await client.query(
      "INSERT INTO local_audit(id,branch_id,staff_id,action,resource_id) VALUES(gen_random_uuid(),$1,$2,'local.unpaid_service_enabled',$1)",
      [branchId, input.operator_staff_id],
    );
    return {
      stage: 'enabled',
      branch_id: branchId,
      setup_hash: hash,
      replayed: false,
      ordering_enabled: true,
    };
  });
}

export function localPosServiceConfig(env = process.env, action = 'prepare') {
  const config = edgeInstallConfig(env),
    url = new URL(config.databaseUrl);
  if (
    config.environment !== 'local' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '55433' ||
    url.pathname !== '/pickchick_edge' ||
    decodeURIComponent(url.username) !== 'pickchick_edge_owner' ||
    (action === 'enable' && config.edgeFulfillmentEnabled !== true)
  )
    throw new Error('Explicit local owner and enabled fulfillment host configuration required');
  return config;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let pool;
  try {
    const [action, path, ...extra] = process.argv.slice(2);
    if (!['prepare', 'enable'].includes(action) || !path || extra.length)
      throw new Error('Expected action and private setup file');
    const config = localPosServiceConfig(process.env, action);
    await assertPrivateStaffPath(path, 'file');
    const file = await open(path, 'r');
    let bytes;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 256 * 1024) throw new Error('Bounded setup file required');
      bytes = await file.readFile();
    } finally {
      await file.close();
    }
    await assertPrivateStaffPath(path, 'file');
    const input = localPosServiceInput(JSON.parse(bytes.toString('utf8')));
    if (
      input.branch_id !== config.branchId ||
      (config.edgeDeviceId && input.fulfillment.deviceId !== config.edgeDeviceId)
    )
      throw new Error('Host binding mismatch');
    pool = createPool(config.databaseUrl, 1);
    const result = await configureLocalPosService(pool, action, input);
    console.log(
      JSON.stringify({
        event: 'local_pos_service_configured',
        ...result,
        payments_enabled: false,
        fiscal_enabled: false,
      }),
    );
  } catch {
    console.error(JSON.stringify({ event: 'local_pos_service_configuration_failed' }));
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
  }
}
