import type { DatabaseClient, DatabasePool } from '@pickchick/database';

type DeliveryStatus = 'pending' | 'applied' | 'rejected' | 'unavailable' | 'superseded';

/**
 * Applied requires the exact release and ACK from the pinned, still-active edge. Rejected means
 * that edge acknowledged the release but kept its previous menu. The edge-reported active menu
 * version is shown only when it comes from the same pinned device.
 */
export async function readCatalogMenuDelivery(
  db: Pick<DatabaseClient | DatabasePool, 'query'>,
  branchId: string,
  catalogVersion: number,
) {
  const row = (
    await db.query<{
      catalog_version: number;
      menu_version: number;
      release_id: string;
      device_id: string;
      status: DeliveryStatus;
      acknowledged_at: Date | null;
      reject_reason: string | null;
      edge_active_version: number | null;
      observed_at: Date | null;
    }>(
      `SELECT c.catalog_version,m.version menu_version,c.release_id,c.device_id,
     CASE WHEN d.status<>'active' OR binding.device_id IS NULL THEN 'unavailable'
       WHEN a.release_id=c.release_id AND i.event_id IS NOT NULL THEN 'applied'
       WHEN r.result='rejected' AND i.event_id IS NOT NULL THEN 'rejected'
       WHEN a.release_id IS NOT NULL AND active.version>m.version THEN 'superseded'
       ELSE 'pending' END status,
     CASE WHEN a.release_id=c.release_id AND i.event_id IS NOT NULL AND d.status='active' AND binding.device_id IS NOT NULL
       THEN a.acknowledged_at ELSE NULL END acknowledged_at,
     CASE WHEN d.status='active' AND binding.device_id IS NOT NULL AND r.result='rejected' AND i.event_id IS NOT NULL
       THEN r.reason ELSE NULL END reject_reason,
     s.active_version edge_active_version,s.observed_at
     FROM catalog_menu_deliveries c JOIN menu_releases m ON m.id=c.release_id AND m.branch_id=c.branch_id
     JOIN devices d ON d.id=c.device_id AND d.branch_id=c.branch_id AND d.kind='edge'
     LEFT JOIN fulfillment_transport_bindings binding ON binding.branch_id=c.branch_id AND binding.device_id=c.device_id AND binding.active
     LEFT JOIN branch_menu_activations a ON a.branch_id=c.branch_id
     LEFT JOIN menu_releases active ON active.id=a.release_id
     LEFT JOIN outbox_events e ON e.aggregate_id=c.release_id AND e.event_type='menu.published'
     LEFT JOIN inbox_messages i ON i.producer_id=c.device_id AND i.event_id=e.event_id
     LEFT JOIN catalog_menu_delivery_results r ON r.release_id=c.release_id AND r.branch_id=c.branch_id
     LEFT JOIN edge_menu_state s ON s.branch_id=c.branch_id AND s.device_id=c.device_id
     WHERE c.branch_id=$1 AND c.catalog_version=$2`,
      [branchId, catalogVersion],
    )
  ).rows[0];
  if (!row) return null;
  const { reject_reason: rejectReason, ...delivery } = row;
  return {
    ...delivery,
    acknowledged_at: row.acknowledged_at?.toISOString() ?? null,
    ...(rejectReason ? { reject_reason: rejectReason } : {}),
    edge_active_version: row.edge_active_version,
    observed_at: row.observed_at?.toISOString() ?? null,
  };
}
