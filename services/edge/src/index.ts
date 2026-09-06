import { Controller, Get, Inject, Module, NotFoundException } from '@nestjs/common';
import { MenuSnapshotSchema } from '@pickchick/contracts';
import {
  createHttpApplication,
  HealthController,
  loadConfig,
  RESOURCE,
  Resources,
} from '@pickchick/platform';
import type { ServiceConfig } from '@pickchick/platform';
import { LocalOrdersController } from './orders-controller.js';

@Controller('edge/v1')
class LocalMenuController {
  constructor(@Inject(RESOURCE) private readonly resources: Resources) {}

  @Get('menu')
  async menu() {
    const { rows } = await this.resources.pool.query<{ payload: unknown }>(
      `SELECT s.payload FROM active_menu a
       JOIN menu_snapshots s ON s.id = a.release_id AND s.branch_id = a.branch_id
       WHERE a.branch_id = $1`,
      [this.resources.config.branchId],
    );
    if (!rows[0]) throw new NotFoundException();
    return MenuSnapshotSchema.parse(rows[0].payload);
  }
}

export async function createEdge(config: ServiceConfig = loadConfig('edge')) {
  if (config.service !== 'edge' || !config.branchId)
    throw new Error('Edge requires branch binding');
  @Module({
    controllers: [HealthController, LocalMenuController, LocalOrdersController],
    providers: [{ provide: RESOURCE, useFactory: () => new Resources(config) }],
  })
  class EdgeModule {}
  return createHttpApplication(EdgeModule);
}
