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
  constructor(@Inject(RESOURCE) private readonly resources: Resources) {}
  private flow() {
    const config = this.resources.config;
    return new TestOrderFlow(this.resources.pool, {
      environment: config.environment,
      enabled: 'testOrderFlowEnabled' in config && config.testOrderFlowEnabled === true,
    });
  }
  private token(value?: string) {
    return value?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
  }
  private async execute<T>(run: (flow: TestOrderFlow) => T | Promise<T>, representation?: string) {
    try {
      const version = TestCatalogVersionSchema.safeParse(representation ?? TEST_CATALOG_VERSION);
      if (!version.success) throw new TestFlowError('INVALID_REQUEST');
      const result = await run(this.flow());
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
        };
        throw new HttpException(
          { code: error.code === 'DISABLED' ? 'NOT_FOUND' : error.code },
          statuses[error.code],
        );
      }
      throw error;
    }
  }
  @Get('catalog') catalog(@Query('catalog_version') representation?: string) {
    return this.execute((flow) => flow.catalog(representation), representation);
  }
  @Post('sessions') session(
    @Body() body: unknown,
    @Query('catalog_version') representation?: string,
  ) {
    return this.execute((flow) => flow.issueSession(body), representation);
  }
  @Post('sessions/continue') @HttpCode(200) continueSession(
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Query('catalog_version') representation?: string,
  ) {
    return this.execute((flow) => flow.continueSession(this.token(auth), body), representation);
  }
  @Post('quotes') quote(
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') key?: string,
    @Query('catalog_version') representation?: string,
  ) {
    return this.execute((flow) => flow.quote(this.token(auth), key ?? '', body), representation);
  }
  @Post('orders') order(
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') key?: string,
    @Query('catalog_version') representation?: string,
  ) {
    return this.execute(
      (flow) => flow.createOrder(this.token(auth), key ?? '', body),
      representation,
    );
  }
  @Get('orders') orders(
    @Headers('authorization') auth?: string,
    @Query('catalog_version') representation?: string,
  ) {
    return this.execute((flow) => flow.ownOrders(this.token(auth)), representation);
  }
  @Get('orders/:id') read(
    @Param('id') orderId: string,
    @Headers('authorization') auth?: string,
    @Query('catalog_version') representation?: string,
  ) {
    return this.execute((flow) => flow.readOrder(this.token(auth), orderId), representation);
  }
  @Post('orders/:id/simulated-payment') @HttpCode(200) payment(
    @Param('id') orderId: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') key?: string,
    @Query('catalog_version') representation?: string,
  ) {
    return this.execute(
      (flow) => flow.simulatePayment(this.token(auth), key ?? '', orderId, body),
      representation,
    );
  }
  @Post('orders/:id/resolve-payment') @HttpCode(200) resolve(
    @Param('id') orderId: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') key?: string,
    @Query('catalog_version') representation?: string,
  ) {
    return this.execute(
      (flow) => flow.resolvePayment(this.token(auth), key ?? '', orderId, body),
      representation,
    );
  }
  @Post('orders/:id/cancel') @HttpCode(200) cancel(
    @Param('id') orderId: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') key?: string,
    @Query('catalog_version') representation?: string,
  ) {
    return this.execute(
      (flow) => flow.cancel(this.token(auth), key ?? '', orderId, body),
      representation,
    );
  }
  @Get('kitchen') kitchen(
    @Headers('authorization') auth?: string,
    @Query('catalog_version') representation?: string,
  ) {
    return this.execute((flow) => flow.kitchen(this.token(auth)), representation);
  }
  @Post('orders/:id/tasks/:taskId/complete') @HttpCode(200) complete(
    @Param('id') orderId: string,
    @Param('taskId') taskId: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') key?: string,
    @Query('catalog_version') representation?: string,
  ) {
    return this.execute(
      (flow) => flow.completeTask(this.token(auth), key ?? '', orderId, taskId, body),
      representation,
    );
  }
  @Post('orders/:id/handoff') @HttpCode(200) handoff(
    @Param('id') orderId: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') key?: string,
    @Query('catalog_version') representation?: string,
  ) {
    return this.execute(
      (flow) => flow.handoff(this.token(auth), key ?? '', orderId, body),
      representation,
    );
  }
  @Get('display') display(
    @Headers('authorization') auth?: string,
    @Query('catalog_version') representation?: string,
  ) {
    return this.execute((flow) => flow.display(this.token(auth)), representation);
  }
  @Get('manager/orders') manager(
    @Headers('authorization') auth?: string,
    @Query('catalog_version') representation?: string,
  ) {
    return this.execute((flow) => flow.managerOrders(this.token(auth)), representation);
  }
}
