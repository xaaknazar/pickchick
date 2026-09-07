import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { provisionFulfillmentTransport } from '@pickchick/fulfillment-transport';

// Explicit local operator setup only. No device credentials are created or printed.
const config = loadConfig('api');
const deviceId = process.argv[2],
  producerId = process.argv[3];
const pool = createPool(config.databaseUrl);
try {
  if (!/^[a-f0-9-]{36}$/.test(deviceId ?? '') || !/^[a-f0-9-]{36}$/.test(producerId ?? ''))
    throw new Error();
  const row = (
    await pool.query(
      "SELECT organization_id,branch_id FROM devices WHERE id=$1 AND kind='edge' AND status='active'",
      [deviceId],
    )
  ).rows[0];
  if (!row) throw new Error();
  await provisionFulfillmentTransport(pool, {
    organizationId: row.organization_id,
    branchId: row.branch_id,
    deviceId,
    producerId,
  });
  console.log(
    JSON.stringify({
      event: 'fulfillment_transport_binding_saved',
      device_id: deviceId,
      branch_id: row.branch_id,
    }),
  );
} catch {
  console.error(JSON.stringify({ event: 'fulfillment_transport_setup_failed' }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
