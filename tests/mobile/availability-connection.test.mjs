import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';
import { testCompleteCatalog } from '@pickchick/test-order-flow/complete-catalog';
import {
  CONNECTION_OK,
  CONNECTION_PROBLEM_AFTER_FAILURES,
  CONNECTION_PROBLEM_AFTER_MS,
  connectionProblem,
  createConnectionTracker,
  failurePersisted,
  persistenceWait,
  phoneNetworkChanged,
  readFailed,
  readSucceeded,
  shownAvailabilityState,
} from '../../apps/mobile/src/availability-connection.ts';
import {
  AvailabilityRequestError,
  CONFIRMATION_DELAY_MS,
  createAvailabilityRecovery,
} from '../../apps/mobile/src/availability-recovery.ts';
import { catalogAvailability } from '../../apps/mobile/src/availability.ts';
import {
  paymentAvailability,
  paymentStopLabel,
  paymentStopMessage,
} from '../../apps/mobile/src/payment-availability.ts';
import { defaultSelections } from '../../apps/mobile/src/domain.ts';

// Owner 28.10.2026 (TestFlight 25): opening the cart flashed «Нет связи с сервером» and the
// quick-pay handle vanished for a moment. One dropped long-poll (and its immediate confirmation
// snapshot over the same dead connection) is not a lost server: the last answer stays, and the
// problem is shown only when it persists. The browser side is browser_cart_unavailable.py K/L/M.

const HOURS = { openingTime: '10:00', closingTime: '00:00', timeZone: 'Asia/Almaty' };
const almaty = (clock) => {
  const [h, m] = clock.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 28, h - 5, m));
};
const p = testCompleteCatalog.products.find((candidate) => candidate.id === 'pick-combo');
const product = {
  ...p,
  priceMinor: p.price_minor,
  modifierGroups: p.modifier_groups,
  source: 'server',
};
const cart = [{ product, quantity: 1, selections: defaultSelections(product) }];
const answer = (extra = {}) => ({
  enabled: true,
  fresh: true,
  orderingOpen: true,
  hours: HOURS,
  signature: 'a'.repeat(64),
  products: [{ id: 'pick-combo', available: true, stoppedOptions: [] }],
  ...extra,
});

/** What the cart bar and the cart decide from the shown state (usePaymentAvailability). */
function decide(data, track, clock = '12:00') {
  const model = catalogAvailability(shownAvailabilityState(data, track), true);
  return paymentAvailability({
    guarded: true,
    now: almaty(clock),
    status: model.availabilityStatus,
    hours: model.availabilityHours,
    known: model.availabilityKnown,
    cart,
  });
}
const handle = (decision) => decision.canPay;
const banner = (decision) => (decision.canPay ? null : paymentStopMessage(decision.stop));

test('a transient error keeps the last answer: the handle stays and no banner appears', () => {
  const data = answer();
  let track = CONNECTION_OK;
  assert.equal(handle(decide(data, track)), true);
  // The long-poll dropped and its confirmation snapshot failed too: one failed cycle.
  track = readFailed(track, 'offline');
  assert.equal(connectionProblem(track), null);
  assert.deepEqual(shownAvailabilityState(data, track), { data, status: 'online' });
  assert.equal(handle(decide(data, track)), true);
  assert.equal(banner(decide(data, track)), null);
  // The retry about two seconds later answers: everything as before, nothing was shown.
  track = readSucceeded(track);
  assert.deepEqual(track, { ...CONNECTION_OK, streak: 1 });
  assert.equal(handle(decide(data, track)), true);
});

test('an answer the reader will not retry is final: shown at once, gone with the next answer', () => {
  // An HTTP refusal, a broken body, a captive-portal page: createCatalogRecovery does not retry
  // these, so waiting five seconds would only keep the last answer on screen for nothing (tech
  // lead 28.10.2026). The guarded submit() re-checks on the server either way.
  const data = answer();
  let track = readFailed(CONNECTION_OK, 'error');
  assert.equal(connectionProblem(track), 'error');
  assert.equal(handle(decide(data, track)), false);
  assert.equal(banner(decide(data, track)), 'Нет связи с сервером');
  // Before the first answer as well: no later read is coming to correct it.
  assert.equal(decide(null, track).stop.kind, 'offline');
  // After a transient failure of the same run, too.
  assert.equal(
    connectionProblem(readFailed(readFailed(CONNECTION_OK, 'offline'), 'error')),
    'error',
  );
  track = readSucceeded(track);
  assert.equal(handle(decide(data, track)), true);
  assert.equal(banner(decide(data, track)), null);
});

