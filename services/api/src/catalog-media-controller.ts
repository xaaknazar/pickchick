import type { IncomingMessage } from 'node:http';
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
  Res,
  UseFilters,
} from '@nestjs/common';
import {
  CATALOG_ASSET_CONTENT_TYPE,
  CATALOG_ASSET_MAX_BYTES,
  CATALOG_ASSET_UPLOAD_ROUTE,
  CATALOG_MEDIA,
  CatalogAdminError,
  CatalogMedia,
} from '@pickchick/catalog-admin';
import type { CatalogMediaFile } from '@pickchick/catalog-admin';
import { SyncError } from '@pickchick/menu-sync';
import {
  CatalogReasonException,
  CatalogReasonFilter,
  catalogStatuses,
} from './catalog-admin-controller.js';

interface MediaResponse {
  status(code: number): MediaResponse;
  setHeader(name: string, value: string | number): void;
  end(body?: Buffer): void;
}

/**
 * Raw image bodies for the upload route only (10 MiB). Registered only when the media flag is
 * on, so a disabled deployment never buffers image bodies; every other route keeps its parser.
 */
interface BodyParserHost {
  useBodyParser(
    parser: 'raw',
    options: { limit: number; type: (request: IncomingMessage) => boolean },
  ): unknown;
}
export function useCatalogAssetBodyParser(app: BodyParserHost) {
  app.useBodyParser('raw', {
    limit: CATALOG_ASSET_MAX_BYTES,
    type: (request: IncomingMessage) =>
      request.method === 'POST' &&
      CATALOG_ASSET_UPLOAD_ROUTE.test(request.url?.split('?')[0] ?? '') &&
      CATALOG_ASSET_CONTENT_TYPE.test(request.headers['content-type'] ?? ''),
  });
}

@Controller()
@UseFilters(CatalogReasonFilter)
export class CatalogMediaController {
  constructor(@Inject(CATALOG_MEDIA) private readonly media: CatalogMedia) {}
  private token(value?: string) {
    return value?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
  }
  private async execute<T>(run: () => Promise<T>) {
    try {
      return await run();
    } catch (error) {
      if (error instanceof CatalogAdminError) {
        if (error.reason) throw new CatalogReasonException(error.code, error.reason);
        throw new HttpException({ code: error.code }, catalogStatuses[error.code]);
      }
      if (error instanceof SyncError)
        throw new HttpException(
          { code: error.code === 'UNAUTHORIZED' ? 'UNAUTHORIZED' : 'NOT_FOUND' },
          error.code === 'UNAUTHORIZED' ? 401 : 404,
        );
      throw error;
    }
  }
  /** Content-addressed bytes never change: cache for a year, validate by the hash ETag. */
  private send(
    response: MediaResponse,
    file: CatalogMediaFile,
    ifNoneMatch: string | undefined,
    scope: 'public' | 'private',
  ) {
    const etag = `"${file.sha256}"`;
    response.setHeader('Cache-Control', `${scope}, max-age=31536000, immutable`);
    response.setHeader('ETag', etag);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    if (scope === 'public') {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
    if (ifNoneMatch?.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)) {
      response.status(304).end();
      return;
    }
    response.setHeader('Content-Type', 'image/webp');
    response.setHeader('Content-Length', file.bytes.length);
    response.status(200).end(file.bytes);
  }

  @Post('v1/admin/catalog/branches/:branchId/assets') @HttpCode(200) upload(
    @Param('branchId') id: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') requestId?: string,
  ) {
    return this.execute(() => this.media.upload(this.token(auth), id, body, requestId));
  }

  @Get('v1/admin/catalog/branches/:branchId/assets') list(
    @Param('branchId') id: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.execute(() => this.media.list(this.token(auth), id));
  }

  // Express also answers HEAD through this GET route; other methods fall through to 404.
  @Get('v1/media/catalog/:file') async file(
    @Param('file') file: string,
    @Res() response: MediaResponse,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    this.send(response, await this.execute(() => this.media.media(file)), ifNoneMatch, 'public');
  }

  /** Private port only (not routed by the public gateway): the edge menu worker download. */
  @Get('internal/v1/edge/media/:file') async edge(
    @Param('file') file: string,
    @Res() response: MediaResponse,
    @Headers('x-device-id') deviceId?: string,
    @Headers('authorization') authorization?: string,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    const auth = {
      deviceId: deviceId ?? '',
      token: authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '',
    };
    this.send(
      response,
      await this.execute(() => this.media.edgeMedia(auth, file)),
      ifNoneMatch,
      'private',
    );
  }
}
