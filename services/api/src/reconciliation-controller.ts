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
import { BackofficeError } from '@pickchick/backoffice-core';
import {
  RECONCILIATION,
  Reconciliation,
  ReconciliationError,
  type ReconciliationReason,
} from '@pickchick/backoffice-core/reconciliation';

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
/** Carries only the stable reason code; never a message, stack or database detail. */
class ReconciliationReasonException extends HttpException {
  constructor(
    readonly code: BackofficeError['code'],
    readonly reason: ReconciliationReason,
  ) {
    super({ code }, statuses[code]);
  }
}
@Catch(ReconciliationReasonException)
class ReconciliationReasonFilter implements ExceptionFilter {
  catch(error: ReconciliationReasonException, host: ArgumentsHost) {
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

/**
 * Daily payment reconciliation for the accountant (BACKOFFICE_RECONCILIATION_ENABLED).
 * Statement imports carry the CSV text: @pickchick/platform scopes a 320 KiB JSON limit to the
 * preview and commands routes only.
 */
@Controller('v1/admin/backoffice/branches/:id/reconciliation')
@UseFilters(ReconciliationReasonFilter)
export class ReconciliationController {
  constructor(@Inject(RECONCILIATION) private readonly service: Reconciliation) {}
  private token(auth?: string) {
    return auth?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
  }
  private async run<T>(fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ReconciliationError && e.detail)
        throw new ReconciliationReasonException(e.code, e.detail);
      if (e instanceof BackofficeError) throw new HttpException({ code: e.code }, statuses[e.code]);
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
  @Post('preview') @HttpCode(200) preview(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.service.preview(this.token(auth), id, body));
  }
  @Post('commands') @HttpCode(200) command(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.service.command(this.token(auth), id, body));
  }
}
