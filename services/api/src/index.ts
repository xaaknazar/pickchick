import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Module,
  NotFoundException,
  Param,
} from '@nestjs/common';
import { BranchSchema, MenuSnapshotSchema, UuidSchema } from '@pickchick/contracts';
import {
  createHttpApplication,
  HealthController,
  loadConfig,
  RESOURCE,
  Resources,
} from '@pickchick/platform';
import type { ServiceConfig } from '@pickchick/platform';

@Controller('v1/branches')
class BranchesController {
  constructor(@Inject(RESOURCE) private readonly resources: Resources) {}

  @Get()
  async list() {
    const { rows } = await this.resources.pool.query(
      'SELECT id, code, name, timezone, ordering_enabled FROM branches ORDER BY code, id LIMIT 100',
    );
    return { branches: rows.map((row: unknown) => BranchSchema.parse(row)) };
  }

  @Get(':branchId/menu')
  async menu(@Param('branchId') branchId: string) {
    const id = UuidSchema.safeParse(branchId);
    if (!id.success) throw new BadRequestException();
    const { rows } = await this.resources.pool.query<{ payload: unknown }>(
      `SELECT r.payload FROM branch_menu_activations a
       JOIN menu_releases r ON r.id = a.release_id AND r.branch_id = a.branch_id
       WHERE a.branch_id = $1`,
      [id.data],
    );
    if (!rows[0]) throw new NotFoundException();
    return MenuSnapshotSchema.parse(rows[0].payload);
  }
}

export async function createApi(config: ServiceConfig = loadConfig('api')) {
  if (config.service !== 'api') throw new Error('API requires api configuration');
  @Module({
    controllers: [HealthController, BranchesController],
    providers: [{ provide: RESOURCE, useFactory: () => new Resources(config) }],
  })
  class ApiModule {}
  return createHttpApplication(ApiModule);
}
