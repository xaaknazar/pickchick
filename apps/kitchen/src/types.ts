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
/** KDS station functions (contracts section 2.3); the station numbers of the kitchen rules. */
export const KDS_FUNCTIONS = [
  'breading',
  'toasts',
  'assembly_hall',
  'assembly_delivery',
  'issue',
  'delivery_handover',
] as const;
export type KdsFunction = (typeof KDS_FUNCTIONS)[number];
/** details.kds of a task: only while the edge KDS layout is on (contracts section 5.4). */
export type TaskKds = {
  function: KdsFunction;
  upstreamOf?: string;
  units?: number;
  unit?: 'finger' | 'toast' | 'burger';
  fingers?: number;
  unmapped?: true;
};
/** Aggregator order of a ticket (snapshot.delivery); only while the KDS layout is on. */
export type Delivery = { provider: 'yandex_eda' | 'glovo'; externalNumber: string };
/** GET fulfillment/layout with enabled:true; enabled:false or 404 is today's screen (null). */
export type KdsLayout = {
  layoutVersion: number;
  mode: 'morning' | 'normal' | 'peak';
  stations: { id: string; function: KdsFunction; name: string; kind: 'prep' | 'assembly' }[];
  /** Stations of this terminal, at most two (tabs). */
  screens: string[];
};
export type BreadingOrder = {
  orderId: string;
  displayNumber: string | null;
  serviceMode: 'takeaway' | 'dine_in';
  delivery?: Delivery;
  lines: { title: string; quantity: number; fingers?: number }[];
  fingers?: number;
};
export type Breading = { orders: BreadingOrder[]; totalFingers?: number };
export const INCIDENT_KINDS = [
  'number_mismatch',
  'not_accepted_in_app',
  'no_photo',
  'courier_refused',
  'other',
] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];
export type IncidentProvider = 'yandex_eda' | 'glovo' | 'other';
export type Incident = {
  incidentId: string;
  provider: IncidentProvider;
  claimedNumber: string | null;
  kind: IncidentKind;
  description: string;
  recordedAt: string;
  displayNumber?: string;
};
/** The three courier handover marks of Аг9; the edge requires all of them. */
export type Handover = { numberMatched: true; courierAccepted: true; photoTaken: true };
export const HANDOVER_MARKS: Handover = Object.freeze({
  numberMatched: true,
  courierAccepted: true,
  photoTaken: true,
});
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
    kds?: TaskKds;
  };
};
export type Order = Summary & {
  assemblyStationId: string;
  channel: 'mobile' | 'kiosk' | 'pos';
  serviceMode: 'takeaway' | 'dine_in';
  kitchenComment?: string;
  delivery?: Delivery;
  restoreReview?: { epoch: number; status: 'pending' | 'resume' | 'retire' };
  tasks: Task[];
  /** Set by the model for orders read from the cloud stream (never taken from the payload). */
  fulfillmentOwner?: 'edge' | 'cloud';
};
export type DisplayItem = { number: string; name?: string; state: 'preparing' | 'ready' };
export type Action =
  | {
      action: 'start_task' | 'complete_task' | 'confirm_stop';
      expectedVersion: number;
      taskId: string;
      expectedTaskVersion: number;
    }
  | { action: 'ready'; expectedVersion: number }
  | { action: 'handoff'; expectedVersion: number; handover?: Handover }
  | { action: 'complete_station'; expectedVersion: number; stationId: string };
