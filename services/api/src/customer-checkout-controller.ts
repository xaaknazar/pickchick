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
} from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import {
  CustomerIdentity,
  CustomerIdentityError,
  CUSTOMER_IDENTITY,
} from '@pickchick/customer-identity';
import { CommerceError, CustomerCheckout, customerCheckoutOptions } from '@pickchick/commerce-core';
import { RESOURCE, Resources } from '@pickchick/platform';

@Controller('v1/customer-checkout')
export class CustomerCheckoutController {
  private readonly checkout: CustomerCheckout;
  constructor(
    @Inject(CUSTOMER_IDENTITY) private readonly identity: CustomerIdentity,
    @Inject(RESOURCE) resources: Resources,
  ) {
    this.checkout = new CustomerCheckout(resources.pool, customerCheckoutOptions(process.env));
  }
  private async execute<T>(
    authorization: string | undefined,
    run: (customerId: string) => Promise<T>,
  ) {
    const token = authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!token) throw new HttpException({ code: 'UNAUTHORIZED' }, 401);
    try {
      const { customer } = await this.identity.me(token);
      return await run(customer.id);
    } catch (error) {
      if (error instanceof CustomerIdentityError)
        throw new HttpException({ code: error.code }, error.code === 'UNAUTHORIZED' ? 401 : 503);
      if (error instanceof CommerceError) {
        const statuses = {
          INVALID: 400,
          FORBIDDEN: 403,
          NOT_FOUND: 404,
          CONFLICT: 409,
          EXPIRED: 409,
          NOT_READY: 503,
          REFUND_LIMIT: 409,
        };
        const code =
          error.code === 'EXPIRED'
            ? 'QUOTE_EXPIRED'
            : error.code === 'INVALID'
              ? 'INVALID_REQUEST'
              : error.code;
        throw new HttpException({ code }, statuses[error.code]);
      }
      throw error;
    }
  }
  @Get('config') config(@Headers('authorization') auth?: string) {
    return this.execute(auth, (id) => this.checkout.config(id));
  }
  @Post('quotes') @HttpCode(200) quote(
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.execute(auth, (id) => this.checkout.quote(id, body));
  }
  @Post('orders') @HttpCode(200) create(
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.execute(auth, (id) => this.checkout.create(id, body));
  }
  @Get('orders') list(@Headers('authorization') auth?: string) {
    return this.execute(auth, (id) => this.checkout.list(id));
  }
  @Post('orders/:orderId/payment') @HttpCode(200) pay(
    @Param('orderId') orderId: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.execute(auth, (id) => this.checkout.pay(id, orderId));
  }
  @Get('orders/:orderId') read(
    @Param('orderId') orderId: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.execute(auth, (id) => this.checkout.read(id, orderId));
  }
  @Get('orders/:orderId/watch') watch(
    @Param('orderId') orderId: string,
    @Query('after') after: string,
    @Res({ passthrough: true }) response: ServerResponse,
    @Headers('authorization') auth?: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.execute(auth, async (id) => {
      if (!/^[a-f0-9]{64}$/.test(after ?? '')) throw new CommerceError('INVALID');
      const deadline = Date.now() + 20000;
      let disconnected = false;
      const onClose = () => {
        disconnected = true;
      };
      response.once('close', onClose);
      try {
        let order = await this.checkout.read(id, orderId);
        // Long poll reads local projections only; never calls Kaspi or creates invoices.
        while (!disconnected && order.revision === after && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          order = await this.checkout.read(id, orderId);
        }
        return order;
      } finally {
        response.off('close', onClose);
      }
    });
  }
}
