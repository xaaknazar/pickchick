import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createPool, type DatabaseClient, type DatabasePool } from '@pickchick/database';
import { RESOURCE, Resources } from '@pickchick/platform';

const CHANNEL = 'pickchick_catalog_published';

/**
 * One dedicated LISTEN connection per API process; polling remains the recovery path.
 * TCP keepalive plus a periodic `SELECT 1` heartbeat detect a silently dropped session; the
 * listener then reconnects and bumps `revision` so every waiter re-reads (a NOTIFY sent while
 * the session was gone is never delivered).
 */
@Injectable()
export class CatalogPublicationListener implements OnModuleInit, OnModuleDestroy {
  private readonly pool: DatabasePool;
  private client: DatabaseClient | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private connectedOnce = false;
  private disconnect: (() => void) | undefined;
  private readonly listeners = new Set<() => void>();
  revision = 0;
  /** Heartbeat period and the time a `SELECT 1` may take before the session is dropped. */
  heartbeatMs = 15_000;
  heartbeatTimeoutMs = 5_000;
  retryMs = 2_000;
  constructor(@Inject(RESOURCE) resources: Resources) {
    this.pool = createPool(resources.pool.options.connectionString!, 1, { keepAliveMs: 10_000 });
  }
  onModuleInit() {
    return this.connect();
  }
  private bump() {
    this.revision++;
    for (const wake of [...this.listeners]) wake();
  }
  private async connect() {
    if (this.stopped) return;
    let client: DatabaseClient | null = null;
    let released = false;
    const failed = () => {
      if (released) return;
      released = true;
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      if (client) {
        client.release(true);
        if (this.client === client) this.client = null;
      }
      if (!this.stopped)
        this.retry = setTimeout(() => {
          void this.connect();
        }, this.retryMs);
    };
    try {
      client = await this.pool.connect();
      this.disconnect = failed;
      client.on('error', failed);
      client.on('end', failed);
      if (this.stopped) {
        failed();
        return;
      }
      await client.query(`LISTEN ${CHANNEL}`);
      if (released) return;
      this.client = client;
      client.on('notification', (message) => {
        if (message.channel === CHANNEL) this.bump();
      });
      const session = client;
      this.heartbeat = setInterval(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('heartbeat timeout')), this.heartbeatTimeoutMs);
        });
        void Promise.race([session.query('SELECT 1'), timeout])
          .catch(() => failed())
          .finally(() => clearTimeout(timer));
      }, this.heartbeatMs);
      this.heartbeat.unref?.();
      // A reconnect may have missed publications: make every waiter re-read now.
      if (this.connectedOnce) this.bump();
      this.connectedOnce = true;
    } catch {
      failed();
    }
  }
  wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.listeners.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.listeners.add(done);
    });
  async onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    for (const wake of [...this.listeners]) wake();
    this.disconnect?.();
    this.client = null;
    await this.pool.end();
  }
}
