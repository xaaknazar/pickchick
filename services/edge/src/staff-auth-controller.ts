import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Res,
} from '@nestjs/common';
import { RESOURCE, Resources } from '@pickchick/platform';
import {
  KitchenPasswordReset,
  TerminalRateLimitError,
  edgeDeviceAccessEnabled,
  loginStaff,
  loginStaffPin,
  logoutStaff,
  OrderError,
  StaffRateLimitError,
  orderErrorStatus,
} from '@pickchick/local-orders';

@Controller('edge/v1/staff')
export class StaffAuthController {
  constructor(@Inject(RESOURCE) private readonly resources: Resources) {}

  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async login(
    @Body() body: unknown,
    @Headers() headers: Record<string, string | undefined>,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void },
  ) {
    try {
      return await loginStaff(this.resources.pool, this.resources.config.branchId!, body, false, {
        id: headers['x-terminal-id'] ?? '',
        key: headers['x-terminal-key'] ?? '',
      });
    } catch (error) {
      if (error instanceof StaffRateLimitError) {
        response.setHeader('Retry-After', '60');
        throw new HttpException({ code: 'AUTH_RATE_LIMITED' }, 429);
      }
      if (error instanceof OrderError)
        throw new HttpException({ code: error.code }, orderErrorStatus[error.code]);
      // Login input/driver errors must never become exception logs with a password/token.
      throw new HttpException({ code: 'SERVICE_UNAVAILABLE' }, 503);
    }
  }

  @Post('pin')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async pin(
    @Body() body: unknown,
    @Headers() headers: Record<string, string | undefined>,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void },
  ) {
    try {
      return await loginStaffPin(this.resources.pool, this.resources.config.branchId!, body, {
        id: headers['x-terminal-id'] ?? '',
        key: headers['x-terminal-key'] ?? '',
      });
    } catch (error) {
      if (error instanceof StaffRateLimitError) {
        response.setHeader('Retry-After', '60');
        throw new HttpException({ code: 'AUTH_RATE_LIMITED' }, 429);
      }
      if (error instanceof OrderError)
        throw new HttpException({ code: error.code }, orderErrorStatus[error.code]);
      throw new HttpException({ code: 'SERVICE_UNAVAILABLE' }, 503);
    }
  }

  @Post('password-reset')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async reset(@Body() body: unknown, @Headers() headers: Record<string, string | undefined>) {
    if (!edgeDeviceAccessEnabled()) throw new HttpException({ code: 'NOT_FOUND' }, 404);
    try {
      if (!this.resources.config.edgeFulfillmentEnabled || !this.resources.config.edgeDeviceId)
        throw new Error('Missing device binding');
      return await new KitchenPasswordReset(
        this.resources.pool,
        this.resources.config.branchId!,
        this.resources.config.edgeDeviceId,
      ).reset(body, { id: headers['x-terminal-id'] ?? '', key: headers['x-terminal-key'] ?? '' });
    } catch (error) {
      if (error instanceof TerminalRateLimitError)
        throw new HttpException({ code: 'AUTH_RATE_LIMITED' }, 429);
      if (error instanceof OrderError)
        throw new HttpException({ code: error.code }, orderErrorStatus[error.code]);
      throw new HttpException({ code: 'SERVICE_UNAVAILABLE' }, 503);
    }
  }

  @Post('logout')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  async logout(@Headers() headers: Record<string, string | undefined>) {
    try {
      await logoutStaff(this.resources.pool, this.resources.config.branchId!, {
        sessionId: headers['x-staff-session-id'] ?? '',
        token: headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '',
        ...(headers['x-terminal-key']
          ? { terminal: { id: headers['x-terminal-id'] ?? '', key: headers['x-terminal-key'] } }
          : {}),
      });
    } catch (error) {
      if (error instanceof OrderError)
        throw new HttpException({ code: error.code }, orderErrorStatus[error.code]);
      throw new HttpException({ code: 'SERVICE_UNAVAILABLE' }, 503);
    }
  }
}
