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
