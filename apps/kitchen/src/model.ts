import { ApiError } from './api.js';
import type { Transport } from './api.js';
import {
  credential,
  stations,
  kitchenPage,
  displayPage,
  summary,
  order,
  record,
  uuid,
  action,
  prefix,
} from './types.js';
import type { Credential, Station, Order, DisplayItem, Action } from './types.js';
export interface StoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export type Pending = {
  version: 1;
  scope: string;
  orderId: string;
  stationId: string;
  key: string;
  body: Action;
};
export type State = {
  actor: Credential | null;
  stations: Station[];
  stationId: string | null;
  mode: 'kitchen' | 'display';
  orders: Order[];
  display: DisplayItem[];
  next: string | null;
  cursor: string | null;
  pending: Pending | null;
  conflict: boolean;
  reviewed: Order | null;
  busy: boolean;
  error: string | null;
  lastSync: number | null;
  storageBlocked: boolean;
  lease: boolean;
};
export type Lease = (name: string) => Promise<(() => void) | null>;
const authKey = 'pickchick.kitchen.credential.v1';
const scope = (c: Credential) => `${c.branch_id}.${c.staff_id}.${c.terminal_id}`;
export const journalKey = (c: Credential) => 'pickchick.kitchen.pending.v1.' + scope(c);
export function parsePending(v: unknown, c: Credential): Pending {
  const p = record(v);
  if (p.version !== 1 || p.scope !== scope(c)) throw new Error('JOURNAL_INVALID');
  return {
    version: 1,
    scope: scope(c),
    orderId: uuid(p.orderId),
    stationId: uuid(p.stationId),
    key: uuid(p.key),
    body: action(p.body),
  };
}
class StaleOperation extends Error {}
export class KitchenModel {
  state: State = {
    actor: null,
    stations: [],
    stationId: null,
    mode: 'kitchen',
    orders: [],
    display: [],
    next: null,
    cursor: null,
    pending: null,
    conflict: false,
    reviewed: null,
    busy: false,
    error: null,
    lastSync: null,
    storageBlocked: false,
    lease: false,
  };
  private release: (() => void) | null = null;
  private allOrders: Order[] = [];
  private epoch = 0;
  constructor(
    private transport: Transport,
    private session: StoragePort,
    private durable: StoragePort,
    private acquire: Lease,
    private changed: () => void = () => {},
    private newId: () => string = () => crypto.randomUUID(),
  ) {}
  private async call(...args: Parameters<Transport>) {
    const epoch = this.epoch;
    try {
      const value = await this.transport(...args);
      if (epoch !== this.epoch) throw new StaleOperation();
      return value;
    } catch (error) {
      if (epoch !== this.epoch) throw new StaleOperation();
      throw error;
    }
  }
  private emit() {
    this.changed();
  }
  private fail(error: unknown) {
    this.state.error =
      error instanceof ApiError
        ? error.code
        : error instanceof Error
          ? error.message
          : 'REQUEST_FAILED';
    if (
      error instanceof ApiError &&
      error.validated &&
      ((error.status === 401 && ['UNAUTHORIZED', 'SESSION_EXPIRED'].includes(error.code)) ||
        (error.status === 403 && error.code === 'FORBIDDEN'))
    ) {
      this.forget();
    }
  }
  private forget() {
    this.epoch++;
    this.state.busy = false;
    try {
      this.session.removeItem(authKey);
    } catch {
      /* fail closed in memory */
    }
    this.release?.();
    this.release = null;
    this.allOrders = [];
    Object.assign(this.state, {
      actor: null,
      orders: [],
      display: [],
      stations: [],
      lastSync: null,
      lease: false,
    });
  }
  private async run(fn: () => Promise<void>) {
    if (this.state.busy) return;
    const epoch = this.epoch;
    this.state.busy = true;
    this.state.error = null;
    this.emit();
    try {
      await fn();
    } catch (e) {
      if (epoch === this.epoch) this.fail(e);
    } finally {
      if (epoch === this.epoch) {
        this.state.busy = false;
        this.emit();
      } else if (!this.state.actor) this.emit();
    }
  }
  async restore() {
    await this.run(async () => {
      let raw: string | null;
      try {
        raw = this.session.getItem(authKey);
      } catch {
        throw new Error('STORAGE_UNAVAILABLE');
      }
      if (raw) await this.signIn(credential(JSON.parse(raw)));
    });
  }
  async importCredential(raw: string) {
    await this.run(async () => {
      if (raw.length > 4096) throw new Error('INVALID_CREDENTIAL');
      await this.signIn(credential(JSON.parse(raw)));
    });
  }
  private async signIn(c: Credential) {
    const epoch = this.epoch;
    if (Date.parse(c.expires_at) <= Date.now()) throw new Error('SESSION_EXPIRED');
    const enabled = record(await this.call(prefix + '/config', null));
    if (enabled.enabled !== true) throw new Error('FULFILLMENT_DISABLED');
    const list = stations(await this.call(prefix + '/stations', c), c.branch_id);
    this.release?.();
    this.release = null;
    this.state.lease = false;
    const release = await this.acquire(scope(c));
    if (epoch !== this.epoch) {
      release?.();
      throw new StaleOperation();
    }
    if (!release) throw new Error('OTHER_WINDOW');
    this.release = release;
    try {
      this.session.setItem(authKey, JSON.stringify(c));
      if (this.session.getItem(authKey) !== JSON.stringify(c)) throw new Error();
    } catch {
      this.release();
      this.release = null;
      throw new Error('STORAGE_UNAVAILABLE');
    }
    Object.assign(this.state, {
      actor: c,
      stations: list,
      stationId: list[0]?.id ?? null,
      orders: [],
      display: [],
      cursor: null,
      next: null,
      pending: null,
      conflict: false,
      reviewed: null,
      storageBlocked: false,
      lease: true,
    });
    try {
      const raw = this.durable.getItem(journalKey(c));
      if (raw) {
        const pending = parsePending(JSON.parse(raw), c);
        this.state.pending = pending;
        this.state.stationId = pending.stationId;
      }
    } catch {
      this.state.storageBlocked = true;
      throw new Error('JOURNAL_INVALID');
    }
    await this.read();
  }
  logout() {
    this.forget();
    this.state.error = null;
    this.emit();
  }
  async refresh() {
    await this.run(() => this.read());
  }
  private async read() {
    const c = this.state.actor;
    if (!c) return;
    if (Date.parse(c.expires_at) <= Date.now()) throw new ApiError('SESSION_EXPIRED', 401, true);
    const all: Order[] = [],
      display: DisplayItem[] = [],
      seen = new Set<string>();
    let cursor: string | null = null,
      bytes = 0,
      pages = 0;
    const started = Date.now();
    do {
      if (++pages > 100 || Date.now() - started > 20000) throw new Error('QUEUE_BOUND_EXCEEDED');
      const q = new URLSearchParams({ limit: '100' });
      if (this.state.mode === 'display') {
        if (cursor) q.set('afterNumber', cursor);
        const page = displayPage(await this.call(prefix + '/display?' + q, c));
        for (const i of page.items) {
          if (seen.has(i.number)) throw new Error('INVALID_RESPONSE');
          seen.add(i.number);
          display.push(i);
        }
        bytes += JSON.stringify(page.items).length;
        cursor = page.next;
      } else {
        const station = this.state.stationId;
        if (!station) throw new Error('NO_STATIONS');
        q.set('stationId', station);
        if (cursor) q.set('afterOrderId', cursor);
        const page = kitchenPage(await this.call(prefix + '/kitchen?' + q, c), c.branch_id);
        for (const i of page.items) {
          if (seen.has(i.orderId)) throw new Error('INVALID_RESPONSE');
          seen.add(i.orderId);
          all.push(i);
        }
        bytes += JSON.stringify(page.items).length;
        cursor = page.next;
      }
      if (bytes > 50 * 1024 * 1024 || seen.size > 10000) throw new Error('QUEUE_BOUND_EXCEEDED');
    } while (cursor);
    this.allOrders = all.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.orderId.localeCompare(b.orderId),
    );
    this.state.display = display;
    this.projectPage();
    this.state.lastSync = Date.now();
  }
  async selectStation(id: string) {
    if (this.state.pending) return;
    await this.run(async () => {
      if (!this.state.stations.some((s) => s.id === id)) throw new Error('INVALID_STATION');
      this.state.stationId = id;
      this.state.cursor = null;
      this.state.orders = [];
      await this.read();
    });
  }
  async selectMode(mode: 'kitchen' | 'display') {
    if (this.state.pending) return;
    await this.run(async () => {
      this.state.mode = mode;
      this.state.cursor = null;
      this.state.orders = [];
      this.state.display = [];
      await this.read();
    });
  }
  private projectPage() {
    const start = this.state.cursor
      ? this.allOrders.findIndex((o) => o.orderId === this.state.cursor!) + 1
      : 0;
    const offset = start < 0 ? 0 : start;
    this.state.orders = this.allOrders.slice(offset, offset + 50);
    this.state.next =
      offset + 50 < this.allOrders.length ? this.state.orders.at(-1)!.orderId : null;
  }
  async page(first = false) {
    if (this.state.busy) return;
    this.state.cursor = first ? null : this.state.next;
    this.projectPage();
    this.emit();
  }
  private persist(p: Pending) {
    const c = this.state.actor;
    if (!c) throw new Error('UNAUTHENTICATED');
    try {
      const raw = JSON.stringify(p);
      this.durable.setItem(journalKey(c), raw);
      if (this.durable.getItem(journalKey(c)) !== raw) throw new Error();
    } catch {
      this.state.storageBlocked = true;
      throw new Error('STORAGE_UNAVAILABLE');
    }
    this.state.pending = p;
    this.emit();
  }
  private clearPending() {
    const c = this.state.actor;
    if (!c) throw new Error('UNAUTHENTICATED');
    try {
      this.durable.removeItem(journalKey(c));
      if (this.durable.getItem(journalKey(c)) !== null) throw new Error();
    } catch {
      this.state.storageBlocked = true;
      throw new Error('STORAGE_UNAVAILABLE');
    }
    this.state.pending = null;
    this.state.conflict = false;
    this.state.reviewed = null;
  }
  async command(o: Order, body: Action) {
    await this.run(async () => {
      const c = this.state.actor,
        s = this.state.stationId;
      if (!c || !s || !this.state.lease || this.state.pending || this.state.storageBlocked)
        throw new Error('RECOVERY_REQUIRED');
      if (
        !this.state.orders.some(
          (current) => current.orderId === o.orderId && current.version === o.version,
        ) ||
        !allowedActions(o, s).some((a) => JSON.stringify(a) === JSON.stringify(body))
      )
        throw new Error('ACTION_UNAVAILABLE');
      const old = this.durable.getItem(journalKey(c));
      if (old) throw new Error('RECOVERY_REQUIRED');
      this.persist({
        version: 1,
        scope: scope(c),
        orderId: o.orderId,
        stationId: s,
        key: this.newId(),
        body: action(body),
      });
      await this.sendPending();
    });
  }
  private async sendPending() {
    const c = this.state.actor,
      p = this.state.pending;
    if (!c || !p || !this.state.lease || this.state.storageBlocked)
      throw new Error('RECOVERY_REQUIRED');
    const raw = this.durable.getItem(journalKey(c));
    if (!raw || JSON.stringify(parsePending(JSON.parse(raw), c)) !== JSON.stringify(p))
      throw new Error('JOURNAL_CHANGED');
    try {
      const result = summary(
        await this.call(`${prefix}/orders/${p.orderId}/actions`, c, p.body, p.key),
        c.branch_id,
      );
      if (result.orderId !== p.orderId) throw new Error('INVALID_RESPONSE');
      this.clearPending();
      await this.read();
    } catch (e) {
      if (e instanceof ApiError && e.validated && e.status === 409 && e.code === 'CONFLICT') {
        this.state.conflict = true;
        await this.review();
      }
      throw e;
    }
  }
  async retry() {
    await this.run(async () => {
      if (this.state.conflict) throw new Error('REVIEW_REQUIRED');
      await this.sendPending();
    });
  }
  private async review() {
    const c = this.state.actor,
      p = this.state.pending;
    if (!c || !p) return;
    this.state.reviewed = order(
      await this.call(`${prefix}/orders/${p.orderId}?stationId=${p.stationId}`, c),
      c.branch_id,
    );
  }
  async reviewConflict() {
    await this.run(async () => {
      if (!this.state.conflict) throw new Error('REVIEW_REQUIRED');
      await this.review();
    });
  }
  async acknowledgeConflict() {
    await this.run(async () => {
      if (!this.state.conflict || !this.state.reviewed) throw new Error('REVIEW_REQUIRED');
      this.clearPending();
      await this.read();
    });
  }
}
export function allowedActions(o: Order, station: string): Action[] {
  const result: Action[] = [];
  for (const t of o.tasks) {
    if (t.stationId !== station) continue;
    const action =
      t.state === 'queued' && ['accepted', 'in_production'].includes(o.state)
        ? 'start_task'
        : t.state === 'in_progress' && o.state === 'in_production'
          ? 'complete_task'
          : t.state === 'cancel_requested' && o.state === 'cancel_requested'
            ? 'confirm_stop'
            : null;
    if (action)
      result.push({
        action,
        expectedVersion: o.version,
        taskId: t.taskId,
        expectedTaskVersion: t.version,
      });
  }
  if (o.assemblyStationId === station) {
    if (o.state === 'in_production' && o.tasks.every((t) => t.state === 'done'))
      result.push({ action: 'ready', expectedVersion: o.version });
    if (o.state === 'ready') result.push({ action: 'handoff', expectedVersion: o.version });
  }
  return result;
}

/** Each LED column rotates independently so a short queue never disappears on another column's later page. */
export function displayWindow(items: DisplayItem[], page: number) {
  const preparing = items.filter((i) => i.state === 'preparing'),
    ready = items.filter((i) => i.state === 'ready');
  const preparingPages = Math.max(1, Math.ceil(preparing.length / 6)),
    readyPages = Math.max(1, Math.ceil(ready.length / 4));
  const pages = Math.max(preparingPages, readyPages),
    current = page % pages;
  return {
    pages,
    page: current,
    preparing: preparing.slice((current % preparingPages) * 6, (current % preparingPages) * 6 + 6),
    ready: ready.slice((current % readyPages) * 4, (current % readyPages) * 4 + 4),
  };
}
