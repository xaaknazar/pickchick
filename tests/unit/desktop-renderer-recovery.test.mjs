import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import {
  RECOVERY_MAX_RELOADS,
  RECOVERY_RELOAD_DELAY_MS,
  RECOVERY_SLOW_RETRY_MS,
  RECOVERY_WINDOW_MS,
  UNRESPONSIVE_GRACE_MS,
  recoveryDecision,
  watchRenderer,
} from '../../apps/pos-desktop/renderer-recovery.mjs';

const root = new URL('../../', import.meta.url);
// A Windows checkout may hold CRLF; the rules are about the text.
const text = (path) => readFileSync(new URL(path, root), 'utf8').replaceAll('\r\n', '\n');
const URL_APP = 'pickchick-pos://app/index.html';

/** A BrowserWindow stand-in with manual timers. */
function shell(extra = {}) {
  const window = new EventEmitter();
  window.webContents = new EventEmitter();
  const state = { loads: [], kills: 0, gone: 0, lines: [], clock: 1_000_000, timers: [] };
  window.isDestroyed = () => false;
  window.webContents.isDestroyed = () => false;
  window.loadURL = async (url) => void state.loads.push(url);
  window.webContents.forcefullyCrashRenderer = () => {
    state.kills += 1;
    window.webContents.emit('render-process-gone', {}, { reason: 'killed' });
  };
  watchRenderer({
    window,
    url: URL_APP,
    onGone: () => (state.gone += 1),
    log: (line) => state.lines.push(JSON.parse(line)),
    now: () => state.clock,
    setTimer: (run, ms) => {
      const timer = { run, at: state.clock + ms };
      state.timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      state.timers = state.timers.filter((entry) => entry !== timer);
    },
    ...extra,
  });
  /** Moves the clock and runs the timers that came due. */
  const advance = (ms) => {
    state.clock += ms;
    for (const timer of state.timers.filter((entry) => entry.at <= state.clock)) {
      state.timers = state.timers.filter((entry) => entry !== timer);
      timer.run();
    }
  };
  const crash = (reason = 'crashed') =>
    window.webContents.emit('render-process-gone', {}, { reason });
  return { window, state, advance, crash };
}

test('the decision reloads a lost page quickly, then once every 5 minutes in a crash loop', () => {
  const fresh = { reloads: [], limited: false };
  const quick = RECOVERY_RELOAD_DELAY_MS,
    slow = RECOVERY_SLOW_RETRY_MS;
  assert.deepEqual(recoveryDecision(fresh, 5000), {
    limited: false,
    delayMs: quick,
    reloads: [5000 + quick],
  });
  // The limit of quick reloads inside the window: the next one is slow.
  const full = Array.from({ length: RECOVERY_MAX_RELOADS }, (_, index) => 1000 + index);
  assert.deepEqual(recoveryDecision({ reloads: full, limited: false }, 2000), {
    limited: true,
    delayMs: slow,
    reloads: [...full, 2000 + slow],
  });
  // One reload has left the window: one more quick reload.
  assert.equal(
    recoveryDecision({ reloads: full, limited: false }, 1000 + RECOVERY_WINDOW_MS).limited,
    false,
  );
  // Lost again soon after a slow reload: still slow, one reload per 5 minutes.
  const looping = { reloads: [...full, 400_000], limited: true };
  assert.deepEqual(recoveryDecision(looping, 400_500), {
    limited: true,
    delayMs: slow,
    reloads: [400_000, 400_500 + slow],
  });
  assert.equal(recoveryDecision(looping, 400_000 + slow - 1).limited, true);
  // A page that lived 5 minutes after the slow reload starts over.
  assert.deepEqual(recoveryDecision(looping, 400_000 + slow), {
    limited: false,
    delayMs: quick,
    reloads: [400_000 + slow + quick],
  });
  // A clock that went back never throws and never keeps a future reload.
  assert.deepEqual(recoveryDecision({ reloads: [9000], limited: true }, 5000), {
    limited: false,
    delayMs: quick,
    reloads: [5000 + quick],
  });
  assert.deepEqual(
    recoveryDecision({ reloads: [1, 2], limited: false }, 3, {
      maxReloads: 2,
      windowMs: 10,
      slowMs: 50,
      delayMs: 1,
    }),
    { limited: true, delayMs: 50, reloads: [1, 2, 53] },
  );
});

test('a crashed page is loaded again after the owner hook, a clean exit is left alone', () => {
  const { state, advance, crash } = shell();
  crash('clean-exit');
  advance(RECOVERY_RELOAD_DELAY_MS);
  assert.equal(state.gone, 1, 'the POS still revokes its journal session');
  assert.deepEqual(state.loads, []);
  crash('oom');
  assert.equal(state.gone, 2);
  assert.deepEqual(state.loads, [], 'not before the pause');
  advance(RECOVERY_RELOAD_DELAY_MS);
  assert.deepEqual(state.loads, [URL_APP]);
  assert.deepEqual(state.lines, [
    { event: 'renderer_recovery_reload', reason: 'oom', delay_ms: RECOVERY_RELOAD_DELAY_MS },
  ]);
});

