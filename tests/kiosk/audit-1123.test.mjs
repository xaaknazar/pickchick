// Regressions for the iPad kiosk audit of 23.11.2026 (polling and the commercial controller).
// Synthetic doubles only: nothing is paid and no network is used.
import test from 'node:test';
import { setImmediate } from 'node:timers';
import assert from 'node:assert/strict';
import { startKioskPolling } from '../../apps/kiosk/src/polling.ts';
import { cart, fixture } from './commercial-fixture.mjs';

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

/** A guest at a live Kaspi QR that expires in three minutes. */
async function atQr(h) {
  const c = await cart(h);
  assert.equal(await c.beginPayment(), true);
  h.order = {
    ...h.order,
    payment: {
      kind: 'kaspi_qr',
      state: 'pending',
      qrPayload: 'https://qr.kaspi.kz/fixture',
      expiresAt: new Date(h.clock + 180000).toISOString(),
    },
  };
  assert.equal(await c.refresh(), true);
  assert.equal(c.getSnapshot().step, 'payment');
  return c;
}

test('#6: the QR tick tells the screen only about a change, and once when the QR expires', async () => {
  const h = fixture();
  const c = await atQr(h);
  await c.tick();
  let renders = 0;
  c.subscribe(() => renders++);
  const shown = c.getSnapshot();
  for (let i = 0; i < 5; i++) {
    h.clock += 1000;
    await c.tick();
  }
  assert.equal(renders, 0, 'five idle seconds: nothing changed');
  assert.equal(c.getSnapshot(), shown, 'an unchanged snapshot keeps its identity');
  // «Начать заново» turns to the staff code after its free seconds: a change of the snapshot.
  h.io.verifyStaff = async () => {};
  h.clock += 15000;
  await c.tick();
  assert.equal(renders, 1);
  assert.equal(c.getSnapshot().startOverNeedsStaff, true);
  // The expiry passes: the screen hides the QR by its own clock, so it is told exactly once.
  h.clock += 170000;
  await c.tick();
  const atExpiry = renders;
  assert.ok(atExpiry >= 2, 'told when the QR expired');
  h.clock += 1000;
  await c.tick();
  h.clock += 1000;
  await c.tick();
  assert.equal(renders, atExpiry);
});

test('#6: an unchanged background reload does not re-render; a real change still does', async () => {
  const h = fixture();
  const c = await atQr(h);
  let renders = 0;
  c.subscribe(() => renders++);
  assert.equal(await c.refresh(), true);
  assert.equal(await c.refresh(), true);
  assert.equal(renders, 0);
  h.order = { ...h.order, phase: 'paid', payment: { ...h.order.payment, state: 'paid' } };
  assert.equal(await c.refresh(), true);
  assert.ok(renders >= 1);
  assert.equal(c.getSnapshot().step, 'order');
});
