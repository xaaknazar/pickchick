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
import { BackofficeError } from '@pickchick/backoffice-core';

export const WORKFORCE = Symbol('WORKFORCE');
export interface WorkforceService {
  read(token: string, branch: string, month: string): Promise<unknown>;
  command(token: string, branch: string, input: unknown): Promise<unknown>;
}
@Controller('v1/admin/backoffice/branches/:id/workforce')
export class WorkforceController {
  constructor(@Inject(WORKFORCE) private readonly service: WorkforceService) {}
  private token(auth?: string) {
    return auth?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
  }
  private async run(fn: () => Promise<unknown>) {
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
    @Param('id') branch: string,
    @Query() query: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(async () => {
      const value = query as { month?: unknown } | null;
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        typeof value.month !== 'string' ||
        !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(value.month)
      )
        throw new BackofficeError('INVALID_REQUEST');
      return this.service.read(this.token(auth), branch, value.month);
    });
  }
  @Post('commands') @HttpCode(200) command(
    @Param('id') branch: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.service.command(this.token(auth), branch, body));
  }
}
