import {
  Body,
  Controller,
  Get,
  Header,
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
  createPosSale,
  listPendingFiscalReceipts,
  readPosConfig,
  readPosSale,
  readShiftReport,
  recordFiscalReceipt,
  refundPosSale,
  voidPosSale,
  OrderError,
  orderErrorStatus,
} from '@pickchick/local-orders';
import type { StaffAuth } from '@pickchick/local-orders';
import { localUnpaidExecution } from '@pickchick/edge-fulfillment';

/**
 * Cutover 19.11 (contracts 5.1, lane pos): paid POS sales on the cashier edge. Everything here
 * is off until the operator switches the branch to pos_sale (scripts/pos-sales-setup.mjs); an
 * edge without schema026 answers 404 on GET pos/config, so the POS keeps its unpaid UI.
 */
@Controller('edge/v1')
export class PosSalesController {
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
  private get execution() {
    return localUnpaidExecution({
      enabled: this.resources.config.edgeFulfillmentEnabled,
      deviceId: this.resources.config.edgeDeviceId,
    });
  }

  @Get('pos/config')
  @Header('Cache-Control', 'no-store')
  config(
    @Headers() headers: Record<string, string | undefined>,
    @Query('client_version') clientVersion?: string,
  ) {
    return this.run(headers, (auth) =>
      readPosConfig(this.pool, this.branchId, auth, clientVersion),
    );
  }

  @Post('pos/sales')
  @HttpCode(201)
  sell(@Headers() headers: Record<string, string | undefined>, @Body() body: unknown) {
    return this.run(headers, (auth) =>
      createPosSale(
        this.pool,
        this.branchId,
        auth,
        headers['idempotency-key'] ?? '',
        body,
        this.execution,
      ),
    );
  }

  @Get('pos/sales/:orderId')
  sale(@Headers() headers: Record<string, string | undefined>, @Param('orderId') orderId: string) {
    return this.run(headers, (auth) => readPosSale(this.pool, this.branchId, auth, orderId));
  }

  /** POS-3: void before the kitchen starts (else 409 ORDER_IN_PRODUCTION). */
  @Post('pos/sales/:orderId/void')
  @HttpCode(200)
  voidSale(
    @Headers() headers: Record<string, string | undefined>,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ) {
    return this.run(headers, (auth) =>
      voidPosSale(
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

  /** POS-3: refund by tender, full or partial; the answer is the PosSale with it. */
  @Post('pos/sales/:orderId/refunds')
  @HttpCode(201)
  refund(
    @Headers() headers: Record<string, string | undefined>,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ) {
    return this.run(headers, (auth) =>
      refundPosSale(
        this.pool,
        this.branchId,
        auth,
        headers['idempotency-key'] ?? '',
        orderId,
        body,
      ),
    );
  }

  /** POS-5: receipts still to be punched in the Webkassa cabinet. */
  @Get('pos/fiscal-receipts/pending')
  @Header('Cache-Control', 'no-store')
  pendingReceipts(
    @Headers() headers: Record<string, string | undefined>,
    @Query('shift_id') shiftId?: unknown,
  ) {
    return this.run(headers, (auth) =>
      listPendingFiscalReceipts(this.pool, this.branchId, auth, shiftId),
    );
  }

  /** POS-5: the Webkassa number of one receipt (a correction needs fiscal_correct). */
  @Post('pos/fiscal-receipts/:receiptId/record')
  @HttpCode(200)
  recordReceipt(
    @Headers() headers: Record<string, string | undefined>,
    @Param('receiptId') receiptId: string,
    @Body() body: unknown,
  ) {
    return this.run(headers, (auth) =>
      recordFiscalReceipt(
        this.pool,
        this.branchId,
        auth,
        headers['idempotency-key'] ?? '',
        receiptId,
        body,
      ),
    );
  }

  /** POS-4: PickChick X report of a sales shift (now, not fiscal). */
  @Get('cash-shifts/:shiftId/x-report')
  @Header('Cache-Control', 'no-store')
  xReport(
    @Headers() headers: Record<string, string | undefined>,
    @Param('shiftId') shiftId: string,
  ) {
    return this.run(headers, (auth) =>
      readShiftReport(this.pool, this.branchId, auth, shiftId, 'x'),
    );
  }

  /** POS-4: PickChick Z report frozen when the sales shift closed (not fiscal). */
  @Get('cash-shifts/:shiftId/z-report')
  @Header('Cache-Control', 'no-store')
  zReport(
    @Headers() headers: Record<string, string | undefined>,
    @Param('shiftId') shiftId: string,
  ) {
    return this.run(headers, (auth) =>
      readShiftReport(this.pool, this.branchId, auth, shiftId, 'z'),
    );
  }
}
