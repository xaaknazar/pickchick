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
  UseFilters,
} from '@nestjs/common';
import { BackofficeError } from '@pickchick/backoffice-core';
import { DEVICE_REGISTRY, DeviceRegistry } from '@pickchick/backoffice-core/device-registry';
import {
  BackofficeReasonException,
  BackofficeReasonFilter,
  statuses,
} from './backoffice-controller.js';

/**
 * Branch device registry. Reads: any back-office grant; writes: branch manager only. A pairing
 * response carries the one-time kiosk login and password, so nothing here is cacheable.
 */
@Controller('v1/admin/backoffice/branches/:id/devices')
@UseFilters(BackofficeReasonFilter)
export class DeviceRegistryController {
  constructor(@Inject(DEVICE_REGISTRY) private readonly service: DeviceRegistry) {}
  private token(auth?: string) {
    return auth?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
  }
  private async run<T>(fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BackofficeError) {
        if (e.reason) throw new BackofficeReasonException(e.code, e.reason);
        throw new HttpException({ code: e.code }, statuses[e.code]);
      }
      throw e;
    }
  }
  @Get() @Header('Cache-Control', 'no-store') list(
    @Param('id') id: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.service.list(this.token(auth), id));
  }
  @Get(':deviceId/events') @Header('Cache-Control', 'no-store') events(
    @Param('id') id: string,
    @Param('deviceId') deviceId: string,
    @Headers('authorization') auth?: string,
    @Query() query?: unknown,
  ) {
    return this.run(() => this.service.events(this.token(auth), id, deviceId, query ?? {}));
  }
  @Post() @HttpCode(200) @Header('Cache-Control', 'no-store') create(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.service.create(this.token(auth), id, body));
  }
  @Post(':deviceId/pairing-codes') @HttpCode(200) @Header('Cache-Control', 'no-store') issue(
    @Param('id') id: string,
    @Param('deviceId') deviceId: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.service.issueCode(this.token(auth), id, deviceId, body));
  }
  @Post(':deviceId/pairing-codes/:codeId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  cancel(
    @Param('id') id: string,
    @Param('deviceId') deviceId: string,
    @Param('codeId') codeId: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.service.cancelCode(this.token(auth), id, deviceId, codeId, body));
  }
  @Post(':deviceId/revoke') @HttpCode(200) @Header('Cache-Control', 'no-store') revoke(
    @Param('id') id: string,
    @Param('deviceId') deviceId: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.service.revoke(this.token(auth), id, deviceId, body));
  }
  @Post(':deviceId/rename') @HttpCode(200) @Header('Cache-Control', 'no-store') rename(
    @Param('id') id: string,
    @Param('deviceId') deviceId: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.service.rename(this.token(auth), id, deviceId, body));
  }
}
