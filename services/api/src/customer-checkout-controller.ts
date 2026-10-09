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
import {
  AVAILABILITY_SIGNATURE_HEADER,
  AvailabilityAfterSchema,
  AvailabilityError,
  CATALOG_VERSION_HEADER,
  CommerceError,
  CustomerCheckout,
  customerCheckoutOptions,
  pollAvailability,
} from '@pickchick/commerce-core';
import { catalogMediaOptions } from '@pickchick/catalog-admin';
import { checkoutRepresentation } from './customer-checkout-response.js';
import { LongPollRoute, longPollMayWait, RESOURCE, Resources } from '@pickchick/platform';

@Controller('v1/customer-checkout')
export class CustomerCheckoutController {
  private readonly checkout: CustomerCheckout;
  private readonly mediaEnabled: boolean;
  constructor(
    @Inject(CUSTOMER_IDENTITY) private readonly identity: CustomerIdentity,
    @Inject(RESOURCE) resources: Resources,
  ) {
    this.checkout = new CustomerCheckout(resources.pool, customerCheckoutOptions(process.env));
    this.mediaEnabled = catalogMediaOptions(process.env).mediaEnabled;
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
      if (error instanceof AvailabilityError)
        throw new HttpException({ code: error.code }, error.code === 'ITEM_STOPPED' ? 409 : 503);
      if (error instanceof CommerceError) {
        const statuses = {
          CATALOG_UPGRADE_REQUIRED: 409,
          INVALID: 400,
          FORBIDDEN: 403,
          NOT_FOUND: 404,
          CONFLICT: 409,
          EXPIRED: 409,
          NOT_READY: 503,
          REFUND_LIMIT: 409,
          RESTAURANT_CLOSED: 409,
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
  @Get('catalog') async catalog(@Res({ passthrough: true }) response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    try {
      return await this.checkout.catalog();
    } catch (error) {
      if (error instanceof CommerceError)
        throw new HttpException({ code: error.code }, error.code === 'NOT_FOUND' ? 404 : 503);
      throw error;
    }
  }
  /** Photo map for new clients; same audience and flag as the catalog, `version` = head. */
  @Get('catalog/media') async catalogMedia(
    @Res({ passthrough: true }) response: ServerResponse,
    @Query('version') version?: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    try {
      return await this.checkout.catalogMedia(version, { mediaEnabled: this.mediaEnabled });
    } catch (error) {
      if (error instanceof CommerceError) {
        const statuses: Partial<Record<CommerceError['code'], number>> = {
          INVALID: 400,
          NOT_FOUND: 404,
          CONFLICT: 409,
        };
        const code = error.code === 'INVALID' ? 'INVALID_REQUEST' : error.code;
        throw new HttpException({ code }, statuses[error.code] ?? 503);
      }
      throw error;
    }
  }
  /** Long-poll only with `after`; on overflow admission lets it read the current state once. */
  @Get('availability')
  @LongPollRoute('after')
  async availability(
    @Res({ passthrough: true }) response: ServerResponse,
    @Query('after') after?: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (after !== undefined && !AvailabilityAfterSchema.safeParse(after).success)
      throw new HttpException('INVALID_REQUEST', 400);
    const read = async () => {
      const state = await this.checkout.availabilityState();
      return { ...state, signature: state.body.signature };
    };
    const wait = longPollMayWait(response.req) ? after : undefined;
    const state = await pollAvailability(read, wait, { cancelled: () => response.destroyed });
    if (state.catalogVersion !== null) {
      response.setHeader(CATALOG_VERSION_HEADER, String(state.catalogVersion));
      response.setHeader(AVAILABILITY_SIGNATURE_HEADER, state.signature);
    }
    return state.body;
  }
  @Get('config') config(
    @Headers('authorization') auth?: string,
    @Headers('accept') accept?: string,
  ) {
    return this.execute(auth, async (id) =>
      checkoutRepresentation(await this.checkout.config(id), accept),
    );
  }
  @Post('quotes') @HttpCode(200) quote(
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('accept') accept?: string,
  ) {
    return this.execute(auth, async (id) =>
      checkoutRepresentation(await this.checkout.quote(id, body), accept),
    );
  }
  @Post('orders') @HttpCode(200) create(
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('accept') accept?: string,
  ) {
    return this.execute(auth, async (id) =>
      checkoutRepresentation(await this.checkout.create(id, body), accept),
    );
  }
  @Get('orders') list(@Headers('authorization') auth?: string, @Headers('accept') accept?: string) {
    return this.execute(auth, async (id) =>
      checkoutRepresentation(await this.checkout.list(id), accept),
    );
  }
  @Post('orders/:orderId/payment') @HttpCode(200) pay(
    @Param('orderId') orderId: string,
    @Headers('authorization') auth?: string,
    @Headers('accept') accept?: string,
  ) {
    return this.execute(auth, async (id) =>
      checkoutRepresentation(await this.checkout.pay(id, orderId), accept),
    );
  }
  @Get('feedback') listFeedback(
    @Res({ passthrough: true }) response: ServerResponse,
    @Headers('authorization') auth?: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.execute(auth, (id) => this.checkout.listFeedback(id));
  }
  @Get('orders/:orderId/feedback') feedback(
    @Res({ passthrough: true }) response: ServerResponse,
    @Param('orderId') orderId: string,
    @Headers('authorization') auth?: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.execute(auth, (id) => this.checkout.feedback(id, orderId));
  }
  @Post('orders/:orderId/feedback') @HttpCode(200) submitFeedback(
    @Param('orderId') orderId: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.execute(auth, (id) => this.checkout.submitFeedback(id, orderId, body));
  }
  @Get('orders/:orderId') read(
    @Param('orderId') orderId: string,
    @Headers('authorization') auth?: string,
    @Headers('accept') accept?: string,
  ) {
    return this.execute(auth, async (id) =>
      checkoutRepresentation(await this.checkout.read(id, orderId), accept),
    );
  }
  @Get('orders/:orderId/watch')
  @LongPollRoute()
  watch(
    @Param('orderId') orderId: string,
    @Query('after') after: string,
    @Res({ passthrough: true }) response: ServerResponse,
    @Headers('authorization') auth?: string,
    @Headers('accept') accept?: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.execute(auth, async (id) => {
      if (!/^[a-f0-9]{64}$/.test(after ?? '')) throw new CommerceError('INVALID');
      // Admission overflow: one read of the current order, the same answer as a timed-out wait.
      const deadline = Date.now() + (longPollMayWait(response.req) ? 20000 : 0);
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
        return checkoutRepresentation(order, accept);
      } finally {
        response.off('close', onClose);
      }
    });
  }
}
