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
  readSession,
  createQuote,
  createLocalOrder,
  readLocalOrder,
  cancelLocalOrder,
  setOrdering,
  readOrdering,
  setStop,
  readStop,
  openCashShift,
  closeCashShift,
  currentCashShift,
  readCashShift,
  listCashShifts,
  listLocalOrders,
  OrderError,
  orderErrorStatus,
} from '@pickchick/local-orders';
import { localUnpaidExecution } from '@pickchick/edge-fulfillment';
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
  private get execution() {
    return localUnpaidExecution({
      enabled: this.resources.config.edgeFulfillmentEnabled,
      deviceId: this.resources.config.edgeDeviceId,
    });
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
      createLocalOrder(
        this.pool,
        this.branchId,
        auth,
        headers['idempotency-key'] ?? '',
        body,
        this.execution,
      ),
    );
  }

  @Get('orders')
  listOrders(
    @Headers() headers: Record<string, string | undefined>,
    @Query('shift_id') shiftId?: string,
  ) {
    return this.run(headers, (auth) => listLocalOrders(this.pool, this.branchId, auth, shiftId));
  }

  @Get('cash-shifts/current')
  currentShift(@Headers() headers: Record<string, string | undefined>) {
    return this.run(headers, (auth) => currentCashShift(this.pool, this.branchId, auth));
  }

  @Get('cash-shifts')
  shifts(@Headers() headers: Record<string, string | undefined>) {
    return this.run(headers, (auth) => listCashShifts(this.pool, this.branchId, auth));
  }

  @Get('cash-shifts/:shiftId')
  shift(@Headers() headers: Record<string, string | undefined>, @Param('shiftId') shiftId: string) {
    return this.run(headers, (auth) => readCashShift(this.pool, this.branchId, auth, shiftId));
  }

  @Post('cash-shifts')
  @HttpCode(201)
  openShift(@Headers() headers: Record<string, string | undefined>, @Body() body: unknown) {
    return this.run(headers, (auth) =>
      openCashShift(this.pool, this.branchId, auth, headers['idempotency-key'] ?? '', body),
    );
  }

  @Post('cash-shifts/:shiftId/close')
  @HttpCode(200)
  closeShift(
    @Headers() headers: Record<string, string | undefined>,
    @Param('shiftId') shiftId: string,
    @Body() body: unknown,
  ) {
    return this.run(headers, (auth) =>
      closeCashShift(
        this.pool,
        this.branchId,
        auth,
        headers['idempotency-key'] ?? '',
        shiftId,
        body,
      ),
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
        this.execution,
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
