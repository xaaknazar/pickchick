import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Query,
} from '@nestjs/common';
import { RESOURCE, Resources } from '@pickchick/platform';
import { PosSyncError, receivePosOrder } from '@pickchick/pos-order-sync';
import { SyncError } from '@pickchick/menu-sync';

/** Private authenticated transport only; no public or manager mutation endpoint. */
@Controller('internal/v1/edge/pos-orders')
export class PosOrderSyncController {
  constructor(@Inject(RESOURCE) private readonly resources: Resources) {}
  @Post('events')
  @HttpCode(200)
  async receive(
    @Body() body: unknown,
    @Query() query: Record<string, unknown>,
    @Headers('x-device-id') deviceId?: string,
    @Headers('authorization') authorization?: string,
  ) {
    if (!this.resources.config.posOrderSyncEnabled) throw new HttpException('NOT_FOUND', 404);
    if (Object.keys(query).length) throw new HttpException('INVALID_REQUEST', 400);
    try {
      return await receivePosOrder(
        this.resources.pool,
        {
          deviceId: deviceId ?? '',
          token: authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '',
        },
        body,
      );
    } catch (error) {
      if (error instanceof PosSyncError || error instanceof SyncError) {
        const status = {
          INVALID_REQUEST: 400,
          UNAUTHORIZED: 401,
          FORBIDDEN: 403,
          CONFLICT: 409,
          NOT_FOUND: 404,
        }[error.code];
        throw new HttpException(error.code, status);
      }
      throw error;
    }
  }
}
