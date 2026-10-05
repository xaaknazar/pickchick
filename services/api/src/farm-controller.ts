import {
  type ArgumentsHost,
  Catch,
  UseFilters,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  CUSTOMER_IDENTITY,
  CustomerIdentity,
  CustomerIdentityError,
} from '@pickchick/customer-identity';
import { FARM, FarmPersistence, FarmPersistenceError } from '@pickchick/farm-persistence';
@Catch(HttpException)
class FarmExceptionFilter {
  catch(error: HttpException, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    response.setHeader('Cache-Control', 'no-store');
    response.status(error.getStatus()).json(error.getResponse());
  }
}
@Controller('v1/customer-farm')
@UseFilters(FarmExceptionFilter)
export class FarmController {
  constructor(
    @Inject(CUSTOMER_IDENTITY) private readonly identity: CustomerIdentity,
    @Inject(FARM) private readonly farm: FarmPersistence,
  ) {}
  private async execute(
    authorization: string | undefined,
    response: { setHeader(name: string, value: string): unknown },
    protocol: string | undefined,
    input?: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    try {
      if (process.env.FARM_ENABLED !== '1') throw new FarmPersistenceError('FARM_UNAVAILABLE');
      const token = authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
      const { customer } = await this.identity.me(token);
      // Old clients parse a strict state schema. Reject before lazy creation/migration.
      if (protocol !== '2')
        throw new HttpException(
          {
            code: 'FARM_UNAVAILABLE',
            minimumProtocol: 2,
            message: 'Обновите PickChick, чтобы продолжить игру в ферму.',
          },
          503,
        );
      return input === undefined
        ? await this.farm.get(customer.id)
        : await this.farm.command(customer.id, input);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof FarmPersistenceError) {
        const status =
          error.code === 'FARM_UNAVAILABLE'
            ? 503
            : error.code === 'UNAUTHORIZED'
              ? 401
              : ['STALE_STATE', 'COMMAND_ID_CONFLICT'].includes(error.code)
                ? 409
                : ['COMMAND_LIMIT', 'RATE_LIMITED'].includes(error.code)
                  ? 429
                  : 400;
        throw new HttpException(
          { code: error.code, ...(error.state ? { state: error.state } : {}) },
          status,
        );
      }
      if (error instanceof CustomerIdentityError)
        throw new HttpException(
          { code: error.code },
          error.code === 'UNAUTHORIZED' ? 401 : error.code === 'SERVICE_UNAVAILABLE' ? 503 : 400,
        );
      throw new HttpException({ code: 'FARM_UNAVAILABLE' }, 503);
    }
  }
  @Get() get(
    @Headers('authorization') auth: string | undefined,
    @Query('protocol') protocol: string | undefined,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): unknown },
  ) {
    return this.execute(auth, response, protocol);
  }
  @Post('commands') @HttpCode(200) command(
    @Headers('authorization') auth: string | undefined,
    @Query('protocol') protocol: string | undefined,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): unknown },
    @Body() input: unknown,
  ) {
    return this.execute(auth, response, protocol, input ?? null);
  }
}
