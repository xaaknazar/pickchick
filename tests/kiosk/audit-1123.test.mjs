// Regressions for the iPad kiosk audit of 23.11.2026 (polling and the commercial controller).
// Synthetic doubles only: nothing is paid and no network is used.
import test from 'node:test';
import { setImmediate } from 'node:timers';
import assert from 'node:assert/strict';
import { startKioskPolling } from '../../apps/kiosk/src/polling.ts';

const iso = '2026-10-04T00:00:00Z';
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

test('#4: a refresh that throws does not stop the foreground poll loop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse(iso) });
  const at = [];
  let broken = 2;
  const controller = {
    getSnapshot: () => ({
      ready: true,
      busy: false,
      catalog: null,
      step: 'start',
      order: null,
      recoveryRequired: false,
      error: null,
    }),
    refresh: async () => {
      at.push(Date.now() - Date.parse(iso));
      if (broken-- > 0) throw Error('refresh');
      return true;
    },
    tick: async () => {},
  };
  const stop = startKioskPolling(controller, () => true);
  t.after(stop);
  for (let i = 0; i < 30; i++) {
    t.mock.timers.tick(1000);
    await flush();
  }
  // 3 s, then the back-off of a failed reload (6 s, 12 s), then the base delay again.
  assert.deepEqual(at.slice(0, 4), [3000, 9000, 21000, 24000]);
});
