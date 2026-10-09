import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Post,
} from '@nestjs/common';
import { RESOURCE, Resources } from '@pickchick/platform';
import {
  edgeDeviceAccessEnabled,
  OrderError,
  orderErrorStatus,
  TerminalAccess,
  TerminalRateLimitError,
} from '@pickchick/local-orders';

@Controller('edge/v1/terminals')
export class TerminalAccessController {
  constructor(@Inject(RESOURCE) private readonly resources: Resources) {}
  private async run<T>(operation: (access: TerminalAccess) => Promise<T>) {
    if (!edgeDeviceAccessEnabled()) throw new HttpException({ code: 'NOT_FOUND' }, 404);
    try {
      if (!this.resources.config.edgeFulfillmentEnabled || !this.resources.config.edgeDeviceId)
        throw new Error('Missing terminal binding');
      return await operation(
        new TerminalAccess(
          this.resources.pool,
          this.resources.config.branchId!,
          this.resources.config.edgeDeviceId,
        ),
      );
    } catch (error) {
      if (error instanceof TerminalRateLimitError)
        throw new HttpException({ code: 'AUTH_RATE_LIMITED' }, 429);
      if (error instanceof OrderError)
        throw new HttpException({ code: error.code }, orderErrorStatus[error.code]);
      // Driver/schema errors must never log pairing material.
      throw new HttpException({ code: 'SERVICE_UNAVAILABLE' }, 503);
    }
  }
  @Post('pair')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  pair(@Body() body: unknown) {
    return this.run((access) => access.pair(body));
  }
  @Get('session')
  @Header('Cache-Control', 'no-store')
  session(@Headers('x-terminal-id') id?: string, @Headers('x-terminal-key') key?: string) {
    return this.run((access) => access.session({ id: id ?? '', key: key ?? '' }));
  }
}
