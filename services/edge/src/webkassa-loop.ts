import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { RESOURCE, Resources } from '@pickchick/platform';
import { WebkassaClient, WebkassaFiscalWorker, readWebkassaAccount } from '@pickchick/local-orders';

/** Pending receipts are looked at this often; a sale also nudges the worker at once. */
export const WEBKASSA_INTERVAL_MS = 5000;

/**
 * Automatic Webkassa receipts of the branch (webkassa-fiscal.ts). Off unless the private account
 * file EDGE_WEBKASSA_ACCOUNT_FILE is configured; a broken file is logged and leaves receipts
 * manual instead of stopping the point server.
 */
@Injectable()
export class WebkassaLoop implements OnApplicationBootstrap, OnModuleDestroy {
  readonly worker: WebkassaFiscalWorker | null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<unknown> | undefined;
  private stopped = false;

  constructor(@Inject(RESOURCE) private readonly resources: Resources) {
    const { webkassaAccountFile, branchId } = resources.config;
    let worker: WebkassaFiscalWorker | null = null;
    if (webkassaAccountFile && branchId) {
      try {
        const account = readWebkassaAccount(webkassaAccountFile);
        if (account)
          worker = new WebkassaFiscalWorker(resources.pool, branchId, new WebkassaClient(account));
      } catch (error) {
        console.error(
          JSON.stringify({ event: 'webkassa_account_invalid', message: (error as Error).message }),
        );
      }
    }
    this.worker = worker;
  }

  onApplicationBootstrap() {
    if (!this.worker) return;
    console.log(JSON.stringify({ event: 'webkassa_enabled' }));
    this.schedule(0);
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  private schedule(delay: number) {
    if (this.stopped || !this.worker) return;
    this.timer = setTimeout(() => {
      this.running = this.worker!.tick()
        .catch((error) =>
          console.error(
            JSON.stringify({ event: 'webkassa_tick_failed', message: (error as Error).message }),
          ),
        )
        .finally(() => {
          this.running = undefined;
          this.schedule(WEBKASSA_INTERVAL_MS);
        });
    }, delay);
    this.timer.unref?.();
  }
}
