import {
  assertPosSalesPrivileges,
  posSalesGrantSql,
  posSalesGrantees,
} from '../windows/pos-sales-grants.mjs';

/**
 * Cloud schema073 (cutover 19.11.2026, lane pos; contracts 3.3 and 5.9): the cloud_pos_*
 * projection of the edge posSales stream. The API role is both the receiver (internal posSales
 * route, CLOUD_POS_SALES_SYNC_ENABLED) and the back-office reader (sales report CC-7), so its
 * rights are the union of the two lists below. The receiver inserts and moves a projection only
 * by a newer event (cloud073 triggers): a sale to voided, a receipt to a newer version. Existing
 * pos_order_sync / kitchen projection grants (pos-sync-grants.mjs) are unchanged. There is no
 * cloud worker on this stream (WORKER_PRIVILEGES is empty). Apply after provision's other helpers;
 * the result is a reset of exactly these relations.
 */
export const MIGRATION = '073_cloud_pos_sales_sync.sql';

export const POS_SALES_RELATIONS = Object.freeze({
  cloud_pos_sale_inbox: 'r',
  cloud_pos_sales: 'r',
  cloud_pos_tenders: 'r',
  cloud_pos_refunds: 'r',
  cloud_pos_refund_tenders: 'r',
  cloud_pos_fiscal_receipts: 'r',
  cloud_pos_shift_reports: 'r',
});
const READ = Object.freeze(['SELECT']);
const APPEND = Object.freeze(['SELECT', 'INSERT']);

/** The posSales receiver (the API runtime role). */
export const RUNTIME_PRIVILEGES = Object.freeze({
  cloud_pos_sale_inbox: APPEND,
  cloud_pos_sales: Object.freeze(['SELECT', 'INSERT', 'UPDATE(state,voided_at,last_sequence)']),
  cloud_pos_tenders: APPEND,
  cloud_pos_refunds: APPEND,
  cloud_pos_refund_tenders: APPEND,
  cloud_pos_fiscal_receipts: Object.freeze([
    'SELECT',
    'INSERT',
    'UPDATE(state,receipt_number,version,recorded_by_staff_id,recorded_at)',
  ]),
  cloud_pos_shift_reports: APPEND,
});
/** The back-office (sales report, reconciliation P1): read only. */
export const BACKOFFICE_PRIVILEGES = Object.freeze(
  Object.fromEntries(
    Object.keys(POS_SALES_RELATIONS)
      .filter((name) => name !== 'cloud_pos_sale_inbox')
      .map((name) => [name, READ]),
  ),
);
export const WORKER_PRIVILEGES = Object.freeze({});

/** Exact rights of the shared API role for the enabled features. */
export function cloudPosSalesPrivileges({ receiver, backoffice }) {
  if (typeof receiver !== 'boolean' || typeof backoffice !== 'boolean')
    throw new Error('Invalid POS sales grants');
  return Object.freeze(receiver ? RUNTIME_PRIVILEGES : backoffice ? BACKOFFICE_PRIVILEGES : {});
}

/** Reset SQL: revokes every privilege of `role` on the 073 tables, then grants the enabled set. */
export function cloudPosSalesGrants(role, options, schema = 'public') {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role ?? '') || !/^[a-z][a-z0-9_]{0,62}$/.test(schema))
    throw new Error('Invalid POS sales grants');
  const privileges = cloudPosSalesPrivileges(options);
  const names = Object.keys(POS_SALES_RELATIONS).map((name) => `"${schema}"."${name}"`);
  return [
    `REVOKE ALL ON ${names.join(', ')} FROM "${role}";`,
    `REVOKE UPDATE(state,voided_at,last_sequence) ON "${schema}"."cloud_pos_sales" FROM "${role}";`,
    `REVOKE UPDATE(state,receipt_number,version,recorded_by_staff_id,recorded_at) ON "${schema}"."cloud_pos_fiscal_receipts" FROM "${role}";`,
    ...(Object.keys(privileges).length
      ? [posSalesGrantSql(role, privileges, schema, POS_SALES_RELATIONS)]
      : []),
  ].join('\n');
}

/** Proves the exact set of cloudPosSalesPrivileges(options) on every 073 table. */
export function assertCloudPosSalesPrivileges(client, role, options, schema = 'public') {
  return assertPosSalesPrivileges(client, role, cloudPosSalesPrivileges(options), {
    schema,
    relations: POS_SALES_RELATIONS,
  });
}
export const cloudPosSalesGrantees = (client, schema = 'public') =>
  posSalesGrantees(client, { schema, relations: POS_SALES_RELATIONS });
