import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createPool, type DatabaseClient, type DatabasePool } from '@pickchick/database';
import { RESOURCE, Resources } from '@pickchick/platform';

/** One dedicated LISTEN connection per API process; polling remains the recovery path. */
@Injectable()
export class CatalogPublicationListener implements OnModuleInit, OnModuleDestroy {
  private readonly pool: DatabasePool;
  private client: DatabaseClient | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private disconnect: (() => void) | undefined;
  private readonly listeners = new Set<() => void>();
  revision = 0;
  constructor(@Inject(RESOURCE) resources: Resources) {
    this.pool = createPool(resources.pool.options.connectionString!, 1);
  }
  onModuleInit() {
    return this.connect();
  }
  private async connect() {
    if (this.stopped) return;
    let client: DatabaseClient | null = null;
    let released = false;
    const failed = () => {
      if (released) return;
      released = true;
      if (client) {
        client.release(true);
        if (this.client === client) this.client = null;
      }
      if (!this.stopped)
        this.retry = setTimeout(() => {
          void this.connect();
        }, 2000);
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
      await client.query('LISTEN pickchick_catalog_published');
      if (released) return;
      this.client = client;
      client.on('notification', (message) => {
        if (message.channel !== 'pickchick_catalog_published') return;
        this.revision++;
        for (const wake of this.listeners) wake();
      });
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
    for (const wake of this.listeners) wake();
    this.disconnect?.();
    this.client = null;
    await this.pool.end();
  }
}
