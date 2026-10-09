import { ApiError, type Request } from './api.js';
export type Data = Record<string, unknown>;
export type Entry = {
  id: string;
  kind: string;
  revision: number;
  payload: Data;
  updated_at: string;
};
export type ReportFilters = { startDate?: string; endDate?: string; shiftId?: string };
export type Snapshot = {
  schema_version: 1;
  branch_id: string;
  role: string;
  as_of: string;
  period_start: string;
  period: string;
  period_end?: string;
  timezone?: string;
  availability?: Data;
  truncated?: Data;
  cashier_shifts?: Data[];
  cashier_orders?: Data[];
  cashier_metrics?: Data;
  selected_shift?: Data | null;
  coverage?: Data;
  operational_shift_filter?: Data;
  records: Entry[];
  stock: Data[];
  orders: Data[];
  pos: Data[];
  metrics: Data;
  chart: Data[];
  finance: Data[];
  refunds: Data[];
  issues: Data[];
  devices: Data[];
  kitchen: Data[];
  guests: Data[];
  audit: Data[];
  catalog_audit: Data[];
  documents: Data[];
  publications: Data[];
  capabilities: Data;
};
export type OperationalApi = (path: string, request?: Request) => Promise<unknown>;
type Pending = {
  actor: string;
  branch: string;
  request: { request_id: string; reason: string; command: Data };
};
const KEY = 'pickchick.backoffice.operations.v1';
/**
 * The legacy table offers revocation only for non-edge, non-kiosk devices still active or pending.
 * Revoking the branch edge (cashier node) cannot be undone and stops the whole branch exchange;
 * kiosks are revoked through the device registry, which also disables kiosk_devices.
 */
export function deviceRevocable(device: Data): boolean {
  return (
    typeof device['kind'] === 'string' &&
    !['edge', 'kiosk'].includes(device['kind']) &&
    device['status'] !== 'revoked'
  );
}
export function object(value: unknown): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError('INVALID_RESPONSE');
  return value as Data;
}
function snapshot(value: unknown, branch: string): Snapshot {
  const o = object(value);
  if (
    o['schema_version'] !== 1 ||
    o['branch_id'] !== branch ||
    typeof o['as_of'] !== 'string' ||
    !['manager', 'analyst'].includes(String(o['role']))
  )
    throw new ApiError('INVALID_RESPONSE');
  for (const k of [
    'records',
    'stock',
    'orders',
    'pos',
    'chart',
    'finance',
    'refunds',
    'issues',
    'devices',
    'kitchen',
    'guests',
    'audit',
    'catalog_audit',
    'documents',
    'publications',
  ])
    if (!Array.isArray(o[k])) throw new ApiError('INVALID_RESPONSE');
  object(o['metrics']);
  object(o['capabilities']);
  return o as Snapshot;
}
export class OperationsModel {
  data: Snapshot | null = null;
  busy = false;
  error: unknown = null;
  pending: Pending | null = null;
  actor = '';
  branch = '';
  period = 'day';
  filters: ReportFilters = {};
  private generation = 0;
  constructor(
    private api: OperationalApi,
    private store: Storage,
    private changed: () => void,
  ) {}
  private key() {
    return KEY + ':' + this.actor;
  }
  clear() {
    this.generation++;
    this.data = null;
    this.actor = '';
    this.branch = '';
    this.period = 'day';
    this.filters = {};
    this.busy = false;
    this.pending = null;
    this.error = null;
  }
  async load(
    actor: string,
    branch: string,
    period = this.period,
    filters: ReportFilters = this.filters,
  ) {
    const changedScope = actor !== this.actor || branch !== this.branch;
    if (changedScope && filters.shiftId) {
      filters = { ...filters };
      delete filters.shiftId;
    }
    if (this.pending && changedScope && actor === this.actor) throw new ApiError('PENDING');
    const changedWindow =
      period !== this.period || JSON.stringify(filters) !== JSON.stringify(this.filters);
    if (changedWindow) this.data = null;
    if (changedScope) {
      this.data = null;
      this.pending = null;
    }
    this.actor = actor;
    this.branch = branch;
    this.period = period;
    this.filters = { ...filters };
    const generation = ++this.generation;
    this.busy = true;
    this.error = null;
    try {
      const raw = this.store.getItem(this.key());
      if (raw) {
        const p = object(JSON.parse(raw));
        const r = object(p['request']);
        if (
          p['actor'] !== actor ||
          typeof p['branch'] !== 'string' ||
          typeof r['request_id'] !== 'string' ||
          typeof r['reason'] !== 'string' ||
          !r['command']
        )
          throw new ApiError('CORRUPTED');
        this.pending = p as Pending;
      }
      this.changed();
      const query = new URLSearchParams({ period });
      if (period === 'custom') {
        if (filters.startDate) query.set('start_date', filters.startDate);
        if (filters.endDate) query.set('end_date', filters.endDate);
      }
      if (filters.shiftId) query.set('shift_id', filters.shiftId);
      const value = await this.api(`branches/${branch}?${query.toString()}`);
      if (generation === this.generation) this.data = snapshot(value, branch);
    } catch (e) {
      if (generation === this.generation) {
        this.error = e;
        if (e instanceof ApiError && [401, 403].includes(e.status)) this.data = null;
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.changed();
      }
    }
  }
  async execute(command: Data, reason: string) {
    if (this.busy || this.pending) throw new ApiError('PENDING');
    if (this.data?.role !== 'manager') throw new ApiError('FORBIDDEN');
    const pending = {
      actor: this.actor,
      branch: this.branch,
      request: { request_id: crypto.randomUUID(), reason, command },
    };
    // The exact request is durable before the first HTTP byte is sent.
    try {
      this.store.setItem(this.key(), JSON.stringify(pending));
    } catch {
      throw new ApiError('STORAGE');
    }
    this.pending = pending;
    return this.recover();
  }
  async recover() {
    if (!this.pending || this.busy) return false;
    const p = this.pending;
    if (p.actor !== this.actor) throw new ApiError('FORBIDDEN');
    const generation = this.generation;
    this.busy = true;
    this.error = null;
    this.changed();
    let success = false;
    try {
      await this.api(`branches/${p.branch}/commands`, { method: 'POST', body: p.request });
      if (generation !== this.generation) return false;
      this.store.removeItem(this.key());
      this.pending = null;
      success = true;
    } catch (e) {
      if (generation !== this.generation) return false;
      this.error = e;
      if (e instanceof ApiError && [401, 403].includes(e.status)) this.data = null;
      if (e instanceof ApiError && [400, 403, 404, 409, 413].includes(e.status)) {
        this.store.removeItem(this.key());
        this.pending = null;
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.changed();
      }
    }
    if (success) await this.load(this.actor, this.branch);
    return success;
  }
  entries(kind: string) {
    return this.data?.records.filter((r) => r.kind === kind) ?? [];
  }
  async order(id: string) {
    const generation = this.generation;
    const value = await this.api(`branches/${this.branch}/orders/${id}`);
    if (generation !== this.generation) throw new ApiError('FORBIDDEN');
    return object(value);
  }
}

