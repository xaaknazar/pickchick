import { Body, Controller, Headers, HttpCode, HttpException, Inject, Post } from '@nestjs/common';
import { RESOURCE, Resources } from '@pickchick/platform';
import {
  pullFulfillment,
  acknowledgeFulfillment,
  receiveFulfillment,
  TransportError,
  PullResponseSchema,
  TransportReceiptSchema,
} from '@pickchick/fulfillment-transport';
import { SyncError } from '@pickchick/menu-sync';
import { CommerceError } from '@pickchick/commerce-core';

@Controller('internal/v1/edge/fulfillment')
export class FulfillmentTransportController {
  constructor(@Inject(RESOURCE) private readonly resources: Resources) {}
  private async run(
    kind: 'pull' | 'ack' | 'events',
    body: unknown,
    deviceId?: string,
    authorization?: string,
  ) {
    if (!this.resources.config.fulfillmentTransportEnabled)
      throw new HttpException('NOT_FOUND', 404);
    const auth = {
      deviceId: deviceId ?? '',
      token: authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '',
    };
    try {
      const result =
        kind === 'pull'
          ? PullResponseSchema.parse(await pullFulfillment(this.resources.pool, auth, body))
          : TransportReceiptSchema.parse(
              await (kind === 'ack' ? acknowledgeFulfillment : receiveFulfillment)(
                this.resources.pool,
                auth,
                body,
              ),
            );
      if (Buffer.byteLength(JSON.stringify(result)) > 1_300_000)
        throw new HttpException('SERVICE_UNAVAILABLE', 503);
      return result;
    } catch (error) {
      if (
        error instanceof TransportError ||
        error instanceof SyncError ||
        error instanceof CommerceError
      ) {
        const code = error.code;
        const status =
          code === 'UNAUTHORIZED'
            ? 401
            : code === 'FORBIDDEN'
              ? 403
              : code === 'NOT_FOUND'
                ? 404
                : code === 'CONFLICT'
                  ? 409
                  : code === 'SERVICE_UNAVAILABLE'
                    ? 503
                    : 400;
        throw new HttpException(code, status);
      }
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
    return this.run('pull', body, deviceId, authorization);
  }
  @Post('ack')
  @HttpCode(200)
  ack(
    @Body() body: unknown,
    @Headers('x-device-id') deviceId?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.run('ack', body, deviceId, authorization);
  }
  @Post('events')
  @HttpCode(200)
  events(
    @Body() body: unknown,
    @Headers('x-device-id') deviceId?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.run('events', body, deviceId, authorization);
  }
}
