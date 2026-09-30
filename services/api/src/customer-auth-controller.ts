import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Ip,
  Patch,
  Post,
} from '@nestjs/common';
import {
  CUSTOMER_IDENTITY,
  CustomerIdentity,
  CustomerIdentityError,
} from '@pickchick/customer-identity';

/** Register with { provide: CUSTOMER_IDENTITY, useFactory: ... }. The domain is disabled by default. */
@Controller('v1')
export class CustomerAuthController {
  constructor(@Inject(CUSTOMER_IDENTITY) private readonly identity: CustomerIdentity) {}
  private token(value?: string) {
    return value?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
  }
  private async execute<T>(run: () => T | Promise<T>) {
    try {
      return await run();
    } catch (error) {
      if (error instanceof CustomerIdentityError) {
        const status = {
          INVALID_REQUEST: 400,
          UNAUTHORIZED: 401,
          CONFLICT: 409,
          RATE_LIMITED: 429,
          SERVICE_UNAVAILABLE: 503,
        };
        throw new HttpException({ code: error.code }, status[error.code]);
      }
      throw error;
    }
  }
  @Get('auth/config') config() {
    return this.identity.config();
  }
  @Post('auth/otp/request') @HttpCode(202) requestOtp(@Body() body: unknown, @Ip() ip: string) {
    // Express trust-proxy must be restricted by the host to known proxy hops; no raw X-Forwarded-For parsing.
    return this.execute(() => this.identity.requestOtp(body, ip));
  }
  @Post('auth/otp/verify') @HttpCode(200) verifyOtp(@Body() body: unknown) {
    return this.execute(() => this.identity.verifyOtp(body));
  }
  @Post('auth/refresh') @HttpCode(200) refresh(@Body() body: unknown) {
    return this.execute(() => this.identity.refresh(body));
  }
  @Post('auth/logout') @HttpCode(200) logout(@Headers('authorization') token?: string) {
    return this.execute(() => this.identity.logout(this.token(token)));
  }
  @Get('customers/me') me(@Headers('authorization') token?: string) {
    return this.execute(() => this.identity.me(this.token(token)));
  }
  @Patch('customers/me') patch(@Body() body: unknown, @Headers('authorization') token?: string) {
    return this.execute(() => this.identity.patchMe(this.token(token), body));
  }
  @Delete('customers/me') remove(@Headers('authorization') token?: string) {
    return this.execute(() => this.identity.deleteMe(this.token(token)));
  }
}