export const prefix = '/edge/v1/fulfillment';
/** Portal route to the cloud kitchen stream (same contract, ADR-0014). */
export const cloudPrefix = '/cloud/v1/fulfillment';
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
        ...(d.kds === undefined ? {} : { kds: taskKds(d.kds) }),
      },
    };
  });
  unique(tasks.map((t) => t.taskId));
  return {
    ...summary(o, branch),
    assemblyStationId: uuid(o.assemblyStationId),
    channel: choice(o.channel, ['mobile', 'kiosk', 'pos']),
    serviceMode: choice(o.serviceMode, ['takeaway', 'dine_in']),
    ...(o.kitchenComment === undefined ? {} : { kitchenComment: str(o.kitchenComment, 60) }),
    ...(o.delivery === undefined ? {} : { delivery: delivery(o.delivery) }),
    ...(o.restoreReview === undefined
      ? {}
      : {
          restoreReview: {
            epoch: int(record(o.restoreReview).epoch),
            status: choice(record(o.restoreReview).status, ['pending', 'resume', 'retire']),
          },
        }),
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
  // Two live orders may share a number (release fixes 19.10, audit 1.4): never refuse the page,
  // only exact repeats are dropped.
  const seen = new Set<string>();
  const distinct = items.filter((i) => {
    const key = i.number + ':' + i.state + ':' + (i.name ?? '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { items: distinct, next: o.nextAfterNumber === null ? null : number(o.nextAfterNumber) };
}
export function action(v: unknown): Action {
  const a = record(v),
    name = choice(a.action, [
      'start_task',
      'complete_task',
      'confirm_stop',
      'ready',
      'handoff',
      'complete_station',
    ]);
  if (name === 'complete_station')
    return { action: name, expectedVersion: int(a.expectedVersion), stationId: uuid(a.stationId) };
  if (name === 'ready') return { action: name, expectedVersion: int(a.expectedVersion) };
  if (name === 'handoff')
    return {
      action: name,
      expectedVersion: int(a.expectedVersion),
      ...(a.handover === undefined ? {} : { handover: handover(a.handover) }),
    };
  return {
    action: name,
    expectedVersion: int(a.expectedVersion),
    taskId: uuid(a.taskId),
    expectedTaskVersion: int(a.expectedTaskVersion),
  };
}

// Cutover KDS (contracts section 5.4). New payloads exist only while the edge KDS layout is on;
// unknown keys are ignored like in order(), known keys are checked.
function count(v: unknown, max = 1_000_000) {
  return int(v, max);
}
/** All three marks, each exactly true; any other value is not a courier handover. */
export function handover(v: unknown): Handover {
  const h = record(v);
  if (
    Object.keys(h).sort().join(',') !== 'courierAccepted,numberMatched,photoTaken' ||
    h.numberMatched !== true ||
    h.courierAccepted !== true ||
    h.photoTaken !== true
  )
    throw new Error('INVALID_RESPONSE');
  return { numberMatched: true, courierAccepted: true, photoTaken: true };
}
export function delivery(v: unknown): Delivery {
  const d = record(v),
    externalNumber = str(d.externalNumber, 40, 3);
  if (!/^[A-Z0-9-]{3,40}$/.test(externalNumber)) throw new Error('INVALID_RESPONSE');
  return { provider: choice(d.provider, ['yandex_eda', 'glovo']), externalNumber };
}
export function taskKds(v: unknown): TaskKds {
  const k = record(v);
  if (k.unmapped !== undefined && k.unmapped !== true) throw new Error('INVALID_RESPONSE');
  return {
    function: choice(k.function, KDS_FUNCTIONS),
    ...(k.upstreamOf === undefined ? {} : { upstreamOf: uuid(k.upstreamOf) }),
    ...(k.units === undefined ? {} : { units: count(k.units) }),
    ...(k.unit === undefined ? {} : { unit: choice(k.unit, ['finger', 'toast', 'burger']) }),
    ...(k.fingers === undefined ? {} : { fingers: count(k.fingers) }),
    ...(k.unmapped === true ? { unmapped: true as const } : {}),
  };
}
/** GET fulfillment/layout: null for {enabled:false}; screens are distinct layout stations. */
export function kdsLayout(v: unknown): KdsLayout | null {
  const o = record(v);
  if (o.enabled === false) return null;
  if (o.enabled !== true) throw new Error('INVALID_RESPONSE');
  const list = array(o.stations, 6, (x) => {
    const s = record(x);
    return {
      id: uuid(s.id),
      function: choice(s.function, KDS_FUNCTIONS),
      name: str(s.name, 100, 1),
      kind: choice(s.kind, ['prep', 'assembly']),
    };
  });
  if (!list.length) throw new Error('INVALID_RESPONSE');
  unique(list.map((s) => s.id));
  unique(list.map((s) => s.function));
  const screens = array(o.screens, 2, uuid);
  unique(screens);
  if (screens.some((id) => !list.some((s) => s.id === id))) throw new Error('INVALID_RESPONSE');
  return {
    layoutVersion: int(o.layoutVersion),
    mode: choice(o.mode, ['morning', 'normal', 'peak']),
    stations: list,
    screens,
  };
}
/** GET fulfillment/kds/breading (station 6 view). */
export function breading(v: unknown): Breading {
  const o = record(v);
  const orders = array(o.orders, 100, (x) => {
    const b = record(x);
    return {
      orderId: uuid(b.orderId),
      displayNumber: b.displayNumber === null ? null : number(b.displayNumber),
      serviceMode: choice(b.serviceMode, ['takeaway', 'dine_in']),
      ...(b.delivery === undefined ? {} : { delivery: delivery(b.delivery) }),
      lines: array(b.lines, 2000, (y) => {
        const l = record(y);
        return {
          title: str(l.title, 250, 1),
          quantity: count(l.quantity),
          ...(l.fingers === undefined ? {} : { fingers: count(l.fingers) }),
        };
      }),
      ...(b.fingers === undefined ? {} : { fingers: count(b.fingers, 100_000_000) }),
    };
  });
  unique(orders.map((b) => b.orderId));
  let totalFingers: number | undefined;
  if (o.totalFingers !== undefined) {
    if (
      typeof o.totalFingers !== 'number' ||
      !Number.isSafeInteger(o.totalFingers) ||
      o.totalFingers < 0
    )
      throw new Error('INVALID_RESPONSE');
    totalFingers = o.totalFingers;
  }
  return { orders, ...(totalFingers === undefined ? {} : { totalFingers }) };
}
export function incident(v: unknown): Incident {
  const i = record(v);
  return {
    incidentId: uuid(i.incidentId),
    provider: choice(i.provider, ['yandex_eda', 'glovo', 'other']),
    claimedNumber: i.claimedNumber === null ? null : str(i.claimedNumber, 40, 1),
    kind: choice(i.kind, INCIDENT_KINDS),
    description: str(i.description, 500, 3),
    recordedAt: date(i.recordedAt),
    ...(i.displayNumber === undefined ? {} : { displayNumber: number(i.displayNumber) }),
  };
}
/** GET fulfillment/incidents?scope=open|today, newest first. */
export function incidents(v: unknown): Incident[] {
  const items = array(record(v).items, 200, incident);
  unique(items.map((i) => i.incidentId));
  return items;
}
