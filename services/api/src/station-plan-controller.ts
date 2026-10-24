import { Body, Controller, Headers, HttpCode, HttpException, Inject, Post } from '@nestjs/common';
import { EdgeDeviceRoute, RESOURCE, Resources } from '@pickchick/platform';
import {
  backofficeOptions,
  pullStationPlan,
  recordStationPlanReceipt,
} from '@pickchick/backoffice-core';
import { SyncError } from '@pickchick/menu-sync';

const statuses = { INVALID_REQUEST: 400, UNAUTHORIZED: 401, NOT_FOUND: 404, CONFLICT: 409 };

/**
 * Station plan delivery for the cashier edge (cloud070, stage 2 lane cfg). Private device
 * transport only, through the same tunnel as menu sync; the public gateway does not route it.
 * 404 unless BACKOFFICE_ENABLED and BACKOFFICE_STATION_PLAN_DELIVERY_ENABLED are both true, so
 * an edge runtime that already knows these routes keeps working against a cloud that does not.
 */
@Controller('internal/v1/edge/station-plans')
@EdgeDeviceRoute()
export class StationPlanTransportController {
  constructor(@Inject(RESOURCE) private readonly resources: Resources) {}
  private async run(
    kind: 'pull' | 'receipt',
    body: unknown,
    deviceId?: string,
    authorization?: string,
  ) {
    if (
      this.resources.config.backofficeEnabled !== true ||
      !backofficeOptions(process.env).stationPlanDeliveryEnabled
    )
      throw new HttpException('NOT_FOUND', 404);
    const auth = {
      deviceId: deviceId ?? '',
      token: authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '',
    };
    try {
      return kind === 'pull'
        ? await pullStationPlan(this.resources.pool, auth, body)
        : await recordStationPlanReceipt(this.resources.pool, auth, body);
    } catch (error) {
      if (error instanceof SyncError) throw new HttpException(error.code, statuses[error.code]);
      throw error;
    }
  }

  @Post('pull')
  @HttpCode(200)
  pull(
    @Body() body: unknown,
    @Headers('x-device-id') deviceId?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.run('pull', body ?? null, deviceId, authorization);
  }

  @Post('receipt')
  @HttpCode(200)
  receipt(
    @Body() body: unknown,
    @Headers('x-device-id') deviceId?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.run('receipt', body ?? null, deviceId, authorization);
  }
}
