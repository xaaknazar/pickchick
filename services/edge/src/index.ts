import type { ServerResponse } from 'node:http';
import { Controller, Get, Inject, Module, NotFoundException, Param, Res } from '@nestjs/common';
import { MenuSnapshotSchema, UuidSchema } from '@pickchick/contracts';
import {
  createHttpApplication,
  HealthController,
  loadConfig,
  RESOURCE,
  Resources,
} from '@pickchick/platform';
import type { ServiceConfig } from '@pickchick/platform';
import { StaffAuthController } from './staff-auth-controller.js';
import { LocalOrdersController } from './orders-controller.js';
import { FulfillmentController } from './fulfillment-controller.js';
import { RemoteStopsLoop } from './remote-stops-loop.js';

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

  /** Cheap poll for the POS: which release is active, without the full snapshot. */
  @Get('menu/version')
  async menuVersion() {
    const { rows } = await this.resources.pool.query<{ release_id: string; version: number }>(
      `SELECT s.id AS release_id, s.version FROM active_menu a
       JOIN menu_snapshots s ON s.id = a.release_id AND s.branch_id = a.branch_id
       WHERE a.branch_id = $1`,
      [this.resources.config.branchId],
    );
    if (!rows[0]) throw new NotFoundException();
    return { release_id: rows[0].release_id, version: rows[0].version };
  }

  /** Content-addressed menu photos cached by the menu worker; served on the edge LAN only. */
  @Get('media/:file')
  async media(@Param('file') file: string, @Res() response: ServerResponse) {
    const sha256 = /^([a-f0-9]{64})\.webp$/.exec(file)?.[1];
    if (!sha256) throw new NotFoundException();
    const { rows } = await this.resources.pool.query<{ bytes: Buffer }>(
      "SELECT bytes FROM menu_media WHERE sha256 = $1 AND mime = 'image/webp'",
      [sha256],
    );
    if (!rows[0]) throw new NotFoundException();
    response.statusCode = 200;
    response.setHeader('Content-Type', 'image/webp');
    response.setHeader('Content-Length', String(rows[0].bytes.length));
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    response.setHeader('ETag', `"${sha256}"`);
    response.end(rows[0].bytes);
  }
}

export async function createEdge(config: ServiceConfig = loadConfig('edge')) {
  if (config.service !== 'edge' || !config.branchId)
    throw new Error('Edge requires branch binding');
  if (config.edgeFulfillmentEnabled && !UuidSchema.safeParse(config.edgeDeviceId).success)
    throw new Error('Enabled edge fulfillment requires device binding');
  @Module({
    controllers: [
      HealthController,
      LocalMenuController,
      LocalOrdersController,
      StaffAuthController,
      FulfillmentController,
    ],
    providers: [{ provide: RESOURCE, useFactory: () => new Resources(config) }, RemoteStopsLoop],
  })
  class EdgeModule {}
  return createHttpApplication(EdgeModule);
}
