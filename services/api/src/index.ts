import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Module,
  NotFoundException,
  Param,
  Post,
  Body,
  Headers,
  HttpCode,
  HttpException,
} from '@nestjs/common';
import { acknowledgeMenu, pullMenu, SyncError } from '@pickchick/menu-sync';
import { BranchSchema, MenuSnapshotSchema, UuidSchema } from '@pickchick/contracts';
import {
  createHttpApplication,
  HealthController,
  loadConfig,
  RESOURCE,
  Resources,
} from '@pickchick/platform';
import type { ServiceConfig } from '@pickchick/platform';
import { TestOrderController } from './test-order-controller.js';

@Controller('v1/capabilities')
class CapabilitiesController {
  constructor(@Inject(RESOURCE) private readonly resources: Resources) {}

  @Get()
  get() {
    return {
      schema_version: 1,
      environment: this.resources.config.environment,
      data_mode: 'synthetic',
      ordering_enabled: false,
      features: {
        phone_auth: false,
        checkout: false,
        payments: false,
        fiscal: false,
        loyalty: false,
        test_order_flow: this.resources.config.testOrderFlowEnabled === true,
      },
      notice: {
        ru: 'Тестовый стенд PickChick. Доступен только синтетический TEST-сценарий при включённом тестовом режиме. Реальные заказы, SMS, платежи и чеки недоступны.',
        kk: 'PickChick сынақ ортасы. Сынақ режимі қосылғанда тек синтетикалық TEST сценарийі қолжетімді. Нақты тапсырыстар, SMS, төлемдер мен чектер қолжетімсіз.',
      },
    };
  }
}

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

@Controller('internal/v1/edge/sync')
class MenuSyncController {
  constructor(@Inject(RESOURCE) private readonly resources: Resources) {}

  private async execute(
    deviceId: string | undefined,
    authorization: string | undefined,
    body?: unknown,
  ) {
    const auth = {
      deviceId: deviceId ?? '',
      token: authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '',
    };
    try {
      return body === undefined
        ? await pullMenu(this.resources.pool, auth)
        : await acknowledgeMenu(this.resources.pool, auth, body);
    } catch (error) {
      if (error instanceof SyncError) {
        const statuses = { INVALID_REQUEST: 400, UNAUTHORIZED: 401, CONFLICT: 409, NOT_FOUND: 404 };
        throw new HttpException(error.code, statuses[error.code]);
      }
      throw error;
    }
  }

  @Get('pull')
  pull(
    @Headers('x-device-id') deviceId?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.execute(deviceId, authorization);
  }

  @Post('ack')
  @HttpCode(200)
  ack(
    @Body() body: unknown,
    @Headers('x-device-id') deviceId?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.execute(deviceId, authorization, body ?? null);
  }
}

export async function createApi(config: ServiceConfig = loadConfig('api')) {
  if (config.service !== 'api') throw new Error('API requires api configuration');
  @Module({
    controllers: [
      HealthController,
      CapabilitiesController,
      BranchesController,
      MenuSyncController,
      ...(config.testOrderFlowEnabled ? [TestOrderController] : []),
    ],
    providers: [{ provide: RESOURCE, useFactory: () => new Resources(config) }],
  })
  class ApiModule {}
  return createHttpApplication(ApiModule);
}
