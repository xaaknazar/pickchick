import { CatalogPublicationListener } from './catalog-publication-listener.js';
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
  MenuChangedError,
  CustomerCheckout,
  customerCheckoutOptions,
  pollAvailability,
} from '@pickchick/commerce-core';
import { catalogMediaOptions } from '@pickchick/catalog-admin';
import { checkoutRepresentation } from './customer-checkout-response.js';
import { RESOURCE, Resources } from '@pickchick/platform';

@Controller('v1/customer-checkout')
export class CustomerCheckoutController {
  private readonly checkout: CustomerCheckout;
  private readonly mediaEnabled: boolean;
  private availabilityCache: {
    revision: number;
    at: number;
    value: Awaited<ReturnType<CustomerCheckout['availabilityState']>>;
  } | null = null;
  private availabilityRead: Promise<
    Awaited<ReturnType<CustomerCheckout['availabilityState']>>
  > | null = null;
  private async availabilityState(): Promise<
    Awaited<ReturnType<CustomerCheckout['availabilityState']>>
  > {
    const revision = this.publications.revision;
    if (
      this.availabilityCache?.revision === revision &&
      Date.now() - this.availabilityCache.at < 500
    )
      return this.availabilityCache.value;
    if (!this.availabilityRead) {
      this.availabilityRead = this.checkout
        .availabilityState()
        .then((value) => {
          this.availabilityCache = { revision, at: Date.now(), value };
          return value;
        })
        .finally(() => {
          this.availabilityRead = null;
        });
    }
    const value = await this.availabilityRead;
    return revision === this.publications.revision ? value : this.availabilityState();
  }
  constructor(
    @Inject(CUSTOMER_IDENTITY) private readonly identity: CustomerIdentity,
    @Inject(RESOURCE) resources: Resources,
    @Inject(CatalogPublicationListener) private readonly publications: CatalogPublicationListener,
  ) {
    this.checkout = new CustomerCheckout(resources.pool, customerCheckoutOptions(process.env));
    this.mediaEnabled = catalogMediaOptions(process.env).mediaEnabled;
  }
  private async execute<T>(
    authorization: string | undefined,
    run: (customerId: string) => Promise<T>,
    accept?: string,
  ) {
    const precise = accept
      ?.split(',')
      .some((part) => part.trim() === 'application/json; profile=pickchick.checkout-errors-v1');
    const token = authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!token) throw new HttpException({ code: 'UNAUTHORIZED' }, 401);
    try {
      const { customer } = await this.identity.me(token);
      return await run(customer.id);
    } catch (error) {
      if (error instanceof CustomerIdentityError)
        throw new HttpException({ code: error.code }, error.code === 'UNAUTHORIZED' ? 401 : 503);
      if (error instanceof AvailabilityError)
        throw new HttpException(
          {
            code:
              error.code === 'AVAILABILITY_STALE' && !precise ? 'SERVICE_UNAVAILABLE' : error.code,
          },
          error.code === 'ITEM_STOPPED' ? 409 : 503,
        );
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
          error instanceof MenuChangedError && precise
            ? 'MENU_CHANGED'
            : error.code === 'RESTAURANT_CLOSED' && !precise
              ? 'CONFLICT'
              : error.code === 'EXPIRED'
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
  @Get('availability') async availability(
    @Res({ passthrough: true }) response: ServerResponse,
    @Query('after') after?: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (after !== undefined && !AvailabilityAfterSchema.safeParse(after).success)
      throw new HttpException('INVALID_REQUEST', 400);
    const read = async () => {
      const state = await this.availabilityState();
      return { ...state, signature: state.body.signature };
    };
    const state = await pollAvailability(read, after, {
      cancelled: () => response.destroyed,
      timeoutMs: 20_000,
      intervalMs: 2000,
      wait: this.publications.wait,
    });
    if (state.catalogVersion !== null) {
      response.setHeader(CATALOG_VERSION_HEADER, String(state.catalogVersion));
      response.setHeader(
        'Access-Control-Expose-Headers',
        `${CATALOG_VERSION_HEADER}, ${AVAILABILITY_SIGNATURE_HEADER}`,
      );
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
    return this.execute(
      auth,
      async (id) => checkoutRepresentation(await this.checkout.quote(id, body), accept),
      accept,
    );
  }
  @Post('orders') @HttpCode(200) create(
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('accept') accept?: string,
  ) {
    return this.execute(
      auth,
      async (id) => checkoutRepresentation(await this.checkout.create(id, body), accept),
      accept,
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
    return this.execute(
      auth,
      async (id) => checkoutRepresentation(await this.checkout.pay(id, orderId), accept),
      accept,
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
  @Get('orders/:orderId/watch') watch(
    @Param('orderId') orderId: string,
    @Query('after') after: string,
    @Res({ passthrough: true }) response: ServerResponse,
    @Headers('authorization') auth?: string,
    @Headers('accept') accept?: string,
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
        return checkoutRepresentation(order, accept);
      } finally {
        response.off('close', onClose);
      }
    });
  }
}
