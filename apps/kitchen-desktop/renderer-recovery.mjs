// Recovery of a crashed or hung page (the same file in pos-desktop and kitchen-desktop).
// A GPU or out-of-memory crash leaves a blank window: the shell loads the app again by itself,
// but stops after a few crashes in a short time so that a broken build does not reload forever.

/** Automatic reloads are counted inside this window. */
export const RECOVERY_WINDOW_MS = 60_000;
/** At most this many automatic reloads inside the window; the next crash is left alone. */
export const RECOVERY_MAX_RELOADS = 3;
/** A page that stays unresponsive this long is treated as crashed. */
export const UNRESPONSIVE_GRACE_MS = 20_000;
/** Pause before loading again, so that a crash on start does not spin. */
export const RECOVERY_RELOAD_DELAY_MS = 1000;

/**
 * Pure decision for one lost page. `reloads` are the times of the earlier automatic reloads.
 * Returns whether to load the app again and the reload times to keep for the next decision.
 */
export function recoveryDecision(
  reloads,
  now,
  { windowMs = RECOVERY_WINDOW_MS, maxReloads = RECOVERY_MAX_RELOADS } = {},
) {
  const recent = reloads.filter((at) => at <= now && now - at < windowMs);
  if (recent.length >= maxReloads) return { reload: false, reloads: recent };
  return { reload: true, reloads: [...recent, now] };
}

/**
 * Wires the decision to a BrowserWindow:
 * - `render-process-gone` (anything but a clean exit): `onGone()` first (the POS revokes its
 *   journal session there), then the app URL is loaded again unless the crash loop limit is hit;
 * - `unresponsive`: after the grace time the hung page is terminated, which arrives here as
 *   `render-process-gone`; `responsive` in between cancels it.
 * The log line carries the event, the Chromium reason and the count - nothing from the page.
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
  let reloads = [],
    hang,
    pending;
  const alive = () => !window.isDestroyed() && !window.webContents.isDestroyed();
  const write = (event, extra = {}) => log(JSON.stringify({ event, ...extra }));
  const settle = () => {
    if (hang) clearTimer(hang);
    hang = undefined;
  };
  window.webContents.on('render-process-gone', (_event, details) => {
    settle();
    onGone();
    const reason = typeof details?.reason === 'string' ? details.reason : 'unknown';
    if (reason === 'clean-exit' || !alive() || pending) return;
    const decision = recoveryDecision(reloads, now());
    reloads = decision.reloads;
    if (!decision.reload) {
      write('renderer_recovery_stopped', { reason, reloads: reloads.length });
      return;
    }
    write('renderer_recovery_reload', { reason, reloads: reloads.length });
    pending = setTimer(() => {
      pending = undefined;
      if (alive()) void Promise.resolve(window.loadURL(url)).catch(() => {});
    }, RECOVERY_RELOAD_DELAY_MS);
  });
  window.on('unresponsive', () => {
    if (hang) return;
    hang = setTimer(() => {
      hang = undefined;
      if (!alive()) return;
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
