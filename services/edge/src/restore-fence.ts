import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { RESOURCE, Resources } from '@pickchick/platform';
import { fenceRestoredEdge } from '@pickchick/local-orders';

/**
 * Before the edge serves its first order: if this database is a restored copy (edge schema023),
 * move every edge-to-cloud producer sequence past the lost timeline once
 * (docs/operations/edge-restore.md). A runtime without the schema or the grant keeps serving
 * with the previous behaviour; the log line tells the operator.
 */
@Injectable()
export class RestoreFenceOnStart implements OnApplicationBootstrap {
  constructor(@Inject(RESOURCE) private readonly resources: Resources) {}

  async onApplicationBootstrap() {
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
    } catch {
      console.warn(JSON.stringify({ event: 'edge_restore_fence_unavailable' }));
    }
  }
}
