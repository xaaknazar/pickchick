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
