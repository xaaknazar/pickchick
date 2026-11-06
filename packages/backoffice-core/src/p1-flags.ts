import type { DatabaseClient } from '@pickchick/database';
import type { BackofficeOptions } from './stops.js';

/**
 * Back-office P1 flags (lane bo-ui, owner decision 05.11; docs/architecture/cutover-2026-11/
 * design-bo-ui.md sections 2 and 4). The API reads the five flags in loadConfig
 * (packages/platform/src/config.ts: strict true|false, cloud API with the back office only,
 * autoconsume needs stock v2) and hands them to the back office through backofficeP1Options.
 *
 * GET branches/:id reports a capability key only while its flag is on, like the cloud lane keys
 * (roles, stock_v2, sales_report). A key is `true` when the feature can run on this database for
 * the current role: cloud075 relations with their rights where the feature writes them. With every
 * flag off p1Capabilities answers {} without a query, so a cabinet on a 074 schema is unchanged.
 */

/** The ServiceConfig fields of the P1 flags (structural: this package does not import platform). */
export interface BackofficeP1Config {
  backofficePosDayEnabled?: boolean;
  backofficeStockAutoconsumeEnabled?: boolean;
  backofficeManagerShiftsEnabled?: boolean;
  backofficeStaffPositionsEnabled?: boolean;
  backofficeDiscountsEnabled?: boolean;
}
/** P1 BackofficeOptions from the API config; a key only for a flag that is on. */
export function backofficeP1Options(config: BackofficeP1Config): BackofficeOptions {
  return {
    ...(config.backofficePosDayEnabled === true ? { posDayEnabled: true } : {}),
    ...(config.backofficeStockAutoconsumeEnabled === true ? { stockAutoconsumeEnabled: true } : {}),
    ...(config.backofficeManagerShiftsEnabled === true ? { managerShiftsEnabled: true } : {}),
    ...(config.backofficeStaffPositionsEnabled === true ? { staffPositionsEnabled: true } : {}),
    ...(config.backofficeDiscountsEnabled === true ? { discountsEnabled: true } : {}),
  };
}

type Db = Pick<DatabaseClient, 'query'>;
const WRITE = ['SELECT', 'INSERT', 'UPDATE'] as const;
/** cloud075 relations and the rights each feature needs (infra/staging/backoffice-p1-grants.mjs). */
export const P1_FEATURE_RELATIONS = Object.freeze({
  stock_autoconsume: Object.freeze([
    ['bo_stock_settings', WRITE],
    ['bo_consumption_items', WRITE],
  ] as const),
  manager_shifts: Object.freeze([['bo_manager_shifts', WRITE]] as const),
  discounts: Object.freeze([
    ['bo_discounts', WRITE],
    ['bo_discount_revisions', ['SELECT'] as const],
  ] as const),
});
/** Every relation of the list exists and the current role holds every listed right on it. */
async function relationsReady(
  db: Db,
  list: readonly (readonly [string, readonly string[]])[],
): Promise<boolean> {
  const pairs = list.flatMap(([name, rights]) => rights.map((right) => [name, right] as const));
  const r = await db.query<{ ok: boolean | null }>(
    `SELECT bool_and(to_regclass(p.name) IS NOT NULL
       AND coalesce(has_table_privilege(current_user, to_regclass(p.name), p.privilege), false)) AS ok
     FROM unnest($1::text[], $2::text[]) AS p(name, privilege)`,
    [pairs.map(([name]) => name), pairs.map(([, right]) => right)],
  );
  return r.rows[0]?.ok === true;
}
export type P1Capabilities = {
  pos_day?: boolean;
  stock_autoconsume?: boolean;
  manager_shifts?: boolean;
  staff_positions?: boolean;
  discounts?: boolean;
  stock_p1?: true;
};
/**
 * The P1 keys of GET branches/:id capabilities, in this order, only for the flags that are on.
 * `stock_p1` (stock P1 under the existing BACKOFFICE_STOCK_V2_ENABLED, design-bo-ui 2) comes last
 * and only while it is usable (`stockP1`, stock-p1.ts stockP1Ready): without cloud075 or its
 * rights the key is absent and the answer is the cloud lane's.
 */
export async function p1Capabilities(
  db: Db,
  options: BackofficeOptions,
  stockP1 = false,
): Promise<P1Capabilities> {
  const out: P1Capabilities = {};
  // Works without cloud073 (the view then reports coverage.pos_tables=false), so always true.
  if (options.posDayEnabled === true) out.pos_day = true;
  if (options.stockAutoconsumeEnabled === true)
    out.stock_autoconsume =
      options.stockV2Enabled === true &&
      (await relationsReady(db, P1_FEATURE_RELATIONS.stock_autoconsume));
  if (options.managerShiftsEnabled === true)
    out.manager_shifts = await relationsReady(db, P1_FEATURE_RELATIONS.manager_shifts);
  // Employee payload fields only (no DDL).
  if (options.staffPositionsEnabled === true) out.staff_positions = true;
  if (options.discountsEnabled === true)
    out.discounts = await relationsReady(db, P1_FEATURE_RELATIONS.discounts);
  if (options.stockV2Enabled === true && stockP1) out.stock_p1 = true;
  return out;
}
