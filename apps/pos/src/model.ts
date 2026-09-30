import * as parse from './types.js';
import type {
  Cart,
  LocalOrder,
  MenuSnapshot,
  Quote,
  StaffCredential,
  StaffSession,
  Stop,
  Ordering,
  CashShift,
  Selection,
} from './types.js';
import { ApiError, passwordTransport, type PasswordTransport, type Transport } from './api.js';
export type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type Pending = {
  key: string;
  path: string;
  body: Record<string, unknown>;
  kind: 'create' | 'cancel' | 'ordering' | 'stop' | 'shift_open' | 'shift_close' | 'shift_move';
  at: string;
};
type Journal = {
  version: 1;
  scope: string;
  draft: Cart | null;
  pending: Pending | null;
  known: string[];
  selected: string | null;
  held?: Cart[];
};
export type State = {
  actor: StaffSession | null;
  menu: MenuSnapshot | null;
  ordering: Ordering | null;
  stops: Map<string, Stop>;
  draft: Cart | null;
  quote: Quote | null;
  order: LocalOrder | null;
  known: string[];
  pending: Pending | null;
  busy: boolean;
  error: unknown;
  connectedAt: number | null;
  storageBlocked: boolean;
  shift: CashShift | null;
  shifts: CashShift[];
  orders: LocalOrder[];
  operationsAvailable: boolean;
  operationsAt: number | null;
  operationsError: unknown;
};
const AUTH_KEY = 'pickchick.pos.staff-session.v1';
export const scopeFor = (actor: StaffSession) =>
  `${actor.branch_id}.${actor.staff_id}.${actor.terminal_id}`;
