import type { DatabaseClient, DatabasePool } from '@pickchick/database';

/** Applied requires the exact release and ACK from the pinned, still-active edge. */
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
      status: 'pending' | 'applied' | 'unavailable' | 'superseded';
      acknowledged_at: Date | null;
    }>(
      `SELECT c.catalog_version,m.version menu_version,c.release_id,c.device_id,
     CASE WHEN d.status<>'active' THEN 'unavailable'
       WHEN a.release_id=c.release_id AND i.event_id IS NOT NULL THEN 'applied'
       WHEN a.release_id IS NOT NULL AND active.version>m.version THEN 'superseded'
       ELSE 'pending' END status,
     CASE WHEN a.release_id=c.release_id AND i.event_id IS NOT NULL AND d.status='active'
       THEN a.acknowledged_at ELSE NULL END acknowledged_at
     FROM catalog_menu_deliveries c JOIN menu_releases m ON m.id=c.release_id AND m.branch_id=c.branch_id
     JOIN devices d ON d.id=c.device_id AND d.branch_id=c.branch_id AND d.kind='edge'
     LEFT JOIN branch_menu_activations a ON a.branch_id=c.branch_id
     LEFT JOIN menu_releases active ON active.id=a.release_id
     LEFT JOIN outbox_events e ON e.aggregate_id=c.release_id AND e.event_type='menu.published'
     LEFT JOIN inbox_messages i ON i.producer_id=c.device_id AND i.event_id=e.event_id
     WHERE c.branch_id=$1 AND c.catalog_version=$2`,
      [branchId, catalogVersion],
    )
  ).rows[0];
  return row ? { ...row, acknowledged_at: row.acknowledged_at?.toISOString() ?? null } : null;
}
