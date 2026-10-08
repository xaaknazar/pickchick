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
  Query,
  UseFilters,
} from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { BACKOFFICE, Backoffice, BackofficeError } from '@pickchick/backoffice-core';
import type { BackofficeErrorReason } from '@pickchick/backoffice-core';
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
/** Stop commands are small; the generic 100 KiB JSON limit is far more than they need. */
export const BACKOFFICE_STOP_BODY_LIMIT = 16 * 1024;
/** Carries only the stable reason code; never a message, stack or database detail. */
class BackofficeReasonException extends HttpException {
  constructor(
    readonly code: BackofficeError['code'],
    readonly reason: BackofficeErrorReason,
  ) {
    super({ code }, statuses[code]);
  }
}
/** Standard error envelope plus `error: {code}` with the precise stop-command reason. */
@Catch(BackofficeReasonException)
class BackofficeReasonFilter implements ExceptionFilter {
  catch(error: BackofficeReasonException, host: ArgumentsHost) {
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
        error: { code: error.reason },
      });
  }
}
@Controller('v1/admin/backoffice')
@UseFilters(BackofficeReasonFilter)
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
        if (e.reason) throw new BackofficeReasonException(e.code, e.reason);
        throw new HttpException({ code: e.code }, statuses[e.code]);
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
  /** Stop list v2. The v1 list inside GET branches/:id keeps its shape for the installed UI. */
  @Get('branches/:id/stops') stops(
    @Param('id') id: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.service.stops(this.token(auth), id));
  }
  @Post('branches/:id/stops') @HttpCode(202) requestStop(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('content-length') length?: string,
  ) {
    if (
      Number(length ?? 0) > BACKOFFICE_STOP_BODY_LIMIT ||
      Buffer.byteLength(JSON.stringify(body ?? null)) > BACKOFFICE_STOP_BODY_LIMIT
    )
      throw new HttpException({ code: 'PAYLOAD_TOO_LARGE' }, 413);
    return this.run(() => this.service.requestStop(this.token(auth), id, body));
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
