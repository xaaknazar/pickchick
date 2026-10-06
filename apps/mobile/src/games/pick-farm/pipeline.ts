import {
  applyFarmCommand,
  BATCH_LIMIT,
  type FarmCommand,
  type FarmState,
} from '@pickchick/farm-game';

type Snapshot = { state: FarmState; serverNow: number; protocol?: number };
/** Serial transport. One request at a time; the durable intent lives in FarmClient. */
export type FarmLane = {
  send(command: FarmCommand): Promise<Snapshot>;
  refresh(): Promise<Snapshot>;
  /** Latest server snapshot after a rejected command (FarmClient refetches it). */
  current(): Snapshot | null;
};
export type Ticket =
  { accepted: true; done: Promise<ActionResult> } | { accepted: false; code: string };
export type ActionResult =
  { ok: true; before: FarmState; after: FarmState } | { ok: false; code: string; local: boolean };

type Item = {
  command: FarmCommand;
  /** Client estimate of server time when the player acted; used only for prediction. */
  at: number;
  resolve(result: ActionResult): void;
};
type Batchable = Extract<FarmCommand, { type: 'harvest' | 'plant' | 'water' }>;
const errorCode = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN';
const httpStatus = (error: unknown) =>
  error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
const NEW_RULES = new Set(['water', 'waterMany', 'harvestMany', 'plantMany']);

/** Coalescing key: only contiguous actions of one kind and one choice become a batch. */
function batchKey(command: FarmCommand): string | null {
  if (command.type === 'harvest') return `harvest:${command.destination ?? ''}`;
  if (command.type === 'plant') return `plant:${command.cropId}`;
  if (command.type === 'water') return 'water';
  return null;
}
function toBatch(commands: Batchable[]): FarmCommand {
  const first = commands[0]!;
  const plotIds = commands.map((c) => c.plotId);
  if (first.type === 'harvest')
    return {
      type: 'harvestMany',
      plotIds,
      ...(first.destination ? { destination: first.destination } : {}),
    };
  if (first.type === 'plant') return { type: 'plantMany', plotIds, cropId: first.cropId };
  return { type: 'waterMany', plotIds };
}

/**
 * Immediate, server-checked play. Every action is first validated by the same engine the
 * server runs, shown at once as a prediction, then confirmed in order. Money and XP shown
 * to the player come from `confirmed`, never from the prediction. A rejected or unknown
 * result drops the remaining predictions, so the field returns to the server state.
 */
