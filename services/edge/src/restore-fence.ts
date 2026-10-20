import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { RESOURCE, Resources } from '@pickchick/platform';
import { fenceRestoredEdge } from '@pickchick/local-orders';

/** Retry interval while PostgreSQL is not reachable yet (for example right after a reboot). */
export const RESTORE_FENCE_RETRY_MS = 5000;

/**
 * Before the edge serves its first order: if this database is a restored copy (edge schema023),
 * move every edge-to-cloud producer sequence past the lost timeline once
 * (docs/operations/edge-restore.md). A runtime without the schema or the grant keeps serving
 * with the previous behaviour; the log line tells the operator. Any other failure (database
 * still starting) is retried in the background until the check runs, so a reboot right after a
 * restore does not leave the first new orders on sequence numbers the cloud already holds.
 */
@Injectable()
export class RestoreFenceOnStart implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<boolean> | undefined;
  private stopped = false;
  private failed = false;

  constructor(@Inject(RESOURCE) private readonly resources: Resources) {}

  async onApplicationBootstrap() {
    if (!(await this.attempt())) this.schedule();
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.attempt();
      void this.running.then((done) => {
        this.running = undefined;
        if (!done) this.schedule();
      });
    }, RESTORE_FENCE_RETRY_MS);
    this.timer.unref?.();
  }

  /** True when no retry is needed: fenced, current, unsupported schema or no grant. */
  private async attempt(): Promise<boolean> {
    try {
      const fence = await fenceRestoredEdge(this.resources.pool);
      if (fence.state === 'restore' || fence.state === 'operator')
        console.warn(
          JSON.stringify({
            event: 'edge_restore_fenced',
            state: fence.state,
            epoch: fence.epoch,
            sequence_gap: fence.sequenceGap,
          }),
        );
      else if (this.failed)
        console.log(JSON.stringify({ event: 'edge_restore_fence_checked', state: fence.state }));
      return true;
    } catch (error) {
      // 42501: the runtime role lacks the EXECUTE grant. That is a release setup problem the
      // operator fixes with edge-runtime-grants; retrying cannot help.
      const denied = (error as { code?: unknown } | null)?.code === '42501';
      if (denied || !this.failed)
        console.warn(
          JSON.stringify({
            event: 'edge_restore_fence_unavailable',
            reason: denied ? 'NOT_GRANTED' : 'RETRYING',
          }),
        );
      this.failed = true;
      return denied;
    }
  }
}