test('a persistent error is shown: a second failed cycle in a row or five seconds', () => {
  const data = answer();
  assert.equal(CONNECTION_PROBLEM_AFTER_FAILURES, 2);
  assert.equal(CONNECTION_PROBLEM_AFTER_MS, 5000);
  // Two cycles in a row.
  let track = readFailed(readFailed(CONNECTION_OK, 'offline'), 'offline');
  assert.equal(connectionProblem(track), 'offline');
  const twice = decide(data, track);
  assert.equal(handle(twice), false);
  assert.equal(banner(twice), 'Нет связи с сервером');
  assert.equal(paymentStopLabel(twice.stop), 'Нет связи');
  // One cycle that never ends in an answer: the persistence timer marks it after five seconds.
  track = readFailed(CONNECTION_OK, 'offline');
  assert.equal(handle(decide(data, track)), true);
  track = failurePersisted(track, track.streak);
  assert.equal(connectionProblem(track), 'offline');
  assert.equal(banner(decide(data, track)), 'Нет связи с сервером');
  // Once shown it stays until the server answers (no blinking), then it is gone at once.
  assert.equal(readFailed(track, 'offline').shown, true);
  track = readSucceeded(track);
  assert.equal(connectionProblem(track), null);
  assert.equal(handle(decide(data, track)), true);
});

test('a timer of an earlier run never marks a new run of failures', () => {
  let track = readFailed(CONNECTION_OK, 'offline');
  const first = track.streak;
  track = readFailed(readSucceeded(track), 'offline');
  assert.notEqual(track.streak, first);
  assert.equal(failurePersisted(track, first), track);
  assert.equal(failurePersisted(track, track.streak).shown, true);
  // Nothing pending: nothing to mark.
  assert.equal(failurePersisted(CONNECTION_OK, 0), CONNECTION_OK);
});

test('the phone itself reports no network: shown at once, until the server answers again', () => {
  const data = answer();
  let track = phoneNetworkChanged(CONNECTION_OK, false);
  assert.equal(connectionProblem(track), 'offline');
  assert.equal(handle(decide(data, track)), false);
  assert.equal(banner(decide(data, track)), 'Нет связи с сервером');
  // The interface is back: still no proof that the server answers, so nothing blinks back.
  track = phoneNetworkChanged(track, true);
  assert.equal(track.phoneOffline, false);
  assert.equal(connectionProblem(track), 'offline');
  assert.equal(handle(decide(data, track)), false);
  track = readSucceeded(track);
  assert.equal(handle(decide(data, track)), true);
  // A connected report while everything is fine changes nothing (no re-render).
  assert.equal(phoneNetworkChanged(CONNECTION_OK, true), CONNECTION_OK);
  const offline = phoneNetworkChanged(CONNECTION_OK, false);
  assert.equal(phoneNetworkChanged(offline, false), offline);
});

test('closed stays closed through a transient or a persistent error', () => {
  // Closed by the server (no published hours): the kept answer says why, not the connection.
  const closed = answer({ orderingOpen: false, hours: undefined });
  const transient = readFailed(CONNECTION_OK, 'offline');
  assert.deepEqual(decide(closed, transient).stop, {
    kind: 'closed',
    opensAt: null,
    opensTomorrow: false,
  });
  // Closed by the published hours at 09:30: the hours come first even when the server is lost.
  const persistent = readFailed(transient, 'offline');
  assert.deepEqual(decide(answer(), persistent, '09:30').stop, {
    kind: 'closed',
    opensAt: '10:00',
    opensTomorrow: false,
  });
  // The server switch and the stale stop list of the last answer stay while it re-reads.
  assert.equal(decide(answer({ enabled: false }), transient).stop.kind, 'switched_off');
  assert.equal(decide(answer({ fresh: false }), transient).stop.kind, 'stale');
});

test('before the first answer a transient failure stays «Проверяем…» without a banner', () => {
  let track = readFailed(CONNECTION_OK, 'offline');
  assert.deepEqual(shownAvailabilityState(null, track), { data: null, status: 'checking' });
  const first = decide(null, track);
  assert.deepEqual(first, { canPay: false, stop: { kind: 'checking' } });
  assert.equal(banner(first), null);
  assert.equal(paymentStopLabel(first.stop), 'Проверяем…');
  track = readFailed(track, 'offline');
  assert.equal(decide(null, track).stop.kind, 'offline');
  assert.equal(banner(decide(null, track)), 'Нет связи с сервером');
});

test('a re-read keeps the last answer: «checking» with data reads the data', () => {
  const closed = answer({ orderingOpen: false });
  const model = catalogAvailability({ data: closed, status: 'checking' }, true);
  assert.equal(model.availabilityStatus, 'closed');
  assert.equal(
    catalogAvailability({ data: null, status: 'checking' }, true).availabilityStatus,
    'checking',
  );
  assert.equal(
    catalogAvailability({ data: closed, status: 'offline' }, true).availabilityStatus,
    'offline',
  );
});

