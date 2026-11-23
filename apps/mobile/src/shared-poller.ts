import { sameContent } from './stable-values.ts';

/**
 * One reader per key for any number of subscribers (audit 23.11 #8): six components that show
 * the same published content used to run six timers and six requests a minute. The first
 * subscriber of a key starts its reader, the last one to leave stops it; the last value stays
 * for the next subscriber. Pure: the request, the timer and the foreground signal are injected.
 */
export function createSharedPoller<T>(options: {
  /** One read; null keeps the last value (a refused or skipped read). */
  read(key: string, signal: AbortSignal): Promise<T | null>;
  /** Asks for a re-read on every tick (timer, return to the foreground); returns its stop. */
  watch(reload: () => void): () => void;
}) {
  const values = new Map<string, T>();
  const readers = new Map<string, { listeners: Set<() => void>; stop(): void }>();
  const start = (key: string) => {
    const listeners = new Set<() => void>();
    const abort = new AbortController();
    let running = false;
    const load = async () => {
      if (running || abort.signal.aborted) return;
      running = true;
      try {
        const next = await options.read(key, abort.signal);
        // A re-read with the same content keeps the object (no render of the subscribers).
        if (next === null || abort.signal.aborted || sameContent(values.get(key), next)) return;
        values.set(key, next);
        for (const listener of [...listeners]) listener();
      } catch {
        /* Keep the last value of this key. */
      } finally {
        running = false;
      }
    };
    void load();
    const unwatch = options.watch(() => void load());
    return {
      listeners,
      stop() {
        abort.abort();
        unwatch();
      },
    };
  };
  return {
    get: (key: string): T | null => values.get(key) ?? null,
    subscribe(key: string, listener: () => void) {
      let reader = readers.get(key);
      if (!reader) {
        reader = start(key);
        readers.set(key, reader);
      }
      const current = reader;
      current.listeners.add(listener);
      return () => {
        current.listeners.delete(listener);
        if (current.listeners.size) return;
        current.stop();
        if (readers.get(key) === current) readers.delete(key);
      };
    },
  };
}
