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
  choice,
  prefix,
  cloudPrefix,
} from './types.js';
import type { Credential, Station, Order, DisplayItem, Action } from './types.js';
export interface StoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
/** Who executes an order: the cashier edge, or the cloud for kiosk/mobile (ADR-0014). */
export type Owner = 'edge' | 'cloud';
/** `signed_out`: the stream needs its own sign-in (cook login for the cashier, code for the server). */
export type StreamStatus = 'online' | 'offline' | 'unknown' | 'signed_out';
/** A cloud kitchen screen bound by a one-time code; its key never reaches the browser. */
export type Screen = {
  screenId: string;
  branchId: string;
  role: 'prep' | 'assembly' | 'display';
  stationIds: string[];
};
export type Pending = {
  version: 1;
  scope: string;
  orderId: string;
  stationId: string;
  key: string;
  body: Action;
  /** Present only in the separate cloud journal; edge journal entries keep the old shape. */
  owner?: 'cloud';
};
export type State = {
  wholeTicketActions: boolean;
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
  /** Cloud kitchen stream configured by the portal; false keeps the edge-only behaviour. */
  cloud: boolean;
  streams: Record<Owner, StreamStatus>;
  /** The portal reports a screen cookie for this page; `screen` is set once the cloud confirms. */
  screenPaired: boolean;
  screen: Screen | null;
  screenLease: boolean;
  cloudPending: Pending | null;
  cloudConflict: boolean;
  cloudReviewed: Order | null;
};
export type Lease = (name: string) => Promise<(() => void) | null>;
const authKey = 'pickchick.kitchen.credential.v1';
const scope = (c: Credential) => `${c.branch_id}.${c.staff_id}.${c.terminal_id}`;
export const screenScope = (s: Pick<Screen, 'branchId' | 'screenId'>) =>
  `screen.${s.branchId}.${s.screenId}`;
export const journalKey = (c: Credential) => 'pickchick.kitchen.pending.v1.' + scope(c);
/** Each owner keeps its own durable journal: a stuck cashier command never blocks cloud work. */
export const screenJournalKey = (s: Pick<Screen, 'branchId' | 'screenId'>) =>
  'pickchick.kitchen.pending.v1.cloud.' + screenScope(s);
export const ownerOf = (o: Pick<Order, 'fulfillmentOwner'>): Owner =>
  o.fulfillmentOwner === 'cloud' ? 'cloud' : 'edge';
export function parsePending(v: unknown, c: Credential | string, owner: Owner = 'edge'): Pending {
  const p = record(v);
  const expected = typeof c === 'string' ? c : scope(c);
  if (
    p.version !== 1 ||
    p.scope !== expected ||
    (owner === 'cloud' ? p.owner !== 'cloud' : p.owner !== undefined)
  )
    throw new Error('JOURNAL_INVALID');
  const body = action(p.body);
  if (body.action === 'complete_station' && body.stationId !== p.stationId)
    throw new Error('JOURNAL_INVALID');
  return {
    version: 1,
    scope: expected,
    orderId: uuid(p.orderId),
    stationId: uuid(p.stationId),
    key: uuid(p.key),
    body,
    ...(owner === 'cloud' ? { owner: 'cloud' as const } : {}),
  };
}
export function screen(v: unknown): Screen {
  const o = record(v);
  if (!Array.isArray(o.stationIds) || o.stationIds.length > 100)
    throw new Error('INVALID_RESPONSE');
  return {
    screenId: uuid(o.screenId),
    branchId: uuid(o.branchId),
    role: choice(o.role, ['prep', 'assembly', 'display']),
    stationIds: o.stationIds.map(uuid),
  };
}
class StaleOperation extends Error {}
/** The cloud rejected this browser's screen (revoked or rotated): pair again with a new code. */
class ScreenRevoked extends Error {
  constructor() {
    super('SCREEN_REVOKED');
  }
}
const revokedSession = (e: unknown) =>
  e instanceof ApiError &&
  e.validated &&
  ((e.status === 401 && ['UNAUTHORIZED', 'SESSION_EXPIRED'].includes(e.code)) ||
    (e.status === 403 && e.code === 'FORBIDDEN'));
