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
  Query,
} from '@nestjs/common';
import { FINANCE, Finance } from '@pickchick/backoffice-core/finance';
import { BackofficeError } from '@pickchick/backoffice-core';

@Controller('v1/admin/backoffice/branches/:id/finance')
export class FinanceController {
  constructor(@Inject(FINANCE) private readonly service: Finance) {}
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
  @Get() read(
    @Param('id') id: string,
    @Headers('authorization') auth?: string,
    @Query() query?: unknown,
  ) {
    return this.run(() => this.service.read(this.token(auth), id, query ?? {}));
  }
  @Post('commands') @HttpCode(200) command(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.service.command(this.token(auth), id, body));
  }
}
