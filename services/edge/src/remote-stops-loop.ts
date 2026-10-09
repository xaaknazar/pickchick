import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { RESOURCE, Resources } from '@pickchick/platform';
import { applyRemoteStops, remoteStopsReady } from '@pickchick/local-orders';

export const REMOTE_STOPS_INTERVAL_MS = 500;

/** Applies back-office stop commands from the edge inbox. Off unless EDGE_REMOTE_STOPS_ENABLED. */
@Injectable()
export class RemoteStopsLoop implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  private lastProblem: string | undefined;

  constructor(@Inject(RESOURCE) private readonly resources: Resources) {}

  onApplicationBootstrap() {
    if (!this.resources.config.remoteStopsEnabled || !this.resources.config.branchId) return;
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
        this.schedule(REMOTE_STOPS_INTERVAL_MS);
      });
    }, delay);
    this.timer.unref?.();
  }

  private report(problem: string | undefined) {
    // Log state changes only: the loop runs twice a second.
    if (problem === this.lastProblem) return;
    this.lastProblem = problem;
    if (problem) console.error(JSON.stringify({ event: 'remote_stops_unavailable', problem }));
    else console.log(JSON.stringify({ event: 'remote_stops_ready' }));
  }

  private async tick() {
    const pool = this.resources.pool,
      branchId = this.resources.config.branchId!;
    try {
      if (!(await remoteStopsReady(pool))) return this.report('SCHEMA_OR_GRANTS_MISSING');
      const results = await applyRemoteStops(pool, branchId);
      this.report(undefined);
      for (const result of results)
        console.log(
          JSON.stringify({
            event: 'remote_stop_applied',
            commandId: result.commandId,
            state: result.state,
          }),
        );
    } catch {
      this.report('APPLY_FAILED');
    }
  }
}
