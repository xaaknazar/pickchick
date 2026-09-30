import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { CATALOG_ADMIN, CatalogAdmin, CatalogAdminError } from '@pickchick/catalog-admin';
@Controller('v1')
export class CatalogAdminController {
  constructor(@Inject(CATALOG_ADMIN) private readonly catalog: CatalogAdmin) {}
  private token(value?: string) {
    return value?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
  }
  private async execute<T>(run: () => T | Promise<T>) {
    try {
      return await run();
    } catch (error) {
      if (error instanceof CatalogAdminError) {
        const statuses = {
          INVALID_REQUEST: 400,
          UNAUTHORIZED: 401,
          FORBIDDEN: 403,
          NOT_FOUND: 404,
          CONFLICT: 409,
          SERVICE_UNAVAILABLE: 503,
        };
        throw new HttpException({ code: error.code }, statuses[error.code]);
      }
      throw error;
    }
  }
  @Get('admin/catalog/branches') branches(@Headers('authorization') auth?: string) {
    return this.execute(() => this.catalog.branches(this.token(auth)));
  }
  @Get('admin/catalog/branches/:branchId') read(
    @Param('branchId') id: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.execute(() => this.catalog.read(this.token(auth), id));
  }
  @Post('admin/catalog/branches/:branchId/draft/seed') @HttpCode(200) seed(
    @Param('branchId') id: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.execute(() => this.catalog.seed(this.token(auth), id, body));
  }
  @Put('admin/catalog/branches/:branchId/draft') save(
    @Param('branchId') id: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.execute(() => this.catalog.save(this.token(auth), id, body));
  }
  @Post('admin/catalog/branches/:branchId/publish') @HttpCode(200) publish(
    @Param('branchId') id: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return this.execute(() => this.catalog.publish(this.token(auth), id, body));
  }
  @Get('catalog/branches/:branchId') published(@Param('branchId') id: string) {
    return this.execute(() => this.catalog.publicCatalog(id));
  }
}