const journalKey = (scope: string) => `pickchick.pos.journal.v1.${scope}`;
const unchanged = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export class PosController {
  state: State = {
    actor: null,
    menu: null,
    ordering: null,
    stops: new Map(),
    draft: null,
    quote: null,
    order: null,
    known: [],
    pending: null,
    busy: false,
    error: null,
    connectedAt: null,
    storageBlocked: false,
    shift: null,
    shifts: [],
    orders: [],
    operationsAvailable: false,
    operationsAt: null,
    operationsError: null,
  };
  private credential: StaffCredential | null = null;
  private journal: Journal | null = null;
  private listeners = new Set<() => void>();
  private generation = 0;
  private releaseLease: (() => void) | null = null;
  constructor(
    private api: Transport,
    private sessions: Store,
    private storage: Store,
    private newKey = () => crypto.randomUUID(),
    private lease?: (scope: string) => Promise<() => void>,
    private passwordApi: PasswordTransport = passwordTransport,
  ) {}
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit() {
    for (const listener of this.listeners) listener();
  }
  private fail(error: unknown) {
    this.state.error = error;
    if (error instanceof ApiError && ['EDGE_UNREACHABLE', 'EDGE_TIMEOUT'].includes(error.code))
      this.state.connectedAt = null;
    if (error instanceof ApiError && error.code === 'UNAUTHORIZED') {
      this.credential = null;
      this.state.actor = null;
      this.releaseLease?.();
      this.releaseLease = null;
      try {
        this.sessions.removeItem(AUTH_KEY);
      } catch {
        /* No new writes follow a lost session. */
      }
    }
    this.emit();
  }
  private async run(action: () => Promise<void>) {
    if (this.state.busy) return;
    this.state.busy = true;
    this.state.error = null;
    this.emit();
    try {
      await action();
    } catch (error) {
      this.fail(error);
    } finally {
      this.state.busy = false;
      this.emit();
    }
  }
  private async request(path: string, options?: Parameters<Transport>[2]) {
    if (!this.credential) throw new ApiError('UNAUTHORIZED', 401);
    const result = await this.api(path, this.credential, options);
    this.state.connectedAt = Date.now();
    return result;
  }
  private save(next: Journal) {
    if (this.state.storageBlocked) throw new Error('STORAGE_UNAVAILABLE');
    const serialized = JSON.stringify(next);
    if (serialized.length > 100000) throw new Error('LIMIT');
    try {
      this.storage.setItem(journalKey(next.scope), serialized);
    } catch {
      this.state.storageBlocked = true;
      throw new Error('STORAGE_UNAVAILABLE');
    }
    this.journal = next;
    this.state.draft = next.draft;
    this.state.pending = next.pending;
    this.state.known = next.known;
  }
  private readJournal(actor: StaffSession): Journal {
    const scope = scopeFor(actor);
    let raw: string | null;
    try {
      raw = this.storage.getItem(journalKey(scope));
    } catch {
      throw new Error('STORAGE_UNAVAILABLE');
    }
    if (raw === null)
      return { version: 1, scope, draft: null, pending: null, known: [], selected: null };
    try {
      if (raw.length > 100000) throw new Error();
      const j = parse.record(JSON.parse(raw));
      if (
        j.version !== 1 ||
        j.scope !== scope ||
        !Array.isArray(j.known) ||
        j.known.length > 100 ||
        !(j.selected === null || parse.isUuid(j.selected))
      )
        throw new Error();
      const pending = j.pending === null ? null : this.parsePending(j.pending);
      return {
        version: 1,
        scope,
        ...(j.held === undefined
          ? {}
          : {
              held: (() => {
                if (!Array.isArray(j.held) || j.held.length > 10) throw new Error();
                return j.held.map(parse.cart);
              })(),
            }),
        draft: j.draft === null ? null : parse.cart(j.draft),
        pending,
        known: j.known.map(parse.uuid),
        selected: j.selected as string | null,
      };
    } catch {
      throw new Error('STORAGE_DAMAGED');
    }
  }
  private parsePending(value: unknown): Pending {
    const p = parse.record(value),
      body = parse.record(p.body),
      path = parse.text(p.path, 160);
    if (p.kind === 'create') {
      if (
        path !== 'orders' ||
        ![1, 2].includes(Object.keys(body).length) ||
        (Object.keys(body).length === 2 && body.kitchen_admission !== 'unpaid')
      )
        throw new Error();
      parse.uuid(body.quote_id);
    } else if (p.kind === 'cancel') {
      if (!/^orders\/[0-9a-f-]+\/cancel$/.test(path) || Object.keys(body).length !== 2)
        throw new Error();
      parse.uuid(path.split('/')[1]);
      parse.integer(body.expected_version);
      parse.text(body.reason);
    } else if (p.kind === 'ordering') {
      if (!['ordering/open', 'ordering/close'].includes(path) || Object.keys(body).length !== 1)
        throw new Error();
      parse.integer(body.expected_version);
    } else if (p.kind === 'stop') {
      if (
        path !== 'availability/stops' ||
        ![4, 5].includes(Object.keys(body).length) ||
        (body.duration !== undefined &&
          !['manual', 'hour', 'shift'].includes(String(body.duration))) ||
        typeof body.stopped !== 'boolean'
      )
        throw new Error();
      parse.uuid(body.variant_id);
      parse.integer(body.expected_version, 0);
      parse.text(body.reason);
    } else if (p.kind === 'shift_open') {
      if (path !== 'cash-shifts' || Object.keys(body).length !== 1) throw new Error();
      parse.minor(body.opening_cash_minor);
    } else if (p.kind === 'shift_move') {
      if (
        !/^cash-shifts\/[0-9a-f-]+\/movements$/.test(path) ||
        Object.keys(body).length !== 3 ||
        !['in', 'out'].includes(String(body.direction))
      )
        throw new Error();
      parse.uuid(path.split('/')[1]);
      parse.minor(body.amount_minor);
      parse.text(body.reason);
    } else if (p.kind === 'shift_close') {
      if (!/^cash-shifts\/[0-9a-f-]+\/close$/.test(path) || Object.keys(body).length !== 3)
        throw new Error();
      parse.uuid(path.split('/')[1]);
      parse.integer(body.expected_version);
      parse.minor(body.counted_cash_minor);
      parse.text(body.reason);
    } else throw new Error();
    return {
      key: parse.uuid(p.key),
      path,
      body,
      kind: p.kind as Pending['kind'],
      at: parse.text(p.at, 40),
    };
  }
  async boot() {
    let stored: string | null;
    try {
      stored = this.sessions.getItem(AUTH_KEY);
    } catch {
      this.fail(new Error('STORAGE_UNAVAILABLE'));
      return;
    }
    if (stored) await this.login(stored);
  }
  async login(raw: string) {
    await this.run(async () => {
      if (raw.length > 10000) throw new Error('INVALID_CREDENTIAL');
      let candidate: StaffCredential;
      try {
        candidate = parse.credential(JSON.parse(raw));
      } catch {
        throw new Error('INVALID_CREDENTIAL');
      }
      await this.establishSession(candidate);
    });
  }
  retryLoginAt = 0;
  async signIn(login: string, password: string, terminalId: string | undefined) {
    await this.run(async () => {
      if (!parse.isUuid(terminalId)) throw new Error('TERMINAL_NOT_CONFIGURED');
      if (Date.now() < this.retryLoginAt) throw new ApiError('AUTH_RATE_LIMITED', 429);
      const account = login.trim().toLowerCase();
      if (
        !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(account) ||
        password.length < 12 ||
        password.length > 128
      )
        throw new Error('INVALID_LOGIN');
      let candidate: StaffCredential;
      try {
        candidate = parse.credential(
          await this.passwordApi({ login: account, password, terminal_id: terminalId }),
        );
      } catch (error) {
        if (error instanceof ApiError && error.code === 'AUTH_RATE_LIMITED')
          this.retryLoginAt = Date.now() + (error.retryAfterSeconds || 60) * 1000;
        throw error;
      }
      if (candidate.terminal_id !== terminalId) throw new Error('WRONG_BRANCH');
      await this.establishSession(candidate);
      this.retryLoginAt = 0;
    });
  }
  private async establishSession(candidate: StaffCredential) {
    const actor = parse.session(await this.api('session', candidate));
    if (actor.session_id !== candidate.session_id || scopeFor(actor) !== scopeFor(candidate))
      throw new Error('WRONG_BRANCH');
    if (actor.role === 'kitchen') throw new ApiError('FORBIDDEN', 403);
    const saved = { ...actor, token: candidate.token };
    if (!this.releaseLease && this.lease)
      this.releaseLease = await this.lease(`${actor.branch_id}.${actor.terminal_id}`);
    let journal: Journal;
    try {
      journal = this.readJournal(actor);
    } catch (error) {
      this.state.storageBlocked = true;
      this.releaseLease?.();
      this.releaseLease = null;
      throw error;
    }
    try {
      this.sessions.setItem(AUTH_KEY, JSON.stringify(saved));
    } catch {
      this.releaseLease?.();
      this.releaseLease = null;
      throw new Error('STORAGE_UNAVAILABLE');
    }
    this.generation++;
    this.credential = saved;
    this.journal = journal;
    this.state = {
      ...this.state,
      actor,
      menu: null,
      ordering: null,
      stops: new Map(),
      quote: null,
      order: null,
      error: null,
      connectedAt: Date.now(),
      draft: journal.draft,
      known: journal.known,
      pending: journal.pending,
      storageBlocked: false,
      shift: null,
      shifts: [],
      orders: [],
      operationsAvailable: false,
      operationsAt: null,
      operationsError: null,
    };
    await this.refreshData();
    await this.readOperations();
    if (journal.selected) await this.readOrder(journal.selected);
  }
  logout() {
    if (this.state.busy) return;
    const credential = this.credential;
    try {
      this.sessions.removeItem(AUTH_KEY);
    } catch {
      this.fail(new Error('STORAGE_UNAVAILABLE'));
      return;
    }
    this.generation++;
    this.credential = null;
    if (credential) void this.api('staff/logout', credential, { method: 'POST' }).catch(() => {});
    this.journal = null;
    this.releaseLease?.();
    this.releaseLease = null;
    this.state = {
      actor: null,
      menu: null,
      ordering: null,
      stops: new Map(),
      draft: null,
      quote: null,
      order: null,
      known: [],
      pending: null,
      busy: false,
      error: null,
      connectedAt: null,
      storageBlocked: false,
      shift: null,
      shifts: [],
      orders: [],
      operationsAvailable: false,
      operationsAt: null,
      operationsError: null,
    };
    this.emit();
  }
  private async refreshData() {
    const [m, o] = await Promise.all([
      this.request('menu').then(parse.menu),
      this.request('ordering').then(parse.ordering),
    ]);
    if (m.branch_id !== this.state.actor?.branch_id || o.branch_id !== m.branch_id)
      throw new Error('WRONG_BRANCH');
    this.state.menu = m;
    this.state.ordering = o;
    this.state.stops = new Map();
    if (this.state.quote && this.state.quote.release_id !== m.release_id) this.state.quote = null;
    if (this.journal && !this.journal.draft)
      this.save({
        ...this.journal,
        draft: { release_id: m.release_id, service_mode: 'takeaway', items: [] },
      });
    await this.loadStops([
      ...new Set([
        ...m.items.slice(0, 36).map((i) => i.variant_id),
        ...(this.state.draft?.items.map((i) => i.variant_id) ?? []),
      ]),
    ]);
  }
  async refresh() {
    await this.run(async () => {
      await this.refreshData();
      await this.readOperations();
    });
  }
  private operationsRead = 0;
  private async readOperations() {
    const read = ++this.operationsRead,
      epoch = this.generation,
      actor = this.state.actor;
    if (!actor) return;
    try {
      const selectedId = this.state.order?.order_id;
      const [shift, orders, shifts, selectedOrder] = await Promise.all([
        this.request('cash-shifts/current').then(parse.currentShift),
        this.request('orders').then(parse.orderFeed),
        this.request('cash-shifts').then(parse.shiftHistory),
        selectedId ? this.request(`orders/${selectedId}`).then(parse.order) : null,
      ]);
      if (epoch !== this.generation || read !== this.operationsRead) return;
      const own = (value: CashShift) =>
        value.branch_id === actor.branch_id &&
        (actor.role === 'shift_manager' || value.terminal_id === actor.terminal_id);
      if (
        (shift &&
          (shift.state !== 'open' || !own(shift) || shift.terminal_id !== actor.terminal_id)) ||
        shifts.some((s) => !own(s)) ||
        orders.some((o) => o.branch_id !== actor.branch_id) ||
        (selectedOrder &&
          (selectedOrder.branch_id !== actor.branch_id || selectedOrder.order_id !== selectedId))
      )
        throw new Error('WRONG_BRANCH');
      this.state.shift = shift;
      this.state.shifts = shifts;
      this.state.orders = orders;
      if (selectedOrder && this.state.order?.order_id === selectedId)
        this.state.order = selectedOrder;
      this.state.operationsAvailable = true;
      this.state.operationsAt = Date.now();
      this.state.operationsError = null;
    } catch (error) {
      if (epoch !== this.generation || read !== this.operationsRead) return;
      this.state.operationsError = error;
      if (error instanceof ApiError && error.code === 'UNAUTHORIZED') this.fail(error);
    }
    this.emit();
  }
  async refreshOperations() {
    if (this.state.busy || this.state.pending || !this.state.actor) return;
    await this.readOperations();
  }
  async refreshStops() {
    const epoch = this.generation;
    try {
      const value = parse.record(await this.request('availability/stops'));
      if (!Array.isArray(value.stops) || value.stops.length > 10000)
        throw new Error('INVALID_RESPONSE');
      const stops = value.stops.map(parse.stop);
      if (epoch !== this.generation) return;
      this.state.stops = new Map(stops.map((s) => [s.variant_id, s]));
      this.emit();
    } catch (error) {
      if (epoch === this.generation) this.fail(error);
    }
  }
  async loadStops(ids: string[]) {
    const epoch = this.generation;
    try {
      for (let i = 0; i < ids.length; i += 6) {
        const batch = await Promise.all(
          ids.slice(i, i + 6).map(async (id) => {
            parse.uuid(id);
            const s = parse.stop(await this.request(`availability/stops/${id}`));
            if (s.variant_id !== id) throw new Error('INVALID_RESPONSE');
            return s;
          }),
        );
        if (epoch !== this.generation) return;
        for (const s of batch) this.state.stops.set(s.variant_id, s);
      }
      this.emit();
    } catch (error) {
      if (epoch === this.generation) this.fail(error);
    }
  }
  private editable() {
    if (
      !this.journal ||
      !this.state.actor ||
      this.state.busy ||
      this.state.storageBlocked ||
      this.state.order
    )
      return false;
    if (this.journal.pending) {
      this.fail(new Error('PENDING'));
      return false;
    }
    return true;
  }
  quantity(id: string, count: number) {
    if (!this.editable() || !this.journal?.draft || !this.state.menu) return;
    try {
      if (!Number.isInteger(count) || count < 0 || count > 99) throw new Error('LIMIT');
      const existing = this.journal.draft.items.find((i) => parse.lineKey(i) === id);
      const variant = existing?.variant_id ?? id;
      const item = this.state.menu.items.find((i) => i.variant_id === variant);
      const old = existing?.quantity ?? 0;
      if (count > old && (!item || this.state.stops.get(variant)?.stopped !== false))
        throw new Error('ITEM_STOPPED');
      if (count && item) parse.validateSelections(item, existing?.modifiers ?? []);
      const items = this.journal.draft.items.flatMap((i) =>
        parse.lineKey(i) === id ? (count ? [{ ...i, quantity: count }] : []) : [i],
      );
      if (count && !existing) items.push({ variant_id: variant, quantity: count });
      if (items.length > 50) throw new Error('LIMIT');
      this.save({
        ...this.journal,
        draft: { ...this.journal.draft, release_id: this.state.menu.release_id, items },
      });
      this.state.quote = null;
      this.state.error = null;
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }
  configure(variantId: string, modifiers: Selection[], quantity: number, previousKey?: string) {
    if (!this.editable() || !this.journal?.draft || !this.state.menu) return;
    try {
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new Error('LIMIT');
      const item = this.state.menu.items.find((i) => i.variant_id === variantId);
      if (!item || this.state.stops.get(variantId)?.stopped !== false)
        throw new Error('ITEM_STOPPED');
      const selected = parse.validateSelections(item, modifiers);
      const next = {
        variant_id: variantId,
        quantity,
        ...(selected.length ? { modifiers: selected } : {}),
      };
      const key = parse.lineKey(next);
      if (previousKey && !this.journal.draft.items.some((i) => parse.lineKey(i) === previousKey))
        throw new Error('INVALID_REQUEST');
      const remaining = this.journal.draft.items.filter((i) => parse.lineKey(i) !== previousKey);
      const matching = remaining.find((i) => parse.lineKey(i) === key);
      if (matching) next.quantity += matching.quantity;
      if (next.quantity > 99) throw new Error('LIMIT');
      const items = remaining.filter((i) => parse.lineKey(i) !== key);
      items.push(next);
      if (items.length > 50) throw new Error('LIMIT');
      this.save({
        ...this.journal,
        draft: { ...this.journal.draft, release_id: this.state.menu.release_id, items },
      });
      this.state.quote = null;
      this.state.error = null;
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }
  mode(mode: Cart['service_mode']) {
    if (!this.editable() || !this.journal?.draft) return;
    try {
      this.save({ ...this.journal, draft: { ...this.journal.draft, service_mode: mode } });
      this.state.quote = null;
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }
  replaceDraft(value: Cart) {
    if (!this.editable() || !this.journal) return;
    try {
      const draft = parse.cart(value);
      if (draft.release_id !== this.state.menu?.release_id) throw new Error('MENU_CHANGED');
      this.save({ ...this.journal, draft });
      this.state.quote = null;
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }
  get heldDrafts() {
    return this.journal?.held ?? [];
  }
  holdDraft() {
    if (!this.editable() || !this.journal?.draft?.items.length) return;
    try {
      if (this.heldDrafts.length >= 10) throw new Error('LIMIT');
      this.save({
        ...this.journal,
        held: [...this.heldDrafts, this.journal.draft],
        draft: { release_id: this.journal.draft.release_id, service_mode: 'takeaway', items: [] },
      });
      this.state.quote = null;
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }
  restoreDraft(index = 0) {
    if (!this.editable() || !this.journal) return;
    try {
      const held = [...this.heldDrafts],
        draft = held.splice(index, 1)[0];
      if (!draft) throw new Error('NOT_FOUND');
      if (this.journal.draft?.items.length) held.push(this.journal.draft);
      this.save({ ...this.journal, held, draft });
      this.state.quote = null;
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }
  async calculate() {
    if (!this.editable()) return;
    await this.run(async () => {
      if (!this.journal?.draft?.items.length) throw new Error('INVALID_REQUEST');
      await this.refreshData();
      const draft = { ...this.journal.draft!, release_id: this.state.menu!.release_id };
      this.save({ ...this.journal, draft });
      this.state.quote = null;
      const q = parse.quote(await this.request('checkout/quotes', { method: 'POST', body: draft }));
      const actual = q.lines
        .map((l) => ({ key: parse.lineKey(l), quantity: l.quantity }))
        .sort((a, b) => a.key.localeCompare(b.key));
      if (
        q.branch_id !== this.state.actor?.branch_id ||
        q.release_id !== draft.release_id ||
        q.service_mode !== draft.service_mode ||
        !unchanged(
          actual,
          draft.items
            .map((l) => ({ key: parse.lineKey(l), quantity: l.quantity }))
            .sort((a, b) => a.key.localeCompare(b.key)),
        )
      )
        throw new Error('INVALID_RESPONSE');
      this.state.quote = q;
    });
  }
  private async begin(kind: Pending['kind'], path: string, body: Record<string, unknown>) {
    if (!this.journal || this.state.storageBlocked || this.journal.pending)
      throw new Error('PENDING');
    const pending = { kind, path, body, key: this.newKey(), at: new Date().toISOString() };
    this.save({ ...this.journal, pending });
    this.emit();
    await this.replay();
  }
  get hasConfirmedOpenShift() {
    const { actor, shift, operationsAvailable, operationsError } = this.state;
    return Boolean(
      actor &&
      operationsAvailable &&
      !operationsError &&
      shift?.state === 'open' &&
      shift.branch_id === actor.branch_id &&
      shift.terminal_id === actor.terminal_id,
    );
  }
  async create(kitchenAdmission = false) {
    if (!this.editable()) return;
    await this.run(async () => {
      if (!this.state.operationsAvailable || this.state.operationsError)
        throw new Error('CASH_SHIFT_STATUS_UNKNOWN');
      if (!this.hasConfirmedOpenShift) throw new Error('CASH_SHIFT_REQUIRED');
      const q = this.state.quote;
      if (!q || Date.parse(q.expires_at) <= Date.now()) throw new Error('QUOTE_EXPIRED');
      if (kitchenAdmission && this.state.ordering?.pos_service_mode !== 'unpaid_service')
        throw new Error('SERVICE_MODE_DISABLED');
      await this.begin('create', 'orders', {
        quote_id: q.quote_id,
        ...(kitchenAdmission ? { kitchen_admission: 'unpaid' } : {}),
      });
    });
  }
  async recover() {
    await this.run(() => this.replay());
  }
  private async replay() {
    const j = this.journal,
      p = j?.pending;
    if (!j || !p) return;
    let value: unknown;
    try {
      value = await this.request(p.path, { method: 'POST', body: p.body, key: p.key });
    } catch (error) {
      const admissionRejected =
        error instanceof ApiError &&
        error.status === 409 &&
        ((p.kind === 'create' &&
          ['SERVICE_MODE_DISABLED', 'KITCHEN_UNAVAILABLE'].includes(error.code)) ||
          (p.kind === 'cancel' && error.code === 'ORDER_IN_PRODUCTION'));
      if (admissionRejected) {
        this.save({ ...j, pending: null });
        this.state.quote = null;
        if (p.kind === 'cancel') await this.readOrder(p.path.split('/')[1]!);
        await this.refreshData();
        await this.readOperations();
      }
      const shiftConflict =
        error instanceof ApiError &&
        error.code === 'CONFLICT' &&
        error.status === 409 &&
        (p.kind === 'shift_open' || p.kind === 'shift_close' || p.kind === 'shift_move');
      if (shiftConflict) {
        // The server rejected this command. A committed same-key replay returns success instead.
        // Persist resolution before reading the new state; uncertain responses remain pending.
        this.save({ ...j, pending: null });
        this.state.operationsAvailable = false;
        this.state.shift = null;
        await this.readOperations();
      }
      if (
        error instanceof ApiError &&
        [
          'QUOTE_EXPIRED',
          'MENU_CHANGED',
          'ITEM_STOPPED',
          'BRANCH_UNAVAILABLE',
          'INVALID_REQUEST',
          'NOT_FOUND',
          'FORBIDDEN',
          'CASH_SHIFT_REQUIRED',
        ].includes(error.code)
      ) {
        this.save({ ...j, pending: null });
        this.state.quote = null;
      }
      throw error;
    }
    if (p.kind === 'create' || p.kind === 'cancel') {
      const created = parse.order(value);
      if (
        created.branch_id !== this.state.actor?.branch_id ||
        (p.kind === 'create' &&
          (created.quote_id !== p.body.quote_id ||
            (p.body.kitchen_admission === 'unpaid' &&
              created.execution_mode !== 'unpaid_service'))) ||
        (p.kind === 'cancel' && p.path !== `orders/${created.order_id}/cancel`)
      )
        throw new Error('INVALID_RESPONSE');
      const known = [created.order_id, ...j.known.filter((id) => id !== created.order_id)].slice(
        0,
        100,
      );
      this.save({
        ...j,
        pending: null,
        selected: created.order_id,
        known,
        draft: p.kind === 'create' ? null : j.draft,
      });
      this.state.order = created;
      this.state.quote = null;
      // Idempotent POST replays its historical result; GET is the authoritative current state.
      await this.readOrder(created.order_id);
      await this.readOperations();
    } else {
      if (p.kind === 'ordering') this.state.ordering = parse.ordering(value);
      if (p.kind === 'stop') {
        const s = parse.stop(value);
        this.state.stops.set(s.variant_id, s);
      }
      if (p.kind === 'shift_move') {
        const shift = parse.cashShift(value),
          move = shift.cash_movements?.find((m) => m.id === p.key);
        if (
          shift.branch_id !== this.state.actor?.branch_id ||
          p.path !== `cash-shifts/${shift.shift_id}/movements` ||
          !move ||
          move.amount_minor !== p.body.amount_minor ||
          move.direction !== p.body.direction ||
          move.reason !== p.body.reason
        )
          throw new Error('INVALID_RESPONSE');
      }
      if (p.kind === 'shift_open' || p.kind === 'shift_close') {
        const shift = parse.cashShift(value),
          actor = this.state.actor!;
        if (
          shift.branch_id !== actor.branch_id ||
          (p.kind === 'shift_open' &&
            (shift.staff_id !== actor.staff_id ||
              shift.terminal_id !== actor.terminal_id ||
              shift.opening_cash_minor !== p.body.opening_cash_minor ||
              shift.state !== 'open')) ||
          (p.kind === 'shift_close' &&
            (p.path !== `cash-shifts/${shift.shift_id}/close` ||
              shift.state !== 'closed' ||
              shift.counted_cash_minor !== p.body.counted_cash_minor))
        )
          throw new Error('INVALID_RESPONSE');
      }
      this.save({ ...j, pending: null });
      this.state.quote = null;
      await this.refreshData();
      await this.readOperations();
    }
  }
  private async readOrder(id: string) {
    const o = parse.order(await this.request(`orders/${parse.uuid(id)}`));
    if (o.order_id !== id || o.branch_id !== this.state.actor?.branch_id)
      throw new Error('INVALID_RESPONSE');
    this.state.order = o;
  }
  async openOrder(id: string) {
    await this.run(async () => {
      if (!this.journal || this.journal.pending) throw new Error('PENDING');
      await this.readOrder(id);
      this.save({
        ...this.journal,
        selected: id,
        known: [id, ...this.journal.known.filter((v) => v !== id)].slice(0, 100),
      });
    });
  }
  newDraft() {
    if (!this.journal || !this.state.menu || this.state.busy) return;
    try {
      if (this.journal.pending) throw new Error('PENDING');
      this.save({
        ...this.journal,
        selected: null,
        draft: this.journal.draft ?? {
          release_id: this.state.menu.release_id,
          service_mode: 'takeaway',
          items: [],
        },
      });
      this.state.order = null;
      this.state.quote = null;
      this.state.error = null;
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }
  async cancel(reason: string) {
    await this.run(async () => {
      const o = this.state.order;
      if (!o || o.state !== 'awaiting_payment' || !reason.trim() || reason.trim().length > 300)
        throw new Error('INVALID_REQUEST');
      await this.begin('cancel', `orders/${o.order_id}/cancel`, {
        expected_version: o.version,
        reason: reason.trim(),
      });
    });
  }
  async setOrdering(enabled: boolean) {
    await this.run(async () => {
      if (this.state.actor?.role !== 'shift_manager' || !this.state.ordering)
        throw new ApiError('FORBIDDEN', 403);
      await this.begin('ordering', `ordering/${enabled ? 'open' : 'close'}`, {
        expected_version: this.state.ordering.version,
      });
    });
  }
  async moveCash(direction: 'in' | 'out', amountMinor: string, reason: string) {
    await this.run(async () => {
      if (!this.state.shift || this.state.actor?.role !== 'shift_manager')
        throw new Error('FORBIDDEN');
      await this.begin('shift_move', `cash-shifts/${this.state.shift.shift_id}/movements`, {
        direction,
        amount_minor: parse.minor(amountMinor),
        reason: parse.text(reason.trim()),
      });
    });
  }
  async openShift(openingCashMinor: string) {
    await this.run(async () => {
      parse.minor(openingCashMinor);
      await this.begin('shift_open', 'cash-shifts', { opening_cash_minor: openingCashMinor });
    });
  }
  async closeShift(shiftId: string, countedCashMinor: string, reason: string) {
    await this.run(async () => {
      const shift = parse.cashShift(await this.request(`cash-shifts/${parse.uuid(shiftId)}`));
      if (shift.branch_id !== this.state.actor?.branch_id || shift.state !== 'open')
        throw new Error('CONFLICT');
      parse.minor(countedCashMinor);
      if (!reason.trim() || reason.trim().length > 300) throw new Error('INVALID_REQUEST');
      await this.begin('shift_close', `cash-shifts/${shiftId}/close`, {
        expected_version: shift.version,
        counted_cash_minor: countedCashMinor,
        reason: reason.trim(),
      });
    });
  }
  async setStop(
    id: string,
    stopped: boolean,
    reason: string,
    duration?: 'manual' | 'hour' | 'shift',
  ) {
    await this.run(async () => {
      if (!this.state.actor || !['cashier', 'shift_manager'].includes(this.state.actor.role))
        throw new ApiError('FORBIDDEN', 403);
      const s = parse.stop(await this.request(`availability/stops/${parse.uuid(id)}`));
      if (!reason.trim() || reason.trim().length > 300) throw new Error('INVALID_REQUEST');
      await this.begin('stop', 'availability/stops', {
        variant_id: id,
        ...(duration ? { duration } : {}),
        stopped,
        expected_version: s.version,
        reason: reason.trim(),
      });
    });
  }
}
