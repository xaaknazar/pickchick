import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from '@pickchick/database';
import type { Snapshot, TaskPlan } from './model.js';
export type State =
  | 'held'
  | 'accepted'
  | 'in_production'
  | 'ready'
  | 'handed_over'
  | 'cancel_requested'
  | 'cancelled'
  | 'released';
export interface Reservation {
  order_id: string;
  branch_id: string;
  commercial_owner: 'cloud' | 'edge_pos';
  admission_kind: 'cloud_authorized' | 'unpaid_service';
  reservation_id: string;
  quote_id: string;
  quote_hash: string;
  owner_hash: string;
  device_id: string;
  snapshot: Snapshot;
  routing_version: number;
  task_plan: TaskPlan[];
  assembly_station_id: string;
  version: number;
  state: State;
  display_number: string | null;
  business_day: string | null;
  authorized_event_id: string | null;
  created_at: Date;
  updated_at: Date;
  cancellation_reason: string | null;
  inventory_disposition: string | null;
}
export interface Task {
  id: string;
  branch_id: string;
  order_id: string;
  station_id: string;
  version: number;
  state: 'queued' | 'in_progress' | 'done' | 'cancel_requested' | 'cancelled';
  kind: 'prep' | 'assembly_item';
  details: TaskPlan['details'];
}
export function view(row: Reservation) {
  return {
    orderId: row.order_id,
    branchId: row.branch_id,
    reservationId: row.reservation_id,
    quoteId: row.quote_id,
    quoteDigest: row.quote_hash,
    ownerHash: row.owner_hash,
    commercialOwner: row.commercial_owner,
    ...(row.commercial_owner === 'edge_pos' ? { executionMode: 'unpaid_service' as const } : {}),
    fulfillmentOwner: 'edge' as const,
    deviceId: row.device_id,
    version: row.version,
    state: row.state,
    displayNumber: row.display_number,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    routingVersion: row.routing_version,
    assemblyStationId: row.assembly_station_id,
  };
}
export async function emit(
  client: DatabaseClient,
  row: Reservation,
  type: string,
  extra: Record<string, unknown> = {},
) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO fulfillment_outbox(event_id,branch_id,order_id,aggregate_version,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)`,
    [id, row.branch_id, row.order_id, row.version, type, { ...view(row), ...extra }],
  );
  return id;
}
export async function advance(
  client: DatabaseClient,
  row: Reservation,
  state: State,
  type: string,
  extra: Record<string, unknown> = {},
) {
  const next = (
    await client.query<Reservation>(
      'UPDATE fulfillment_reservations SET state=$2,version=version+1,updated_at=clock_timestamp() WHERE order_id=$1 RETURNING *',
      [row.order_id, state],
    )
  ).rows[0]!;
  await emit(client, next, type, extra);
  return next;
}
