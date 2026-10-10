import { transaction } from '@pickchick/database';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { CloudKitchenError, SetupSchema, digest, parse } from './model.js';

/**
 * Trusted provisioning of cloud kitchen stations and routing (owner role, no HTTP route).
 * Same validation as edge `provisionFulfillment`: unique stations, the assembly station is of
 * kind assembly, every route points at a station of the matching kind. Routing versions are
 * immutable and only move forward; a station keeps its kind and name.
 */
export async function provisionCloudKitchenInTransaction(client: DatabaseClient, input: unknown) {
  const config = parse(SetupSchema, input);
  const stations = new Map(config.stations.map((s) => [s.id, s]));
  if (
    stations.size !== config.stations.length ||
    stations.get(config.routing.assemblyStationId)?.kind !== 'assembly' ||
    new Set(config.routing.routes.map((r) => r.productId)).size !== config.routing.routes.length
  )
    throw new CloudKitchenError('INVALID');
  for (const route of config.routing.routes)
    if (stations.get(route.stationId)?.kind !== (route.kind === 'prep' ? 'prep' : 'assembly'))
      throw new CloudKitchenError('INVALID');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'cloud_kitchen:config:' + config.branchId,
  ]);
  const active = (
    await client.query<{ active_routing_version: number }>(
      'SELECT active_routing_version FROM cloud_kitchen_config WHERE branch_id=$1 FOR UPDATE',
      [config.branchId],
    )
  ).rows[0];
  if (active && active.active_routing_version > config.routing.version)
    throw new CloudKitchenError('CONFLICT');
  for (const station of config.stations) {
    await client.query(
      'INSERT INTO cloud_kitchen_stations(branch_id,id,kind,name) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [config.branchId, station.id, station.kind, station.name],
    );
    const saved = (
      await client.query(
        'SELECT kind,name FROM cloud_kitchen_stations WHERE branch_id=$1 AND id=$2',
        [config.branchId, station.id],
      )
    ).rows[0];
    if (saved?.kind !== station.kind || saved?.name !== station.name)
      throw new CloudKitchenError('CONFLICT');
  }
  const hash = digest(config.routing);
  await client.query(
    'INSERT INTO cloud_kitchen_routing(branch_id,version,assembly_station_id,payload,payload_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
    [
      config.branchId,
      config.routing.version,
      config.routing.assemblyStationId,
      config.routing,
      hash,
    ],
  );
  const saved = (
    await client.query(
      'SELECT payload_hash FROM cloud_kitchen_routing WHERE branch_id=$1 AND version=$2',
      [config.branchId, config.routing.version],
    )
  ).rows[0];
  if (saved?.payload_hash !== hash) throw new CloudKitchenError('CONFLICT');
  await client.query(
    `INSERT INTO cloud_kitchen_config(branch_id,active_routing_version) VALUES($1,$2)
     ON CONFLICT(branch_id) DO UPDATE SET active_routing_version=EXCLUDED.active_routing_version,updated_at=clock_timestamp()`,
    [config.branchId, config.routing.version],
  );
}
export function provisionCloudKitchen(pool: DatabasePool, input: unknown) {
  return transaction(pool, (client) => provisionCloudKitchenInTransaction(client, input));
}
