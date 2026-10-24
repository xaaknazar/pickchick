const TABLES =
  'bo_station_plans,bo_station_plan_deliveries,bo_station_plan_receipts,bo_station_plan_edge_state';
const DELIVERY_UPDATE = 'device_id,last_delivered_at,deliveries';
const EDGE_STATE_UPDATE = 'device_id,active_plan_id,active_version,stations,observed_at';

/**
 * Station plan delivery to the cashier edge (after cloud070, stage 2 lane cfg). Apply after
 * backofficeGrants. A separate helper: backoffice-grants.mjs is pinned by SHA-256 in guarded
 * historical releases and must stay byte-identical.
 *
 * - back-office off: no access to the station plan tables.
 * - back-office on, delivery off: SELECT only, so the cabinet keeps showing past versions.
 * - delivery on (BACKOFFICE_STATION_PLAN_DELIVERY_ENABLED=true): INSERT of plans, deliveries,
 *   receipts and edge reports, and UPDATE of only the delivery counter/time and the edge report.
 *   Plans and receipts are never updatable or deletable (immutable triggers as well).
 * Column UPDATE grants are revoked explicitly: REVOKE ALL on a table leaves them in place.
 */
export function stationPlanGrants(role, { backoffice, delivery } = {}) {
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(role ?? '') ||
    typeof backoffice !== 'boolean' ||
    typeof delivery !== 'boolean'
  )
    throw new Error('Invalid station plan grants');
  let sql = `REVOKE ALL ON ${TABLES} FROM ${role};
 REVOKE UPDATE(${DELIVERY_UPDATE}) ON bo_station_plan_deliveries FROM ${role};
 REVOKE UPDATE(${EDGE_STATE_UPDATE}) ON bo_station_plan_edge_state FROM ${role};`;
  if (backoffice) sql += `\n GRANT SELECT ON ${TABLES} TO ${role};`;
  if (backoffice && delivery)
    sql += `
 GRANT INSERT ON ${TABLES} TO ${role};
 GRANT UPDATE(${DELIVERY_UPDATE}) ON bo_station_plan_deliveries TO ${role};
 GRANT UPDATE(${EDGE_STATE_UPDATE}) ON bo_station_plan_edge_state TO ${role};`;
  return sql;
}
