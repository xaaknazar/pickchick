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
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { EXPENSES, Expenses, ExpensesError } from '@pickchick/backoffice-core/expenses';

/**
 * «Расходы» of the back office (cloud077, BACKOFFICE_EXPENSES_ENABLED). Organization-wide: the
 * login's token names the organization; the branches are its points. GET reads, POST writes
 * (the gateway and the cabinet proxy pass only these two methods). A closed month is CONFLICT
 * with the reason MONTH_CLOSED in the standard envelope (error.code), like the stop routes.
 */
const STATUS = {
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  MONTH_CLOSED: 409,
  SERVICE_UNAVAILABLE: 503,
} as const;
class MonthClosedException extends HttpException {
  constructor() {
    super({ code: 'CONFLICT' }, 409);
  }
}
@Catch(MonthClosedException)
class MonthClosedFilter implements ExceptionFilter {
  catch(_error: MonthClosedException, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const request = http.getRequest<{ traceId?: string }>();
    http
      .getResponse<{ status(code: number): { json(body: unknown): void } }>()
      .status(409)
      .json({
        code: 'CONFLICT',
        message_key: 'errors.conflict',
        trace_id: request.traceId ?? randomUUID(),
        retryable: false,
        error: { code: 'MONTH_CLOSED' },
      });
  }
}
@Controller('v1/admin/backoffice/expenses')
@UseFilters(MonthClosedFilter)
export class ExpensesController {
  constructor(@Inject(EXPENSES) private readonly service: Expenses) {}
  private token(auth?: string) {
    return auth?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
  }
  private async run(fn: () => Promise<unknown>): Promise<unknown> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ExpensesError && e.code === 'MONTH_CLOSED') throw new MonthClosedException();
      if (e instanceof ExpensesError) throw new HttpException({ code: e.code }, STATUS[e.code]);
      // The 077 trigger of a closed month (another writer closed it a moment ago).
      if ((e as { message?: string }).message === 'The month is closed')
        throw new MonthClosedException();
      throw e;
    }
  }
  @Get('meta') meta(@Headers('authorization') auth?: string) {
    return this.run(() => this.service.meta(this.token(auth)));
  }
  @Get('entry') entry(@Query() q: unknown, @Headers('authorization') auth?: string) {
    return this.run(() => this.service.entryScreen(this.token(auth), q ?? {}));
  }
  @Post('cell') @HttpCode(200) cell(
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.service.cell(this.token(auth), body));
  }
  @Post('row') @HttpCode(200) row(@Body() body: unknown, @Headers('authorization') auth?: string) {
    return this.run(() => this.service.row(this.token(auth), body));
  }
  @Post('entries') @HttpCode(200) create(
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.service.createEntry(this.token(auth), body));
  }
  @Post('entries/:id') @HttpCode(200) update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.service.updateEntry(this.token(auth), id, body));
  }
  @Post('entries/:id/delete') @HttpCode(200) remove(
    @Param('id') id: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.service.deleteEntry(this.token(auth), id));
  }
  @Post('cash') @HttpCode(200) cash(
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.service.cash(this.token(auth), body));
  }
  @Get('journal') journal(@Query() q: unknown, @Headers('authorization') auth?: string) {
    return this.run(() => this.service.journal(this.token(auth), q ?? {}));
  }
  @Get('pnl') pnl(@Query() q: unknown, @Headers('authorization') auth?: string) {
    return this.run(() => this.service.pnl(this.token(auth), q ?? {}));
  }
  @Get('analytics') analytics(@Query() q: unknown, @Headers('authorization') auth?: string) {
    return this.run(() => this.service.analytics(this.token(auth), q ?? {}));
  }
  @Get('log') log(@Query() q: unknown, @Headers('authorization') auth?: string) {
    return this.run(() => this.service.actions(this.token(auth), q ?? {}));
  }
  @Post('months/:month/close') @HttpCode(200) close(
    @Param('month') month: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.service.month(this.token(auth), month, true));
  }
  @Post('months/:month/open') @HttpCode(200) open(
    @Param('month') month: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.service.month(this.token(auth), month, false));
  }
  @Get('access') access(@Headers('authorization') auth?: string) {
    return this.run(() => this.service.access(this.token(auth)));
  }
  @Post('access') @HttpCode(200) setAccess(
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.service.setAccess(this.token(auth), body));
  }
}
