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
} from '@nestjs/common';
import { EdgeDeviceRoute, RESOURCE, Resources } from '@pickchick/platform';
import { BackofficeError } from '@pickchick/backoffice-core';
import {
  DeviceRegistry,
  DeviceAccessError,
  deviceAccessEnabled,
  exchangeDeviceAccess,
  kioskPresence,
} from '@pickchick/backoffice-core/devices';
import { SyncError } from '@pickchick/menu-sync';
import {
  kioskCheckoutOptions,
  kioskEnrollmentKey,
  kioskKaspiTerminalConfig,
  kioskMultiBranchEnabled,
} from '@pickchick/commerce-core';
import type { KioskPairingOptions } from '@pickchick/backoffice-core/devices';

/**
 * «Подключить киоск» (owner request 16.11.2026): only with BACKOFFICE_KIOSK_PAIRING_ENABLED=true,
 * the back office on, the kiosk checkout configured and KIOSK_ENROLLMENT_KEY present (the same key
 * /enrollment/exchange decrypts with). Otherwise kiosk registration stays offline-only.
 */
export function kioskPairingOptions(
  env: NodeJS.ProcessEnv,
  backofficeEnabled: boolean,
): KioskPairingOptions | null {
  const flag = env['BACKOFFICE_KIOSK_PAIRING_ENABLED'] ?? 'false';
  if (!['true', 'false'].includes(flag)) throw new Error('Invalid kiosk pairing flag');
  if (flag !== 'true' || !backofficeEnabled) return null;
  // A broken kiosk checkout env must not take «Устройства» down: pairing simply stays off.
  let checkout: ReturnType<typeof kioskCheckoutOptions>,
    encryptionKey: Buffer | null,
    multiBranch: boolean,
    terminal: ReturnType<typeof kioskKaspiTerminalConfig>;
  try {
    checkout = kioskCheckoutOptions(env);
    encryptionKey = kioskEnrollmentKey(env);
    // ADR-0019: other points («Киоски на этой точке») only with KIOSK_MULTI_BRANCH_ENABLED.
    multiBranch = kioskMultiBranchEnabled(env);
    terminal = kioskKaspiTerminalConfig(env);
  } catch {
    return null;
  }
  if (!checkout || !encryptionKey) return null;
  return {
    encryptionKey,
    organizationId: checkout.organizationId,
    branchId: checkout.branchId,
    multiBranch,
    terminalAccountId: terminal?.accountId ?? null,
  };
}

