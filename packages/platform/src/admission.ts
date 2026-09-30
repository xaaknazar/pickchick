import { ServiceUnavailableException } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { defer, finalize } from 'rxjs';

export class CapacityExceeded extends ServiceUnavailableException {
  constructor() {
    super({ code: 'SERVICE_UNAVAILABLE' });
  }
}

/** Per-process protection, independent from branch kitchen capacity and rate limits. */
export class Admission implements NestInterceptor {
  active = 0;
  probes = 0;
  watches = 0;
  rejected = 0;
  completed = 0;

  constructor(readonly limit = 32) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1024)
      throw new Error('Invalid HTTP admission limit');
  }

  intercept(context: ExecutionContext, next: CallHandler) {
    // Class and method identity cannot be spoofed by a path/query/header.
    const health = context.getClass().name === 'HealthController';
    const probe = health && context.getHandler().name === 'ready';
    const watch =
      context.getClass().name === 'TestOrderController' && context.getHandler().name === 'watch';
    if (health && !probe) return next.handle();
    return defer(() => {
      if (probe ? this.probes >= 4 : watch ? this.watches >= 32 : this.active >= this.limit) {
        this.rejected += 1;
        context
          .switchToHttp()
          .getResponse<{ setHeader(name: string, value: string): void }>()
          .setHeader('Retry-After', '1');
        throw new CapacityExceeded();
      }
      if (probe) this.probes += 1;
      else if (watch) this.watches += 1;
      else this.active += 1;
      // Track the handler observable, not the client socket: an aborted client
      // does not mean its database transaction has stopped executing.
      return next.handle().pipe(
        finalize(() => {
          if (probe) this.probes -= 1;
          else if (watch) this.watches -= 1;
          else this.active -= 1;
          this.completed += 1;
        }),
      );
    });
  }
}
