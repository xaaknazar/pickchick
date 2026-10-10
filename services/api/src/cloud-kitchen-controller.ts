import {
  Body,
  Controller,
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
 * Cloud kitchen feed and commands for kiosk/mobile orders (ADR-0014, stage S2).
 *
 * Disabled by default: unless CLOUD_KITCHEN_API_ENABLED=1 every route answers 404, exactly as if
 * the controller were absent. Real device authentication (revocable kitchen device credential
 * from the back office) is a later stage; until then the only way to obtain an actor is the
 * test hook, which additionally needs CLOUD_KITCHEN_TEST_AUTH=1 and is refused in staging.
 * Neither variable is set in any staging compose file. Not registered in createApi yet.
 */
export interface KitchenActor {
  branchId: string;
  deviceId: string;
  stationIds: string[];
  manager: boolean;
}
/** Structural port implemented by `CloudKitchen` from @pickchick/cloud-kitchen. */
export interface CloudKitchenPort {
  listStations(actor: KitchenActor): Promise<unknown>;
  listKitchen(actor: KitchenActor, input: unknown): Promise<unknown>;
  readDisplay(actor: KitchenActor, input: unknown): Promise<unknown>;
  readOrder(actor: KitchenActor, orderId: string, input: unknown): Promise<unknown>;
  act(actor: KitchenActor, idempotencyKey: unknown, input: unknown): Promise<unknown>;
}
export interface CloudKitchenOptions {
  enabled: boolean;
  testAuth: boolean;
}
export const CLOUD_KITCHEN = Symbol('CLOUD_KITCHEN');
export const CLOUD_KITCHEN_OPTIONS = Symbol('CLOUD_KITCHEN_OPTIONS');
export const TEST_ACTOR_HEADER = 'x-pickchick-test-kitchen-actor';

/** Flags from the environment. The test hook never turns on in staging, whatever is set. */
export function cloudKitchenOptions(
  env: Record<string, string | undefined>,
  environment: 'local' | 'test' | 'staging',
): CloudKitchenOptions {
  const enabled = env.CLOUD_KITCHEN_API_ENABLED === '1';
  return {
    enabled,
    testAuth: enabled && environment !== 'staging' && env.CLOUD_KITCHEN_TEST_AUTH === '1',
  };
}

const STATUS: Record<string, number> = {
  INVALID: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  NOT_READY: 409,
  ROUTING_MISSING: 409,
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function testActor(header: string | undefined): KitchenActor {
  if (!header || header.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(header))
    throw new UnauthorizedException({ code: 'UNAUTHORIZED' });
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  } catch {
    throw new UnauthorizedException({ code: 'UNAUTHORIZED' });
  }
  const actor = value as Partial<KitchenActor> | null;
  if (
    !actor ||
    typeof actor !== 'object' ||
    Object.keys(actor).sort().join() !== 'branchId,deviceId,manager,stationIds' ||
    typeof actor.branchId !== 'string' ||
    !uuid.test(actor.branchId) ||
    typeof actor.deviceId !== 'string' ||
    !uuid.test(actor.deviceId) ||
    typeof actor.manager !== 'boolean' ||
    !Array.isArray(actor.stationIds) ||
    actor.stationIds.length > 100 ||
    !actor.stationIds.every((id) => typeof id === 'string' && uuid.test(id))
  )
    throw new UnauthorizedException({ code: 'UNAUTHORIZED' });
  return actor as KitchenActor;
}
/** Query strings carry numbers as text; only plain small integers are converted. */
function numeric(query: Record<string, unknown>, keys: string[]) {
  const out: Record<string, unknown> = { ...query };
  for (const key of keys)
    if (typeof out[key] === 'string' && /^[0-9]{1,4}$/.test(out[key] as string))
      out[key] = Number(out[key]);
  return out;
}

@Controller('v1/kitchen')
export class CloudKitchenController {
  constructor(
    @Inject(CLOUD_KITCHEN) private readonly kitchen: CloudKitchenPort,
    @Inject(CLOUD_KITCHEN_OPTIONS) private readonly options: CloudKitchenOptions,
  ) {}
  private async run<T>(actorHeader: string | undefined, fn: (actor: KitchenActor) => Promise<T>) {
    if (!this.options.enabled) throw new NotFoundException();
    // No production device authentication exists yet (later stage): without the test hook the
    // enabled API still refuses every caller.
    if (!this.options.testAuth) throw new UnauthorizedException({ code: 'UNAUTHORIZED' });
    const actor = testActor(actorHeader);
    try {
      return await fn(actor);
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      if (typeof code === 'string' && code in STATUS)
        throw new HttpException({ code }, STATUS[code]!);
      throw e;
    }
  }
  @Get('stations') stations(@Headers(TEST_ACTOR_HEADER) actor?: string) {
    return this.run(actor, (a) => this.kitchen.listStations(a));
  }
  @Get('kitchen') feed(
    @Query() query: Record<string, unknown>,
    @Headers(TEST_ACTOR_HEADER) actor?: string,
  ) {
    return this.run(actor, (a) => this.kitchen.listKitchen(a, numeric(query, ['limit'])));
  }
  @Get('display') display(
    @Query() query: Record<string, unknown>,
    @Headers(TEST_ACTOR_HEADER) actor?: string,
  ) {
    return this.run(actor, (a) =>
      this.kitchen.readDisplay(a, numeric(query, ['limit', 'afterNumber'])),
    );
  }
  @Get('orders/:orderId') order(
    @Param('orderId') orderId: string,
    @Query() query: Record<string, unknown>,
    @Headers(TEST_ACTOR_HEADER) actor?: string,
  ) {
    return this.run(actor, (a) => this.kitchen.readOrder(a, orderId, { ...query }));
  }
  @Post('commands') @HttpCode(200) command(
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
    @Headers(TEST_ACTOR_HEADER) actor?: string,
  ) {
    return this.run(actor, (a) => this.kitchen.act(a, key, body));
  }
}

/** Standalone module for tests and for the later createApi wiring. */
export function cloudKitchenModule(providers: Provider[]): Type<unknown> {
  @Module({ controllers: [CloudKitchenController], providers })
  class CloudKitchenModule {}
  return CloudKitchenModule;
}
