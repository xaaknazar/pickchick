import { z } from 'zod';
import type { BackofficeP2Permission, BackofficePermission } from './roles.js';
import {
  SupplierPriceSaveCommand,
  SupplierSaveCommand,
  SupplyRequestCancelCommand,
  SupplyRequestReceiveCommand,
  SupplyRequestSaveCommand,
  SupplyRequestSubmitCommand,
} from './supply.js';
import { SupplierPricesImportCommand } from './supplier-import.js';

/**
 * Every second-wave command (lane bo-ui2, design-bo-ui.md §9.4). Like the P1 commands of
 * stock-p1.ts they have their own schema, parsed by index.ts only while their flags are on
 * (P2_COMMAND_FLAGS), so with the flags off each one is exactly an unknown command
 * (INVALID_REQUEST) and the shared Command and P1Command unions stay those of bo-ui.
 */
export const P2Command = z.discriminatedUnion('type', [
  SupplierSaveCommand,
  SupplierPriceSaveCommand,
  // Step 3: the price import of scripts/supplier-prices-import.mjs (supplier-import.ts).
  SupplierPricesImportCommand,
  SupplyRequestSaveCommand,
  SupplyRequestSubmitCommand,
  SupplyRequestCancelCommand,
  SupplyRequestReceiveCommand,
]);
export type P2CommandInput = z.infer<typeof P2Command>;
/** POST .../commands body of a second-wave command (the same envelope as Request in model.ts). */
export const P2Request = z.strictObject({
  request_id: z.uuid(),
  reason: z.string().trim().min(3).max(500),
  command: P2Command,
});
export type P2RequestInput = z.infer<typeof P2Request>;
/**
 * The permissions each second-wave command checks (design-bo-ui §9.3, roles.ts): all of them,
 * in this order. Receiving also posts a stock receipt, so it needs stock.receipt as well.
 */
export const P2_COMMAND_PERMISSIONS: Readonly<
  Record<P2CommandInput['type'], readonly (BackofficeP2Permission | BackofficePermission)[]>
> = Object.freeze({
  supplier_save: ['suppliers.write'],
  supplier_price_save: ['suppliers.write'],
  supplier_prices_import: ['suppliers.write'],
  supply_request_save: ['supply.write'],
  supply_request_submit: ['supply.write'],
  supply_request_cancel: ['supply.close'],
  supply_request_receive: ['supply.close', 'stock.receipt'],
});
/** The back-office options each second-wave command needs besides its own feature checks. */
export const P2_COMMAND_FLAGS: Readonly<
  Record<
    P2CommandInput['type'],
    readonly ('supplyEnabled' | 'stockV2Enabled' | 'staffAssignmentEnabled')[]
  >
> = Object.freeze({
  supplier_save: ['supplyEnabled', 'stockV2Enabled'],
  supplier_price_save: ['supplyEnabled', 'stockV2Enabled'],
  supplier_prices_import: ['supplyEnabled', 'stockV2Enabled'],
  supply_request_save: ['supplyEnabled', 'stockV2Enabled'],
  supply_request_submit: ['supplyEnabled', 'stockV2Enabled'],
  supply_request_cancel: ['supplyEnabled', 'stockV2Enabled'],
  supply_request_receive: ['supplyEnabled', 'stockV2Enabled'],
});
/** The second-wave permissions of the supply feature (permissions[] while it is available). */
export const SUPPLY_PERMISSIONS: readonly BackofficeP2Permission[] = Object.freeze([
  'suppliers.write',
  'supply.write',
  'supply.close',
]);
