import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import { KIOSK_INCIDENTS, KioskPaymentIncidents } from '@pickchick/backoffice-core/kiosk-incidents';
import { BackofficeError } from '@pickchick/backoffice-core';

/** Manager-only hand-over of an unresolved kiosk payment; never declares a bank result. */
@Controller('v1/admin/backoffice/branches/:id/kiosk-payment-incidents')
export class KioskIncidentController {
  constructor(@Inject(KIOSK_INCIDENTS) private readonly service: KioskPaymentIncidents) {}
  private token(auth?: string) {
    return auth?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
  }
  private async run<T>(fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BackofficeError)
        throw new HttpException(
          { code: e.code },
          {
            INVALID_REQUEST: 400,
            UNAUTHORIZED: 401,
            FORBIDDEN: 403,
            NOT_FOUND: 404,
            CONFLICT: 409,
            SERVICE_UNAVAILABLE: 503,
            INSUFFICIENT_STOCK: 409,
            NOT_READY: 409,
          }[e.code],
        );
      throw e;
    }
  }
  @Get() list(@Param('id') id: string, @Headers('authorization') auth?: string) {
    return this.run(() => this.service.list(this.token(auth), id));
  }
  @Post() @HttpCode(200) accept(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.service.accept(this.token(auth), id, body));
  }
}
