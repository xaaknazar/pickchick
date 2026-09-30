import { createPool } from '@pickchick/database';
import type { DatabaseClient } from '@pickchick/database';

/** One dedicated LISTEN connection per API, never one database connection per phone. */
export class TestOrderEvents {
  private readonly pool;
  private connecting: Promise<void> | undefined;
  private client: DatabaseClient | undefined;
  private closed = false;
  private disconnect: (() => void) | undefined;
  private readonly listeners = new Set<(id: string | null) => void>();
  constructor(databaseUrl: string) {
    this.pool = createPool(databaseUrl, 1);
  }
  private async connect() {
    if (this.closed) throw new Error('Events closed');
    if (this.client) return;
    this.connecting ??= (async () => {
      const client = await this.pool.connect();
      let failed = false;
      const lost = () => {
        if (failed) return;
        failed = true;
        if (this.client === client) {
          this.client = undefined;
          this.disconnect = undefined;
        }
        client.release(true);
        for (const listener of this.listeners) listener(null);
      };
      client.on('error', lost);
      client.on('end', lost);
      client.on('notification', (message) => {
        if (message.channel === 'pickchick_test_orders' && message.payload)
          for (const listener of this.listeners) listener(message.payload);
      });
      try {
        await client.query('LISTEN pickchick_test_orders');
        if (failed || this.closed) throw new Error('Events unavailable');
        this.client = client;
        this.disconnect = lost;
      } catch (error) {
        lost();
        throw error;
      }
    })().finally(() => {
      this.connecting = undefined;
    });
    await this.connecting;
  }
  async subscribe() {
    await this.connect();
    // Subscribe before reading the snapshot; remember notifications racing that read.
    const seen = new Set<string>();
    let lost = false;
    let wake: (() => void) | undefined;
    let ids = new Set<string>();
    const listener = (id: string | null) => {
      if (id === null || seen.size >= 1000) lost = true;
      else seen.add(id);
      if (lost || (id !== null && ids.has(id))) wake?.();
    };
    this.listeners.add(listener);
    let cleanup = () => {};
    return {
      wait: (orderIds: string[], signal: AbortSignal, timeoutMs = 20000) => {
        ids = new Set(orderIds);
        if (lost || signal.aborted || [...ids].some((id) => seen.has(id))) return Promise.resolve();
        return new Promise<void>((resolve) => {
          const done = () => {
            cleanup();
            resolve();
          };
          const timer = setTimeout(done, timeoutMs);
          cleanup = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            wake = undefined;
          };
          wake = done;
          signal.addEventListener('abort', done, { once: true });
        });
      },
      dispose: () => {
        wake?.();
        cleanup();
        this.listeners.delete(listener);
      },
    };
  }
  async close() {
    this.closed = true;
    for (const listener of this.listeners) listener(null);
    await this.connecting?.catch(() => {});
    this.disconnect?.();
    this.client = undefined;
    await this.pool.end();
  }
}
