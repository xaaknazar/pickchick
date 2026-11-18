import type { ServerResponse } from 'node:http';
import {
  Controller,
  Get,
  Post,
  Param,
  Req,
  Res,
  Inject,
  HttpCode,
  HttpException,
} from '@nestjs/common';
import { RESOURCE, Resources } from '@pickchick/platform';
import {
  CommerceError,
  TipTopPayReceiver,
  TipTopPayError,
  TipTopPayTestCheckout,
  tipTopPayConfig,
  tipTopPay3dsHtml,
  tipTopPay3dsResultHtml,
  tipTopPayTestOptions,
} from '@pickchick/commerce-core';

function page(response: ServerResponse, html: string) {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.end(html);
}

@Controller('v1/integrations/tiptoppay')
export class TipTopPayController {
  private readonly receiver: TipTopPayReceiver;
  private readonly testCheckout: TipTopPayTestCheckout;
  constructor(@Inject(RESOURCE) resources: Resources) {
    this.receiver = new TipTopPayReceiver(resources.pool, tipTopPayConfig(process.env));
    this.testCheckout = new TipTopPayTestCheckout(
      resources.pool,
      tipTopPayTestOptions(process.env),
    );
  }

  /** 3-D Secure of a TEST card payment, opened by the app in the in-app browser. */
  @Get('test-3ds') threeDsPage(@Res() response: ServerResponse) {
    page(response, tipTopPay3dsHtml);
  }
  /** TermUrl: the bank posts MD and PaRes here; the server finishes the charge (post3ds). */
  @Post('test-3ds-return') @HttpCode(200) async threeDsReturn(
    @Req() request: { body: unknown },
    @Res() response: ServerResponse,
  ) {
    if (!Buffer.isBuffer(request.body)) throw new HttpException('INVALID_REQUEST', 400);
    const form = new URLSearchParams(request.body.toString('utf8'));
    let state: 'paid' | 'failed' | 'pending' = 'pending';
    try {
      state = await this.testCheckout.complete3ds(form.get('MD'), form.get('PaRes'));
    } catch (error) {
      if (!(error instanceof CommerceError)) throw error;
    }
    page(response, tipTopPay3dsResultHtml(state));
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
      // TEST terminal notifications are configured as test-check / test-pay / test-fail.
      const test = event.startsWith('test-');
      return await (test ? this.testCheckout : this.receiver).receive(
        test ? event.slice(5) : event,
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
