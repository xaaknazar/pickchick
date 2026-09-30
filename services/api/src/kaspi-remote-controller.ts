import { Controller, Post, Req, Inject, HttpCode, HttpException } from '@nestjs/common';
import { RESOURCE, Resources } from '@pickchick/platform';
import {
  KaspiRemoteError,
  hintKaspiInvoice,
  kaspiRemoteConfig,
  verifyKaspiBridgeWebhook,
} from '@pickchick/commerce-core';
import type { KaspiRemoteConfig } from '@pickchick/commerce-core';

/**
 * Signed notifications from the private local Kaspi bridge. They only schedule an
 * immediate status re-check by the worker; money is never recorded from this body.
 */
@Controller('v1/integrations/kaspi-remote')
export class KaspiRemoteController {
  private readonly config: KaspiRemoteConfig | null;
  constructor(@Inject(RESOURCE) private readonly resources: Resources) {
    this.config = kaspiRemoteConfig(process.env);
  }

  @Post('webhook')
  @HttpCode(200)
  async receive(
    @Req()
    request: {
      body: unknown;
      headers: Record<string, string | string[] | undefined>;
    },
  ) {
    if (!this.config) throw new HttpException('KASPI_REMOTE_DISABLED', 503);
    const type = request.headers['content-type'];
    if (
      typeof type !== 'string' ||
      !/^application\/json(?:;|$)/i.test(type) ||
      !Buffer.isBuffer(request.body)
    )
      throw new HttpException('UNSUPPORTED_MEDIA_TYPE', 415);
    const signature = request.headers['x-webhook-signature'];
    try {
      const { operationId } = verifyKaspiBridgeWebhook(
        request.body,
        typeof signature === 'string' ? signature : undefined,
        this.config.webhookSecret,
      );
      await hintKaspiInvoice(this.resources.pool, this.config.accountId, operationId);
      return { received: true };
    } catch (error) {
      if (error instanceof KaspiRemoteError)
        throw new HttpException(
          'KASPI_NOTIFICATION_REJECTED',
          error.code === 'SIGNATURE' ? 401 : 400,
        );
      throw error;
    }
  }
}
