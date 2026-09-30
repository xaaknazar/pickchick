import { Controller, Post, Param, Req, Inject, HttpCode, HttpException } from '@nestjs/common';
import { RESOURCE, Resources } from '@pickchick/platform';
import { TipTopPayReceiver, TipTopPayError, tipTopPayConfig } from '@pickchick/commerce-core';

@Controller('v1/integrations/tiptoppay')
export class TipTopPayController {
  private readonly receiver: TipTopPayReceiver;
  constructor(@Inject(RESOURCE) resources: Resources) {
    this.receiver = new TipTopPayReceiver(resources.pool, tipTopPayConfig(process.env));
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
      return await this.receiver.receive(
        event,
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
