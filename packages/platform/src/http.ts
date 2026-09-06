import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  Catch,
  Controller,
  Get,
  HttpException,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HealthSchema, ReadinessSchema, UuidSchema } from '@pickchick/contracts';
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
    const status = error instanceof HttpException ? error.getStatus() : 500;
    if (error instanceof ServiceUnavailableException) {
      const readiness = ReadinessSchema.safeParse(error.getResponse());
      if (readiness.success) {
        response.status(503).json(readiness.data);
        return;
      }
    }
    const code =
      status === 400
        ? 'INVALID_REQUEST'
        : status === 404
          ? 'NOT_FOUND'
          : status === 503
            ? 'SERVICE_UNAVAILABLE'
            : 'INTERNAL_ERROR';
    const traceId = request.traceId ?? randomUUID();
    if (status >= 500) {
      console.error(JSON.stringify({ event: 'request_failed', code, trace_id: traceId }));
    }
    response.status(status).json({
      code,
      message_key: `errors.${code.toLowerCase()}`,
      trace_id: traceId,
      retryable: status === 503,
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

  @Get('ready')
  async ready() {
    const status = ReadinessSchema.parse(await this.resources.readiness());
    if (!status.ready) throw new ServiceUnavailableException(status);
    return status;
  }
}

export async function createHttpApplication(module: Type<unknown>) {
  const app = await NestFactory.create(module, { logger: false, abortOnError: false });
  app.use((request: RequestContext, response: ResponseContext, next: () => void) => {
    const incoming = UuidSchema.safeParse(request.headers['x-request-id']);
    request.traceId = incoming.success ? incoming.data : randomUUID();
    response.setHeader('X-Request-Id', request.traceId);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.useGlobalFilters(new SafeExceptionFilter());
  return app;
}
