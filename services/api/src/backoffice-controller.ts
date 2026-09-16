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
import { BACKOFFICE, Backoffice, BackofficeError } from '@pickchick/backoffice-core';
@Controller('v1/admin/backoffice')
export class BackofficeController {
  constructor(@Inject(BACKOFFICE) private service: Backoffice) {}
  private token(auth?: string) {
    return auth?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
  }
  private async run<T>(fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BackofficeError) {
        const status = {
          INVALID_REQUEST: 400,
          UNAUTHORIZED: 401,
          FORBIDDEN: 403,
          NOT_FOUND: 404,
          CONFLICT: 409,
          SERVICE_UNAVAILABLE: 503,
          INSUFFICIENT_STOCK: 409,
          NOT_READY: 409,
        };
        throw new HttpException({ code: e.code }, status[e.code]);
      }
      throw e;
    }
  }
  @Get('branches/:id') read(
    @Param('id') id: string,
    @Headers('authorization') auth?: string,
    @Query() query?: unknown,
  ) {
    return this.run(() => this.service.read(this.token(auth), id, query ?? {}));
  }
  @Get('branches/:id/orders/:orderId') order(
    @Param('id') id: string,
    @Param('orderId') orderId: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.service.order(this.token(auth), id, orderId));
  }
  @Post('branches/:id/commands') @HttpCode(200) command(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.service.command(this.token(auth), id, body));
  }
}

@Controller('v1/content')
export class BackofficeContentController {
  constructor(@Inject(BACKOFFICE) private service: Backoffice) {}
  @Get('branches/:id') async content(
    @Param('id') id: string,
    @Query('channel') channel = 'mobile',
  ) {
    try {
      return await this.service.content(id, channel);
    } catch (error) {
      if (error instanceof BackofficeError) throw new HttpException({ code: error.code }, 400);
      throw error;
    }
  }
}
