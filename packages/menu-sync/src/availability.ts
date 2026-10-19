import { createHash } from 'node:crypto';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';

/** Exact identity of the installed local POS catalog v1/v2, never a name match. */
export function localCatalogId(branchId: string, kind: string, key: string) {
  const hash = createHash('sha256')
    .update(`pickchick-local-draft-v1:${branchId}:${kind}:${key}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hash[12] = '8';
  hash[16] = (8 | (parseInt(hash[16]!, 16) & 3)).toString(16);
  const h = hash.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function localSelectionIds(
  branchId: string,
  productId: string,
  selections: { group_id: string; option_id: string }[],
) {
  return [
    localCatalogId(branchId, 'base-preview', productId),
    ...selections.map((s) =>
      localCatalogId(branchId, 'modifier-option', `${productId}:${s.group_id}:${s.option_id}`),
    ),
  ];
}

/*
 * Combo stop rule (PM decision 1, release fixes 2026-10-19), one rule for the cloud channels
 * (kiosk, mobile) and the cashier admission:
 * - a product is stopped by its own stop;
 * - a modifier option is stopped by its own stop or by the stop of the product it points to:
 *   its linked_product_id, otherwise the catalog product whose id is the option id (combo drink
 *   and sauce options repeat the standalone product ids). A stop id exists only for a real
 *   product, so an option id that names no product can never match;
 * - a combo/duo/set is unavailable when one of its fixed components is stopped, or when every
 *   option of a required choice group is stopped. A stopped option inside a group is shown as
 *   unavailable and cannot be chosen.
 */
const productStopId = (branchId: string, productId: string) =>
  localCatalogId(branchId, 'base-preview', productId);

/** Every stop id that blocks one ordered line: the product, each chosen option, the product the
 * option points to, and every fixed component (the snapshot's resolved components). */
export function lineStopIds(
  branchId: string,
  line: {
    productId: string;
    selections: { group_id: string; option_id: string; linked_product_id?: string | null }[];
    componentIds?: readonly string[];
  },
) {
  return [
    ...localSelectionIds(branchId, line.productId, line.selections),
    ...line.selections.map((s) => productStopId(branchId, s.linked_product_id ?? s.option_id)),
    ...(line.componentIds ?? []).map((id) => productStopId(branchId, id)),
  ];
}

/** Catalog fields the rule reads (structural; the catalog package is not a dependency). */
export interface StopRuleProduct {
  id: string;
  available: boolean;
  combo_components?: readonly { product_id: string }[];
  modifier_groups: readonly {
    id: string;
    min: number;
    options: readonly { id: string; available: boolean; linked_product_id?: string | null }[];
  }[];
}
/** Per published product: whether it can be sold now and which of its options cannot. */
export function catalogStopView(
  branchId: string,
  stopped: ReadonlySet<string>,
  products: readonly StopRuleProduct[],
) {
  const byId = new Map(products.map((p) => [p.id, p]));
  const own = (id: string) => stopped.has(id) || stopped.has(productStopId(branchId, id));
  const blocked = new Map<string, boolean>();
  // A fixed component may itself be a combo: follow it, at most a few levels and never in a loop.
  const componentStopped = (id: string, depth: number): boolean => {
    if (own(id)) return true;
    const product = byId.get(id);
    if (!product || depth > 4) return false;
    const cached = blocked.get(id);
    if (cached !== undefined) return cached;
    blocked.set(id, false);
    const result = (product.combo_components ?? []).some((c) =>
      componentStopped(c.product_id, depth + 1),
    );
    blocked.set(id, result);
    return result;
  };
  return products.map((product) => {
    const stoppedOptions = product.modifier_groups.flatMap((group) =>
      group.options
        .filter((option) => {
          if (!option.available) return true;
          if (
            stopped.has(
              localCatalogId(branchId, 'modifier-option', `${product.id}:${group.id}:${option.id}`),
            )
          )
            return true;
          const linked = option.linked_product_id ?? (byId.has(option.id) ? option.id : null);
          return linked !== null && own(linked);
        })
        .map((option) => ({ group_id: group.id, option_id: option.id })),
    );
    const dead = (groupId: string, options: readonly { id: string }[]) =>
      options.every((o) =>
        stoppedOptions.some((s) => s.group_id === groupId && s.option_id === o.id),
      );
    const available =
      product.available &&
      !own(product.id) &&
      !(product.combo_components ?? []).some((c) => componentStopped(c.product_id, 1)) &&
      !product.modifier_groups.some((g) => g.min > 0 && dead(g.id, g.options));
    return { productId: product.id, available, stoppedOptions };
  });
}
/** Same duration semantics as the POS: manual, one hour, or until shift closes. */
export async function effectiveLocalStops(
  db: Pick<DatabaseClient | DatabasePool, 'query'>,
  branchId: string,
): Promise<string[]> {
  const result = await db.query<{ variant_id: string }>(
    `SELECT variant_id FROM local_stops WHERE branch_id=$1 AND stopped
    AND (expires_at IS NULL OR expires_at>clock_timestamp())
    AND (expires_shift_id IS NULL OR EXISTS(SELECT 1 FROM local_cash_shifts s WHERE s.id=expires_shift_id AND s.state='open')) ORDER BY variant_id`,
    [branchId],
  );
  return result.rows.map((r) => r.variant_id);
}
