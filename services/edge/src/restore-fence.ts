import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type {
  CanActivate,
  ExecutionContext,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { RESOURCE, Resources } from '@pickchick/platform';
import { fenceRestoredEdge } from '@pickchick/local-orders';

/** Retry interval while PostgreSQL is not reachable yet (for example right after a reboot). */
export const RESTORE_FENCE_RETRY_MS = 5000;
/** While writes are refused the reason is logged again this often. */
export const RESTORE_FENCE_REMINDER_MS = 300_000;

const CONNECTION_CODE =
  /^(?:08[0-9A-Z]{3}|57P0[0-9A-Z]|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|EPIPE)$/;
// node-postgres reports a dropped or timed out connection without a code.
const CONNECTION_TEXT = /^(?:Connection terminated|timeout exceeded when trying to connect)/;

/**
 * What a failed fence check says. `connection`: the database is not answering (SQLSTATE class
 * 08, 57P0x, a socket error) - only then is it unknown whether this is a restored copy. `code`
 * is a SQLSTATE, a Node system code or the error class; never the message.
 */
export function restoreFenceFailure(error: unknown): { code: string; connection: boolean } {
  const value = error as { code?: unknown; cause?: { code?: unknown }; name?: unknown } | null;
  const raw = [value?.code, value?.cause?.code].find(
    (code): code is string => typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code),
  );
  if (raw) return { code: raw, connection: CONNECTION_CODE.test(raw) };
  if (error instanceof Error && CONNECTION_TEXT.test(error.message))
    return { code: 'CONNECTION', connection: true };
  const name = value?.name;
  return {
    code: typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name) ? name : 'UNKNOWN',
    connection: false,
  };
}

/**
 * Before the edge serves its first order: if this database is a restored copy (edge schema023),
 * move every edge-to-cloud producer sequence past the lost timeline once
 * (docs/operations/edge-restore.md). A runtime without the schema or the grant keeps serving
 * with the previous behaviour; the log line tells the operator.
 *
 * While the database does not answer (still starting after a reboot) the check is retried in
 * the background, `pending` is true and RestoreFenceGuard refuses every writing request, so a
 * reboot right after a restore does not leave the first new orders on sequence numbers the
 * cloud already holds. Any other failure of the check (the function raises, schema skew) is
 * logged and retried too, but never refuses writes: the database is fine and the till must
 * keep selling.
 */
@Injectable()
export class RestoreFenceOnStart implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<boolean> | undefined;
  private stopped = false;
  private failed = false;
  private open = false;
  private logged: { key: string; at: number } | undefined;

  /** True while writes are refused: the check has not run and the database does not answer. */
  get pending() {
    return !this.open;
  }

  constructor(@Inject(RESOURCE) private readonly resources: Resources) {}

  async onApplicationBootstrap() {
    if (!(await this.attempt())) this.schedule();
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.attempt();
      void this.running.then((done) => {
        this.running = undefined;
        if (!done) this.schedule();
      });
    }, RESTORE_FENCE_RETRY_MS);
    this.timer.unref?.();
  }

  /** True when no retry is needed: fenced, current, unsupported schema or no grant. */
  private async attempt(): Promise<boolean> {
    try {
      const fence = await fenceRestoredEdge(this.resources.pool);
      this.open = true;
      if (fence.state === 'restore' || fence.state === 'operator')
        console.warn(
          JSON.stringify({
            event: 'edge_restore_fenced',
            state: fence.state,
            epoch: fence.epoch,
            sequence_gap: fence.sequenceGap,
          }),
        );
      else if (this.failed)
        console.log(JSON.stringify({ event: 'edge_restore_fence_checked', state: fence.state }));
      return true;
    } catch (error) {
      this.failed = true;
      const { code, connection } = restoreFenceFailure(error);
      // 42501: the runtime role lacks the EXECUTE grant. That is a release setup problem the
      // operator fixes with edge-runtime-grants; retrying cannot help.
      if (code === '42501') {
        this.open = true;
        console.warn(
          JSON.stringify({ event: 'edge_restore_fence_unavailable', reason: 'NOT_GRANTED' }),
        );
        return true;
      }
      // Once writes were admitted they stay admitted: refusing them later protects nothing.
      if (!connection) this.open = true;
      const writes = this.open ? 'accepted' : 'refused';
      const key = `${code}:${writes}`,
        now = Date.now();
      // One line per change; while writes are refused, a reminder every 5 minutes.
      if (
        this.logged?.key !== key ||
        (!this.open && now - this.logged.at >= RESTORE_FENCE_REMINDER_MS)
      ) {
        this.logged = { key, at: now };
        console[connection ? 'warn' : 'error'](
          JSON.stringify({
            event: 'edge_restore_fence_unavailable',
            reason: connection ? 'RETRYING' : 'FAILED',
            code,
            writes,
          }),
        );
      }
      return false;
    }
  }
}

/**
 * While the restore fence has not run because the database does not answer, the edge answers
 * reads and health but refuses every writing request with 503: an order, sale, shift or kitchen
 * event written now could take a producer sequence the cloud already holds. The fence only
 * needs the local PostgreSQL, never the WAN; a check that fails for any other reason does not
 * refuse writes.
 */
@Injectable()
export class RestoreFenceGuard implements CanActivate {
  constructor(@Inject(RestoreFenceOnStart) private readonly fence: RestoreFenceOnStart) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.fence.pending) return true;
    const method = context.switchToHttp().getRequest<{ method?: string }>().method ?? '';
    if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return true;
    throw new ServiceUnavailableException();
  }
}
