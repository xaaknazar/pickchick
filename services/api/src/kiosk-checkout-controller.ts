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
import { RESOURCE, Resources } from '@pickchick/platform';
import {
  AVAILABILITY_SIGNATURE_HEADER,
  AvailabilityAfterSchema,
  AvailabilityError,
  CATALOG_VERSION_HEADER,
  CommerceError,
  pollAvailability,
  KioskCheckout,
  KioskSessions,
  KioskEnrollment,
  kioskEnrollmentKey,
  kioskCheckoutOptions,
  kioskPiiKey,
} from '@pickchick/commerce-core';
import type { KioskGuest } from '@pickchick/commerce-core';
import { catalogMediaOptions } from '@pickchick/catalog-admin';

@Controller('v1/kiosk-checkout')
export class KioskCheckoutController {
  private readonly enrollment: KioskEnrollment | null;
  private readonly sessions: KioskSessions | null;
  private readonly checkout: KioskCheckout | null;
  private readonly mediaEnabled = catalogMediaOptions(process.env).mediaEnabled;
  constructor(@Inject(RESOURCE) resources: Resources) {
    const options = kioskCheckoutOptions(process.env),
      key = kioskPiiKey(process.env);
    if (options && !key) throw new Error('KIOSK_CHECKOUT_PII_KEY required');
    const enrollmentKey = kioskEnrollmentKey(process.env);
    this.enrollment =
      options && enrollmentKey
        ? new KioskEnrollment(resources.pool, {
            encryptionKey: enrollmentKey,
            organizationId: options.organizationId,
            branchId: options.branchId,
          })
        : null;
    this.sessions = options && key ? new KioskSessions(resources.pool, { piiKey: key }) : null;
    this.checkout = this.sessions
      ? new KioskCheckout(resources.pool, options, this.sessions)
      : null;
  }
  private async execute<T>(response: ServerResponse, run: () => Promise<T>) {
    response.setHeader('Cache-Control', 'no-store');
    if (!this.checkout || !this.sessions) throw new HttpException({ code: 'NOT_READY' }, 503);
    try {
      return await run();
    } catch (error) {
      if (error instanceof AvailabilityError)
        throw new HttpException({ code: error.code }, error.code === 'ITEM_STOPPED' ? 409 : 503);
      if (error instanceof CommerceError) {
        const codes = {
          INVALID: 400,
          FORBIDDEN: 403,
          NOT_FOUND: 404,
          CONFLICT: 409,
          EXPIRED: 409,
          NOT_READY: 503,
          REFUND_LIMIT: 409,
          RESTAURANT_CLOSED: 409,
          CATALOG_UPGRADE_REQUIRED: 409,
        };
        throw new HttpException({ code: error.code }, codes[error.code]);
      }
      throw error;
    }
  }
  private async guest(
    device?: string,
    key?: string,
    authorization?: string,
    allowExpired = false,
  ): Promise<KioskGuest> {
    return this.sessions!.authenticate(
      device ?? '',
      key ?? '',
      authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '',
      { allowExpired },
    );
  }
  @Post('enrollment/exchange') @HttpCode(200) enrollmentExchange(
    @Res({ passthrough: true }) res: ServerResponse,
    @Body() body: unknown,
  ) {
    return this.execute(res, async () => {
      if (!this.enrollment) throw new CommerceError('FORBIDDEN');
      return this.enrollment.exchange(body);
    });
  }
  @Post('enrollment/check') @HttpCode(200) enrollmentCheck(
    @Res({ passthrough: true }) res: ServerResponse,
    @Headers('x-kiosk-device') device?: string,
    @Headers('x-kiosk-key') key?: string,
  ) {
    return this.execute(res, async () => {
      const enrolled = await this.sessions!.validateDevice(device ?? '', key ?? '');
      // Config checks the deployment branch; this read does not allocate a guest session.
      // Ordering and kitchen readiness do not prevent enrolling an authorized device.
      const config = await this.checkout!.config({ ...enrolled, sessionId: enrolled.deviceId });
      return { valid: true, branchId: config.branchId, restaurant: config.restaurant };
    });
  }
  @Post('sessions') @HttpCode(200) start(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: ServerResponse,
    @Headers('x-kiosk-device') device?: string,
    @Headers('x-kiosk-key') key?: string,
  ) {
    return this.execute(res, async () => {
      const session = await this.sessions!.start(device ?? '', key ?? '', body);
      // A device from a different branch never gains access to this checkout deployment.
      await this.checkout!.config({ ...session, deviceId: device! });
      return session;
    });
  }
  @Post('sessions/end') @HttpCode(200) end(
    @Res({ passthrough: true }) res: ServerResponse,
    @Headers('x-kiosk-device') device?: string,
    @Headers('x-kiosk-key') key?: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.execute(res, async () => {
      const guest = await this.sessions!.authenticate(
        device ?? '',
        key ?? '',
        auth?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '',
        { allowEnded: true },
      );
      await this.sessions!.end(guest.sessionId);
      return { ended: true };
    });
  }
  @Get('catalog') catalog(
    @Res({ passthrough: true }) res: ServerResponse,
    @Headers('x-kiosk-device') device?: string,
    @Headers('x-kiosk-key') key?: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.execute(res, async () =>
      this.checkout!.catalog(await this.guest(device, key, auth)),
    );
  }
  /** Photo map for new kiosk builds; `version` must equal the head catalog version. */
  @Get('catalog/media') catalogMedia(
    @Res({ passthrough: true }) res: ServerResponse,
    @Query('version') version?: unknown,
    @Headers('x-kiosk-device') device?: string,
    @Headers('x-kiosk-key') key?: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.execute(res, async () =>
      this.checkout!.catalogMedia(await this.guest(device, key, auth), version, {
        mediaEnabled: this.mediaEnabled,
      }),
    );
  }
  /**
   * Without `after` this is the same single read as before. With `after` (the previous
   * X-Availability-Signature) it waits, re-reading every second for up to 25 s, until stops,
   * freshness or the head catalog version change. The body shape never changes.
   */
  @Get('availability') availability(
    @Res({ passthrough: true }) res: ServerResponse,
    @Query('after') after?: unknown,
    @Headers('x-kiosk-device') device?: string,
    @Headers('x-kiosk-key') key?: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.execute(res, async () => {
      if (after !== undefined && !AvailabilityAfterSchema.safeParse(after).success)
        throw new CommerceError('INVALID');
      const guest = await this.guest(device, key, auth);
      const state = await pollAvailability(
        () => this.checkout!.availabilityState(guest),
        after as string | undefined,
        { cancelled: () => res.destroyed },
      );
      res.setHeader(CATALOG_VERSION_HEADER, String(state.catalogVersion));
      res.setHeader(AVAILABILITY_SIGNATURE_HEADER, state.signature);
      return state.body;
    });
  }
  @Get('config') config(
    @Res({ passthrough: true }) res: ServerResponse,
    @Headers('x-kiosk-device') device?: string,
    @Headers('x-kiosk-key') key?: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.execute(res, async () =>
      this.checkout!.config(await this.guest(device, key, auth)),
    );
  }
  @Post('quotes') @HttpCode(200) quote(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: ServerResponse,
    @Headers('x-kiosk-device') device?: string,
    @Headers('x-kiosk-key') key?: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.execute(res, async () =>
      this.checkout!.quote(await this.guest(device, key, auth), body),
    );
  }
  @Post('orders') @HttpCode(200) create(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: ServerResponse,
    @Headers('x-kiosk-device') device?: string,
    @Headers('x-kiosk-key') key?: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.execute(res, async () =>
      this.checkout!.create(await this.guest(device, key, auth, true), body),
    );
  }
  @Post('orders/:id/payment') @HttpCode(200) pay(
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: ServerResponse,
    @Headers('x-kiosk-device') device?: string,
    @Headers('x-kiosk-key') key?: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.execute(res, async () =>
      this.checkout!.pay(await this.guest(device, key, auth, true), id, body),
    );
  }
  @Get('orders/:id') read(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: ServerResponse,
    @Headers('x-kiosk-device') device?: string,
    @Headers('x-kiosk-key') key?: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.execute(res, async () =>
      this.checkout!.read(await this.guest(device, key, auth, true), id),
    );
  }
}
