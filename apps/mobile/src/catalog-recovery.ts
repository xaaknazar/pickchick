// Only owns a public catalog read. Order/payment commands never enter this loop.
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const;

export function createCatalogRecovery<T>(options: {
  load(signal: AbortSignal): Promise<T>;
  isRetryable(error: unknown): boolean;
  onLoading(): void;
  onSuccess(value: T): void;
  onFailure(error: unknown): void;
}) {
  let active = false;
  let stopped = false;
  let retryIndex = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | null = null;
  let resumeAfterRequest = false;

  const clearRetry = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const run = async () => {
    if (stopped || !active || request) return;
    const controller = new AbortController();
    request = controller;
    options.onLoading();
    try {
      const value = await options.load(controller.signal);
      if (!stopped && active && !controller.signal.aborted) options.onSuccess(value);
    } catch (error) {
      if (!stopped && active && !controller.signal.aborted) {
        options.onFailure(error);
        const delay = RETRY_DELAYS_MS[retryIndex];
        if (delay !== undefined && options.isRetryable(error)) {
          retryIndex += 1;
          timer = setTimeout(() => {
            timer = undefined;
            void run();
          }, delay);
        }
      }
    } finally {
      request = null;
      // A rapid background/foreground transition must finish cancelling the old
      // request before starting another, even if fetch settles its abort later.
      if (resumeAfterRequest && !stopped && active) {
        resumeAfterRequest = false;
        void run();
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
        request?.abort();
      } else {
        retryIndex = 0;
        if (request) resumeAfterRequest = true;
        else void run();
      }
    },
    stop() {
      stopped = true;
      clearRetry();
      resumeAfterRequest = false;
      request?.abort();
    },
  };
}
