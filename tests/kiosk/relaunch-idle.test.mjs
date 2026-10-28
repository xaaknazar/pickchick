// Stage 2 (24.10.2026), lane kln: a relaunched kiosk (power loss, crash, update, AppLock
// relaunch) never shows the previous guest's shopping draft once the idle reset (90 + 15 s) has
// passed; a payment that may exist is never touched. Synthetic fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CommercialKioskController } from '../../apps/kiosk/src/commercial-controller.ts';
import { KIOSK_IDLE_GRACE_MS, KIOSK_IDLE_MS } from '../../apps/kiosk/src/controller.ts';
import { cart, fixture } from './commercial-fixture.mjs';

const IDLE_RESET_MS = KIOSK_IDLE_MS + KIOSK_IDLE_GRACE_MS;
const stored = (h) => JSON.parse(h.rawFlow);
const token = (h) => (h.rawSession ? JSON.parse(h.rawSession).token : null);

/** A relaunched controller that records every screen it would have shown. */
function relaunch(h) {
  const c = new CommercialKioskController(h.io);
  const shown = [];
  c.subscribe(() => {
    const s = c.getSnapshot();
    shown.push({ step: s.step, cart: s.cart.length, mode: s.mode });
  });
  return { c, shown };
}

for (const draft of ['cart', 'mode only']) {
  test(`relaunch after the idle limit clears a ${draft} draft before any screen shows it`, async () => {
    const h = fixture();
    const before = await cart(h);
    if (draft === 'mode only') {
      assert.equal(await before.updateQuantity(before.getSnapshot().cart[0].lineId, 0), true);
      assert.equal(stored(h).cart.length, 0);
      assert.equal(stored(h).mode, 'takeaway');
    }
    const oldToken = token(h);
    h.clock = stored(h).lastActivityAt + IDLE_RESET_MS;
    h.calls = [];
    const { c, shown } = relaunch(h);
    assert.equal(await c.restore(), true);
    const s = c.getSnapshot();
    assert.equal(s.step, 'start');
    assert.equal(s.cart.length, 0);
    assert.equal(s.mode, null);
    assert.equal(s.invoicePhone, '');
    assert.deepEqual(
      shown.filter((v) => v.step !== 'start' || v.cart || v.mode),
      [],
      'the old draft was never on screen',
    );
    // The previous guest is ended like an idle reset; its session is never renewed or reused.
    assert.equal(h.calls[0].path, '/sessions/end');
    assert.equal(h.calls[0].token, oldToken);
    assert.notEqual(token(h), oldToken);
    assert.equal(stored(h).resetPending, false);
    assert.deepEqual(stored(h).cart, []);
    assert.equal(stored(h).mode, null);
    // The next guest starts normally.
    assert.equal(await c.start(), true);
    assert.equal(c.getSnapshot().step, 'mode');
  });
}

test('relaunch within the idle limit keeps the draft (a crash in front of the guest)', async () => {
  const h = fixture();
  await cart(h);
  const saved = stored(h);
  h.clock = saved.lastActivityAt + KIOSK_IDLE_MS;
  const { c } = relaunch(h);
  assert.equal(await c.restore(), true);
  assert.equal(c.getSnapshot().step, 'menu');
  assert.equal(c.getSnapshot().cart.length, 1);
  assert.deepEqual(stored(h).cart, saved.cart);
  // The usual countdown then runs from the stored activity.
  await c.tick();
  assert.equal(c.getSnapshot().idleWarningSeconds, Math.ceil(KIOSK_IDLE_GRACE_MS / 1000));
});

test('relaunch after the idle limit offline: the draft is gone locally, the reset ends later', async () => {
  const h = fixture();
  await cart(h);
  const oldToken = token(h);
  h.clock = stored(h).lastActivityAt + IDLE_RESET_MS + 60000;
  h.endFail = true;
  const { c, shown } = relaunch(h);
  assert.equal(await c.restore(), false);
  assert.equal(c.getSnapshot().step, 'start');
  assert.equal(c.getSnapshot().cart.length, 0);
  assert.equal(c.getSnapshot().errorCode, 'OFFLINE');
  assert.deepEqual(
    shown.filter((v) => v.cart || v.mode),
    [],
  );
  // Only the reset marker survives; the guest identity is kept until the server ends it.
  assert.equal(stored(h).resetPending, true);
  assert.deepEqual(stored(h).cart, []);
  assert.equal(token(h), oldToken);
  h.endFail = false;
  assert.equal(await c.refresh(), true);
  assert.equal(stored(h).resetPending, false);
  assert.notEqual(token(h), oldToken);
  assert.equal(await c.start(), true);
  assert.equal(c.getSnapshot().step, 'mode');
});

test('relaunch never clears an order whose payment may exist, however long ago', async () => {
  const h = fixture();
  const before = await cart(h);
  assert.equal(await before.beginPayment(), true);
  const orderId = stored(h).order.orderId;
  h.clock += IDLE_RESET_MS * 10;
  h.calls = [];
  const { c } = relaunch(h);
  await c.restore();
  assert.equal(stored(h).order.orderId, orderId);
  assert.equal(stored(h).resetPending, false);
  assert.ok(c.getSnapshot().order);
  assert.ok(['payment', 'recovery'].includes(c.getSnapshot().step));
  assert.equal(
    h.calls.some((call) => call.path === '/sessions/end'),
    false,
  );
});

test('relaunch never clears a saved payment intent, however long ago', async () => {
  const h = fixture();
  const before = await cart(h);
  h.failPath = '/quotes';
  assert.equal(await before.beginPayment(), false);
  const intent = stored(h).intent;
  assert.ok(intent);
  h.clock += IDLE_RESET_MS * 10;
  h.failPath = '/quotes';
  const { c } = relaunch(h);
  await c.restore();
  assert.deepEqual(stored(h).intent, intent);
  assert.equal(stored(h).resetPending, false);
  assert.equal(c.getSnapshot().recoveryRequired, true);
});
