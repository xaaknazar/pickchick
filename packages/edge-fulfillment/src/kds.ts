import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parse } from './model.js';

/** KDS station functions; same values as KdsFunctionSchema in @pickchick/contracts (section 2.1). */
export type KdsFunction =
  'breading' | 'toasts' | 'assembly_hall' | 'assembly_delivery' | 'issue' | 'delivery_handover';
export type KdsStationSpec = {
  function: KdsFunction;
  kind: 'prep' | 'assembly';
  /** Screen title (contracts section 2.3); stored as fulfillment_stations.name. */
  name: string;
};
/** The six KDS stations of the restaurant, in the order of its kitchen flow (section 2.3). */
export const KDS_STATIONS: readonly Readonly<KdsStationSpec>[] = Object.freeze(
  (
    [
      { function: 'breading', kind: 'prep', name: 'Панировка (6)' },
      { function: 'toasts', kind: 'prep', name: 'Тосты и бургеры (5)' },
      { function: 'assembly_hall', kind: 'assembly', name: 'Сборка - зал (стол 1)' },
      { function: 'assembly_delivery', kind: 'assembly', name: 'Сборка - доставка (стол 2)' },
      { function: 'issue', kind: 'assembly', name: 'Выдача (2)' },
      { function: 'delivery_handover', kind: 'assembly', name: 'Выдача доставки (3)' },
    ] as const
  ).map((station) => Object.freeze({ ...station })),
);

const FunctionSchema = z.enum([
  'breading',
  'toasts',
  'assembly_hall',
  'assembly_delivery',
  'issue',
  'delivery_handover',
]);

/**
 * Deterministic edge station id of a KDS function:
 * localCatalogId(branchId, 'kds-station', fn) of @pickchick/menu-sync (availability.ts), the
 * same UUID-shaped SHA-256 identity as the installed local catalog. Recomputed here because this
 * package does not depend on menu-sync; a test pins both to the same value.
 */
export function kdsStationId(branchId: string, fn: KdsFunction): string {
  parse(z.uuid(), branchId);
  parse(FunctionSchema, fn);
  const hash = createHash('sha256')
    .update(`pickchick-local-draft-v1:${branchId}:kds-station:${fn}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hash[12] = '8';
  hash[16] = (8 | (parseInt(hash[16]!, 16) & 3)).toString(16);
  const h = hash.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
