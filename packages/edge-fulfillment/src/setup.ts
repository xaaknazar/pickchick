import { transaction } from '@pickchick/database';
import type { DatabasePool, DatabaseClient } from '@pickchick/database';
import { z } from 'zod';
import { SetupSchema, parse, digest, FulfillmentError, CloudScopeSchema } from './model.js';
import type { TrustedCloud } from './model.js';

export async function boundary(client: DatabaseClient, input: TrustedCloud) {
  const scope = parse(CloudScopeSchema, input);
  const row = (
    await client.query('SELECT * FROM fulfillment_config WHERE branch_id=$1 FOR SHARE', [
      scope.branchId,
    ])
  ).rows[0];
  if (
    !row ||
    row.organization_id !== scope.organizationId ||
    row.device_id !== scope.deviceId ||
    row.cloud_producer_id !== scope.producerId
  )
    throw new FulfillmentError('FORBIDDEN');
  return row;
}
/** Trusted local provisioning only. No remote/public setup route is supplied. */
export async function provisionFulfillmentInTransaction(client: DatabaseClient, input: unknown) {
  const config = parse(SetupSchema, input);
  const stations = new Map(config.stations.map((s) => [s.id, s]));
  if (
    stations.size !== config.stations.length ||
    stations.get(config.routing.assemblyStationId)?.kind !== 'assembly' ||
    new Set(config.routing.routes.map((r) => r.productId)).size !== config.routing.routes.length
  )
    throw new FulfillmentError('INVALID');
  for (const route of config.routing.routes)
    if (stations.get(route.stationId)?.kind !== (route.kind === 'prep' ? 'prep' : 'assembly'))
      throw new FulfillmentError('INVALID');
  await client.query(
    'INSERT INTO fulfillment_config(branch_id,organization_id,device_id,cloud_producer_id,active_routing_version) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
    [
      config.branchId,
      config.organizationId,
      config.deviceId,
      config.producerId,
      config.routing.version,
    ],
  );
  const row = (
    await client.query('SELECT * FROM fulfillment_config WHERE branch_id=$1 FOR UPDATE', [
      config.branchId,
    ])
  ).rows[0];
  if (
    !row ||
    row.organization_id !== config.organizationId ||
    row.device_id !== config.deviceId ||
    row.cloud_producer_id !== config.producerId ||
    row.active_routing_version > config.routing.version
  )
    throw new FulfillmentError('CONFLICT');
  for (const station of config.stations) {
    await client.query(
      'INSERT INTO fulfillment_stations(branch_id,id,kind,name) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [config.branchId, station.id, station.kind, station.name],
    );
    const saved = (
      await client.query(
        'SELECT kind,name FROM fulfillment_stations WHERE branch_id=$1 AND id=$2',
        [config.branchId, station.id],
      )
    ).rows[0];
    if (saved?.kind !== station.kind || saved?.name !== station.name)
      throw new FulfillmentError('CONFLICT');
  }
  const hash = digest(config.routing);
  await client.query(
    'INSERT INTO fulfillment_routing(branch_id,version,payload,payload_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [config.branchId, config.routing.version, config.routing, hash],
  );
  const saved = (
    await client.query(
      'SELECT payload_hash FROM fulfillment_routing WHERE branch_id=$1 AND version=$2',
      [config.branchId, config.routing.version],
    )
  ).rows[0];
  if (saved?.payload_hash !== hash) throw new FulfillmentError('CONFLICT');
  await client.query('UPDATE fulfillment_config SET active_routing_version=$2 WHERE branch_id=$1', [
    config.branchId,
    config.routing.version,
  ]);
}
export function provisionFulfillment(pool: DatabasePool, input: unknown) {
  return transaction(pool, (client) => provisionFulfillmentInTransaction(client, input));
}
/** Local provisioner grants stations to existing kitchen staff, never caller role claims. */
export async function grantStationInTransaction(
  client: DatabaseClient,
  branchId: string,
  staffId: string,
  stationId: string,
) {
  for (const id of [branchId, staffId, stationId]) parse(z.uuid(), id);
  const staff = (
    await client.query(
      "SELECT 1 FROM local_staff WHERE id=$1 AND branch_id=$2 AND role='kitchen' AND active FOR SHARE",
      [staffId, branchId],
    )
  ).rowCount;
  if (!staff) throw new FulfillmentError('FORBIDDEN');
  await client.query(
    'INSERT INTO fulfillment_station_grants(branch_id,staff_id,station_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [branchId, staffId, stationId],
  );
}
export function grantStation(
  pool: DatabasePool,
  branchId: string,
  staffId: string,
  stationId: string,
) {
  return transaction(pool, (client) =>
    grantStationInTransaction(client, branchId, staffId, stationId),
  );
}
