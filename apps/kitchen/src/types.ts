/** Browser boundary mirrors the LAN fulfillment contract; no server-only dependency is shipped. */
export type Credential = {
  session_id: string;
  staff_id: string;
  terminal_id: string;
  branch_id: string;
  role: 'kitchen' | 'shift_manager';
  token: string;
  expires_at: string;
};
export type Station = { id: string; kind: 'prep' | 'assembly'; name: string };
export type Summary = {
  orderId: string;
  branchId: string;
  version: number;
  state:
    | 'held'
    | 'accepted'
    | 'in_production'
    | 'ready'
    | 'handed_over'
    | 'cancel_requested'
    | 'cancelled'
    | 'released';
  displayNumber: string | null;
  routingVersion: number;
  createdAt: string;
  updatedAt: string;
};
export type Task = {
  taskId: string;
  stationId: string;
  version: number;
  state: 'queued' | 'in_progress' | 'done' | 'cancel_requested' | 'cancelled';
  kind: 'prep' | 'assembly_item';
  details: {
    lineId: string;
    productId: string;
    title: string;
    parentTitle: string;
    description: string;
    quantity: number;
    modifiers: {
      groupId: string;
      groupTitle: { ru: string; kk: string };
      optionId: string;
      label: { ru: string; kk: string };
      quantity: number;
      linkedProductId: string | null;
    }[];
  };
};
export type Order = Summary & {
  assemblyStationId: string;
  channel: 'mobile' | 'pos';
  serviceMode: 'takeaway' | 'dine_in';
  tasks: Task[];
};
export type DisplayItem = { number: string; name?: string; state: 'preparing' | 'ready' };
export type Action =
  | {
      action: 'start_task' | 'complete_task' | 'confirm_stop';
      expectedVersion: number;
      taskId: string;
      expectedTaskVersion: number;
    }
  | { action: 'ready' | 'handoff'; expectedVersion: number };
