import type { IncomingMessage } from 'node:http';
import { TipTopPayController } from './tiptoppay-controller.js';
import { KaspiRemoteController } from './kaspi-remote-controller.js';
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
import {
  BranchSchema,
  CapabilitiesSchema,
  MenuSnapshotSchema,
  UuidSchema,
} from '@pickchick/contracts';
import {
  createHttpApplication,
  HealthController,
  loadConfig,
  RESOURCE,
  Resources,
} from '@pickchick/platform';
import type { ServiceConfig } from '@pickchick/platform';
import { TestOrderController } from './test-order-controller.js';
import { CustomerAuthController } from './customer-auth-controller.js';
import {
  CUSTOMER_IDENTITY,
  CustomerIdentity,
  createCustomerIdentityOptions,
} from '@pickchick/customer-identity';
import { createPhoneCodeDelivery } from '@pickchick/phone-verification';
import { CATALOG_ADMIN, CatalogAdmin } from '@pickchick/catalog-admin';
import { CatalogAdminController } from './catalog-admin-controller.js';
import { BACKOFFICE, Backoffice } from '@pickchick/backoffice-core';
import { BackofficeController, BackofficeContentController } from './backoffice-controller.js';
import { FulfillmentTransportController } from './fulfillment-transport-controller.js';
import { PosOrderSyncController } from './pos-order-sync-controller.js';

@Controller('v1/capabilities')
class CapabilitiesController {
  constructor(@Inject(RESOURCE) private readonly resources: Resources) {}

  @Get()
  get() {
    return CapabilitiesSchema.parse({
      schema_version: 1,
      environment: this.resources.config.environment,
      data_mode: this.resources.config.customerAuthEnabled ? 'pilot' : 'synthetic',
      ordering_enabled: false,
      features: {
        phone_auth: this.resources.config.customerAuthEnabled === true,
        checkout: false,
        payments: false,
        fiscal: false,
        loyalty: false,
        test_order_flow: this.resources.config.testOrderFlowEnabled === true,
        unpaid_test_orders: this.resources.config.testOrderFlowEnabled === true,
      },
      notice: this.resources.config.customerAuthEnabled
        ? {
            ru: 'Заказы в ресторане доступны без оплаты. Оплата и чеки в процессе подключения.',
            kk: 'Мейрамханаға тапсырыстар төлемсіз қолжетімді. Төлем мен чектер қосылуда.',
          }
        : {
            ru: 'Тестовый стенд PickChick. Доступен только синтетический TEST-сценарий при включённом тестовом режиме. Реальные заказы, SMS, платежи и чеки недоступны.',
            kk: 'PickChick сынақ ортасы. Сынақ режимі қосылғанда тек синтетикалық TEST сценарийі қолжетімді. Нақты тапсырыстар, SMS, төлемдер мен чектер қолжетімсіз.',
          },
    });
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
      TipTopPayController,
      KaspiRemoteController,
      CapabilitiesController,
      BranchesController,
      MenuSyncController,
      CustomerAuthController,
      CatalogAdminController,
      BackofficeController,
      BackofficeContentController,
      FulfillmentTransportController,
      PosOrderSyncController,
      ...(config.testOrderFlowEnabled ? [TestOrderController] : []),
    ],
    providers: [
      {
        provide: BACKOFFICE,
        inject: [RESOURCE],
        useFactory: (resources: Resources) =>
          new Backoffice(resources.pool, config.backofficeEnabled === true),
      },
      { provide: RESOURCE, useFactory: () => new Resources(config) },
      {
        provide: CATALOG_ADMIN,
        inject: [RESOURCE],
        useFactory: (resources: Resources) =>
          new CatalogAdmin(resources.pool, { enabled: config.catalogAdminEnabled === true }),
      },
      {
        provide: CUSTOMER_IDENTITY,
        inject: [RESOURCE],
        useFactory: (resources: Resources) => {
          const env = {
            ...process.env,
            CUSTOMER_AUTH_ENABLED: String(config.customerAuthEnabled === true),
          };
          const options = createCustomerIdentityOptions(env);
          return new CustomerIdentity(
            resources.pool,
            options,
            createPhoneCodeDelivery(options.enabled ? env : {}),
          );
        },
      },
    ],
  })
  class ApiModule {}
  const app = await createHttpApplication(ApiModule, {
    // The Kaspi bridge signs the exact JSON bytes it sends.
    rawJsonRoutes: [/^\/v1\/integrations\/kaspi-remote\/webhook\/?$/],
  });
  app.useBodyParser('raw', {
    limit: 16 * 1024,
    type: (request: IncomingMessage) =>
      request.method === 'POST' &&
      /^\/v1\/integrations\/tiptoppay\/[^/?]+\/?$/.test(request.url?.split('?')[0] ?? '') &&
      /^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers['content-type'] ?? ''),
  });
  return app;
}
