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
import {
  readSession,
  createQuote,
  createLocalOrder,
  readLocalOrder,
  cancelLocalOrder,
  setOrdering,
  readOrdering,
  setStop,
  readStop,
  OrderError,
  orderErrorStatus,
} from '@pickchick/local-orders';
import type { StaffAuth } from '@pickchick/local-orders';

@Controller('edge/v1')
export class LocalOrdersController {
  constructor(@Inject(RESOURCE) private readonly resources: Resources) {}

  private async run<T>(
    headers: Record<string, string | undefined>,
    action: (auth: StaffAuth) => Promise<T>,
  ) {
    const auth = {
      sessionId: headers['x-staff-session-id'] ?? '',
      token: headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '',
    };
    try {
      return await action(auth);
    } catch (error) {
      if (error instanceof OrderError)
        throw new HttpException({ code: error.code }, orderErrorStatus[error.code]);
      throw error;
    }
  }
  private get branchId() {
    return this.resources.config.branchId!;
  }
  private get pool() {
    return this.resources.pool;
  }

  @Get('availability/stops/:variantId')
  stopState(
    @Headers() headers: Record<string, string | undefined>,
    @Param('variantId') variantId: string,
  ) {
    return this.run(headers, (auth) => readStop(this.pool, this.branchId, auth, variantId));
  }

  @Get('session')
  session(@Headers() headers: Record<string, string | undefined>) {
    return this.run(headers, (auth) => readSession(this.pool, this.branchId, auth));
  }

  @Post('checkout/quotes')
  @HttpCode(201)
  quote(@Headers() headers: Record<string, string | undefined>, @Body() body: unknown) {
    return this.run(headers, (auth) => createQuote(this.pool, this.branchId, auth, body));
  }

  @Post('orders')
  @HttpCode(201)
  create(@Headers() headers: Record<string, string | undefined>, @Body() body: unknown) {
    return this.run(headers, (auth) =>
      createLocalOrder(this.pool, this.branchId, auth, headers['idempotency-key'] ?? '', body),
    );
  }

  @Get('orders/:orderId')
  read(@Headers() headers: Record<string, string | undefined>, @Param('orderId') orderId: string) {
    return this.run(headers, (auth) => readLocalOrder(this.pool, this.branchId, auth, orderId));
  }

  @Post('orders/:orderId/cancel')
  @HttpCode(200)
  cancel(
    @Headers() headers: Record<string, string | undefined>,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ) {
    return this.run(headers, (auth) =>
      cancelLocalOrder(
        this.pool,
        this.branchId,
        auth,
        headers['idempotency-key'] ?? '',
        orderId,
        body,
      ),
    );
  }

  @Get('ordering')
  ordering(@Headers() headers: Record<string, string | undefined>) {
    return this.run(headers, (auth) => readOrdering(this.pool, this.branchId, auth));
  }

  @Post('ordering/open')
  @HttpCode(200)
  open(@Headers() headers: Record<string, string | undefined>, @Body() body: unknown) {
    return this.run(headers, (auth) =>
      setOrdering(this.pool, this.branchId, auth, headers['idempotency-key'] ?? '', true, body),
    );
  }

  @Post('ordering/close')
  @HttpCode(200)
  close(@Headers() headers: Record<string, string | undefined>, @Body() body: unknown) {
    return this.run(headers, (auth) =>
      setOrdering(this.pool, this.branchId, auth, headers['idempotency-key'] ?? '', false, body),
    );
  }

  @Post('availability/stops')
  @HttpCode(200)
  stop(@Headers() headers: Record<string, string | undefined>, @Body() body: unknown) {
    return this.run(headers, (auth) =>
      setStop(this.pool, this.branchId, auth, headers['idempotency-key'] ?? '', body),
    );
  }
}
