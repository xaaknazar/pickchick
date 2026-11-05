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
  readPosConfig,
  readPosSale,
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
        localUnpaidExecution({
          enabled: this.resources.config.edgeFulfillmentEnabled,
          deviceId: this.resources.config.edgeDeviceId,
        }),
      ),
    );
  }

  @Get('pos/sales/:orderId')
  sale(@Headers() headers: Record<string, string | undefined>, @Param('orderId') orderId: string) {
    return this.run(headers, (auth) => readPosSale(this.pool, this.branchId, auth, orderId));
  }
}