export type StopDuration = 'manual' | 'hour' | 'shift';
export type StopRef = { product_id: string; group_id?: string; option_id?: string };
export type StopPending = {
  command_id: string;
  stopped: boolean;
  duration: StopDuration;
  state: 'pending' | 'delivered';
  actor_label: string;
  created_at: string | null;
  expires_at: string | null;
};
export type StopResult = {
  command_id: string;
  stopped: boolean;
  state: string;
  result_version: number | null;
  actor_label: string;
  created_at: string | null;
  resolved_at: string | null;
};
export type StopItem = {
  catalog_ref: StopRef;
  variant_id: string;
  kind: 'product' | 'option';
  name_ru: string;
  product_name_ru: string;
  group_name_ru: string | null;
  listed: boolean;
  stopped: boolean;
  version: number | null;
  source: 'pos' | 'backoffice' | null;
  expires_at: string | null;
  shift_scoped: boolean;
  sales_blocked: boolean;
  pending: StopPending | null;
  last_result: StopResult | null;
};
/** Stop list v2 (GET .../stops): published catalog rows with the cashier state per variant. */
export type StopList = {
  schema_version: 2;
  branch_id: string;
  role: 'manager' | 'analyst';
  as_of: string;
  remote_stops: { enabled: boolean; edge_ready: boolean; writable: boolean };
  catalog: { version: number; published_at: string } | null;
  availability: {
    device_id: string | null;
    revision: string | null;
    observed_at: string | null;
    fresh: boolean;
    stopped_count: number;
    states_reported: boolean;
  };
  items: StopItem[];
  unknown_stops: {
    variant_id: string;
    name_ru: string | null;
    kind: string | null;
    version: number | null;
    source: 'pos' | 'backoffice' | null;
    expires_at: string | null;
    shift_scoped: boolean;
  }[];
};
const nullableString = (v: unknown) => v === null || typeof v === 'string';
const nullableVersion = (v: unknown) => v === null || (Number.isInteger(v) && (v as number) >= 0);
function stopPending(v: unknown): StopPending | null {
  if (v === null) return null;
  const o = object(v);
  if (
    typeof o['command_id'] !== 'string' ||
    typeof o['stopped'] !== 'boolean' ||
    !['manual', 'hour', 'shift'].includes(String(o['duration'])) ||
    !['pending', 'delivered'].includes(String(o['state'])) ||
    typeof o['actor_label'] !== 'string' ||
    !nullableString(o['created_at']) ||
    !nullableString(o['expires_at'])
  )
    throw new ApiError('INVALID_RESPONSE');
  return o as StopPending;
}
function stopResult(v: unknown): StopResult | null {
  if (v === null) return null;
  const o = object(v);
  if (
    typeof o['command_id'] !== 'string' ||
    typeof o['stopped'] !== 'boolean' ||
    typeof o['state'] !== 'string' ||
    !nullableVersion(o['result_version']) ||
    typeof o['actor_label'] !== 'string' ||
    !nullableString(o['created_at']) ||
    !nullableString(o['resolved_at'])
  )
    throw new ApiError('INVALID_RESPONSE');
  return o as StopResult;
}
export function stopList(value: unknown, branch: string): StopList {
  const o = object(value);
  const remote = object(o['remote_stops']),
    availability = object(o['availability']);
  if (
    o['schema_version'] !== 2 ||
    o['branch_id'] !== branch ||
    !['manager', 'analyst'].includes(String(o['role'])) ||
    typeof o['as_of'] !== 'string' ||
    typeof remote['enabled'] !== 'boolean' ||
    typeof remote['edge_ready'] !== 'boolean' ||
    typeof remote['writable'] !== 'boolean' ||
    typeof availability['fresh'] !== 'boolean' ||
    !nullableString(availability['observed_at']) ||
    !Array.isArray(o['items']) ||
    !Array.isArray(o['unknown_stops']) ||
    (o['catalog'] !== null &&
      (!Number.isInteger(object(o['catalog'])['version']) ||
        typeof object(o['catalog'])['published_at'] !== 'string'))
  )
    throw new ApiError('INVALID_RESPONSE');
  for (const raw of o['items'] as unknown[]) {
    const item = object(raw),
      ref = object(item['catalog_ref']);
    if (
      typeof ref['product_id'] !== 'string' ||
      (ref['group_id'] === undefined) !== (ref['option_id'] === undefined) ||
      typeof item['variant_id'] !== 'string' ||
      !['product', 'option'].includes(String(item['kind'])) ||
      typeof item['name_ru'] !== 'string' ||
      typeof item['product_name_ru'] !== 'string' ||
      !nullableString(item['group_name_ru']) ||
      typeof item['listed'] !== 'boolean' ||
      typeof item['stopped'] !== 'boolean' ||
      typeof item['sales_blocked'] !== 'boolean' ||
      !nullableVersion(item['version']) ||
      !nullableString(item['expires_at'])
    )
      throw new ApiError('INVALID_RESPONSE');
    item['pending'] = stopPending(item['pending'] ?? null);
    item['last_result'] = stopResult(item['last_result'] ?? null);
  }
  for (const raw of o['unknown_stops'] as unknown[]) {
    const s = object(raw);
    if (typeof s['variant_id'] !== 'string' || !nullableString(s['name_ru']))
      throw new ApiError('INVALID_RESPONSE');
  }
  return o as unknown as StopList;
}
export type StopIntent = { stopped: boolean; duration: StopDuration; reason: string };
/** Reason sent when the manager leaves it empty: the API requires 3-300 characters. */
export const defaultStopReason = (stopped: boolean) =>
  stopped ? 'Стоп из кабинета управляющего' : 'Возврат в продажу из кабинета управляющего';
