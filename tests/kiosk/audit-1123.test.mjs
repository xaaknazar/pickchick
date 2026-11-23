// Regressions for the iPad kiosk audit of 23.11.2026 (polling and the commercial controller).
// Synthetic doubles only: nothing is paid and no network is used.
import test from 'node:test';
import { setImmediate } from 'node:timers';
import assert from 'node:assert/strict';
import { startKioskPolling } from '../../apps/kiosk/src/polling.ts';
import { readFileSync } from 'node:fs';
import {
  APP_RESTART_MS,
  KioskErrorBoundary,
  SCREEN_CRASH_REPEAT_MS,
  SCREEN_RESTART_MS,
  crashEndsGuest,
} from '../../apps/kiosk/src/errorBoundary.ts';
import { KASPI_CALL_TIMEOUT_MS } from '../../apps/kiosk/src/kaspi-terminal.ts';
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

// #2: the error boundary. React Native is not rendered in these tests, so the class is driven
// through its lifecycle methods as React calls them.
function boundary(props) {
  const b = new KioskErrorBoundary(props);
  b.props = props;
  b.setState = (update) => {
    b.state = { ...b.state, ...(typeof update === 'function' ? update(b.state) : update) };
  };
  const fail = () => {
    b.setState(KioskErrorBoundary.getDerivedStateFromError(Error('render')));
    b.componentDidCatch(Error('render'), { componentStack: '' });
  };
  return { b, fail };
}

test('#2: a failed render shows the notice and the tree is mounted again after the timeout', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const restarts = [];
  const { b, fail } = boundary({
    restartMs: SCREEN_RESTART_MS,
    fallback: (restart) => ({ notice: true, restart }),
    onRestart: () => restarts.push('restart'),
    children: 'screens',
  });
  const first = b.render();
  assert.equal(first.props.children, 'screens');
  fail();
  assert.equal(b.render().notice, true, 'never a blank screen');
  t.mock.timers.tick(SCREEN_RESTART_MS - 1);
  assert.equal(b.state.failed, true);
  t.mock.timers.tick(1);
  assert.deepEqual(restarts, ['restart']);
  const again = b.render();
  assert.equal(again.props.children, 'screens');
  assert.notEqual(again.key, first.key, 'a new key mounts the tree from scratch');
  // The button on the notice restarts at once and leaves no timer behind.
  fail();
  b.render().restart();
  assert.equal(b.state.failed, false);
  t.mock.timers.tick(SCREEN_RESTART_MS * 2);
  assert.deepEqual(restarts, ['restart', 'restart']);
  // A callback that throws does not keep the notice up.
  b.props.onRestart = () => {
    throw Error('callback');
  };
  fail();
  t.mock.timers.tick(SCREEN_RESTART_MS);
  assert.equal(b.state.failed, false);
  // Unmounted while the notice is shown: nothing fires later.
  fail();
  b.componentWillUnmount();
  const round = b.state.round;
  t.mock.timers.tick(SCREEN_RESTART_MS * 2);
  assert.equal(b.state.round, round);
});

test('#2: a repeated failure starts a new guest only for a plain draft, never under a payment', () => {
  const draft = {
    ready: true,
    busy: false,
    step: 'menu',
    order: null,
    recoveryRequired: false,
    terminalPayment: null,
    terminalOpen: false,
    syncPending: false,
  };
  assert.equal(crashEndsGuest(draft, false), false, 'the first failure keeps the cart');
  assert.equal(crashEndsGuest(draft, true), true);
  for (const open of [
    { order: { order_id: 'o' } },
    { recoveryRequired: true },
    { terminalPayment: { phase: 'waiting' } },
    { terminalOpen: true },
    { syncPending: true },
    { busy: true },
    { ready: false },
    { step: 'start' },
  ])
    assert.equal(crashEndsGuest({ ...draft, ...open }, true), false, JSON.stringify(open));
  assert.ok(SCREEN_CRASH_REPEAT_MS > SCREEN_RESTART_MS);
  // The app boundary replaces the controller: its requests in flight end first.
  assert.ok(APP_RESTART_MS > 15000 && APP_RESTART_MS > KASPI_CALL_TIMEOUT_MS);
});

test('#2: with a payment open, the controller itself refuses a new guest', async () => {
  const h = fixture();
  const c = await atQr(h);
  const before = h.rawFlow;
  assert.equal(await c.newGuest(), false);
  assert.equal(JSON.parse(h.rawFlow).order.orderId, JSON.parse(before).order.orderId);
  assert.equal(c.getSnapshot().order !== null, true, 'the open payment is kept');
});

test('#2: the app and the guest screens are both inside the boundary', () => {
  const read = (path) => readFileSync(new URL(`../../apps/kiosk/${path}`, import.meta.url), 'utf8');
  const app = read('App.tsx');
  assert.match(app, /<KioskErrorBoundary[\s\S]*<KioskApp \/>[\s\S]*<\/KioskErrorBoundary>/);
  assert.match(app, /restartMs=\{APP_RESTART_MS\}/);
  const guest = read('src/screens/GuestScreen.tsx');
  assert.match(
    guest,
    /<KioskErrorBoundary[\s\S]*<ScreenTransition[\s\S]*<\/ScreenTransition>\s*<\/KioskErrorBoundary>/,
  );
  assert.match(guest, /crashEndsGuest\(model, repeated\)/);
});
