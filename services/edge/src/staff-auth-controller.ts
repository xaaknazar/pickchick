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
  ApprovalPinError,
  KitchenPasswordReset,
  requestManagerApproval,
  TerminalRateLimitError,
  edgeDeviceAccessEnabled,
  loginStaff,
  loginStaffPin,
  logoutStaff,
  OrderError,
  StaffRateLimitError,
  orderErrorStatus,
  pinBackoffStatus,
} from '@pickchick/local-orders';
import { UuidSchema } from '@pickchick/contracts';

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
        response.setHeader('Retry-After', String(error.retryAfterSeconds));
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
        response.setHeader('Retry-After', String(error.retryAfterSeconds));
        throw new HttpException({ code: 'AUTH_RATE_LIMITED' }, 429);
      }
      if (error instanceof OrderError) {
        if (error.code === 'UNAUTHORIZED') this.logPinFailure(body);
        throw new HttpException({ code: error.code }, orderErrorStatus[error.code]);
      }
      throw new HttpException({ code: 'SERVICE_UNAVAILABLE' }, 503);
    }
  }

  /** Failed PIN attempts on a known terminal, for the operator log: never the PIN or a staff id. */
  private logPinFailure(body: unknown, event = 'staff_pin_failed') {
    const terminal = (body as { terminal_id?: unknown } | null)?.terminal_id;
    if (typeof terminal !== 'string' || !UuidSchema.safeParse(terminal).success) return;
    const status = pinBackoffStatus(this.resources.config.branchId!, terminal);
    if (!status.failures) return;
    console.warn(
      JSON.stringify({
        event,
        terminal_id: terminal.toLowerCase(),
        failures: status.failures,
        locked_seconds: status.lockedSeconds,
      }),
    );
  }

  /**
   * Cutover (contracts 5.1, R13): one-time shift manager approval typed on the cashier's desk.
   * The desk is the session's terminal; wrong PINs share the staff/pin backoff of that desk.
   */
  @Post('approvals')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  async approval(
    @Body() body: unknown,
    @Headers() headers: Record<string, string | undefined>,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void },
  ) {
    try {
      return await requestManagerApproval(
        this.resources.pool,
        this.resources.config.branchId!,
        {
          sessionId: headers['x-staff-session-id'] ?? '',
          token: headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '',
        },
        body,
      );
    } catch (error) {
      if (error instanceof StaffRateLimitError) {
        response.setHeader('Retry-After', String(error.retryAfterSeconds));
        throw new HttpException({ code: 'AUTH_RATE_LIMITED' }, 429);
      }
      if (error instanceof ApprovalPinError)
        this.logPinFailure({ terminal_id: error.terminalId }, 'staff_approval_pin_failed');
      if (error instanceof OrderError)
        throw new HttpException({ code: error.code }, orderErrorStatus[error.code]);
      // PIN input/driver errors must never become exception logs with a PIN or token.
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
