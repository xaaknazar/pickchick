import { HttpException, ServiceUnavailableException, SetMetadata } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isIP } from 'node:net';
import { defer, finalize, mergeMap, timer } from 'rxjs';
import type { Observable } from 'rxjs';

export class CapacityExceeded extends ServiceUnavailableException {
  constructor() {
    super({ code: 'SERVICE_UNAVAILABLE' });
  }
}

const ROUTE = 'pickchick:admission-route';
const IMMEDIATE = Symbol.for('pickchick.admission.long-poll-immediate');
type RouteClass = { kind: 'edge' } | { kind: 'long-poll'; query?: string; perClient?: false };
const reflector = new Reflector();

/**
 * Device-authenticated cashier edge transport (`/internal/v1/edge/*`). It is admitted from a
 * reserved budget public traffic cannot occupy, and only then borrows ordinary capacity.
 */
export const EdgeDeviceRoute = () => SetMetadata(ROUTE, { kind: 'edge' } satisfies RouteClass);

/**
 * A bounded wait for a change (long-poll or watch). It holds its own budget instead of an
 * ordinary slot. With `query`, only a request carrying that query parameter waits; without it
 * the same handler is an ordinary single read. The handler must honour `longPollMayWait`.
 * `perClient: false` exempts a route whose gateway hop does not forward the client address
 * (its `request.ip` would be the front proxy, shared by every caller).
 */
export const LongPollRoute = (query?: string, options: { perClient?: boolean } = {}) =>
  SetMetadata(ROUTE, {
    kind: 'long-poll',
    ...(query ? { query } : {}),
    ...(options.perClient === false ? { perClient: false as const } : {}),
  } satisfies RouteClass);

/**
 * False when admission answers this long-poll in its overflow mode: the handler then reads the
 * current state once and returns it, the same response as a wait that found no change.
 */
export function longPollMayWait(request: object): boolean {
  return (request as Record<symbol, unknown>)[IMMEDIATE] !== true;
}

export interface AdmissionOptions {
  /** Ordinary requests (HTTP_MAX_IN_FLIGHT). */
  limit?: number | undefined;
  /** Long-polls that may wait for a change (HTTP_MAX_LONG_POLL); as many again are paced. */
  longPollLimit?: number | undefined;
  /** Waiting and, separately, paced long-polls per client address (HTTP_MAX_LONG_POLL_PER_IP). */
  longPollPerClient?: number | undefined;
  /** Reserved for device-authenticated edge transport (HTTP_MAX_EDGE_IN_FLIGHT). */
  edgeLimit?: number | undefined;
  /** Pause before an overflow long-poll reads once (HTTP_LONG_POLL_OVERFLOW_DELAY_MS). */
  overflowDelayMs?: number | undefined;
  /**
   * Enforce the per-client cap (HTTP_LONG_POLL_PER_IP_ENABLED, off by default). Only meaningful
   * behind an explicitly trusted proxy: otherwise every client shares the gateway address and
   * the cap would turn into a global one.
   */
  perClient?: boolean | undefined;
  random?: (() => number) | undefined;
}

interface Client {
  waiting: number;
  paced: number;
}
interface HttpRequestLike {
  ip?: string;
  query?: unknown;
  socket?: { remoteAddress?: string };
}
type Release = () => void;

function bounded(name: string, value: number, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`Invalid HTTP admission ${name}`);
  return value;
}

/**
 * Per-client key from Express `request.ip`, which honours X-Forwarded-For only from the
 * explicitly configured TRUSTED_PROXY_IPS hops. IPv6 clients share their /64.
 */
