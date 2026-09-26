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
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { TestOrderEvents } from './test-order-events.js';
import { TestOrderWatchSchema, sameTestOrderVersions } from '@pickchick/test-order-flow';
import { RESOURCE, Resources } from '@pickchick/platform';
import {
  TestFlowError,
  TestOrderFlow,
  TestCatalogVersionSchema,
  TEST_CATALOG_VERSION,
  legacyTestResponse,
} from '@pickchick/test-order-flow';

@Controller('v1/test')
export class TestOrderController {
  private readonly events: TestOrderEvents;
  private readonly watchers = new Map<string, number>();
  constructor(@Inject(RESOURCE) private readonly resources: Resources) {
    this.events = new TestOrderEvents(resources.config.databaseUrl);
  }
  async onModuleDestroy() {
    await this.events.close();
  }

  @Post('orders/watch') @HttpCode(200) watch(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: ServerResponse,
    @Headers('authorization') auth?: string,
    @Query('catalog_version') representation?: string,
    @Query('number_format') numberFormat?: string,
  ) {
    return this.execute(
      async (flow) => {
        const parsed = TestOrderWatchSchema.safeParse(body);
        if (!parsed.success) throw new TestFlowError('INVALID_REQUEST');
        const token = this.token(auth);
        // Authenticate before opening a subscription; authenticate again after every wait.
        await flow.ownOrders(token);
        if ((this.watchers.get(token) ?? 0) >= 2) throw new TestFlowError('RATE_LIMITED');
        this.watchers.set(token, (this.watchers.get(token) ?? 0) + 1);
        const abort = new AbortController();
        const close = () => abort.abort();
        response.on('close', close);
        if (response.destroyed) abort.abort();
        let subscription: Awaited<ReturnType<TestOrderEvents['subscribe']>> | undefined;
        try {
          try {
            subscription = await this.events.subscribe();
          } catch {
            throw new ServiceUnavailableException();
          }
          const snapshot = await flow.ownOrders(token);
          if (!sameTestOrderVersions(snapshot.orders, parsed.data.versions)) return snapshot;
          await subscription.wait(
            snapshot.orders.map((o) => o.order_id),
            abort.signal,
          );
          return abort.signal.aborted ? snapshot : await flow.ownOrders(token);
        } finally {
          subscription?.dispose();
          response.off('close', close);
          const remaining = (this.watchers.get(token) ?? 1) - 1;
          if (remaining) this.watchers.set(token, remaining);
          else this.watchers.delete(token);
        }
      },
      representation,
      numberFormat,
    );
  }
  private flow() {
    const config = this.resources.config;
    return new TestOrderFlow(this.resources.pool, {
      environment: config.environment,
      enabled: 'testOrderFlowEnabled' in config && config.testOrderFlowEnabled === true,
      customerAuthEnabled: config.customerAuthEnabled === true,
    });
  }
  private token(value?: string) {
    return value?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
  }
  private async execute<T>(
    run: (flow: TestOrderFlow) => T | Promise<T>,
    representation?: string,
    numberFormat?: string,
  ) {
    try {
      const version = TestCatalogVersionSchema.safeParse(representation ?? TEST_CATALOG_VERSION);
      if (!version.success) throw new TestFlowError('INVALID_REQUEST');
      if (numberFormat !== undefined && numberFormat !== 'daily')
        throw new TestFlowError('INVALID_REQUEST');
      const flow = this.flow();
      const raw = await run(flow);
      const result = numberFormat === 'daily' ? await flow.dailyNumbers(raw) : raw;
      return version.data === TEST_CATALOG_VERSION ? legacyTestResponse(result) : result;
    } catch (error) {
      if (error instanceof TestFlowError) {
        const statuses = {
          DISABLED: 404,
          INVALID_REQUEST: 400,
          UNAUTHORIZED: 401,
          FORBIDDEN: 403,
          NOT_FOUND: 404,
          CONFLICT: 409,
          QUOTE_EXPIRED: 409,
          RATE_LIMITED: 429,
          BRANCH_UNAVAILABLE: 503,
          SHIFT_CLOSED: 409,
        };
        throw new HttpException(
          { code: error.code === 'DISABLED' ? 'NOT_FOUND' : error.code },
          statuses[error.code],
        );
      }
      throw error;
    }
  }
  @Get('catalog') catalog(
    @Query('catalog_version') representation?: string,
    @Query('number_format') numberFormat?: string,
  ) {
    return this.execute((flow) => flow.catalog(representation), representation, numberFormat);
  }
  @Get('shift') shift(@Headers('authorization') auth?: string) {
    return this.execute((flow) => flow.currentShift(this.token(auth)));
  }
  @Post('shift/open') openShift(
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.execute((flow) => flow.changeShift(this.token(auth), key ?? '', 'open', body));
  }
  @Post('shift/close') closeShift(
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.execute((flow) => flow.changeShift(this.token(auth), key ?? '', 'close', body));
  }
  @Post('sessions') session(
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Query('catalog_version') representation?: string,
    @Query('number_format') numberFormat?: string,
  ) {
    return this.execute(
      (flow) => flow.issueSession(body, this.token(auth)),
      representation,
      numberFormat,
    );
  }
  @Post('sessions/continue') @HttpCode(200) continueSession(
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Query('catalog_version') representation?: string,
    @Query('number_format') numberFormat?: string,
  ) {
    return this.execute(
      (flow) => flow.continueSession(this.token(auth), body),
      representation,
      numberFormat,
    );
  }
  @Post('quotes') quote(
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') key?: string,
    @Query('catalog_version') representation?: string,
    @Query('number_format') numberFormat?: string,
  ) {
    return this.execute(
      (flow) => flow.quote(this.token(auth), key ?? '', body),
      representation,
      numberFormat,
    );
  }
  @Post('orders') order(
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') key?: string,
    @Query('catalog_version') representation?: string,
    @Query('number_format') numberFormat?: string,
  ) {
    return this.execute(
      (flow) => flow.createOrder(this.token(auth), key ?? '', body),
      representation,
      numberFormat,
    );
  }
  @Get('orders') orders(
    @Headers('authorization') auth?: string,
    @Query('catalog_version') representation?: string,
    @Query('number_format') numberFormat?: string,
  ) {
    return this.execute((flow) => flow.ownOrders(this.token(auth)), representation, numberFormat);
  }
  @Get('history') history(
    @Headers('authorization') auth?: string,
    @Query('before') before?: string,
    @Query('catalog_version') representation?: string,
    @Query('number_format') numberFormat?: string,
  ) {
    return this.execute(
      (flow) => flow.history(this.token(auth), before),
      representation,
      numberFormat,
    );
  }
  @Get('orders/:id/feedback') feedback(
    @Param('id') id: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.execute((flow) => flow.feedback(this.token(auth), id));
  }
  @Post('orders/:id/feedback') @HttpCode(200) submitFeedback(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.execute((flow) => flow.submitFeedback(this.token(auth), key ?? '', id, body));
  }
  @Get('orders/:id') read(
    @Param('id') orderId: string,
    @Headers('authorization') auth?: string,
    @Query('catalog_version') representation?: string,
    @Query('number_format') numberFormat?: string,
  ) {
    return this.execute(
      (flow) => flow.readOrder(this.token(auth), orderId),
      representation,
      numberFormat,
    );
  }
  @Post('orders/:id/simulated-payment') @HttpCode(200) payment(
    @Param('id') orderId: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') key?: string,
    @Query('catalog_version') representation?: string,
    @Query('number_format') numberFormat?: string,
  ) {
    return this.execute(
      (flow) => flow.simulatePayment(this.token(auth), key ?? '', orderId, body),
      representation,
      numberFormat,
    );
  }
  @Post('orders/:id/resolve-payment') @HttpCode(200) resolve(
    @Param('id') orderId: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') key?: string,
    @Query('catalog_version') representation?: string,
    @Query('number_format') numberFormat?: string,
  ) {
    return this.execute(
      (flow) => flow.resolvePayment(this.token(auth), key ?? '', orderId, body),
      representation,
      numberFormat,
    );
  }
  @Post('orders/:id/cancel') @HttpCode(200) cancel(
    @Param('id') orderId: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') key?: string,
    @Query('catalog_version') representation?: string,
    @Query('number_format') numberFormat?: string,
  ) {
    return this.execute(
      (flow) => flow.cancel(this.token(auth), key ?? '', orderId, body),
      representation,
      numberFormat,
    );
  }
  @Get('kitchen') kitchen(
    @Headers('authorization') auth?: string,
    @Query('catalog_version') representation?: string,
    @Query('number_format') numberFormat?: string,
  ) {
    return this.execute((flow) => flow.kitchen(this.token(auth)), representation, numberFormat);
  }
  @Post('orders/:id/tasks/:taskId/complete') @HttpCode(200) complete(
    @Param('id') orderId: string,
    @Param('taskId') taskId: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') key?: string,
    @Query('catalog_version') representation?: string,
    @Query('number_format') numberFormat?: string,
  ) {
    return this.execute(
      (flow) => flow.completeTask(this.token(auth), key ?? '', orderId, taskId, body),
      representation,
      numberFormat,
    );
  }
  @Post('orders/:id/handoff') @HttpCode(200) handoff(
    @Param('id') orderId: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') key?: string,
    @Query('catalog_version') representation?: string,
    @Query('number_format') numberFormat?: string,
  ) {
    return this.execute(
      (flow) => flow.handoff(this.token(auth), key ?? '', orderId, body),
      representation,
      numberFormat,
    );
  }
  @Get('display') display(
    @Headers('authorization') auth?: string,
    @Query('catalog_version') representation?: string,
    @Query('number_format') numberFormat?: string,
    @Query('shift_context') shiftContext?: string,
  ) {
    return this.execute(
      async (flow) => {
        const result = await flow.display(this.token(auth));
        return numberFormat === 'daily' && shiftContext === '1'
          ? flow.dailyNumbers(result, true)
          : result;
      },
      representation,
      numberFormat,
    );
  }
  @Get('manager/orders') manager(
    @Headers('authorization') auth?: string,
    @Query('catalog_version') representation?: string,
    @Query('number_format') numberFormat?: string,
  ) {
    return this.execute(
      (flow) => flow.managerOrders(this.token(auth)),
      representation,
      numberFormat,
    );
  }
}
