import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { RESOURCE, Resources } from '@pickchick/platform';
import { pollTerminalPayments } from '@pickchick/local-orders';

/** Unfinished Kaspi terminal attempts are asked about this often by the point server itself. */
export const KASPI_TERMINAL_INTERVAL_MS = 5000;

/**
 * P0-4 (audit 26.11): a Kaspi Smart POS payment started at a cash desk is finished by the point
 * server even when the POS window is closed or restarted (terminal-payments.ts). On an edge
 * without schema029 a pass does nothing.
 */
@Injectable()
export class KaspiTerminalLoop implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  private lastProblem: string | undefined;

  constructor(@Inject(RESOURCE) private readonly resources: Resources) {}

  onApplicationBootstrap() {
    if (!this.resources.config.branchId) return;
    this.schedule(0);
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick().finally(() => {
        this.running = undefined;
        this.schedule(KASPI_TERMINAL_INTERVAL_MS);
      });
    }, delay);
    this.timer.unref?.();
  }

  private async tick() {
    let problem: string | undefined;
    try {
      await pollTerminalPayments(this.resources.pool, this.resources.config.branchId!);
    } catch (error) {
      problem = (error as { code?: string }).code ?? (error as Error).name;
    }
    // Log changes only: the loop runs every 5 s.
    if (problem === this.lastProblem) return;
    this.lastProblem = problem;
    if (problem) console.error(JSON.stringify({ event: 'kaspi_terminal_poll_failed', problem }));
    else console.log(JSON.stringify({ event: 'kaspi_terminal_poll_ready' }));
  }
}