export function admissionClientKey(address: string | undefined): string {
  const ip = (address ?? '').split('%')[0]!.toLowerCase();
  if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) return ip.slice(7);
  if (isIP(ip) === 4) return ip;
  if (isIP(ip) !== 6) return 'unknown';
  const [head = '', tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  // An embedded dotted IPv4 tail occupies two groups.
  const dotted = [...left, ...right].at(-1)?.includes('.') ? 1 : 0;
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<string>(8 - left.length - right.length - dotted).fill('0'), ...right];
  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(':')}::/64`;
}

/**
 * Per-process protection, independent from branch kitchen capacity and rate limits.
 *
 * Separate budgets: ordinary requests (`limit`), readiness probes, TEST order watches, the
 * public mobile menu availability watch (256, unchanged for installed apps),
 * long-polls and the reserved edge transport. A long-poll never occupies an ordinary slot while
 * it waits, so open apps and kiosks cannot starve login, payments, back office or the cashier.
 */
export class Admission implements NestInterceptor {
  readonly limit: number;
  readonly longPollLimit: number;
  readonly longPollPerClient: number;
  readonly edgeLimit: number;
  readonly overflowDelayMs: number;
  readonly perClient: boolean;
  private readonly random: () => number;
  private readonly clients = new Map<string, Client>();
  active = 0;
  probes = 0;
  watches = 0;
  catalogWatches = 0;
  longPolls = 0;
  paced = 0;
  edge = 0;
  edgeBorrowed = 0;
  rejected = 0;
  completed = 0;
  pacedTotal = 0;
  clientRejected = 0;

  constructor(options: number | AdmissionOptions = {}) {
    const o = typeof options === 'number' ? { limit: options } : options;
    this.limit = bounded('limit', o.limit ?? 32, 1, 1024);
    this.longPollLimit = bounded('long-poll limit', o.longPollLimit ?? 64, 1, 1024);
    this.longPollPerClient = bounded('per-client limit', o.longPollPerClient ?? 16, 1, 1024);
    this.edgeLimit = bounded('edge limit', o.edgeLimit ?? 16, 1, 256);
    this.overflowDelayMs = bounded('overflow delay', o.overflowDelayMs ?? 5000, 0, 30_000);
    this.perClient = o.perClient === true;
    this.random = o.random ?? Math.random;
  }

  /** Client addresses currently holding a waiting or paced long-poll. */
  get longPollClients() {
    return this.clients.size;
  }

  intercept(context: ExecutionContext, next: CallHandler) {
    // Class and method identity cannot be spoofed by a path/query/header.
    const health = context.getClass().name === 'HealthController';
    const probe = health && context.getHandler().name === 'ready';
    const watch =
      context.getClass().name === 'TestOrderController' && context.getHandler().name === 'watch';
    // Installed mobile apps keep the dedicated menu-availability bucket they were released with.
    const catalogWatch =
      context.getClass().name === 'CustomerCheckoutController' &&
      context.getHandler().name === 'availability';
    if (health && !probe) return next.handle();
    const route =
      probe || watch || catalogWatch
        ? undefined
        : reflector.getAllAndOverride<RouteClass | undefined>(ROUTE, [
            context.getHandler(),
            context.getClass(),
          ]);
    return defer(() => {
      if (probe) return this.run(context, next, this.take('probes', 4));
      if (watch) return this.run(context, next, this.take('watches', 32));
      if (catalogWatch) return this.run(context, next, this.take('catalogWatches', 256));
      if (route?.kind === 'edge') return this.run(context, next, this.takeEdge());
      if (route?.kind === 'long-poll') {
        const request = context.switchToHttp().getRequest<HttpRequestLike>();
        if (waits(route, request))
          return this.longPoll(context, next, request, this.perClient && route.perClient !== false);
      }
      return this.run(context, next, this.takeGeneral());
    });
  }

  private take(counter: 'probes' | 'watches' | 'catalogWatches', max: number): Release | null {
    if (this[counter] >= max) return null;
    this[counter] += 1;
    return () => {
      this[counter] -= 1;
    };
  }

  private takeGeneral(): Release | null {
    if (this.active >= this.limit) return null;
    this.active += 1;
    return () => {
      this.active -= 1;
    };
  }

  private takeEdge(): Release | null {
    if (this.edge < this.edgeLimit) {
      this.edge += 1;
      return () => {
        this.edge -= 1;
      };
    }
    // A burst above the reservation shares ordinary capacity, as all traffic did before.
    const general = this.takeGeneral();
    if (!general) return null;
    this.edgeBorrowed += 1;
    return () => {
      this.edgeBorrowed -= 1;
      general();
    };
  }

  private run(context: ExecutionContext, next: CallHandler, release: Release | null) {
    if (!release) {
      this.rejected += 1;
      retryAfter(context, 1);
      throw new CapacityExceeded();
    }
    // Track the handler observable, not the client socket: an aborted client
    // does not mean its database transaction has stopped executing.
    return next.handle().pipe(
      finalize(() => {
        release();
        this.completed += 1;
      }),
    );
  }

  private longPoll(
    context: ExecutionContext,
    next: CallHandler,
    request: HttpRequestLike,
    perClient: boolean,
  ): Observable<unknown> {
    const key = perClient ? admissionClientKey(request.ip ?? request.socket?.remoteAddress) : '';
    const client = perClient ? (this.clients.get(key) ?? { waiting: 0, paced: 0 }) : null;
    const forget = () => {
      if (client && !client.waiting && !client.paced) this.clients.delete(key);
    };
    if (
      this.longPolls < this.longPollLimit &&
      (!client || client.waiting < this.longPollPerClient)
    ) {
      this.longPolls += 1;
      if (client) {
        client.waiting += 1;
        this.clients.set(key, client);
      }
      return this.run(context, next, () => {
        this.longPolls -= 1;
        if (client) client.waiting -= 1;
        forget();
      });
    }
    if (client && client.paced >= this.longPollPerClient) {
      this.clientRejected += 1;
      retryAfter(context, Math.max(1, Math.ceil(this.overflowDelayMs / 1000)));
      throw new HttpException({ code: 'RATE_LIMITED' }, 429);
    }
    if (this.paced >= this.longPollLimit) {
      this.rejected += 1;
      retryAfter(context, 1);
      throw new CapacityExceeded();
    }
    // Overflow: answer with the current state instead of a 503. Installed clients poll again
    // right after any answer, so the single read is paced; the pause holds no slot and no
    // database connection. The read itself is an ordinary short request.
    this.paced += 1;
    this.pacedTotal += 1;
    if (client) {
      client.paced += 1;
      this.clients.set(key, client);
    }
    (request as Record<symbol, unknown>)[IMMEDIATE] = true;
    const delay = Math.round(this.overflowDelayMs * (0.75 + 0.5 * this.random()));
    return timer(delay).pipe(
      mergeMap(() => this.run(context, next, this.takeGeneral())),
      finalize(() => {
        this.paced -= 1;
        if (client) client.paced -= 1;
        forget();
      }),
    );
  }
}

function waits(route: { query?: string }, request: HttpRequestLike) {
  if (route.query === undefined) return true;
  const query = request.query;
  return (
    !!query &&
    typeof query === 'object' &&
    (query as Record<string, unknown>)[route.query] !== undefined
  );
}

function retryAfter(context: ExecutionContext, seconds: number) {
  context
    .switchToHttp()
    .getResponse<{ setHeader(name: string, value: string): void }>()
    .setHeader('Retry-After', String(seconds));
}
