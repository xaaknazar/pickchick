import { randomUUID } from 'node:crypto';
import {
  Body,
  Catch,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  UseFilters,
} from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { BackofficeError, CloudChannelStops, CloudStopError } from '@pickchick/backoffice-core';
import { CloudKitchenBackoffice } from '@pickchick/backoffice-core/cloud-kitchen';

/**
 * Back-office routes of the cloud kitchen channel (ADR-0014 S4): kitchen screens and pairing
 * codes, the branch mode edge <-> cloud, cloud channel stops and the stale cashier override.
 * Registered by createApi only with BACKOFFICE_CLOUD_KITCHEN_ENABLED=true; the services refuse
 * with 503 unless their own flags are on as well. Manager token as for the rest of the BO.
 */
export const CLOUD_KITCHEN_BACKOFFICE = Symbol('CLOUD_KITCHEN_BACKOFFICE');
export const CLOUD_CHANNEL_STOPS = Symbol('CLOUD_CHANNEL_STOPS');

const statuses: Record<BackofficeError['code'], number> = {
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  SERVICE_UNAVAILABLE: 503,
  INSUFFICIENT_STOCK: 409,
  NOT_READY: 409,
};
class DetailException extends HttpException {
  constructor(
    readonly code: BackofficeError['code'],
    readonly detail: string,
  ) {
    super({ code }, statuses[code]);
  }
}
/** Standard error envelope plus `error: {code}` with the precise stop reason. */
@Catch(DetailException)
class DetailFilter implements ExceptionFilter {
  catch(error: DetailException, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const request = http.getRequest<{ traceId?: string }>();
    const status = error.getStatus();
    http
      .getResponse<{ status(code: number): { json(body: unknown): void } }>()
      .status(status)
      .json({
        code: error.code,
        message_key: `errors.${error.code.toLowerCase()}`,
        trace_id: request.traceId ?? randomUUID(),
        retryable: status === 503,
        error: { code: error.detail },
      });
  }
}

@Controller('v1/admin/backoffice/branches/:branchId/cloud-kitchen')
@UseFilters(DetailFilter)
export class CloudKitchenBackofficeController {
  constructor(
    @Inject(CLOUD_KITCHEN_BACKOFFICE) private readonly kitchen: CloudKitchenBackoffice,
    @Inject(CLOUD_CHANNEL_STOPS) private readonly stops: CloudChannelStops,
  ) {}
  private token(auth?: string) {
    return auth?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
  }
  private async run<T>(fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof CloudStopError) throw new DetailException(e.code, e.detail);
      if (e instanceof BackofficeError) {
        if (e.reason) throw new DetailException(e.code, e.reason);
        throw new HttpException({ code: e.code }, statuses[e.code]);
      }
      throw e;
    }
  }
  @Get() read(@Param('branchId') branch: string, @Headers('authorization') auth?: string) {
    return this.run(() => this.kitchen.read(this.token(auth), branch));
  }
  @Post('screens') @HttpCode(200) createScreen(
    @Param('branchId') branch: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.kitchen.createScreen(this.token(auth), branch, body));
  }
  @Post('screens/:screenId/pairing-code') @HttpCode(200) pairingCode(
    @Param('branchId') branch: string,
    @Param('screenId') screen: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.kitchen.issuePairingCode(this.token(auth), branch, screen, body));
  }
  @Post('screens/:screenId/revoke') @HttpCode(200) revoke(
    @Param('branchId') branch: string,
    @Param('screenId') screen: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.kitchen.revokeScreen(this.token(auth), branch, screen, body));
  }
  @Get('mode') mode(@Param('branchId') branch: string, @Headers('authorization') auth?: string) {
    return this.run(() => this.kitchen.readMode(this.token(auth), branch));
  }
  @Post('mode') @HttpCode(200) setMode(
    @Param('branchId') branch: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.kitchen.setMode(this.token(auth), branch, body));
  }
  @Get('stops') readStops(
    @Param('branchId') branch: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.stops.read(this.token(auth), branch));
  }
  @Post('stops') @HttpCode(200) setStop(
    @Param('branchId') branch: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.stops.setStop(this.token(auth), branch, body));
  }
  @Post('stops/override') @HttpCode(200) override(
    @Param('branchId') branch: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.stops.overrideCashierStop(this.token(auth), branch, body));
  }
}
