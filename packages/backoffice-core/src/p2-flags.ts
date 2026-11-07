import type { DatabaseClient } from '@pickchick/database';
import { p1RelationsReady } from './p1-flags.js';
import type { BackofficeOptions } from './stops.js';

/**
 * Back-office second wave (lane bo-ui2, owner decision 06.11; docs/architecture/cutover-2026-11/
 * design-bo-ui.md «Вторая волна»). The API reads the three flags in loadConfig
 * (packages/platform/src/config.ts: strict true|false, cloud API with the back office only;
 * supply needs stock v2, the staff assignment needs the staff positions) and hands them to the
 * back office through backofficeP2Options.
 *
 * GET branches/:id reports a capability key only while its flag is on, like the cloud lane and
 * bo-ui keys, after all of them (after `stock_p1`). A key is `true` when the feature can run on
 * this database for the current role: cloud076 relations with the rights of
 * infra/staging/backoffice-supply-grants.mjs where the feature writes them. With every flag off
 * p2Capabilities answers {} without a query, so the answer is the bo-ui one byte for byte.
 */

/** The ServiceConfig fields of the second-wave flags (structural: no platform import here). */
export interface BackofficeP2Config {
  backofficeSupplyEnabled?: boolean;
  backofficeStockReportsEnabled?: boolean;
  backofficeStaffAssignmentEnabled?: boolean;
}
/** Second-wave BackofficeOptions from the API config; a key only for a flag that is on. */
export function backofficeP2Options(config: BackofficeP2Config): BackofficeOptions {
  return {
    ...(config.backofficeSupplyEnabled === true ? { supplyEnabled: true } : {}),
    ...(config.backofficeStockReportsEnabled === true ? { stockReportsEnabled: true } : {}),
    ...(config.backofficeStaffAssignmentEnabled === true ? { staffAssignmentEnabled: true } : {}),
  };
}

type Db = Pick<DatabaseClient, 'query'>;
const WRITE = ['SELECT', 'INSERT', 'UPDATE'] as const;
/** cloud076 relations and the rights each feature needs (backoffice-supply-grants.mjs). */
export const P2_FEATURE_RELATIONS = Object.freeze({
  supply: Object.freeze([
    ['bo_suppliers', WRITE],
    ['bo_supplier_price_imports', ['SELECT', 'INSERT'] as const],
    ['bo_supplier_prices', WRITE],
    ['bo_supply_requests', WRITE],
  ] as const),
  staff_assignment: Object.freeze([['bo_staff_assignments', WRITE]] as const),
});
export type P2Capabilities = {
  supply?: boolean;
  stock_reports?: true;
  staff_assignment?: boolean;
};
/**
 * The second-wave keys of GET branches/:id capabilities, in this order, only for the flags that
 * are on. `supply` also needs stock v2 (a received request is a stock v2 receipt) and
 * `staff_assignment` the staff positions (the stations are positions), like loadConfig requires.
 * `stock_reports` reads only tables the back office already reads, so it is always true.
 */
export async function p2Capabilities(db: Db, options: BackofficeOptions): Promise<P2Capabilities> {
  const out: P2Capabilities = {};
  if (options.supplyEnabled === true)
    out.supply =
      options.stockV2Enabled === true && (await p1RelationsReady(db, P2_FEATURE_RELATIONS.supply));
  if (options.stockReportsEnabled === true) out.stock_reports = true;
  if (options.staffAssignmentEnabled === true)
    out.staff_assignment =
      options.staffPositionsEnabled === true &&
      (await p1RelationsReady(db, P2_FEATURE_RELATIONS.staff_assignment));
  return out;
}