/** Polling cadence: fast while a command waits for the cashier, slow otherwise. */
export const STOP_POLL_FAST_MS = 2000,
  STOP_POLL_SLOW_MS = 10000;
/**
 * Back-office stop/unstop commands for the cashier edge. The edge stays the source of truth:
 * a command only queues intent with the row's expected_version; the list shows the verdict.
 */
export class StopsModel {
  data: StopList | null = null;
  busy = false;
  error: unknown = null;
  /** The API has no v2 stop list (older deployment): the v1 snapshot view is used instead. */
  unsupported = false;
  actor = '';
  branch = '';
  /** Start of the latest load (ms); polling waits nextDelay() from here. */
  loadedAt = 0;
  private generation = 0;
  /** Request ids are reused for an identical retry after a lost reply (server idempotency). */
  private sent = new Map<string, { body: string; requestId: string }>();
  constructor(
    private api: OperationalApi,
    private changed: () => void,
    private requestId = () => crypto.randomUUID(),
  ) {}
  clear() {
    this.generation++;
    this.data = null;
    this.busy = false;
    this.error = null;
    this.unsupported = false;
    this.actor = '';
    this.branch = '';
    this.loadedAt = 0;
    this.sent.clear();
  }
  get waiting() {
    return Boolean(this.data?.items.some((item) => item.pending));
  }
  nextDelay() {
    return this.waiting ? STOP_POLL_FAST_MS : STOP_POLL_SLOW_MS;
  }
  async load(actor: string, branch: string) {
    if (actor !== this.actor || branch !== this.branch) {
      this.clear();
      this.actor = actor;
      this.branch = branch;
    }
    const generation = ++this.generation;
    this.busy = true;
    this.loadedAt = Date.now();
    try {
      const value = await this.api(`branches/${branch}/stops`);
      if (generation !== this.generation) return;
      this.data = stopList(value, branch);
      this.unsupported = false;
      this.error = null;
    } catch (e) {
      if (generation !== this.generation) return;
      if (e instanceof ApiError && e.status === 404 && !e.reason) {
        this.unsupported = true;
        this.data = null;
        this.error = null;
      } else {
        this.error = e;
        if (e instanceof ApiError && [401, 403].includes(e.status)) this.data = null;
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.changed();
      }
    }
  }
  /** Queues one command; the row turns pending at once and polling picks up the verdict. */
  async request(item: StopItem, intent: StopIntent) {
    const data = this.data;
    if (!data || data.branch_id !== this.branch) throw new ApiError('INVALID_REQUEST');
    if (!data.remote_stops.enabled)
      throw new ApiError('SERVICE_UNAVAILABLE', 0, 'REMOTE_STOPS_DISABLED');
    if (data.role !== 'manager') throw new ApiError('FORBIDDEN', 0, 'STOP_FORBIDDEN');
    if (item.pending) throw new ApiError('CONFLICT', 0, 'STOP_COMMAND_IN_PROGRESS');
    if (item.version === null || !item.listed)
      throw new ApiError('NOT_READY', 0, 'EDGE_STOPS_NOT_READY');
    const reason =
      intent.reason.trim().length >= 3 ? intent.reason.trim() : defaultStopReason(intent.stopped);
    const fields = {
      catalog_ref: item.catalog_ref,
      stopped: intent.stopped,
      duration: intent.stopped ? intent.duration : 'manual',
      reason: reason.slice(0, 300),
      expected_version: item.version,
    };
    const body = JSON.stringify(fields);
    const previous = this.sent.get(item.variant_id);
    const requestId = previous?.body === body ? previous.requestId : this.requestId();
    this.sent.set(item.variant_id, { body, requestId });
    const branch = this.branch,
      generation = this.generation;
    let result: Data;
    try {
      result = object(
        await this.api(`branches/${branch}/stops`, {
          method: 'POST',
          body: { request_id: requestId, ...fields },
        }),
      );
    } catch (e) {
      // A definitive answer ends this attempt; a lost reply keeps the id for an exact retry.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500)
        this.sent.delete(item.variant_id);
      if (e instanceof ApiError && e.code === 'FORBIDDEN' && !e.reason)
        throw new ApiError('FORBIDDEN', e.status, 'STOP_FORBIDDEN');
      throw e;
    }
    this.sent.delete(item.variant_id);
    if (generation !== this.generation || branch !== this.branch) return false;
    const row = this.data?.items.find((v) => v.variant_id === item.variant_id);
    if (row && typeof result['command_id'] === 'string')
      row.pending = {
        command_id: result['command_id'],
        stopped: fields.stopped,
        duration: fields.duration as StopDuration,
        state: 'pending',
        actor_label: 'Вы',
        created_at: typeof result['created_at'] === 'string' ? result['created_at'] : null,
        expires_at: typeof result['expires_at'] === 'string' ? result['expires_at'] : null,
      };
    this.changed();
    void this.load(this.actor, branch);
    return true;
  }
}