async function run<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (error) {
    if (
      error instanceof BackofficeError ||
      error instanceof DeviceAccessError ||
      error instanceof SyncError
    ) {
      const code = error.code;
      const status =
        code === 'UNAUTHORIZED'
          ? 401
          : code === 'FORBIDDEN'
            ? 403
            : code === 'NOT_FOUND'
              ? 404
              : code === 'CONFLICT' || code === 'CODE_ALREADY_ISSUED'
                ? 409
                : code === 'DEVICE_ACCESS_RATE_LIMITED'
                  ? 429
                  : [
                        'DEVICE_ACCESS_UNAVAILABLE',
                        'EDGE_UNAVAILABLE',
                        'SERVICE_UNAVAILABLE',
                      ].includes(code)
                    ? 503
                    : 400;
      throw new HttpException(
        {
          code,
          ...(error instanceof BackofficeError && error.reason ? { reason: error.reason } : {}),
        },
        status,
      );
    }
    // Pairing material must never reach exception logs or generic driver diagnostics.
    throw new HttpException({ code: 'SERVICE_UNAVAILABLE' }, 503);
  }
}
function bounded(body: unknown) {
  if (Buffer.byteLength(JSON.stringify(body ?? null)) > 32768)
    throw new HttpException({ code: 'PAYLOAD_TOO_LARGE' }, 413);
  return body;
}
@Controller('v1/admin/backoffice/branches/:branch/devices')
export class DeviceRegistryController {
  private readonly service: DeviceRegistry;
  constructor(@Inject(RESOURCE) resources: Resources) {
    this.service = new DeviceRegistry(
      resources.pool,
      deviceAccessEnabled() && resources.config.backofficeEnabled === true,
      process.env['DEVICE_CENTER_ENABLED'] === 'true' &&
        resources.config.backofficeEnabled === true,
      kioskPairingOptions(process.env, resources.config.backofficeEnabled === true),
    );
  }
  private token(auth?: string) {
    return auth?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
  }
  @Get()
  @Header('Cache-Control', 'no-store')
  read(@Param('branch') branch: string, @Headers('authorization') auth?: string) {
    return run(() => this.service.read(this.token(auth), branch));
  }
  @Get('kitchen-password-reset/events')
  @Header('Cache-Control', 'no-store')
  resetEvents(@Param('branch') branch: string, @Headers('authorization') auth?: string) {
    return run(() => this.service.resetEvents(this.token(auth), branch));
  }
  @Get(':id/events')
  @Header('Cache-Control', 'no-store')
  events(
    @Param('branch') branch: string,
    @Param('id') id: string,
    @Headers('authorization') auth?: string,
  ) {
    return run(() => this.service.events(this.token(auth), branch, id));
  }
  @Post('inventory')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  inventory(
    @Param('branch') branch: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return run(() => this.service.inventory(this.token(auth), branch, bounded(body)));
  }
  @Get(':id/inventory-events')
  @Header('Cache-Control', 'no-store')
  inventoryEvents(
    @Param('branch') branch: string,
    @Param('id') id: string,
    @Headers('authorization') auth?: string,
  ) {
    return run(() => this.service.inventoryHistory(this.token(auth), branch, id));
  }
  @Post('pairing-codes')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  issue(
    @Param('branch') branch: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return run(() => this.service.issue(this.token(auth), branch, bounded(body)));
  }
  @Post('kiosk-pairing')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  issueKiosk(
    @Param('branch') branch: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return run(() => this.service.issueKiosk(this.token(auth), branch, bounded(body)));
  }
  /** ADR-0019 «Киоски на этой точке»: body { request_id, enabled, expected_version, reason }. */
  @Post('kiosk-branch')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  kioskBranch(
    @Param('branch') branch: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return run(() => this.service.kioskBranch(this.token(auth), branch, bounded(body)));
  }
  @Post('kitchen-password-reset')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  reset(
    @Param('branch') branch: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return run(() => this.service.issueKitchenReset(this.token(auth), branch, bounded(body)));
  }
  @Post('revoke')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  revoke(
    @Param('branch') branch: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return run(() => this.service.revoke(this.token(auth), branch, bounded(body)));
  }
}
@Controller('internal/v1/edge/devices')
@EdgeDeviceRoute()
export class DeviceAccessTransportController {
  constructor(@Inject(RESOURCE) private readonly resources: Resources) {}
  @Post('exchange')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  exchange(
    @Body() body: unknown,
    @Headers('x-device-id') deviceId?: string,
    @Headers('authorization') auth?: string,
  ) {
    if (!deviceAccessEnabled()) throw new HttpException({ code: 'NOT_FOUND' }, 404);
    return run(() =>
      exchangeDeviceAccess(
        this.resources.pool,
        { deviceId: deviceId ?? '', token: auth?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '' },
        bounded(body),
      ),
    );
  }
}

@Controller('v1/kiosk-checkout/device-presence')
export class KioskPresenceController {
  constructor(@Inject(RESOURCE) private readonly resources: Resources) {}
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  receive(
    @Headers('x-kiosk-device') id?: string,
    @Headers('x-kiosk-key') key?: string,
    @Body() body?: unknown,
  ) {
    if (process.env['DEVICE_CENTER_ENABLED'] !== 'true')
      throw new HttpException({ code: 'NOT_FOUND' }, 404);
    return run(() => kioskPresence(this.resources.pool, id ?? '', key ?? '', bounded(body)));
  }
}
