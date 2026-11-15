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
  Query,
  Res,
  UseFilters,
} from '@nestjs/common';
import {
  BACKOFFICE,
  Backoffice,
  BackofficeError,
  SPLASH_PART_BYTES,
} from '@pickchick/backoffice-core';
import type { SplashFile } from '@pickchick/backoffice-core';
import { BackofficeReasonException, BackofficeReasonFilter } from './backoffice-controller.js';

/**
 * Video of the app storefront (owner request 15.11.2026; backoffice-core splash.ts, cloud078,
 * BACKOFFICE_APP_SPLASH_ENABLED). Back office: GET .../splash, raw parts of at most 256 KiB,
 * finish, choose. App: public GET /v1/media/app/<sha256>.mp4 with HTTP ranges.
 */
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
export const SPLASH_PART_ROUTE = new RegExp(
  `^/v1/admin/backoffice/branches/${UUID}/splash/uploads/${UUID}/parts/[0-9]{1,3}/?$`,
);
interface BodyParserHost {
  useBodyParser(
    parser: 'raw',
    options: { limit: number; type: (request: IncomingMessage) => boolean },
  ): unknown;
}
/** Raw octet-stream bodies for the part route only; every other route keeps its parser. */
export function useSplashPartBodyParser(app: BodyParserHost) {
  app.useBodyParser('raw', {
    limit: SPLASH_PART_BYTES,
    type: (request: IncomingMessage) =>
      request.method === 'POST' &&
      SPLASH_PART_ROUTE.test(request.url?.split('?')[0] ?? '') &&
      /^application\/octet-stream(?:;|$)/i.test(request.headers['content-type'] ?? ''),
  });
}
const statuses: Record<BackofficeError['code'], number> = {
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  SERVICE_UNAVAILABLE: 503,
  INSUFFICIENT_STOCK: 409,
  NOT_READY: 409,
};
async function run<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BackofficeError) {
      if (e.reason) throw new BackofficeReasonException(e.code, e.reason);
      throw new HttpException({ code: e.code }, statuses[e.code]);
    }
    throw e;
  }
}
const token = (auth?: string) => auth?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';

@Controller('v1/admin/backoffice/branches/:id/splash')
@UseFilters(BackofficeReasonFilter)
export class AppSplashController {
  constructor(@Inject(BACKOFFICE) private service: Backoffice) {}
  @Get() read(@Param('id') id: string, @Headers('authorization') auth?: string) {
    return run(() => this.service.splash(token(auth), id));
  }
  @Post('uploads/:upload/parts/:part') @HttpCode(200) part(
    @Param('id') id: string,
    @Param('upload') upload: string,
    @Param('part') part: string,
    @Query() query: unknown,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return run(() => this.service.splashPart(token(auth), id, upload, part, query, body));
  }
  @Post('uploads/:upload/finish') @HttpCode(200) finish(
    @Param('id') id: string,
    @Param('upload') upload: string,
    @Headers('authorization') auth?: string,
  ) {
    return run(() => this.service.splashFinish(token(auth), id, upload));
  }
  @Post() @HttpCode(200) choose(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
  ) {
    return run(() => this.service.splashSet(token(auth), id, body));
  }
}

interface MediaResponse {
  status(code: number): MediaResponse;
  setHeader(name: string, value: string | number): void;
  end(body?: Buffer): void;
}
@Controller('v1/media/app')
export class AppSplashMediaController {
  constructor(@Inject(BACKOFFICE) private service: Backoffice) {}
  // Express also answers HEAD through this GET route.
  @Get(':file') async file(
    @Param('file') file: string,
    @Res() response: MediaResponse,
    @Headers('range') range?: string,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    let found: SplashFile;
    try {
      found = await this.service.splashMedia(file, range);
    } catch (e) {
      if (e instanceof BackofficeError && e.reason === 'RANGE') {
        response.status(416).end();
        return;
      }
      if (e instanceof BackofficeError) {
        response.status(404).end();
        return;
      }
      throw e;
    }
    const etag = `"${found.sha256}"`;
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    response.setHeader('ETag', etag);
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Type', 'video/mp4');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (!range && ifNoneMatch?.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
      response.status(304).end();
      return;
    }
    response.setHeader('Content-Length', found.bytes.length);
    if (found.partial) {
      response.setHeader('Content-Range', `bytes ${found.start}-${found.end}/${found.size}`);
      response.status(206).end(found.bytes);
    } else response.status(200).end(found.bytes);
  }
}
