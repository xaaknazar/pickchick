import { Body, Controller, Headers, HttpCode, HttpException, Inject, Post } from '@nestjs/common';
import { RESOURCE, Resources } from '@pickchick/platform';
import { confirmDeviceIdentity, rotateDeviceIdentity, SyncError } from '@pickchick/menu-sync';

/**
 * Device-only identity renewal over the private edge tunnel (never the public gateway).
 * Off unless CLOUD_EDGE_IDENTITY_ROTATION_ENABLED=true; then authenticated by the device's own
 * current (or, for a replay, just-replaced) credential. See edge-identity-rotation.md.
 */
@Controller('internal/v1/edge/identity')
export class EdgeIdentityController {
  constructor(@Inject(RESOURCE) private readonly resources: Resources) {}

  private async run(
    kind: 'rotate' | 'confirm',
    body: unknown,
    deviceId?: string,
    authorization?: string,
  ) {
    if (!this.resources.config.edgeIdentityRotationEnabled)
      throw new HttpException('NOT_FOUND', 404);
    const auth = {
      deviceId: deviceId ?? '',
      token: authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '',
    };
    try {
      return kind === 'rotate'
        ? await rotateDeviceIdentity(this.resources.pool, auth, body)
        : await confirmDeviceIdentity(this.resources.pool, auth, body);
    } catch (error) {
      if (error instanceof SyncError) {
        const statuses = { INVALID_REQUEST: 400, UNAUTHORIZED: 401, CONFLICT: 409, NOT_FOUND: 404 };
        throw new HttpException(error.code, statuses[error.code]);
      }
      throw error;
    }
  }

  @Post('rotate')
  @HttpCode(200)
  rotate(
    @Body() body: unknown,
    @Headers('x-device-id') deviceId?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.run('rotate', body, deviceId, authorization);
  }

  @Post('confirm')
  @HttpCode(200)
  confirm(
    @Body() body: unknown,
    @Headers('x-device-id') deviceId?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.run('confirm', body, deviceId, authorization);
  }
}
