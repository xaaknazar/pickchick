import { Controller, Get, Headers, HttpException, Inject } from '@nestjs/common';
import { RESOURCE, Resources } from '@pickchick/platform';
import { OrderError, orderErrorStatus, readCloudLink } from '@pickchick/local-orders';

/**
 * GET edge/v1/cloud-link: is the cashier still in contact with the cloud (internet/WAN)? The
 * POS shows "no internet" separately from "no connection to the cashier" (offline stand finding,
 * docs/operations/offline-stand.md). Read only; any signed-in staff session.
 */
@Controller('edge/v1')
export class CloudLinkController {
  constructor(@Inject(RESOURCE) private readonly resources: Resources) {}

  @Get('cloud-link')
  async read(@Headers() headers: Record<string, string | undefined>) {
    const auth = {
      sessionId: headers['x-staff-session-id'] ?? '',
      token: headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '',
    };
    try {
      return await readCloudLink(this.resources.pool, this.resources.config.branchId!, auth);
    } catch (error) {
      if (error instanceof OrderError)
        throw new HttpException({ code: error.code }, orderErrorStatus[error.code]);
      throw error;
    }
  }
}
