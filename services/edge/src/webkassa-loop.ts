import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { RESOURCE, Resources } from '@pickchick/platform';
import {
  WebkassaClient,
  WebkassaFiscalWorker,
  checkWebkassaMode,
  readWebkassaAccount,
} from '@pickchick/local-orders';

/** Pending receipts are looked at this often; a sale also nudges the worker at once. */
export const WEBKASSA_INTERVAL_MS = 5000;

/**
 * Automatic Webkassa receipts of the branch (webkassa-fiscal.ts). Off unless the private account
 * file EDGE_WEBKASSA_ACCOUNT_FILE is configured; a broken file is logged and leaves receipts
 * manual instead of stopping the point server.
 *
 * Owner 28.11.2026: the mode EDGE_WEBKASSA_ENVIRONMENT (live|test) must be set explicitly and
 * equal the host of the account file (live = kkm, test = devkkm). Otherwise receipts stay manual
 * (as without a file: GET pos/webkassa answers 404), the point keeps selling, and one
 * `webkassa_mode_blocked` event says why (no secrets, no file content).
 */
@Injectable()
export class WebkassaLoop implements OnApplicationBootstrap, OnModuleDestroy {
  readonly worker: WebkassaFiscalWorker | null;
  /** Test (devkkm) or live register; null while Webkassa is off. Shown on the POS (P0-2). */
  readonly environment: 'test' | 'live' | null;
  /** Why receipts are manual although an account file is set (mode missing or not equal to host). */
  readonly blocked: Record<string, unknown> | null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<unknown> | undefined;
  private stopped = false;

  constructor(@Inject(RESOURCE) private readonly resources: Resources) {
    const { webkassaAccountFile, branchId, webkassaEnvironment, webkassaModeInvalid } =
      resources.config;
    let worker: WebkassaFiscalWorker | null = null;
    let environment: 'test' | 'live' | null = null;
    let blocked: Record<string, unknown> | null = null;
    if (webkassaAccountFile && branchId && webkassaModeInvalid) {
      blocked = { ok: false, reason: webkassaModeInvalid, expected: 'live|test' };
    } else if (webkassaAccountFile && branchId) {
      try {
        const account = readWebkassaAccount(webkassaAccountFile);
        if (account) {
          const check = checkWebkassaMode(webkassaEnvironment, account);
          if (check.ok) {
            worker = new WebkassaFiscalWorker(
              resources.pool,
              branchId,
              new WebkassaClient(account),
            );
            environment = check.environment;
          } else blocked = { ...check };
        }
      } catch (error) {
        console.error(
          JSON.stringify({ event: 'webkassa_account_invalid', message: (error as Error).message }),
        );
      }
    }
    this.worker = worker;
    this.environment = environment;
    this.blocked = blocked;
  }

  onApplicationBootstrap() {
    if (this.blocked) {
      console.error(
        JSON.stringify({
          event: 'webkassa_mode_blocked',
          ...this.blocked,
          hint: 'set EDGE_WEBKASSA_ENVIRONMENT to the mode of the account file host (test or live); receipts stay manual',
        }),
      );
      return;
    }
    if (!this.worker) return;
    console.log(JSON.stringify({ event: 'webkassa_enabled', environment: this.environment }));
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
