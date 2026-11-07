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
import { EdgeDeviceRoute, RESOURCE, Resources } from '@pickchick/platform';
import {
  PosSyncError,
  receivePosOrder,
  receivePosKitchen,
  receivePosSales,
} from '@pickchick/pos-order-sync';
import { SyncError } from '@pickchick/menu-sync';

const deviceAuth = (deviceId?: string, authorization?: string) => ({
  deviceId: deviceId ?? '',
  token: authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '',
});
function syncHttpError(error: unknown): unknown {
  if (error instanceof PosSyncError || error instanceof SyncError) {
    const status = {
      INVALID_REQUEST: 400,
      UNAUTHORIZED: 401,
      FORBIDDEN: 403,
      CONFLICT: 409,
      NOT_FOUND: 404,
    }[error.code];
    return new HttpException(error.code, status);
  }
  return error;
}

/** Private authenticated transport only; no public or manager mutation endpoint. */
@Controller('internal/v1/edge/pos-orders')
@EdgeDeviceRoute()
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
      const receive =
        body &&
        typeof body === 'object' &&
        'aggregate_type' in body &&
        body.aggregate_type === 'order_fulfillment'
          ? receivePosKitchen
          : receivePosOrder;
      return await receive(
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
  /**
   * posSales stream (contracts 5.6, cutover CC-4): paid POS sales, voids, refunds, Webkassa
   * receipt records and Z reports of the cashier edge. Disabled = 404, exactly like a cloud
   * without this route; the edge then keeps its durable outbox and asks again in 10 minutes.
   */
  @Post('sales')
  @HttpCode(200)
  async receiveSales(
    @Body() body: unknown,
    @Query() query: Record<string, unknown>,
    @Headers('x-device-id') deviceId?: string,
    @Headers('authorization') authorization?: string,
  ) {
    if (!this.resources.config.posOrderSyncEnabled || !this.resources.config.posSalesSyncEnabled)
      throw new HttpException('NOT_FOUND', 404);
    if (Object.keys(query).length) throw new HttpException('INVALID_REQUEST', 400);
    try {
      return await receivePosSales(this.resources.pool, deviceAuth(deviceId, authorization), body, {
        // Whitelisted metadata only: never the payload, staff names, reasons or receipt numbers.
        onRejected: (rejection) =>
          console.warn(JSON.stringify({ event: 'pos_sale_rejected', ...rejection })),
      });
    } catch (error) {
      throw syncHttpError(error);
    }
  }
}