export const prefix = '/edge/v1/fulfillment';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('INVALID_RESPONSE');
  return v as Record<string, unknown>;
}
export function str(v: unknown, max = 250, min = 0): string {
  if (typeof v !== 'string' || v.length > max || v.length < min)
    throw new Error('INVALID_RESPONSE');
  return v;
}
export function uuid(v: unknown): string {
  const s = str(v, 36, 36);
  if (!UUID.test(s)) throw new Error('INVALID_RESPONSE');
  return s;
}
export function int(v: unknown, max = 2147483647): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > max)
    throw new Error('INVALID_RESPONSE');
  return v;
}
export function choice<T extends string>(v: unknown, values: readonly T[]): T {
  if (typeof v !== 'string' || !values.includes(v as T)) throw new Error('INVALID_RESPONSE');
  return v as T;
}
function date(v: unknown) {
  const s = str(v, 40, 20);
  if (!/^\d{4}-\d\d-\d\dT/.test(s) || !Number.isFinite(Date.parse(s)))
    throw new Error('INVALID_RESPONSE');
  return s;
}
function number(v: unknown) {
  const s = str(v, 19, 1);
  if (!/^[1-9]\d*$/.test(s) || BigInt(s) > 9223372036854775807n)
    throw new Error('INVALID_RESPONSE');
  return s;
}
function array<T>(v: unknown, max: number, parse: (v: unknown) => T): T[] {
  if (!Array.isArray(v) || v.length > max) throw new Error('INVALID_RESPONSE');
  return v.map(parse);
}
function unique(values: string[]) {
  if (new Set(values).size !== values.length) throw new Error('INVALID_RESPONSE');
}
export function credential(v: unknown): Credential {
  const o = record(v),
    token = str(o.token, 64, 64);
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('INVALID_CREDENTIAL');
  return {
    session_id: uuid(o.session_id),
    staff_id: uuid(o.staff_id),
    terminal_id: uuid(o.terminal_id),
    branch_id: uuid(o.branch_id),
    role: choice(o.role, ['kitchen', 'shift_manager']),
    token,
    expires_at: date(o.expires_at),
  };
}
export function stations(v: unknown, branch: string): Station[] {
  const o = record(v);
  if (uuid(o.branchId) !== branch) throw new Error('SCOPE_MISMATCH');
  const items = array(o.items, 100, (x) => {
    const s = record(x);
    return {
      id: uuid(s.id),
      kind: choice(s.kind, ['prep', 'assembly']),
      name: str(s.name, 160, 1),
    };
  });
  unique(items.map((i) => i.id));
  return items;
}
export function summary(v: unknown, branch: string): Summary {
  const o = record(v);
  if (uuid(o.branchId) !== branch) throw new Error('SCOPE_MISMATCH');
  return {
    orderId: uuid(o.orderId),
    branchId: branch,
    version: int(o.version),
    state: choice(o.state, [
      'held',
      'accepted',
      'in_production',
      'ready',
      'handed_over',
      'cancel_requested',
      'cancelled',
      'released',
    ]),
    displayNumber: o.displayNumber === null ? null : number(o.displayNumber),
    routingVersion: int(o.routingVersion),
    createdAt: date(o.createdAt),
    updatedAt: date(o.updatedAt),
  };
}
function names(v: unknown) {
  const o = record(v);
  return { ru: str(o.ru), kk: str(o.kk) };
}
export function order(v: unknown, branch: string): Order {
  const o = record(v);
  const tasks = array(o.tasks, 2000, (input) => {
    const t = record(input),
      d = record(t.details);
    return {
      taskId: uuid(t.taskId),
      stationId: uuid(t.stationId),
      version: int(t.version),
      state: choice(t.state, ['queued', 'in_progress', 'done', 'cancel_requested', 'cancelled']),
      kind: choice(t.kind, ['prep', 'assembly_item']),
      details: {
        lineId: uuid(d.lineId),
        productId: str(d.productId, 160, 1),
        title: str(d.title, 250, 1),
        parentTitle: str(d.parentTitle),
        description: str(d.description, 2000),
        quantity: int(d.quantity, 1000000),
        modifiers: array(d.modifiers, 100, (v) => {
          const m = record(v);
          return {
            groupId: str(m.groupId, 160, 1),
            groupTitle: names(m.groupTitle),
            optionId: str(m.optionId, 160, 1),
            label: names(m.label),
            quantity: int(m.quantity, 1000000),
            linkedProductId: m.linkedProductId === null ? null : str(m.linkedProductId, 160, 1),
          };
        }),
      },
    };
  });
  unique(tasks.map((t) => t.taskId));
  return {
    ...summary(o, branch),
    assemblyStationId: uuid(o.assemblyStationId),
    channel: choice(o.channel, ['mobile', 'pos']),
    serviceMode: choice(o.serviceMode, ['takeaway', 'dine_in']),
    tasks,
  };
}
export function kitchenPage(v: unknown, branch: string) {
  const o = record(v),
    items = array(o.items, 100, (x) => order(x, branch));
  unique(items.map((i) => i.orderId));
  return { items, next: o.nextAfterOrderId === null ? null : uuid(o.nextAfterOrderId) };
}
export function displayPage(v: unknown) {
  const o = record(v);
  const items = array(o.items, 100, (x) => {
    const i = record(x);
    if (Object.keys(i).some((k) => !['number', 'state', 'name'].includes(k)))
      throw new Error('INVALID_RESPONSE');
    return {
      number: number(i.number),
      ...(i.name === undefined ? {} : { name: str(i.name, 14) }),
      state: choice(i.state, ['preparing', 'ready']),
    };
  });
  unique(items.map((i) => i.number));
  return { items, next: o.nextAfterNumber === null ? null : number(o.nextAfterNumber) };
}
export function action(v: unknown): Action {
  const a = record(v),
    name = choice(a.action, ['start_task', 'complete_task', 'confirm_stop', 'ready', 'handoff']);
  if (name === 'ready' || name === 'handoff')
    return { action: name, expectedVersion: int(a.expectedVersion) };
  return {
    action: name,
    expectedVersion: int(a.expectedVersion),
    taskId: uuid(a.taskId),
    expectedTaskVersion: int(a.expectedTaskVersion),
  };
}
