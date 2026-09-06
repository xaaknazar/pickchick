import type { TestOrder } from '@pickchick/test-order-flow/contracts';

interface SavedOrderReader {
  restore(): Promise<boolean>;
  hasPending(): Promise<boolean>;
  orders(): Promise<TestOrder[]>;
}
export interface SavedOrderObservation {
  state: 'empty' | 'observed' | 'unavailable';
  hasSavedSession: boolean;
  hasPending: boolean;
  orders: TestOrder[];
  error: unknown;
}

/** Reading a saved TEST identity must not depend on a fresh restaurant catalog.
 * This boundary never authenticates a new customer or submits a new cart.
 * A failed read is unknown, not an authoritative empty order history.
 */
export async function observeSavedOrders(client: SavedOrderReader): Promise<SavedOrderObservation> {
  let hasSavedSession = false;
  let hasPending = false;
  try {
    hasSavedSession = await client.restore();
    hasPending = await client.hasPending();
    if (!hasSavedSession && !hasPending)
      return { state: 'empty', hasSavedSession, hasPending, orders: [], error: null };
    const orders = await client.orders();
    hasPending = await client.hasPending();
    return { state: 'observed', hasSavedSession, hasPending, orders, error: null };
  } catch (error) {
    return { state: 'unavailable', hasSavedSession, hasPending, orders: [], error };
  }
}

export function canCreateTestOrder(catalogConfirmed: boolean, restored: boolean): boolean {
  return catalogConfirmed && restored;
}