test('the tracker: one timer per run, cancelled by an answer, a new run starts its own', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seen = [];
  const tracker = createConnectionTracker({ onChange: (track) => seen.push(track) });
  t.after(() => tracker.stop());
  tracker.failed('offline');
  t.mock.timers.tick(CONNECTION_PROBLEM_AFTER_MS - 1);
  assert.equal(connectionProblem(tracker.current()), null);
  tracker.succeeded();
  t.mock.timers.tick(CONNECTION_PROBLEM_AFTER_MS);
  assert.equal(connectionProblem(tracker.current()), null, 'the answer cancelled the timer');
  tracker.failed('offline');
  t.mock.timers.tick(CONNECTION_PROBLEM_AFTER_MS - 1);
  assert.equal(connectionProblem(tracker.current()), null);
  t.mock.timers.tick(1);
  assert.equal(connectionProblem(tracker.current()), 'offline', 'five seconds without an answer');
  tracker.succeeded();
  tracker.failed('error');
  assert.equal(connectionProblem(tracker.current()), 'error', 'not retried: at once');
  tracker.succeeded();
  tracker.network(false);
  assert.equal(connectionProblem(tracker.current()), 'offline', 'the phone itself: at once');
  const changes = seen.length;
  tracker.network(false);
  assert.equal(seen.length, changes, 'an unchanged report does not re-render');
  tracker.stop();
  tracker.failed('offline');
  assert.equal(seen.length, changes, 'nothing after stop');
});

test('long-poll dropped, snapshot failed, retry answers: never shown; still failing: shown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let mode = 'ok';
  let data = null;
  const tracker = createConnectionTracker({ onChange: () => {} });
  const recovery = createAvailabilityRecovery({
    random: () => 1,
    onChecking: () => {},
    read: async () => {
      if (mode !== 'ok') throw new Error('Network request failed');
      return answer();
    },
    onSuccess: (value) => {
      data = value;
      tracker.succeeded();
    },
    onFailure: (_e, retrying) => tracker.failed(retrying ? 'offline' : 'error'),
  });
  t.after(() => {
    recovery.stop();
    tracker.stop();
  });
  const shown = () => decide(data, tracker.current());
  recovery.setActive(true);
  await flush();
  assert.equal(handle(shown()), true);
  // The next long-poll and its confirmation snapshot both fail (one cycle).
  mode = 'fail';
  t.mock.timers.tick(100);
  await flush();
  t.mock.timers.tick(CONFIRMATION_DELAY_MS);
  await flush();
  await flush();
  assert.equal(tracker.current().failures, 1);
  assert.equal(handle(shown()), true, 'one dropped cycle keeps the handle');
  // The retry two seconds later answers.
  mode = 'ok';
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(tracker.current().failures, 0);
  assert.equal(handle(shown()), true);
  // Now the server is really gone: the retry fails as well and the problem is shown.
  mode = 'fail';
  t.mock.timers.tick(100);
  await flush();
  t.mock.timers.tick(CONFIRMATION_DELAY_MS);
  await flush();
  await flush();
  assert.equal(handle(shown()), true);
  t.mock.timers.tick(2000);
  await flush();
  await flush();
  assert.equal(handle(shown()), false);
  assert.equal(banner(shown()), 'Нет связи с сервером');
});

test('a refresh restarts the reader, not the five seconds of a failure still pending', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const first = createConnectionTracker({ onChange: () => {} });
  first.failed('offline');
  t.mock.timers.tick(3000);
  // useAvailability recreates the tracker from the current track on a refresh.
  const pending = first.current();
  first.stop();
  assert.equal(persistenceWait(pending, Date.now()), 2000);
  const second = createConnectionTracker({ initial: pending, onChange: () => {} });
  t.after(() => second.stop());
  t.mock.timers.tick(1999);
  assert.equal(connectionProblem(second.current()), null);
  t.mock.timers.tick(1);
  assert.equal(connectionProblem(second.current()), 'offline', 'five seconds since the first');
  // An answer ends the run; the next run counts from its own first failure.
  second.succeeded();
  assert.equal(second.current().since, null);
  second.failed('offline');
  assert.equal(second.current().since, Date.now());
  // A run older than the persistence time is marked at once; a clock set back waits 5 s at most.
  assert.equal(persistenceWait({ ...pending, since: Date.now() - 60_000 }, Date.now()), 0);
  assert.equal(
    persistenceWait({ ...pending, since: Date.now() + 60_000 }, Date.now()),
    CONNECTION_PROBLEM_AFTER_MS,
  );
});

test('an HTTP refusal of the long-poll is not confirmed and is shown at once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let data = null;
  const tracker = createConnectionTracker({ onChange: () => {} });
  const recovery = createAvailabilityRecovery({
    random: () => 1,
    onChecking: () => {},
    read: async () => {
      if (++calls === 1) return answer();
      throw new AvailabilityRequestError(403);
    },
    onSuccess: (value) => {
      data = value;
      tracker.succeeded();
    },
    onFailure: (_e, retrying) => tracker.failed(retrying ? 'offline' : 'error'),
  });
  t.after(() => {
    recovery.stop();
    tracker.stop();
  });
  recovery.setActive(true);
  await flush();
  t.mock.timers.tick(100);
  await flush();
  await flush();
  assert.equal(calls, 2, 'no confirmation snapshot for a refusal');
  assert.equal(connectionProblem(tracker.current()), 'error');
  assert.equal(banner(decide(data, tracker.current())), 'Нет связи с сервером');
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(calls, 2, 'and no retry either');
});
