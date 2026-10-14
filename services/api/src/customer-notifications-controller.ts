import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpException,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  CUSTOMER_NOTIFICATIONS,
  CustomerNotifications,
  NotificationError,
} from '@pickchick/customer-notifications';
@Controller('v1')
export class CustomerNotificationsController {
  constructor(
    @Inject(CUSTOMER_NOTIFICATIONS) private readonly notifications: CustomerNotifications,
  ) {}
  private token(value?: string) {
    return value?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
  }
  private async run<T>(fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof NotificationError)
        throw new HttpException(
          { code: error.code },
          {
            UNAUTHORIZED: 401,
            INVALID_REQUEST: 400,
            SERVICE_UNAVAILABLE: 503,
            NOT_FOUND: 404,
            RATE_LIMITED: 429,
          }[error.code],
        );
      throw error;
    }
  }
  @Get('notifications/config') config() {
    return this.notifications.config();
  }
  @Get('customers/me/notification-preferences') preferences(
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.notifications.preferences(this.token(auth)));
  }
  @Patch('customers/me/notification-preferences') update(
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.notifications.updatePreferences(this.token(auth), body));
  }
  @Post('customers/me/push-devices') register(
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.notifications.register(this.token(auth), body));
  }
  @Delete('customers/me/push-devices/:id') unregister(
    @Param('id') id: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.notifications.unregister(this.token(auth), id));
  }
  @Get('customers/me/notifications') inbox(@Headers('authorization') auth?: string) {
    return this.run(() => this.notifications.inbox(this.token(auth)));
  }
  @Post('customers/me/notifications/:id/read') read(
    @Param('id') id: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.run(() => this.notifications.read(this.token(auth), id));
  }
}
