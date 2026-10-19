// Release fixes 2026-10-19 (audit 1.3, 4.2, 6.3): the cashier refuses a kiosk/mobile combo with a
// stopped fixed component or a stopped linked product, the same rule as the cloud sales gate.
import assert from 'node:assert/strict';
import test from 'node:test';
import { localSelectionIds } from '@pickchick/local-orders';
import { FulfillmentError } from '../dist/index.js';
import { fixture } from './fixture.mjs';

const stopped = (error) => error instanceof FulfillmentError && error.reason === 'ITEM_STOPPED';

for (const [what, productId] of [
  ['A fixed component', 'fries'],
  ['A linked option product', 'drink'],
])
  test(`${what} on the stop list refuses the combo admission; unstopping admits it`, () =>
    fixture(async (f) => {
      const command = f.admission(true),
        id = localSelectionIds(f.scope.branchId, productId, [])[0];
      await f.pool.query(
        'INSERT INTO local_stops(branch_id,variant_id,stopped,version,reason) VALUES($1,$2,true,1,$$Synthetic stop$$)',
        [f.scope.branchId, id],
      );
      await assert.rejects(f.repo.acceptCloud(f.scope, command), stopped);
      assert.equal(await f.count('fulfillment_reservations'), 0);
      // A plain burger without that product is still admitted.
      assert.equal((await f.repo.acceptCloud(f.scope, f.admission(false))).state, 'held');
      await f.pool.query('UPDATE local_stops SET stopped=false');
      assert.equal((await f.repo.acceptCloud(f.scope, command)).state, 'held');
    }));
