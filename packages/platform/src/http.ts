import 'reflect-metadata';
import { CapacityExceeded } from './admission.js';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  Catch,
  Controller,
  Get,
  HttpException,
  Header,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ErrorSchema, HealthSchema, ReadinessSchema, UuidSchema } from '@pickchick/contracts';
import { RESOURCE, Resources } from './resources.js';

interface RequestContext {
  headers: Record<string, string | string[] | undefined>;
  traceId?: string;
}
interface ResponseContext {
  status(status: number): ResponseContext;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

@Catch()
class SafeExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestContext>();
    const response = http.getResponse<ResponseContext>();
    const oversizedBody =
      error instanceof Error &&
      'type' in error &&
      error.type === 'entity.too.large' &&
      'status' in error &&
      error.status === 413;
    const status = error instanceof HttpException ? error.getStatus() : oversizedBody ? 413 : 500;
    if (error instanceof ServiceUnavailableException) {
      const readiness = ReadinessSchema.safeParse(error.getResponse());
      if (readiness.success) {
        response.status(503).json(readiness.data);
        return;
      }
    }
    const defaultCode =
      status === 400
        ? 'INVALID_REQUEST'
        : status === 401
          ? 'UNAUTHORIZED'
          : status === 403
            ? 'FORBIDDEN'
            : status === 409
              ? 'CONFLICT'
              : status === 413
                ? 'PAYLOAD_TOO_LARGE'
                : status === 429
                  ? 'RATE_LIMITED'
                  : status === 404
                    ? 'NOT_FOUND'
                    : status === 503
                      ? 'SERVICE_UNAVAILABLE'
                      : 'INTERNAL_ERROR';
    const details = error instanceof HttpException ? error.getResponse() : null;
    const declared =
      details && typeof details === 'object' && 'code' in details
        ? ErrorSchema.shape.code.safeParse(details.code)
        : null;
    const code = declared?.success ? declared.data : defaultCode;
    const traceId = request.traceId ?? randomUUID();
    if (status >= 500 && !(error instanceof CapacityExceeded)) {
      console.error(JSON.stringify({ event: 'request_failed', code, trace_id: traceId }));
    }
    response.status(status).json({
      code,
      message_key: `errors.${code.toLowerCase()}`,
      trace_id: traceId,
      retryable: status === 503 || status === 429,
    });
  }
}

@Controller('health')
export class HealthController {
  constructor(@Inject(RESOURCE) private readonly resources: Resources) {}

  @Get('live')
  live() {
    return HealthSchema.parse({ service: this.resources.config.service, alive: true });
  }

  // Private network only; public gateway has an explicit route allowlist.
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  metrics() {
    const { pool, admission } = this.resources;
    const values = {
      pickchick_http_in_flight: admission.active,
      pickchick_readiness_in_flight: admission.probes,
      pickchick_http_admission_limit: admission.limit,
      pickchick_http_rejected_total: admission.rejected,
      pickchick_http_completed_total: admission.completed,
      pickchick_db_pool_total: pool.totalCount,
      pickchick_db_pool_idle: pool.idleCount,
      pickchick_db_pool_waiting: pool.waitingCount,
      pickchick_process_heap_bytes: process.memoryUsage().heapUsed,
    };
    return Object.entries(values)
      .map(
        ([name, value]) =>
          `# TYPE ${name} ${name.endsWith('_total') && name.includes('http_') ? 'counter' : 'gauge'}\n${name} ${value}\n`,
      )
      .join('');
  }

  @Get('ready')
  async ready() {
    const status = ReadinessSchema.parse(await this.resources.readiness());
    if (!status.ready) throw new ServiceUnavailableException(status);
    return status;
  }
}

export async function createHttpApplication(module: Type<unknown>) {
  const app = await NestFactory.create<NestExpressApplication>(module, {
    logger: false,
    abortOnError: false,
  });
  app.use((request: RequestContext, response: ResponseContext, next: () => void) => {
    const incoming = UuidSchema.safeParse(request.headers['x-request-id']);
    request.traceId = incoming.success ? incoming.data : randomUUID();
    response.setHeader('X-Request-Id', request.traceId);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  const instance = app.getHttpAdapter().getInstance();
  instance.disable('x-powered-by');
  // Full catalog drafts are larger than ordinary commands. Scope the extra bytes
  // to this one route, while retaining Nest/Express' 100 KiB limit elsewhere.
  app.useBodyParser('json', {
    limit: 320 * 1024,
    type: (request: IncomingMessage) =>
      request.method === 'PUT' &&
      /^\/v1\/admin\/catalog\/branches\/[a-f0-9-]{36}\/draft\/?$/.test(
        request.url?.split('?')[0] ?? '',
      ) &&
      /^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? ''),
  });
  app.useBodyParser('json', { limit: 100 * 1024 });
  const proxyIps = app.get<Resources>(RESOURCE).config.trustedProxyIps;
  // Explicit hop addresses only. Trusting all forwarded headers defeats per-IP SMS limits.
  if (proxyIps?.length) instance.set('trust proxy', proxyIps);
  app.useGlobalFilters(new SafeExceptionFilter());
  app.useGlobalInterceptors(app.get<Resources>(RESOURCE).admission);
  return app;
}
