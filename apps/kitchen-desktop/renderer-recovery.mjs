// Recovery of a crashed or hung page (the same file in pos-desktop and kitchen-desktop).
// A GPU or out-of-memory crash leaves a blank window: the shell loads the app again by itself.
// After a few crashes in a short time it slows down to one reload every 5 minutes, so that a
// broken build does not spin but the window is never left blank for good.

/** Quick automatic reloads are counted inside this window. */
export const RECOVERY_WINDOW_MS = 60_000;
/** At most this many quick reloads inside the window; after that the reloads are slow. */
export const RECOVERY_MAX_RELOADS = 3;
/** A page that stays unresponsive this long is treated as crashed. */
export const UNRESPONSIVE_GRACE_MS = 20_000;
/** Pause before a quick reload, so that a crash on start does not spin. */
export const RECOVERY_RELOAD_DELAY_MS = 1000;
/** Pause before a reload once the crash loop limit is reached. */
export const RECOVERY_SLOW_RETRY_MS = 300_000;

/**
 * Pure decision for one lost page. `history` is what the previous decision returned (start with
 * `{ reloads: [], limited: false }`): the times of the earlier automatic reloads and whether
 * the last one was a slow one.
 * - fewer than the limit of reloads inside the window: reload after the short pause;
 * - the limit is reached: `limited`, reload after 5 minutes;
 * - a page that is lost again less than 5 minutes after a slow reload stays `limited`; one that
 *   lived longer starts over with quick reloads.
 * Returns the pause before this reload and the history for the next decision.
 */
export function recoveryDecision(
  history,
  now,
  {
    windowMs = RECOVERY_WINDOW_MS,
    maxReloads = RECOVERY_MAX_RELOADS,
    delayMs = RECOVERY_RELOAD_DELAY_MS,
    slowMs = RECOVERY_SLOW_RETRY_MS,
  } = {},
) {
  const kept = history.reloads.filter((at) => at <= now && now - at < Math.max(windowMs, slowMs));
  const last = kept.at(-1);
  const limited =
    kept.filter((at) => now - at < windowMs).length >= maxReloads ||
    (history.limited && last !== undefined && now - last < slowMs);
  const pause = limited ? slowMs : delayMs;
  return { limited, delayMs: pause, reloads: [...kept, now + pause] };
}

/**
 * Wires the decision to a BrowserWindow:
 * - `render-process-gone` (anything but a clean exit): `onGone()` first (the POS revokes its
 *   journal session there), then the app URL is loaded again after the decided pause;
 * - `unresponsive`: after the grace time the hung page is terminated, which arrives here as
 *   `render-process-gone`; `responsive` in between cancels it. Once the crash loop limit is
 *   reached a hung page is left alone: it may still answer, and killing it would only blank
 *   the window until the next slow reload.
 * - a reload whose `loadURL` fails is logged with the Chromium error code and repeated.
 * The log line carries the event, the Chromium reason and the pause - nothing from the page.
 */
export function watchRenderer({
  window,
  url,
  onGone = () => {},
  log = (line) => console.error(line),
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let history = { reloads: [], limited: false },
    hang,
    pending;
  const alive = () => !window.isDestroyed() && !window.webContents.isDestroyed();
  const write = (event, extra = {}) => log(JSON.stringify({ event, ...extra }));
  const settle = () => {
    if (hang) clearTimer(hang);
    hang = undefined;
  };
  // One reload at a time, each through the decision.
  const recover = (reason) => {
    if (pending || !alive()) return;
    const decision = recoveryDecision(history, now());
    history = { reloads: decision.reloads, limited: decision.limited };
    write(decision.limited ? 'renderer_recovery_slowed' : 'renderer_recovery_reload', {
      reason,
      delay_ms: decision.delayMs,
    });
    pending = setTimer(() => {
      pending = undefined;
      if (!alive()) return;
      // A load that fails (the local server is not up yet, the load was aborted) would leave
      // a blank window: it is logged and tried again through the same decision.
      const failed = (error) => {
        const code = error?.code;
        write('renderer_recovery_load_failed', {
          code: typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'UNKNOWN',
        });
        recover('load-failed');
      };
      try {
        void Promise.resolve(window.loadURL(url)).catch(failed);
      } catch (error) {
        failed(error);
      }
    }, decision.delayMs);
  };
  window.webContents.on('render-process-gone', (_event, details) => {
    settle();
    onGone();
    const reason = typeof details?.reason === 'string' ? details.reason : 'unknown';
    if (reason !== 'clean-exit') recover(reason);
  });
  window.on('unresponsive', () => {
    if (hang) return;
    hang = setTimer(() => {
      hang = undefined;
      if (!alive() || pending) return;
      if (recoveryDecision(history, now()).limited) {
        write('renderer_recovery_unresponsive_left');
        return;
      }
      write('renderer_recovery_unresponsive');
      window.webContents.forcefullyCrashRenderer();
    }, UNRESPONSIVE_GRACE_MS);
  });
  window.on('responsive', settle);
  window.on('closed', () => {
    settle();
    if (pending) clearTimer(pending);
    pending = undefined;
  });
}
