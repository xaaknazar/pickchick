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
  CommerceRepository,
  CustomerCheckout,
  customerCheckoutConfig,
  customerCheckoutError,
  maskCustomerPhone,
} from '@pickchick/commerce-core';
import type { CustomerCheckoutConfig } from '@pickchick/commerce-core';
import {
  CUSTOMER_IDENTITY,
  CustomerIdentity,
  CustomerIdentityError,
} from '@pickchick/customer-identity';

const TOKEN = /^Bearer ([a-f0-9]{64})$/;
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Mobile checkout paid by a Kaspi invoice to the customer's verified phone.
 * Off unless CUSTOMER_KASPI_CHECKOUT_ENABLED=true; the Kaspi provider account
 * must additionally be enabled in the database. Invoices are issued and checked
 * only by the Kaspi worker; this adapter never reports payment by itself.
 */
@Controller('v1/customer/checkout')
export class CustomerCheckoutController {
  private readonly config: CustomerCheckoutConfig | null;
  private readonly checkout: CustomerCheckout | null;
  constructor(
    @Inject(RESOURCE) resources: Resources,
    @Inject(CUSTOMER_IDENTITY) private readonly identity: CustomerIdentity,
  ) {
    this.config = customerCheckoutConfig(process.env);
    this.checkout = this.config
      ? new CustomerCheckout(resources.pool, new CommerceRepository(resources.pool), this.config)
      : null;
  }

  private async customer(authorization?: string) {
    const token = authorization?.match(TOKEN)?.[1];
    if (!token) throw new HttpException({ code: 'UNAUTHORIZED' }, 401);
    try {
      return (await this.identity.me(token)).customer;
    } catch (error) {
      if (error instanceof CustomerIdentityError) {
        if (error.code === 'UNAUTHORIZED') throw new HttpException({ code: 'UNAUTHORIZED' }, 401);
        throw new HttpException({ code: 'SERVICE_UNAVAILABLE' }, 503);
      }
      throw error;
    }
  }
  private enabled() {
    if (!this.checkout) throw new HttpException({ code: 'SERVICE_UNAVAILABLE' }, 503);
    return this.checkout;
  }
  private key(value?: string) {
    if (!value || !KEY.test(value)) throw new HttpException({ code: 'INVALID_REQUEST' }, 400);
    return value.toLowerCase();
  }
  private async execute<T>(
    authorization: string | undefined,
    key: string | undefined | null,
    run: (checkout: CustomerCheckout, customerId: string, key: string) => Promise<T>,
  ) {
    const checkout = this.enabled();
    const customer = await this.customer(authorization);
    const request = key === null ? '' : this.key(key);
    try {
      return await run(checkout, customer.id, request);
    } catch (error) {
      const mapped = customerCheckoutError(error);
      if (mapped) throw new HttpException({ code: mapped.code }, mapped.status);
      throw error;
    }
  }

  /** Whether this build may offer Kaspi checkout, and where the invoice will go. */
  @Get()
  async status(@Headers('authorization') authorization?: string) {
    if (!this.checkout) return { enabled: false };
    const customer = await this.customer(authorization);
    return {
      enabled: true,
      payment_method: 'kaspi',
      phone_masked: maskCustomerPhone(customer.phone),
    };
  }

  @Post('quotes')
  @HttpCode(200)
  quote(
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.execute(authorization, key, (checkout, id, request) =>
      checkout.quote(id, request, body),
    );
  }

  @Post('orders')
  @HttpCode(200)
  order(
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.execute(authorization, key, (checkout, id, request) =>
      checkout.createOrder(id, request, body),
    );
  }

  @Post('orders/:orderId/kaspi-payment')
  @HttpCode(200)
  pay(
    @Param('orderId') orderId: string,
    @Headers('authorization') authorization?: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.execute(authorization, key, (checkout, id, request) =>
      checkout.pay(id, request, orderId),
    );
  }

  @Get('orders/:orderId')
  read(@Param('orderId') orderId: string, @Headers('authorization') authorization?: string) {
    return this.execute(authorization, null, (checkout, id) => checkout.read(id, orderId));
  }
}
