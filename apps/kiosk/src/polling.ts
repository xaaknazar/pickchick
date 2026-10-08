import type { KioskState } from './model';

/** Errors back off 3 s, 6 s, 12 s, 24 s, then every 30 s; nothing here blocks the UI. */
export const backoffMs = (failures: number) => Math.min(30000, 3000 * 2 ** Math.min(failures, 4));
/** Without a signature the server cannot long-poll, so plain reads are spaced out. */
export const PLAIN_AVAILABILITY_MS = 15000;

export interface PollingController {
  getSnapshot(): KioskState;
  refresh(): Promise<void>;
  tick(): Promise<void>;
  /** One background availability cycle (commercial kiosk only). */
  watchAvailability?: () => Promise<
    'idle' | 'unchanged' | 'changed' | 'reloaded' | 'unsupported' | 'failed'
  >;
}

/**
 * Background loops of the kiosk screen:
 * 1. the foreground refresh (order, recovery, missing menu, and a catalog/config re-read every
 *    60 s mid-session), as before;
 * 2. the availability long-poll, which also runs on the start/attract screen so stops and a new
 *    publication are visible before a guest taps;
 * 3. the 1 s idle tick.
 * Returns a stop function. `isActive` reports whether the app is in the foreground.
 */
export function startKioskPolling(
  controller: PollingController,
  isActive: () => boolean,
): () => void {
  let stopped = false;
  let failures = 0;
  let catalogPollAt = Date.now();
  let poll: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (stopped) return;
    poll = setTimeout(async () => {
      const before = controller.getSnapshot();
      if (
        isActive() &&
        before.ready &&
        !before.busy &&
        (before.order ||
          before.recoveryRequired ||
          !before.catalog ||
          (before.step !== 'start' && Date.now() - catalogPollAt >= 60000))
      ) {
        await controller.refresh();
        if (controller.getSnapshot().catalog) catalogPollAt = Date.now();
        failures = controller.getSnapshot().error ? failures + 1 : 0;
      }
      schedule();
    }, backoffMs(failures));
  };
  schedule();

  let watchFailures = 0;
  let watch: ReturnType<typeof setTimeout> | undefined;
  const watchNext = (delay: number) => {
    if (stopped || !controller.watchAvailability) return;
    watch = setTimeout(async () => {
      let next: number;
      try {
        const result = isActive() ? await controller.watchAvailability!() : 'idle';
        if (result === 'failed') next = backoffMs(watchFailures++);
        else {
          watchFailures = 0;
          next =
            result === 'changed' || result === 'unchanged' || result === 'reloaded'
              ? 0
              : result === 'unsupported'
                ? PLAIN_AVAILABILITY_MS
                : backoffMs(0);
        }
      } catch {
        next = backoffMs(watchFailures++);
      }
      watchNext(next);
    }, delay);
  };
  watchNext(backoffMs(0));

  const idle = setInterval(() => {
    if (isActive()) void controller.tick();
  }, 1000);
  return () => {
    stopped = true;
    clearTimeout(poll);
    clearTimeout(watch);
    clearInterval(idle);
  };
}
