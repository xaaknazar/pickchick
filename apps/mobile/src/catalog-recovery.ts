// Only owns a public catalog read. Order/payment commands never enter this loop.
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000] as const;
/** Published menus are re-read once a minute while the app is in the foreground. */
export const PUBLISHED_CATALOG_REFRESH_MS = 60_000;

/** `X-Catalog-Version` from the availability long-poll: a positive decimal integer or null. */
export function parseCatalogVersionHeader(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,8}$/.test(value.trim())) return null;
  return Number(value.trim());
}

/**
 * Version a catalog refresh should be started for, or null. Only a head newer than both the
 * loaded publication and an already requested refresh starts one, so a repeated header never
 * restarts a refresh that is still loading.
 */
export function catalogRefreshTarget(
  headVersion: number | null,
  loadedVersion: number | null,
  requestedVersion: number | null,
): number | null {
  if (headVersion === null || loadedVersion === null) return null;
  return headVersion > Math.max(loadedVersion, requestedVersion ?? 0) ? headVersion : null;
}

export function recoveryRetryDelay(failures: number, random = Math.random): number {
  const base = RETRY_DELAYS_MS[Math.min(Math.max(failures - 1, 0), RETRY_DELAYS_MS.length - 1)]!;
  return Math.round(base * (0.8 + Math.min(1, Math.max(0, random())) * 0.2));
}

export function createCatalogRecovery<T>(options: {
  load(signal: AbortSignal): Promise<T>;
  isRetryable(error: unknown): boolean;
  /** `background` is true for a scheduled re-read or `refresh()`, false for activation. */
  onLoading(background: boolean): void;
  onSuccess(value: T): void;
  onFailure(error: unknown, background: boolean): void;
  random?: () => number;
  /** Foreground re-read after a success; null keeps the old read-once behaviour. */
  successDelay?: (value: T) => number | null;
}) {
  let active = false;
  let stopped = false;
  let retryIndex = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | null = null;
  let resumeAfterRequest = false;
  let refreshAfterRequest = false;

  const clearRetry = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const schedule = (delay: number, background: boolean) => {
    timer = setTimeout(() => {
      timer = undefined;
      void run(background);
    }, delay);
  };
  const run = async (background = false) => {
    if (stopped || !active || request) return;
    const controller = new AbortController();
    request = controller;
    options.onLoading(background);
    try {
      const value = await options.load(controller.signal);
      if (!stopped && active && !controller.signal.aborted) {
        retryIndex = 0;
        options.onSuccess(value);
        const delay = options.successDelay?.(value) ?? null;
        if (delay !== null && Number.isFinite(delay) && !stopped && active && !refreshAfterRequest)
          schedule(delay, true);
      }
    } catch (error) {
      if (!stopped && active && !controller.signal.aborted) {
        options.onFailure(error, background);
        if (options.isRetryable(error) && !refreshAfterRequest)
          schedule(recoveryRetryDelay(++retryIndex, options.random), background);
      }
    } finally {
      request = null;
      // A rapid background/foreground transition must finish cancelling the old
      // request before starting another, even if fetch settles its abort later.
      if (resumeAfterRequest && !stopped && active) {
        resumeAfterRequest = false;
        refreshAfterRequest = false;
        void run();
      } else if (refreshAfterRequest && !stopped && active) {
        refreshAfterRequest = false;
        clearRetry();
        void run(true);
      }
    }
  };

  return {
    setActive(next: boolean) {
      if (stopped || active === next) return;
      active = next;
      clearRetry();
      if (!active) {
        resumeAfterRequest = false;
        refreshAfterRequest = false;
        request?.abort();
      } else {
        retryIndex = 0;
        if (request) resumeAfterRequest = true;
        else void run();
      }
    },
    /**
     * Re-read now without the activation loading state, e.g. when the server reports a newer
     * publication. A read already in flight is followed by exactly one more read.
     */
    refresh() {
      if (stopped || !active) return;
      if (request) {
        refreshAfterRequest = true;
        return;
      }
      clearRetry();
      retryIndex = 0;
      void run(true);
    },
    stop() {
      stopped = true;
      clearRetry();
      resumeAfterRequest = false;
      refreshAfterRequest = false;
      request?.abort();
    },
  };
}
