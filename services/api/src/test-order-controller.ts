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
import { RESOURCE, Resources } from '@pickchick/platform';
import { TestFlowError, TestOrderFlow } from '@pickchick/test-order-flow';

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
  private async execute<T>(run: (flow: TestOrderFlow) => T | Promise<T>) {
    try {
      return await run(this.flow());
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
  @Get('catalog') catalog() {
    return this.execute((flow) => flow.catalog());
  }
  @Post('sessions') session(@Body() body: unknown) {
    return this.execute((flow) => flow.issueSession(body));
  }
  @Post('sessions/continue') @HttpCode(200) continueSession(
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.execute((flow) => flow.continueSession(this.token(auth), body));
  }
  @Post('quotes') quote(
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.execute((flow) => flow.quote(this.token(auth), key ?? '', body));
  }
  @Post('orders') order(
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.execute((flow) => flow.createOrder(this.token(auth), key ?? '', body));
  }
  @Get('orders') orders(@Headers('authorization') auth?: string) {
    return this.execute((flow) => flow.ownOrders(this.token(auth)));
  }
  @Get('orders/:id') read(@Param('id') orderId: string, @Headers('authorization') auth?: string) {
    return this.execute((flow) => flow.readOrder(this.token(auth), orderId));
  }
  @Post('orders/:id/simulated-payment') @HttpCode(200) payment(
    @Param('id') orderId: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.execute((flow) => flow.simulatePayment(this.token(auth), key ?? '', orderId, body));
  }
  @Post('orders/:id/resolve-payment') @HttpCode(200) resolve(
    @Param('id') orderId: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.execute((flow) => flow.resolvePayment(this.token(auth), key ?? '', orderId, body));
  }
  @Post('orders/:id/cancel') @HttpCode(200) cancel(
    @Param('id') orderId: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.execute((flow) => flow.cancel(this.token(auth), key ?? '', orderId, body));
  }
  @Get('kitchen') kitchen(@Headers('authorization') auth?: string) {
    return this.execute((flow) => flow.kitchen(this.token(auth)));
  }
  @Post('orders/:id/tasks/:taskId/complete') @HttpCode(200) complete(
    @Param('id') orderId: string,
    @Param('taskId') taskId: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.execute((flow) =>
      flow.completeTask(this.token(auth), key ?? '', orderId, taskId, body),
    );
  }
  @Post('orders/:id/handoff') @HttpCode(200) handoff(
    @Param('id') orderId: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.execute((flow) => flow.handoff(this.token(auth), key ?? '', orderId, body));
  }
  @Get('display') display(@Headers('authorization') auth?: string) {
    return this.execute((flow) => flow.display(this.token(auth)));
  }
  @Get('manager/orders') manager(@Headers('authorization') auth?: string) {
    return this.execute((flow) => flow.managerOrders(this.token(auth)));
  }
}
