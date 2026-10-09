import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import { RESOURCE, Resources } from '@pickchick/platform';
import { BackofficeError } from '@pickchick/backoffice-core';
import {
  DeviceRegistry,
  DeviceAccessError,
  deviceAccessEnabled,
  exchangeDeviceAccess,
} from '@pickchick/backoffice-core/devices';
import { SyncError } from '@pickchick/menu-sync';

async function run<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (error) {
    if (
      error instanceof BackofficeError ||
      error instanceof DeviceAccessError ||
      error instanceof SyncError
    ) {
      const code = error.code;
      const status =
        code === 'UNAUTHORIZED'
          ? 401
          : code === 'FORBIDDEN'
            ? 403
            : code === 'NOT_FOUND'
              ? 404
              : code === 'CONFLICT' || code === 'CODE_ALREADY_ISSUED'
                ? 409
                : code === 'DEVICE_ACCESS_RATE_LIMITED'
                  ? 429
                  : [
                        'DEVICE_ACCESS_UNAVAILABLE',
                        'EDGE_UNAVAILABLE',
                        'SERVICE_UNAVAILABLE',
                      ].includes(code)
                    ? 503
                    : 400;
      throw new HttpException(
        {
          code,
          ...(error instanceof BackofficeError && error.reason ? { reason: error.reason } : {}),
        },
        status,
      );
    }
    // Pairing material must never reach exception logs or generic driver diagnostics.
    throw new HttpException({ code: 'SERVICE_UNAVAILABLE' }, 503);
  }
}
function bounded(body: unknown) {
  if (Buffer.byteLength(JSON.stringify(body ?? null)) > 32768)
    throw new HttpException({ code: 'PAYLOAD_TOO_LARGE' }, 413);
  return body;
}
@Controller('v1/admin/backoffice/branches/:branch/devices')
export class DeviceRegistryController {
  private readonly service: DeviceRegistry;
  constructor(@Inject(RESOURCE) resources: Resources) {
    this.service = new DeviceRegistry(
      resources.pool,
      deviceAccessEnabled() && resources.config.backofficeEnabled === true,
    );
  }
  private token(auth?: string) {
    return auth?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
  }
  @Get()
  @Header('Cache-Control', 'no-store')
  read(@Param('branch') branch: string, @Headers('authorization') auth?: string) {
    return run(() => this.service.read(this.token(auth), branch));
  }
  @Get('kitchen-password-reset/events')
  @Header('Cache-Control', 'no-store')
  resetEvents(@Param('branch') branch: string, @Headers('authorization') auth?: string) {
    return run(() => this.service.resetEvents(this.token(auth), branch));
  }
  @Get(':id/events')
  @Header('Cache-Control', 'no-store')
  events(
    @Param('branch') branch: string,
    @Param('id') id: string,
    @Headers('authorization') auth?: string,
  ) {
    return run(() => this.service.events(this.token(auth), branch, id));
  }
  @Post('pairing-codes')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  issue(
    @Param('branch') branch: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return run(() => this.service.issue(this.token(auth), branch, bounded(body)));
  }
  @Post('kitchen-password-reset')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  reset(
    @Param('branch') branch: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return run(() => this.service.issueKitchenReset(this.token(auth), branch, bounded(body)));
  }
  @Post('revoke')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  revoke(
    @Param('branch') branch: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return run(() => this.service.revoke(this.token(auth), branch, bounded(body)));
  }
}
@Controller('internal/v1/edge/devices')
export class DeviceAccessTransportController {
  constructor(@Inject(RESOURCE) private readonly resources: Resources) {}
  @Post('exchange')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  exchange(
    @Body() body: unknown,
    @Headers('x-device-id') deviceId?: string,
    @Headers('authorization') auth?: string,
  ) {
    if (!deviceAccessEnabled()) throw new HttpException({ code: 'NOT_FOUND' }, 404);
    return run(() =>
      exchangeDeviceAccess(
        this.resources.pool,
        { deviceId: deviceId ?? '', token: auth?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '' },
        bounded(body),
      ),
    );
  }
}