export class FarmPipeline {
  confirmed: Snapshot | null = null;
  /** Optimistic until the server proves otherwise, then the client falls back silently. */
  batching = true;
  watering = true;
  private queue: Item[] = [];
  private sending: Item[] = [];
  private running = false;
  private refreshWaiters: ((ok: boolean) => void)[] = [];
  private disposed = false;
  private cache: FarmState | null = null;
  private lastAt = 0;
  private lane: FarmLane;
  private now: () => number;
  private changed: () => void;
  private failed: (error: unknown) => void;
  constructor(
    lane: FarmLane,
    now: () => number,
    changed: () => void,
    failed: (error: unknown) => void = () => undefined,
  ) {
    this.lane = lane;
    this.now = now;
    this.changed = changed;
    this.failed = failed;
  }
  get pending() {
    return this.queue.length + this.sending.length;
  }
  /** Confirmed state with every unconfirmed action applied in order (cached). */
  predicted(): FarmState | null {
    if (!this.confirmed) return null;
    if (this.cache) return this.cache;
    let state = this.confirmed.state;
    for (const item of [...this.sending, ...this.queue]) {
      try {
        state = applyFarmCommand(state, item.command, Math.max(item.at, this.confirmed.serverNow));
      } catch {
        /* A confirmed state can make a later prediction obsolete; the server decides. */
      }
    }
    this.cache = state;
    return state;
  }
  /**
   * Validates synchronously. An accepted action is visible at once in `predicted()` and is
   * confirmed later; a rejected one never reaches the network.
   */
  submit(command: FarmCommand): Ticket {
    if (this.disposed) return { accepted: false, code: 'CANCELLED' };
    const base = this.predicted();
    if (!base) return { accepted: false, code: 'NOT_READY' };
    if (!this.watering && (command.type === 'water' || command.type === 'waterMany'))
      return { accepted: false, code: 'WATER_UNAVAILABLE' };
    // Monotonic: a later action never predates an earlier prediction, even when a server
    // answer re-anchors the local clock slightly backwards.
    const at = Math.max(this.now(), this.confirmed!.serverNow, this.lastAt);
    let next: FarmState;
    try {
      next = applyFarmCommand(base, command, at);
    } catch (error) {
      return { accepted: false, code: errorCode(error) };
    }
    const done = new Promise<ActionResult>((resolve) => {
      this.queue.push({ command, at, resolve });
    });
    this.cache = next;
    this.lastAt = at;
    this.changed();
    void this.drain();
    return { accepted: true, done };
  }
  act(command: FarmCommand): Promise<ActionResult> {
    const ticket = this.submit(command);
    return ticket.accepted
      ? ticket.done
      : Promise.resolve({ ok: false, code: ticket.code, local: true });
  }
  /** Reads the server state after queued actions are settled. */
  refresh(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.refreshWaiters.push(resolve);
      void this.drain();
    });
  }
  dispose() {
    this.disposed = true;
    this.cancel('CANCELLED');
    for (const waiter of this.refreshWaiters.splice(0)) waiter(false);
  }
  private cancel(code: string) {
    this.cache = null;
    for (const item of this.queue.splice(0)) item.resolve({ ok: false, code, local: true });
  }
  private take(): Item[] {
    const head = this.queue[0]!;
    const key = this.batching ? batchKey(head.command) : null;
    let count = 1;
    if (key)
      while (
        count < this.queue.length &&
        count < BATCH_LIMIT &&
        batchKey(this.queue[count]!.command) === key
      )
        count++;
    return this.queue.splice(0, count);
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.disposed && (this.queue.length || this.refreshWaiters.length)) {
        if (!this.queue.length) {
          const waiters = this.refreshWaiters.splice(0);
          let ok = false;
          try {
            this.confirmed = await this.lane.refresh();
            this.cache = null;
            ok = true;
          } catch (error) {
            this.confirmed = this.lane.current() ?? this.confirmed;
            this.cache = null;
            this.failed(error);
          }
          for (const waiter of waiters) waiter(ok);
          this.changed();
          continue;
        }
        const group = this.take();
        this.sending = group;
        const command =
          group.length > 1 ? toBatch(group.map((i) => i.command as Batchable)) : group[0]!.command;
        const before = this.confirmed!.state;
        try {
          const next = await this.lane.send(command);
          this.confirmed = next;
          this.sending = [];
          this.cache = null;
          for (const item of group) item.resolve({ ok: true, before, after: next.state });
        } catch (error) {
          this.sending = [];
          this.confirmed = this.lane.current() ?? this.confirmed;
          this.cache = null;
          const code = errorCode(error);
          // Older Farm API: the request was rejected before any change. Retry as before.
          if (
            code === 'INVALID_REQUEST' &&
            httpStatus(error) === 400 &&
            NEW_RULES.has(command.type)
          ) {
            if (group.length > 1) {
              this.batching = false;
              this.queue.unshift(...group);
            } else {
              this.watering = false;
              group[0]!.resolve({ ok: false, code: 'WATER_UNAVAILABLE', local: false });
              this.queue = this.queue.filter((item) => {
                if (item.command.type !== 'water') return true;
                item.resolve({ ok: false, code: 'WATER_UNAVAILABLE', local: true });
                return false;
              });
            }
            this.cache = null;
            this.changed();
            continue;
          }
          for (const item of group) item.resolve({ ok: false, code, local: false });
          this.cancel('CANCELLED');
          this.failed(error);
        }
        this.changed();
      }
    } finally {
      this.running = false;
    }
  }
}
