import { randomUUID } from 'node:crypto';
import { applyMenu, publishMenu } from '@pickchick/menu-sync';
import { provisionStaff, setOrdering, openCashShift } from '@pickchick/local-orders';
import { withSyncDatabases } from './sync.mjs';

export const staffAuth = (credential) => ({
  sessionId: credential.session_id,
  token: credential.token,
});
export const staffHeaders = (credential, key = randomUUID()) => ({
  Authorization: `Bearer ${credential.token}`,
  'X-Staff-Session-Id': credential.session_id,
  'Idempotency-Key': key,
  'Content-Type': 'application/json',
});
export async function withOrderDesk(run, open = true) {
  await withSyncDatabases(async (context) => {
    const { cloud, edge, branch, menu } = context;
    const release = menu();
    await applyMenu(edge.pool, branch, await publishMenu(cloud.pool, release));
    const setup = (role) => ({
      staff_id: randomUUID(),
      terminal_id: randomUUID(),
      name: 'Synthetic staff',
      role,
    });
    const cashierSetup = setup('cashier');
    const cashier = await provisionStaff(edge.pool, branch, cashierSetup);
    const manager = await provisionStaff(edge.pool, branch, {
      ...setup('shift_manager'),
      terminal_id: cashier.terminal_id,
    });
    const shift = await openCashShift(edge.pool, branch, staffAuth(manager), randomUUID(), {
      opening_cash_minor: '0',
    });
    if (open)
      await setOrdering(edge.pool, branch, staffAuth(manager), randomUUID(), true, {
        expected_version: 1,
      });
    const cart = {
      release_id: release.release_id,
      service_mode: 'takeaway',
      items: [{ variant_id: release.items[0].variant_id, quantity: 2 }],
    };
    await run({ ...context, release, cashier, cashierSetup, manager, cart, setup, shift });
  });
}