export class KitchenModel {
  state: State = {
    wholeTicketActions: false,
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
    cloud: false,
    streams: { edge: 'unknown', cloud: 'unknown' },
    screenPaired: false,
    screen: null,
    screenLease: false,
    cloudPending: null,
    cloudConflict: false,
    cloudReviewed: null,
  };
  private streamOrders: Record<Owner, Order[]> = { edge: [], cloud: [] };
  private streamDisplay: Record<Owner, DisplayItem[]> = { edge: [], cloud: [] };
  private edgeStations: Station[] = [];
  private cloudStations: Station[] = [];
  private release: (() => void) | null = null;
  private screenRelease: (() => void) | null = null;
  /** Cloud mode: a paired customer display reads the cashier's numbers with its device cookie. */
  edgeDevice: () => boolean = () => false;
  /** Cook session restored while the cashier was away; retried on refresh (cloud mode only). */
  private deferredCook: Credential | null = null;
  private allOrders: Order[] = [];
  private epoch = 0;
  private snapshotScope: string | null = null;
  constructor(
    private transport: Transport,
    private session: StoragePort,
    private durable: StoragePort,
    private acquire: Lease,
    private changed: () => void = () => {},
    private newId: () => string = () => crypto.randomUUID(),
  ) {}
  private scopeKey() {
    const c = this.state.actor,
      sc = this.state.screen;
    if (!c && !sc) return null;
    if (!this.state.cloud)
      return `${this.epoch}:${scope(c!)}:${c!.session_id}:${this.state.mode}:${this.state.stationId ?? ''}`;
    return `${this.epoch}:${c ? scope(c) + ':' + c.session_id : '-'}:${sc ? sc.screenId : '-'}:${this.state.mode}:${this.state.stationId ?? ''}`;
  }
  /** Called once from the portal config before any session is restored. */
  enableCloud(paired = false) {
    this.state.cloud = true;
    this.state.screenPaired = paired;
    this.state.streams = { edge: 'signed_out', cloud: paired ? 'unknown' : 'signed_out' };
  }
  /** Something is signed in that can show orders: a cook (edge) or a cloud screen. */
  get active() {
    return !!this.state.actor || (this.state.cloud && this.state.screenPaired);
  }
  private branch() {
    return this.state.screen?.branchId ?? this.state.actor?.branch_id ?? null;
  }
  private slot(owner: Owner) {
    const s = this.state;
    return owner === 'cloud'
      ? { pending: s.cloudPending, conflict: s.cloudConflict, reviewed: s.cloudReviewed }
      : { pending: s.pending, conflict: s.conflict, reviewed: s.reviewed };
  }
  private setSlot(
    owner: Owner,
    patch: Partial<{ pending: Pending | null; conflict: boolean; reviewed: Order | null }>,
  ) {
    const s = this.state;
    if (owner === 'cloud') {
      if ('pending' in patch) s.cloudPending = patch.pending!;
      if ('conflict' in patch) s.cloudConflict = patch.conflict!;
      if ('reviewed' in patch) s.cloudReviewed = patch.reviewed!;
    } else {
      if ('pending' in patch) s.pending = patch.pending!;
      if ('conflict' in patch) s.conflict = patch.conflict!;
      if ('reviewed' in patch) s.reviewed = patch.reviewed!;
    }
  }
  /** Journal identity per owner: cook scope for the cashier, screen scope for the cloud. */
  private journal(owner: Owner) {
    if (owner === 'cloud') {
      const sc = this.state.screen;
      return sc && this.state.screenLease
        ? { key: screenJournalKey(sc), scope: screenScope(sc), actor: null }
        : null;
    }
    const c = this.state.actor;
    return c && this.state.lease ? { key: journalKey(c), scope: scope(c), actor: c } : null;
  }
  private resetSnapshot() {
    this.snapshotScope = null;
    this.allOrders = [];
    this.streamOrders = { edge: [], cloud: [] };
    this.streamDisplay = { edge: [], cloud: [] };
    Object.assign(this.state, {
      orders: [],
      display: [],
      cursor: null,
      next: null,
      lastSync: null,
    });
  }
  /** Cloud mode: stations of both identities, preparation first; keeps a still-valid choice. */
  private mergeStations() {
    const list = [...this.edgeStations];
    for (const s of this.cloudStations) if (!list.some((k) => k.id === s.id)) list.push(s);
    this.state.stations = list;
    if (!list.some((s) => s.id === this.state.stationId))
      this.state.stationId =
        list.find((station) => station.kind === 'prep')?.id ?? list[0]?.id ?? null;
  }
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
  /** Cloud requests: a validated 401 means this screen is no longer bound. */
  private async cloudCall(path: string, body?: unknown, key?: string) {
    try {
      return await this.call(path, null, body, key);
    } catch (error) {
      if (error instanceof ApiError && error.validated && error.status === 401)
        throw new ScreenRevoked();
      throw error;
    }
  }
  private emit() {
    this.changed();
  }
  private fail(error: unknown) {
    if (error instanceof ScreenRevoked) {
      this.forgetScreen();
      this.state.error = 'SCREEN_REVOKED';
      return;
    }
    this.state.error =
      error instanceof ApiError
        ? error.code
        : error instanceof Error
          ? error.message
          : 'REQUEST_FAILED';
    if (revokedSession(error)) this.forget();
  }
  private forget() {
    this.epoch++;
    this.state.busy = false;
    this.deferredCook = null;
    try {
      this.session.removeItem(authKey);
    } catch {
      /* fail closed in memory */
    }
    this.release?.();
    this.release = null;
    this.resetSnapshot();
    Object.assign(this.state, {
      actor: null,
      orders: [],
      display: [],
      stations: [],
      lastSync: null,
      lease: false,
    });
    if (this.state.cloud) {
      // The cloud screen keeps working without the cook.
      this.edgeStations = [];
      this.mergeStations();
      this.state.streams.edge = 'signed_out';
    }
  }
  private forgetScreen() {
    this.epoch++;
    this.state.busy = false;
    this.screenRelease?.();
    this.screenRelease = null;
    this.cloudStations = [];
    this.resetSnapshot();
    // The durable cloud journal stays on the device; it is shown again after re-pairing.
    Object.assign(this.state, {
      screen: null,
      screenPaired: false,
      screenLease: false,
      cloudPending: null,
      cloudConflict: false,
      cloudReviewed: null,
    });
    this.state.streams.cloud = 'signed_out';
    this.mergeStations();
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
      } else if (!this.state.actor || (this.state.cloud && !this.state.screen)) this.emit();
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
      if (!raw) return;
      const c = credential(JSON.parse(raw));
      if (!this.state.cloud) {
        await this.signIn(c);
        return;
      }
      try {
        await this.signIn(c);
      } catch (error) {
        // Cashier away: the cloud screen goes on; the cook session is retried on refresh.
        if (revokedSession(error) || error instanceof StaleOperation) throw error;
        this.deferredCook = c;
        this.state.streams.edge = 'offline';
      }
    });
  }
  async importCredential(raw: string) {
    await this.run(async () => {
      if (raw.length > 4096) throw new Error('INVALID_CREDENTIAL');
      await this.signIn(credential(JSON.parse(raw)));
    });
  }
  retryLoginAt = 0;
  async signInWithPassword(login: string, password: string, terminalId: string | undefined) {
    await this.run(async () => {
      try {
        uuid(terminalId);
      } catch {
        throw new Error('TERMINAL_NOT_CONFIGURED');
      }
      if (Date.now() < this.retryLoginAt) throw new ApiError('AUTH_RATE_LIMITED', 429);
      const account = login.trim().toLowerCase();
      if (
        !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(account) ||
        password.length < 12 ||
        password.length > 128
      )
        throw new Error('INVALID_LOGIN');
      let c: Credential;
      try {
        c = credential(
          await this.call('/edge/v1/staff/login', null, {
            login: account,
            password,
            terminal_id: terminalId,
          }),
        );
      } catch (error) {
        if (error instanceof ApiError && error.code === 'AUTH_RATE_LIMITED')
          this.retryLoginAt = Date.now() + (error.retryAfterSeconds || 60) * 1000;
        throw error;
      }
      if (c.terminal_id !== terminalId) throw new Error('SCOPE_MISMATCH');
      const session = credential({
        ...record(await this.call('/edge/v1/session', c)),
        token: c.token,
      });
      if (
        Object.keys(c).some(
          (key) => c[key as keyof Credential] !== session[key as keyof Credential],
        )
      )
        throw new Error('SCOPE_MISMATCH');
      await this.signIn(c);
      this.retryLoginAt = 0;
    });
  }
  private async signIn(c: Credential) {
    const epoch = this.epoch;
    if (Date.parse(c.expires_at) <= Date.now()) throw new Error('SESSION_EXPIRED');
    if (this.state.screen && this.state.screen.branchId !== c.branch_id)
      throw new Error('SCOPE_MISMATCH');
    const enabled = record(await this.call(prefix + '/config', null));
    if (enabled.enabled !== true) throw new Error('FULFILLMENT_DISABLED');
    // Cloud orders use whole-ticket actions; with the cloud stream the page uses them for both.
    this.state.wholeTicketActions = this.state.cloud || enabled.wholeTicketActions === true;
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
    this.deferredCook = null;
    if (this.state.cloud) {
      this.edgeStations = list;
      Object.assign(this.state, {
        actor: c,
        pending: null,
        conflict: false,
        reviewed: null,
        storageBlocked: false,
        lease: true,
      });
      this.mergeStations();
    } else
      Object.assign(this.state, {
        actor: c,
        stations: list,
        stationId: list.find((station) => station.kind === 'prep')?.id ?? list[0]?.id ?? null,
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
    this.resetSnapshot();
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
  /** Re-reads the cloud binding of this page (portal cookie, checked by the cloud). */
  async restoreScreen() {
    await this.run(async () => {
      if (!this.state.cloud || !this.state.screenPaired) return;
      await this.attachScreen(screen(await this.cloudCall('/cloud/session')));
    });
  }
  /** One-time code from the back office -> this browser becomes a cloud kitchen screen. */
  async pairScreen(code: string, role: Screen['role']) {
    await this.run(async () => {
      const text = code.trim();
      if (!/^[0-9A-Za-z]{10}$/.test(text.replace(/[\s-]/g, '')))
        throw new Error('INVALID_PAIRING_CODE');
      let bound: Screen;
      try {
        bound = screen(await this.call('/cloud/pair', null, { code: text }));
      } catch (error) {
        if (error instanceof ApiError && error.validated) {
          if (error.status === 401) throw new Error('PAIRING_REJECTED', { cause: error });
          if (error.status === 409) throw new Error('PAIRING_WRONG_SCREEN', { cause: error });
          if (error.status === 429) throw new Error('PAIRING_RATE_LIMITED', { cause: error });
        }
        throw error;
      }
      if (bound.role !== role) throw new Error('PAIRING_WRONG_SCREEN');
      this.state.screenPaired = true;
      await this.attachScreen(bound);
    });
  }
  private async attachScreen(sc: Screen) {
    const epoch = this.epoch;
    if (this.state.actor && this.state.actor.branch_id !== sc.branchId)
      throw new Error('SCOPE_MISMATCH');
    const list =
      sc.role === 'display'
        ? []
        : stations(await this.cloudCall(cloudPrefix + '/stations'), sc.branchId);
    this.screenRelease?.();
    this.screenRelease = null;
    this.state.screenLease = false;
    const release = await this.acquire(screenScope(sc));
    if (epoch !== this.epoch) {
      release?.();
      throw new StaleOperation();
    }
    if (!release) throw new Error('OTHER_WINDOW');
    this.screenRelease = release;
    this.cloudStations = list;
    this.state.wholeTicketActions = true;
    Object.assign(this.state, {
      screen: sc,
      screenPaired: true,
      screenLease: true,
      cloudPending: null,
      cloudConflict: false,
      cloudReviewed: null,
    });
    this.mergeStations();
    if (sc.role === 'display') this.state.mode = 'display';
    this.resetSnapshot();
    try {
      const raw = this.durable.getItem(screenJournalKey(sc));
      if (raw) {
        const pending = parsePending(JSON.parse(raw), screenScope(sc), 'cloud');
        this.state.cloudPending = pending;
        this.state.stationId = pending.stationId;
      }
    } catch {
      this.state.storageBlocked = true;
      throw new Error('JOURNAL_INVALID');
    }
    await this.read();
  }
  logout() {
    const actor = this.state.actor;
    this.forget();
    if (actor) void this.transport('/edge/v1/staff/logout', actor).catch(() => {});
    this.state.error = null;
    this.emit();
  }
  async refresh() {
    await this.run(async () => {
      if (this.state.cloud) {
        // Bindings that could not be confirmed earlier are retried before reading.
        if (this.state.screenPaired && !this.state.screen)
          try {
            await this.attachScreen(screen(await this.cloudCall('/cloud/session')));
            return;
          } catch (error) {
            if (error instanceof ScreenRevoked || error instanceof StaleOperation) throw error;
            this.state.streams.cloud = 'offline';
          }
        if (this.deferredCook && !this.state.actor) {
          const c = this.deferredCook;
          try {
            await this.signIn(c);
            return;
          } catch (error) {
            if (revokedSession(error) || error instanceof StaleOperation) throw error;
            this.state.streams.edge = 'offline';
          }
        }
      }
      await this.read();
    });
  }
  private async read() {
    const c = this.state.actor;
    if (!this.state.cloud) {
      if (!c) return;
      if (Date.parse(c.expires_at) <= Date.now()) throw new ApiError('SESSION_EXPIRED', 401, true);
      const edge = await this.readStream(prefix, c, c.branch_id);
      this.publish(edge.orders, edge.display);
      return;
    }
    const sc = this.state.screen;
    if (c && Date.parse(c.expires_at) <= Date.now())
      throw new ApiError('SESSION_EXPIRED', 401, true);
    const device = !c && this.state.mode === 'display' && this.edgeDevice();
    if (!c && !sc) return;
    const branch = this.branch()!;
    if (this.snapshotScope !== this.scopeKey()) {
      this.streamOrders = { edge: [], cloud: [] };
      this.streamDisplay = { edge: [], cloud: [] };
    }
    const skip = Promise.resolve(null);
    const [edge, cloud] = await Promise.allSettled([
      c || device ? this.readStream(prefix, c, branch) : skip,
      sc ? this.readStream(cloudPrefix, null, branch) : skip,
    ]);
    for (const result of [edge, cloud])
      if (result.status === 'rejected' && result.reason instanceof StaleOperation)
        throw result.reason;
    if (edge.status === 'rejected' && c && revokedSession(edge.reason)) throw edge.reason;
    if (cloud.status === 'rejected' && cloud.reason instanceof ScreenRevoked) throw cloud.reason;
    const status = (r: PromiseSettledResult<unknown>, signedIn: boolean, deferred = false) =>
      !signedIn
        ? deferred
          ? 'offline'
          : 'signed_out'
        : r.status === 'fulfilled'
          ? 'online'
          : 'offline';
    this.state.streams = {
      edge: status(edge, !!c || device, !!this.deferredCook),
      cloud: status(cloud, !!sc, this.state.screenPaired),
    };
    const failed = [edge, cloud].filter((r) => r.status === 'rejected');
    const succeeded = [edge, cloud].filter((r) => r.status === 'fulfilled' && r.value);
    if (!succeeded.length && failed.length) throw (failed[0] as PromiseRejectedResult).reason;
    // The unreachable stream keeps its last orders visible; its actions are blocked in the UI.
    for (const [owner, result, signedIn] of [
      ['edge', edge, !!c || device],
      ['cloud', cloud, !!sc],
    ] as const) {
      if (!signedIn) {
        this.streamOrders[owner] = [];
        this.streamDisplay[owner] = [];
      } else if (result.status === 'fulfilled' && result.value) {
        this.streamOrders[owner] = result.value.orders.map((o) =>
          owner === 'cloud' ? { ...o, fulfillmentOwner: 'cloud' as const } : o,
        );
        this.streamDisplay[owner] = result.value.display;
      }
    }
    // One ticket per orderId: the cloud copy is authoritative for orders the cloud owns.
    const cloudIds = new Set(this.streamOrders.cloud.map((o) => o.orderId));
    const numbers = new Set(this.streamDisplay.edge.map((i) => i.number));
    this.publish(
      [
        ...this.streamOrders.cloud,
        ...this.streamOrders.edge.filter((o) => !cloudIds.has(o.orderId)),
      ],
      [
        ...this.streamDisplay.edge,
        ...this.streamDisplay.cloud.filter((i) => !numbers.has(i.number)),
      ],
    );
  }
  private publish(all: Order[], display: DisplayItem[]) {
    this.allOrders = all.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.orderId.localeCompare(b.orderId),
    );
    this.state.display = display;
    this.snapshotScope = this.scopeKey();
    this.projectPage();
    this.state.lastSync = Date.now();
  }
  private async readStream(base: string, c: Credential | null, branch: string) {
    const get = (path: string) =>
      c ? this.call(path, c) : base === cloudPrefix ? this.cloudCall(path) : this.call(path, null);
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
        const page = displayPage(await get(base + '/display?' + q));
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
        const page = kitchenPage(await get(base + '/kitchen?' + q), branch);
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
    return { orders: all, display };
  }
  async selectStation(id: string) {
    if (this.state.pending || this.state.cloudPending) return;
    await this.run(async () => {
      if (!this.state.stations.some((s) => s.id === id)) throw new Error('INVALID_STATION');
      this.state.stationId = id;
      this.resetSnapshot();
      await this.read();
    });
  }
  async selectMode(mode: 'kitchen' | 'display') {
    if (this.state.pending || this.state.cloudPending) return;
    await this.run(async () => {
      this.state.mode = mode;
      this.resetSnapshot();
      await this.read();
    });
  }
  private projectPage() {
    if (!this.snapshotScope || this.snapshotScope !== this.scopeKey()) {
      this.resetSnapshot();
      return;
    }
    const start = this.state.cursor
      ? this.allOrders.findIndex((o) => o.orderId === this.state.cursor!) + 1
      : 0;
    const offset = start < 0 ? 0 : start;
    this.state.orders = this.allOrders.slice(offset, offset + 50);
    this.state.next =
      offset + 50 < this.allOrders.length ? this.state.orders.at(-1)!.orderId : null;
  }
  async page(first = false) {
    if (this.state.busy || !this.snapshotScope || this.snapshotScope !== this.scopeKey()) return;
    this.state.cursor = first ? null : this.state.next;
    this.projectPage();
    this.emit();
  }
  private persist(owner: Owner, p: Pending) {
    const j = this.journal(owner);
    if (!j) throw new Error('UNAUTHENTICATED');
    try {
      const raw = JSON.stringify(p);
      this.durable.setItem(j.key, raw);
      if (this.durable.getItem(j.key) !== raw) throw new Error();
    } catch {
      this.state.storageBlocked = true;
      throw new Error('STORAGE_UNAVAILABLE');
    }
    this.setSlot(owner, { pending: p });
    this.emit();
  }
  private clearPending(owner: Owner) {
    const j = this.journal(owner);
    if (!j) throw new Error('UNAUTHENTICATED');
    try {
      this.durable.removeItem(j.key);
      if (this.durable.getItem(j.key) !== null) throw new Error();
    } catch {
      this.state.storageBlocked = true;
      throw new Error('STORAGE_UNAVAILABLE');
    }
    this.setSlot(owner, { pending: null, conflict: false, reviewed: null });
  }
  /** True when this order's owner stream is known to be unreachable right now. */
  ownerOffline(o: Pick<Order, 'fulfillmentOwner'>) {
    return this.state.cloud && this.state.streams[ownerOf(o)] !== 'online';
  }
  async command(o: Order, body: Action) {
    await this.run(async () => {
      const s = this.state.stationId,
        owner = ownerOf(o);
      if (owner === 'cloud' && !this.state.cloud) throw new Error('ACTION_UNAVAILABLE');
      const j = this.journal(owner);
      if (!j || !s || this.slot(owner).pending || this.state.storageBlocked)
        throw new Error(
          !j && owner === 'edge' && this.state.cloud ? 'COOK_LOGIN_REQUIRED' : 'RECOVERY_REQUIRED',
        );
      if (this.ownerOffline(o))
        throw new Error(owner === 'cloud' ? 'CLOUD_OFFLINE' : 'EDGE_OFFLINE');
      if (
        !this.state.orders.some(
          (current) =>
            current.orderId === o.orderId &&
            current.version === o.version &&
            ownerOf(current) === owner,
        ) ||
        !allowedActions(o, s, this.state.wholeTicketActions).some(
          (a) => JSON.stringify(a) === JSON.stringify(body),
        )
      )
        throw new Error('ACTION_UNAVAILABLE');
      const old = this.durable.getItem(j.key);
      if (old) throw new Error('RECOVERY_REQUIRED');
      this.persist(owner, {
        version: 1,
        scope: j.scope,
        orderId: o.orderId,
        stationId: s,
        key: this.newId(),
        body: action(body),
        ...(owner === 'cloud' ? { owner: 'cloud' as const } : {}),
      });
      await this.sendPending(owner);
    });
  }
  private async sendPending(owner: Owner) {
    const j = this.journal(owner),
      p = this.slot(owner).pending;
    if (!j || !p || this.state.storageBlocked) throw new Error('RECOVERY_REQUIRED');
    const raw = this.durable.getItem(j.key);
    if (!raw || JSON.stringify(parsePending(JSON.parse(raw), j.scope, owner)) !== JSON.stringify(p))
      throw new Error('JOURNAL_CHANGED');
    // Exactly one owner receives a command: the journal decides, never a fallback.
    try {
      const path = `${owner === 'cloud' ? cloudPrefix : prefix}/orders/${p.orderId}/actions`;
      const result = summary(
        j.actor
          ? await this.call(path, j.actor, p.body, p.key)
          : await this.cloudCall(path, p.body, p.key),
        this.branch()!,
      );
      if (result.orderId !== p.orderId) throw new Error('INVALID_RESPONSE');
      this.clearPending(owner);
      await this.read();
    } catch (e) {
      if (e instanceof ApiError && e.validated && e.status === 409 && e.code === 'CONFLICT') {
        this.setSlot(owner, { conflict: true });
        await this.review(owner);
      }
      throw e;
    }
  }
  async retry(owner: Owner = 'edge') {
    await this.run(async () => {
      if (this.slot(owner).conflict) throw new Error('REVIEW_REQUIRED');
      await this.sendPending(owner);
    });
  }
  private async review(owner: Owner) {
    const j = this.journal(owner),
      p = this.slot(owner).pending;
    if (!j || !p) return;
    const path = `${owner === 'cloud' ? cloudPrefix : prefix}/orders/${p.orderId}?stationId=${p.stationId}`;
    const reviewed = order(
      j.actor ? await this.call(path, j.actor) : await this.cloudCall(path),
      this.branch()!,
    );
    this.setSlot(owner, {
      reviewed: owner === 'cloud' ? { ...reviewed, fulfillmentOwner: 'cloud' } : reviewed,
    });
  }
  async reviewConflict(owner: Owner = 'edge') {
    await this.run(async () => {
      if (!this.slot(owner).conflict) throw new Error('REVIEW_REQUIRED');
      await this.review(owner);
    });
  }
  async acknowledgeConflict(owner: Owner = 'edge') {
    await this.run(async () => {
      const slot = this.slot(owner);
      if (!slot.conflict || !slot.reviewed) throw new Error('REVIEW_REQUIRED');
      this.clearPending(owner);
      await this.read();
    });
  }
}
export function allowedActions(o: Order, station: string, wholeTicketActions = false): Action[] {
  if (wholeTicketActions && ['accepted', 'in_production'].includes(o.state)) {
    const own = o.tasks.filter((t) => t.stationId === station);
    const assembly = o.assemblyStationId === station;
    const permitted = assembly
      ? o.tasks.length > 0 && o.tasks.every((t) => t.stationId === station || t.state === 'done')
      : own.some((t) => ['queued', 'in_progress'].includes(t.state));
    if (permitted && own.every((t) => ['queued', 'in_progress', 'done'].includes(t.state)))
      return [{ action: 'complete_station', expectedVersion: o.version, stationId: station }];
    return [];
  }
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
