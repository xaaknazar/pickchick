import { transaction } from '@pickchick/database';
import type { DatabasePool, DatabaseClient } from '@pickchick/database';
import { z } from 'zod';
import { SetupSchema, parse, digest, FulfillmentError, CloudScopeSchema } from './model.js';
import type { TrustedCloud } from './model.js';
import { KDS_STATIONS, kdsStationId } from './kds.js';
import type { KdsFunction } from './kds.js';

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

export type KdsProvisioning = {
  stations: { id: string; function: KdsFunction; kind: 'prep' | 'assembly'; name: string }[];
  stationsAdded: number;
  /** Active kitchen identity with the shared login `kitchen`, or null when none is enrolled. */
  kitchenStaffId: string | null;
  grantsAdded: number;
  settingsCreated: boolean;
};
/**
 * Trusted local provisioning of the six KDS stations (contracts section 2.3, schema027), run by
 * the guarded upgrade tool inside its transaction. Idempotent: an existing station with the same
 * id must have the same kind and name (else CONFLICT), existing stations, routes and grants are
 * never changed or removed (the old "Приготовление"/"Сборка" stay for rollback). Grants all six
 * to the active kitchen identity whose login is `kitchen`, and creates the kds_settings row
 * switched off with its audit row. Never enables the layout and never touches orders.
 */
export async function provisionKdsStations(
  client: DatabaseClient,
  branchId: string,
): Promise<KdsProvisioning> {
  parse(z.uuid(), branchId);
  const schema = (
    await client.query(
      "SELECT to_regclass('kds_settings') IS NOT NULL AND to_regclass('kds_setting_changes') IS NOT NULL AS ready",
    )
  ).rows[0];
  if (!schema?.ready) throw new FulfillmentError('NOT_READY');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'pickchick-kds-provision:' + branchId,
  ]);
  const config = await client.query(
    'SELECT 1 FROM fulfillment_config WHERE branch_id=$1 FOR SHARE',
    [branchId],
  );
  if (!config.rowCount) throw new FulfillmentError('NOT_READY');
  const stations: KdsProvisioning['stations'] = [];
  let stationsAdded = 0;
  for (const spec of KDS_STATIONS) {
    const id = kdsStationId(branchId, spec.function);
    stationsAdded += (
      await client.query(
        'INSERT INTO fulfillment_stations(branch_id,id,kind,name) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [branchId, id, spec.kind, spec.name],
      )
    ).rowCount!;
    const saved = (
      await client.query(
        'SELECT kind,name FROM fulfillment_stations WHERE branch_id=$1 AND id=$2 FOR SHARE',
        [branchId, id],
      )
    ).rows[0];
    if (saved?.kind !== spec.kind || saved?.name !== spec.name)
      throw new FulfillmentError('CONFLICT');
    stations.push({ id, function: spec.function, kind: spec.kind, name: spec.name });
  }
  const kitchen = (
    await client.query(
      `SELECT s.id FROM local_staff s JOIN local_staff_passwords p ON p.staff_id=s.id AND p.branch_id=s.branch_id
       WHERE s.branch_id=$1 AND s.active AND s.role='kitchen' AND p.login='kitchen' FOR SHARE OF s`,
      [branchId],
    )
  ).rows[0] as { id: string } | undefined;
  let grantsAdded = 0;
  if (kitchen)
    for (const station of stations)
      grantsAdded += (
        await client.query(
          'INSERT INTO fulfillment_station_grants(branch_id,staff_id,station_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [branchId, kitchen.id, station.id],
        )
      ).rowCount!;
  const settings = await client.query('SELECT 1 FROM kds_settings WHERE branch_id=$1 FOR UPDATE', [
    branchId,
  ]);
  let settingsCreated = false;
  if (!settings.rowCount) {
    const reason = 'Станции KDS созданы, раскладка выключена';
    // Audit row first: the settings row's deferred foreign key needs it at commit.
    await client.query(
      `INSERT INTO kds_setting_changes(command_id,branch_id,version,field,value,actor,reason,request_hash)
       VALUES(gen_random_uuid(),$1,1,'provisioned',NULL,'operator',$2,$3)`,
      [branchId, reason, digest({ branchId, field: 'provisioned', reason })],
    );
    await client.query(
      "INSERT INTO kds_settings(branch_id,layout_enabled,shift_mode,version) VALUES($1,false,'normal',1)",
      [branchId],
    );
    settingsCreated = true;
  }
  return {
    stations,
    stationsAdded,
    kitchenStaffId: kitchen?.id ?? null,
    grantsAdded,
    settingsCreated,
  };
}