test('a crash loop slows down to one reload per 5 minutes and never leaves the window blank', () => {
  const { window, state, advance, crash } = shell();
  for (let i = 0; i < RECOVERY_MAX_RELOADS; i++) {
    crash();
    advance(RECOVERY_RELOAD_DELAY_MS);
  }
  assert.equal(state.loads.length, RECOVERY_MAX_RELOADS);
  crash('launch-failed');
  assert.deepEqual(state.lines.at(-1), {
    event: 'renderer_recovery_slowed',
    reason: 'launch-failed',
    delay_ms: RECOVERY_SLOW_RETRY_MS,
  });
  advance(RECOVERY_SLOW_RETRY_MS - 1);
  assert.equal(state.loads.length, RECOVERY_MAX_RELOADS, 'no quick reload past the limit');
  advance(1);
  assert.equal(state.loads.length, RECOVERY_MAX_RELOADS + 1, 'the slow reload');
  // Still looping: the next reload is slow again.
  crash();
  advance(RECOVERY_RELOAD_DELAY_MS);
  assert.equal(state.loads.length, RECOVERY_MAX_RELOADS + 1);
  advance(RECOVERY_SLOW_RETRY_MS);
  assert.equal(state.loads.length, RECOVERY_MAX_RELOADS + 2);
  // In the loop a page that hangs is not killed: it may answer, and a kill would blank it.
  window.emit('unresponsive');
  advance(UNRESPONSIVE_GRACE_MS);
  assert.equal(state.kills, 0);
  assert.equal(state.lines.at(-1).event, 'renderer_recovery_unresponsive_left');
  assert.equal(state.loads.length, RECOVERY_MAX_RELOADS + 2);
  assert.equal(state.gone, RECOVERY_MAX_RELOADS + 2);
  // A page that lived 5 minutes is recovered quickly again, also from a hang.
  advance(RECOVERY_SLOW_RETRY_MS);
  window.emit('unresponsive');
  advance(UNRESPONSIVE_GRACE_MS);
  assert.equal(state.kills, 1);
  advance(RECOVERY_RELOAD_DELAY_MS);
  assert.equal(state.loads.length, RECOVERY_MAX_RELOADS + 3);
});

test('a hang right after the quick reloads are used up is left alone', () => {
  const { window, state, advance, crash } = shell();
  for (let i = 0; i < RECOVERY_MAX_RELOADS; i++) {
    crash();
    advance(RECOVERY_RELOAD_DELAY_MS);
  }
  window.emit('unresponsive');
  advance(UNRESPONSIVE_GRACE_MS);
  assert.equal(state.kills, 0, 'the limit is reached: no kill');
  assert.equal(state.loads.length, RECOVERY_MAX_RELOADS);
  // It hangs again after the window has passed: terminated and reloaded as usual.
  window.emit('responsive');
  advance(RECOVERY_WINDOW_MS);
  window.emit('unresponsive');
  advance(UNRESPONSIVE_GRACE_MS);
  assert.equal(state.kills, 1);
});

test('a page that stays unresponsive is terminated and reloaded; responsive cancels it', () => {
  const { window, state, advance } = shell();
  window.emit('unresponsive');
  advance(UNRESPONSIVE_GRACE_MS - 1);
  window.emit('responsive');
  advance(UNRESPONSIVE_GRACE_MS);
  assert.equal(state.kills, 0, 'it answered in time');
  window.emit('unresponsive');
  window.emit('unresponsive');
  advance(UNRESPONSIVE_GRACE_MS);
  assert.equal(state.kills, 1);
  advance(RECOVERY_RELOAD_DELAY_MS);
  assert.deepEqual(state.loads, [URL_APP]);
  assert.deepEqual(
    state.lines.map((line) => line.event),
    ['renderer_recovery_unresponsive', 'renderer_recovery_reload'],
  );
});

test('a closed or destroyed window is never reloaded', () => {
  const closed = shell();
  closed.crash();
  closed.window.emit('unresponsive');
  closed.window.emit('closed');
  closed.advance(UNRESPONSIVE_GRACE_MS + RECOVERY_RELOAD_DELAY_MS);
  assert.deepEqual(closed.state.loads, []);
  assert.equal(closed.state.kills, 0);
  const destroyed = shell();
  destroyed.window.isDestroyed = () => true;
  destroyed.crash();
  destroyed.advance(RECOVERY_RELOAD_DELAY_MS);
  assert.deepEqual(destroyed.state.loads, []);
  assert.deepEqual(destroyed.state.lines, []);
});

test('both desktop shells ship the same recovery module and use it', () => {
  assert.equal(
    text('apps/pos-desktop/renderer-recovery.mjs'),
    text('apps/kitchen-desktop/renderer-recovery.mjs'),
    'renderer-recovery.mjs must be identical in pos-desktop and kitchen-desktop',
  );
  for (const app of ['pos-desktop', 'kitchen-desktop']) {
    assert.match(text(`apps/${app}/electron-builder.yml`), /^ {2}- renderer-recovery\.mjs$/m);
    // The package check compares the packaged files with an exact list.
    assert.match(text(`apps/${app}/scripts/verify-package.mjs`), /'\/renderer-recovery\.mjs',/);
    assert.match(text(`apps/${app}/package.json`), /node --check renderer-recovery\.mjs/);
    assert.match(
      text(`apps/${app}/main.mjs`),
      /import \{ watchRenderer \} from '\.\/renderer-recovery\.mjs';/,
    );
  }
  // The till keeps revoking the journal session of a lost page.
  assert.match(
    text('apps/pos-desktop/main.mjs'),
    /watchRenderer\(\{ window, url: APP_URL, onGone: \(\) => journal\.setSession\(null\) \}\);/,
  );
  assert.match(
    text('apps/kitchen-desktop/main.mjs'),
    /watchRenderer\(\{ window, url: APP_URL \}\);\s+await window\.loadURL\(APP_URL\);/,
  );
});
