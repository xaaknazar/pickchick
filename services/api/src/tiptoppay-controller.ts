import type { ServerResponse } from 'node:http';
import {
  Controller,
  Post,
  Get,
  Res,
  Param,
  Req,
  Inject,
  HttpCode,
  HttpException,
} from '@nestjs/common';
import { RESOURCE, Resources } from '@pickchick/platform';
import {
  TipTopPayReceiver,
  TipTopPayError,
  tipTopPayConfig,
  TipTopPayHostedSessions,
  tipTopPayCheckoutOptions,
  tipTopPayHostedHtml,
  CommerceError,
  TipTopPayTestCheckout,
  tipTopPayTestOptions,
  tipTopPayTestHostedHtml,
} from '@pickchick/commerce-core';

@Controller('v1/integrations/tiptoppay')
export class TipTopPayController {
  private readonly receiver: TipTopPayReceiver;
  private readonly hosted: TipTopPayHostedSessions;
  private readonly testCheckout: TipTopPayTestCheckout;
  constructor(@Inject(RESOURCE) resources: Resources) {
    this.testCheckout = new TipTopPayTestCheckout(
      resources.pool,
      tipTopPayTestOptions(process.env),
    );
    this.hosted = new TipTopPayHostedSessions(
      resources.pool,
      tipTopPayCheckoutOptions(process.env),
    );
    this.receiver = new TipTopPayReceiver(resources.pool, tipTopPayConfig(process.env));
  }

  @Get('checkout') checkout(@Res() response: ServerResponse) {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.end(tipTopPayHostedHtml);
  }
  @Post('checkout-session') @HttpCode(200) async checkoutSession(
    @Req() request: { body: unknown },
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (!Buffer.isBuffer(request.body)) throw new HttpException('INVALID_REQUEST', 400);
    const form = new URLSearchParams(request.body.toString('utf8'));
    if ([...form.keys()].length !== 1 || !form.has('token'))
      throw new HttpException('INVALID_REQUEST', 400);
    try {
      return await this.hosted.open(form.get('token'));
    } catch (error) {
      if (error instanceof CommerceError) throw new HttpException('CHECKOUT_UNAVAILABLE', 404);
      throw error;
    }
  }
  @Post('checkout-status') @HttpCode(200) async checkoutStatus(
    @Req() request: { body: unknown },
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (!Buffer.isBuffer(request.body)) throw new HttpException('INVALID_REQUEST', 400);
    const form = new URLSearchParams(request.body.toString('utf8'));
    if ([...form.keys()].length !== 1 || !form.has('token'))
      throw new HttpException('INVALID_REQUEST', 400);
    try {
      return await this.hosted.status(form.get('token'));
    } catch (error) {
      if (error instanceof CommerceError) throw new HttpException('CHECKOUT_UNAVAILABLE', 404);
      throw error;
    }
  }
  @Get('test-checkout') testPage(@Res() response: ServerResponse) {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.end(tipTopPayTestHostedHtml);
  }
  @Post('test-checkout-session') @HttpCode(200) async testSession(
    @Req() request: { body: unknown },
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (!Buffer.isBuffer(request.body)) throw new HttpException('INVALID_REQUEST', 400);
    const form = new URLSearchParams(request.body.toString('utf8'));
    if ([...form.keys()].length !== 1 || !form.has('token'))
      throw new HttpException('INVALID_REQUEST', 400);
    try {
      return await this.testCheckout.open(form.get('token'));
    } catch (error) {
      if (error instanceof CommerceError) throw new HttpException('CHECKOUT_UNAVAILABLE', 404);
      throw error;
    }
  }
  @Post('test-checkout-status') @HttpCode(200) async testStatus(
    @Req() request: { body: unknown },
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (!Buffer.isBuffer(request.body)) throw new HttpException('INVALID_REQUEST', 400);
    const form = new URLSearchParams(request.body.toString('utf8'));
    if ([...form.keys()].length !== 1 || !form.has('token'))
      throw new HttpException('INVALID_REQUEST', 400);
    try {
      return await this.testCheckout.status(form.get('token'));
    } catch (error) {
      if (error instanceof CommerceError) throw new HttpException('CHECKOUT_UNAVAILABLE', 404);
      throw error;
    }
  }
  @Post(':event')
  @HttpCode(200)
  async receive(
    @Param('event') event: string,
    @Req()
    request: {
      body: unknown;
      headers: Record<string, string | string[] | undefined>;
    },
  ) {
    const type = request.headers['content-type'];
    if (
      typeof type !== 'string' ||
      !/^application\/x-www-form-urlencoded(?:;|$)/i.test(type) ||
      !Buffer.isBuffer(request.body)
    )
      throw new HttpException('UNSUPPORTED_MEDIA_TYPE', 415);
    const signature = request.headers['content-hmac'];
    try {
      const receiver = event.startsWith('test-') ? this.testCheckout : this.receiver;
      return await receiver.receive(
        event.startsWith('test-') ? event.slice(5) : event,
        request.body,
        typeof signature === 'string' ? signature : undefined,
      );
    } catch (error) {
      if (error instanceof TipTopPayError) {
        const status = { DISABLED: 503, SIGNATURE: 401, INVALID: 400, MODE: 409, BINDING: 409 }[
          error.code
        ];
        throw new HttpException('PAYMENT_NOTIFICATION_REJECTED', status);
      }
      // Database failure must remain non-200 so the provider retries delivery.
      throw error;
    }
  }
}
