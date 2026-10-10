import {
  Body,
  Controller,
  Req,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import type { Provider, Type } from '@nestjs/common';

/**
 * Cloud kitchen feed and commands for kiosk/mobile orders (ADR-0014, stages S2 and S4).
 *
 * Disabled by default: unless CLOUD_KITCHEN_API_ENABLED=1 every route answers 404, exactly as if
 * the controller were absent. The intended caller is the existing kitchen portal server
 * (infra/kitchen-portal, /kitchen-live/{prep,assembly,display}) on the same VPS, acting for its
 * already-authenticated portal session: it holds one internal service credential per branch and
 * role (a cloud 056 "screen" row: branch, role, stations, generation, revocable) and sends it as
 * `Authorization: Bearer pcks_...`. The credential is obtained once with a one-time pairing code
 * (owner operator or back office). Internal-only by default: requests relayed by the public
 * gateway (forwarding headers) are 404. No device registry (051) and no cashier are involved.
 * prep/assembly credentials read the feed and send commands for their stations; a display
 * credential only reads the customer display. Every feed poll is the station heartbeat of the
 * KITCHEN_OFFLINE gate.
 */
export interface KitchenActor {
  branchId: string;
  deviceId: string;
  stationIds: string[];
  manager: boolean;
}
export interface AuthenticatedScreen {
  screenId: string;
  branchId: string;
  role: 'prep' | 'assembly' | 'display';
  generation: number;
  actor: KitchenActor;
}
/** Structural port implemented by `CloudKitchen` from @pickchick/cloud-kitchen. */
export interface CloudKitchenPort {
  listStations(actor: KitchenActor): Promise<unknown>;
  listKitchen(actor: KitchenActor, input: unknown): Promise<unknown>;
  readDisplay(actor: KitchenActor, input: unknown): Promise<unknown>;
  readOrder(actor: KitchenActor, orderId: string, input: unknown): Promise<unknown>;
  act(actor: KitchenActor, idempotencyKey: unknown, input: unknown): Promise<unknown>;
  admitPendingPaid(branchId: string): Promise<unknown>;
}
/** Structural port implemented by `KitchenScreens` from @pickchick/cloud-kitchen. */
export interface KitchenScreenAuthPort {
  authenticate(key: unknown, options: { heartbeat?: boolean }): Promise<AuthenticatedScreen>;
  exchange(input: unknown): Promise<unknown>;
}
export interface CloudKitchenOptions {
  enabled: boolean;
  /** Default true: only private-network callers (the kitchen portal server on the same VPS).
   * A request relayed by the public gateway carries forwarding headers and is answered 404. */
  internalOnly?: boolean;
}
export const CLOUD_KITCHEN = Symbol('CLOUD_KITCHEN');
export const CLOUD_KITCHEN_SCREENS = Symbol('CLOUD_KITCHEN_SCREENS');
export const CLOUD_KITCHEN_OPTIONS = Symbol('CLOUD_KITCHEN_OPTIONS');

/** Flags from the environment: exactly '1' turns the API on; it stays internal-only unless
 * CLOUD_KITCHEN_PUBLIC=1 (direct screens through the gateway, not used by the portal). */
export function cloudKitchenOptions(env: Record<string, string | undefined>): CloudKitchenOptions {
  return {
    enabled: env.CLOUD_KITCHEN_API_ENABLED === '1',
    internalOnly: env.CLOUD_KITCHEN_PUBLIC !== '1',
  };
}
const FORWARDED = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip'];
/** Request headers as Nest passes them; used only for the internal-only check. */
type Incoming = { headers: Record<string, string | string[] | undefined> };

const STATUS: Record<string, number> = {
  INVALID: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  NOT_READY: 409,
  ROUTING_MISSING: 409,
};
type Access = 'any' | 'station' | 'feed';

/** Query strings carry numbers as text; only plain small integers are converted. */
function numeric(query: Record<string, unknown>, keys: string[]) {
  const out: Record<string, unknown> = { ...query };
  for (const key of keys)
    if (typeof out[key] === 'string' && /^[0-9]{1,4}$/.test(out[key] as string))
      out[key] = Number(out[key]);
  return out;
}
const bearer = (header: string | undefined) => header?.match(/^Bearer (\S{1,200})$/)?.[1];

@Controller('v1/kitchen')
export class CloudKitchenController {
  constructor(
    @Inject(CLOUD_KITCHEN) private readonly kitchen: CloudKitchenPort,
    @Inject(CLOUD_KITCHEN_SCREENS) private readonly screens: KitchenScreenAuthPort,
    @Inject(CLOUD_KITCHEN_OPTIONS) private readonly options: CloudKitchenOptions,
  ) {}
  private mapped(e: unknown): never {
    const code = (e as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && code in STATUS)
      throw new HttpException({ code }, STATUS[code]!);
    throw e;
  }
  private open(request: Incoming) {
    if (!this.options.enabled) throw new NotFoundException();
    if (
      this.options.internalOnly !== false &&
      FORWARDED.some((h) => request.headers[h] !== undefined)
    )
      throw new NotFoundException();
  }
  private async run<T>(
    request: Incoming,
    access: Access,
    fn: (actor: KitchenActor, screen: AuthenticatedScreen) => Promise<T>,
  ) {
    this.open(request);
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' && authorization !== undefined)
      throw new UnauthorizedException({ code: 'UNAUTHORIZED' });
    let screen: AuthenticatedScreen;
    try {
      screen = await this.screens.authenticate(bearer(authorization), {
        heartbeat: access === 'feed',
      });
    } catch {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED' });
    }
    if (access !== 'any' && screen.role === 'display')
      throw new ForbiddenException({ code: 'FORBIDDEN' });
    try {
      return await fn(screen.actor, screen);
    } catch (e) {
      this.mapped(e);
    }
  }
  /** One-time pairing code -> screen key (shown once). Every failure is the same 401. */
  @Post('pairing') @HttpCode(200) async pair(@Body() body: unknown, @Req() request: Incoming) {
    this.open(request);
    try {
      return await this.screens.exchange(body);
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === 'FORBIDDEN')
        throw new UnauthorizedException({ code: 'UNAUTHORIZED' });
      this.mapped(e);
    }
  }
  /** The screen itself: role, stations and generation of its key. */
  @Get('me') me(@Req() request: Incoming) {
    return this.run(request, 'any', async (actor, screen) => ({
      screenId: screen.screenId,
      branchId: screen.branchId,
      role: screen.role,
      stationIds: actor.stationIds,
      generation: screen.generation,
    }));
  }
  @Get('stations') stations(@Req() request: Incoming) {
    return this.run(request, 'any', (a) => this.kitchen.listStations(a));
  }
  @Get('kitchen') feed(@Query() query: Record<string, unknown>, @Req() request: Incoming) {
    return this.run(request, 'feed', async (a) => {
      // Catch-up admission of paid cloud orders captured by processes without the hook.
      await this.kitchen.admitPendingPaid(a.branchId);
      return this.kitchen.listKitchen(a, numeric(query, ['limit']));
    });
  }
  @Get('display') display(@Query() query: Record<string, unknown>, @Req() request: Incoming) {
    return this.run(request, 'any', (a) =>
      this.kitchen.readDisplay(a, numeric(query, ['limit', 'afterNumber'])),
    );
  }
  @Get('orders/:orderId') order(
    @Param('orderId') orderId: string,
    @Query() query: Record<string, unknown>,
    @Req() request: Incoming,
  ) {
    return this.run(request, 'station', (a) => this.kitchen.readOrder(a, orderId, { ...query }));
  }
  @Post('commands') @HttpCode(200) command(
    @Body() body: unknown,
    @Req() request: Incoming,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.run(request, 'station', (a) => this.kitchen.act(a, key, body));
  }
}

/** Standalone module for tests; createApi registers the controller behind the same flag. */
export function cloudKitchenModule(providers: Provider[]): Type<unknown> {
  @Module({ controllers: [CloudKitchenController], providers })
  class CloudKitchenModule {}
  return CloudKitchenModule;
}
