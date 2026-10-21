/**
 * Pure kitchen fulfillment state machine (ADR-0014, stage S1).
 *
 * Shared by the edge aggregate (`@pickchick/edge-fulfillment`) and the future cloud kitchen
 * aggregate. No I/O, clock, randomness or storage: callers load the locked order and its tasks,
 * run the station permission check where the documented order requires it, and persist the
 * returned steps. Every step is exactly one aggregate version increment and one event; a task
 * step also increments that task's version by one.
 *
 * The order of checks is part of the contract because it decides which error code a caller
 * sees when several guards fail at once:
 *   1. idempotent replay (`replayDecision`), before loading the order;
 *   2. aggregate `expectedVersion` (`checkVersion`) -> CONFLICT;
 *   3. command shape (`commandShape`) -> INVALID;
 *   4. per kind, after the caller's own permission check where noted, the `plan*` functions.
 */

export const ORDER_STATES = [
  'held',
  'accepted',
  'in_production',
  'ready',
  'handed_over',
  'cancel_requested',
  'cancelled',
  'released',
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export const TASK_STATES = [
  'queued',
  'in_progress',
  'done',
  'cancel_requested',
  'cancelled',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const KITCHEN_ACTIONS = [
  'start_task',
  'complete_task',
  'complete_station',
  'confirm_stop',
  'ready',
  'handoff',
  'confirm_cancel',
] as const;
export type KitchenAction = (typeof KITCHEN_ACTIONS)[number];
export type TaskAction = 'start_task' | 'complete_task' | 'confirm_stop';

export type RejectCode = 'INVALID' | 'FORBIDDEN' | 'NOT_READY' | 'CONFLICT';
export type Decision<T> = { ok: true; value: T } | { ok: false; code: RejectCode };
const ok = <T>(value: T): Decision<T> => ({ ok: true, value });
const reject = <T = never>(code: RejectCode): Decision<T> => ({ ok: false, code });

/** Order states in which kitchen work (tasks, station completion, ready) is accepted. */
export function acceptsWork(order: OrderState): boolean {
  return order === 'accepted' || order === 'in_production';
}
/** Task states that still block confirm_cancel. */
export function blocksCancel(task: TaskState): boolean {
  return task === 'queued' || task === 'in_progress' || task === 'cancel_requested';
}

export interface KitchenCommand {
  action: KitchenAction;
  stationId?: string | undefined;
  taskId?: string | undefined;
  expectedTaskVersion?: number | undefined;
  reason?: string | undefined;
  inventoryDisposition?: string | undefined;
}
export interface TaskSnapshot {
  id: string;
  stationId: string;
  state: TaskState;
  version: number;
}
export type EventKind = 'task_changed' | 'ready' | 'handed_over' | 'cancelled';
export type Step =
  | {
      kind: 'task';
      event: 'task_changed';
      taskId: string;
      stationId: string;
      from: TaskState;
      to: TaskState;
      /** Task version after this step. */
      taskVersion: number;
      /** Order state after this step. */
      order: OrderState;
    }
  | { kind: 'order'; event: 'ready' | 'handed_over' | 'cancelled'; order: OrderState };

export type ReplayDecision = 'execute' | 'replay' | 'conflict';
/** Same command id: same canonical request replays the stored result, another body conflicts. */
export function replayDecision(
  savedRequestHash: string | undefined,
  requestHash: string,
): ReplayDecision {
  if (savedRequestHash === undefined) return 'execute';
  return savedRequestHash === requestHash ? 'replay' : 'conflict';
}

/** Optimistic concurrency for the order aggregate or a task. */
export function checkVersion(actual: number, expected: number): Decision<void> {
  return actual === expected ? ok(undefined) : reject('CONFLICT');
}

export type CommandShape =
  | { kind: 'station'; stationId: string }
  | { kind: 'task'; action: TaskAction; taskId: string; expectedTaskVersion: number }
  | { kind: 'order'; action: 'ready' | 'handoff' | 'confirm_cancel' };
/** Field combinations per action. All shape checks precede any permission or state check. */
export function commandShape(command: KitchenCommand): Decision<CommandShape> {
  if (command.action !== 'complete_station' && command.stationId) return reject('INVALID');
  switch (command.action) {
    case 'complete_station':
      if (
        !command.stationId ||
        command.taskId ||
        command.expectedTaskVersion ||
        command.reason ||
        command.inventoryDisposition
      )
        return reject('INVALID');
      return ok({ kind: 'station', stationId: command.stationId });
    case 'start_task':
    case 'complete_task':
    case 'confirm_stop':
      if (!command.taskId || !command.expectedTaskVersion) return reject('INVALID');
      return ok({
        kind: 'task',
        action: command.action,
        taskId: command.taskId,
        expectedTaskVersion: command.expectedTaskVersion,
      });
    case 'ready':
    case 'handoff':
    case 'confirm_cancel':
      if (command.taskId || command.expectedTaskVersion) return reject('INVALID');
      return ok({ kind: 'order', action: command.action });
  }
}

/** Pure transition of one task. Caller has already checked station permission. */
export function planTask(input: {
  action: TaskAction;
  order: OrderState;
  task: TaskSnapshot;
  expectedTaskVersion: number;
}): Decision<Step[]> {
  const { action, order, task } = input;
  const version = checkVersion(task.version, input.expectedTaskVersion);
  if (!version.ok) return version;
  let to: TaskState;
  if (action === 'confirm_stop') {
    if (order !== 'cancel_requested' || task.state !== 'cancel_requested')
      return reject('NOT_READY');
    to = 'cancelled';
  } else {
    if (!acceptsWork(order)) return reject('NOT_READY');
    if (action === 'start_task') {
      if (task.state !== 'queued') return reject('NOT_READY');
      to = 'in_progress';
    } else {
      if (task.state !== 'in_progress') return reject('NOT_READY');
      to = 'done';
    }
  }
  return ok([
    {
      kind: 'task',
      event: 'task_changed',
      taskId: task.id,
      stationId: task.stationId,
      from: task.state,
      to,
      taskVersion: task.version + 1,
      order: action === 'confirm_stop' ? 'cancel_requested' : 'in_production',
    },
  ]);
}

/**
 * Whole-station completion: every unfinished own task advances through each intermediate state
 * (queued -> in_progress -> done) so the event stream equals single-task commands; the assembly
 * station then makes the order ready. Caller has already checked station permission and should
 * check `acceptsWork` before loading tasks.
 */
export function planCompleteStation(input: {
  order: OrderState;
  assemblyStationId: string;
  stationId: string;
  tasks: readonly TaskSnapshot[];
}): Decision<Step[]> {
  const { order, assemblyStationId, stationId, tasks } = input;
  if (!acceptsWork(order)) return reject('NOT_READY');
  const own = tasks.filter((task) => task.stationId === stationId);
  const assembly = stationId === assemblyStationId;
  if (!assembly && !own.length) return reject('FORBIDDEN');
  if (
    assembly &&
    (!tasks.length || tasks.some((task) => task.stationId !== stationId && task.state !== 'done'))
  )
    return reject('NOT_READY');
  if (own.some((task) => !['queued', 'in_progress', 'done'].includes(task.state)))
    return reject('NOT_READY');
  if (!assembly && own.every((task) => task.state === 'done')) return reject('NOT_READY');
  const steps: Step[] = [];
  for (const task of own) {
    if (task.state === 'done') continue;
    const path: TaskState[] = task.state === 'queued' ? ['in_progress', 'done'] : ['done'];
    let from: TaskState = task.state;
    let taskVersion = task.version;
    for (const to of path) {
      taskVersion++;
      steps.push({
        kind: 'task',
        event: 'task_changed',
        taskId: task.id,
        stationId: task.stationId,
        from,
        to,
        taskVersion,
        order: 'in_production',
      });
      from = to;
    }
  }
  if (assembly) steps.push({ kind: 'order', event: 'ready', order: 'ready' });
  return ok(steps);
}

/** Assembly marks the order ready. Caller has already checked assembly station permission. */
export function planReady(input: {
  order: OrderState;
  tasks: readonly TaskSnapshot[];
}): Decision<Step[]> {
  if (!acceptsWork(input.order)) return reject('NOT_READY');
  if (!input.tasks.length || input.tasks.some((task) => task.state !== 'done'))
    return reject('NOT_READY');
  return ok([{ kind: 'order', event: 'ready', order: 'ready' }]);
}

/** Assembly hands the ready order over. Caller has already checked assembly station permission. */
export function planHandoff(input: { order: OrderState }): Decision<Step[]> {
  if (input.order !== 'ready') return reject('NOT_READY');
  return ok([{ kind: 'order', event: 'handed_over', order: 'handed_over' }]);
}

/** Manager-only check and preconditions before tasks are loaded. */
export function guardConfirmCancel(input: {
  order: OrderState;
  manager: boolean;
  reason?: string | undefined;
  inventoryDisposition?: string | undefined;
}): Decision<void> {
  if (!input.manager) return reject('FORBIDDEN');
  if (input.order !== 'cancel_requested' || !input.reason || !input.inventoryDisposition)
    return reject('NOT_READY');
  return ok(undefined);
}

/** Final cancellation after every task has stopped (done or cancelled). */
export function planConfirmCancel(input: {
  order: OrderState;
  manager: boolean;
  reason?: string | undefined;
  inventoryDisposition?: string | undefined;
  tasks: readonly TaskSnapshot[];
}): Decision<Step[]> {
  const guard = guardConfirmCancel(input);
  if (!guard.ok) return guard;
  if (input.tasks.some((task) => blocksCancel(task.state))) return reject('NOT_READY');
  return ok([{ kind: 'order', event: 'cancelled', order: 'cancelled' }]);
}
