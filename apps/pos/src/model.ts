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
} from './types.js';
import { ApiError, type Transport } from './api.js';
export type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type Pending = {
  key: string;
  path: string;
  body: Record<string, unknown>;
  kind: 'create' | 'cancel' | 'ordering' | 'stop';
  at: string;
};
type Journal = {
  version: 1;
  scope: string;
  draft: Cart | null;
  pending: Pending | null;
  known: string[];
  selected: string | null;
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
    try {
      this.storage.setItem(journalKey(next.scope), JSON.stringify(next));
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
      if (path !== 'orders' || Object.keys(body).length !== 1) throw new Error();
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
        Object.keys(body).length !== 4 ||
        typeof body.stopped !== 'boolean'
      )
        throw new Error();
      parse.uuid(body.variant_id);
      parse.integer(body.expected_version, 0);
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
      };
      await this.refreshData();
      if (journal.selected) await this.readOrder(journal.selected);
    });
  }
  logout() {
    if (this.state.busy) return;
    try {
      this.sessions.removeItem(AUTH_KEY);
    } catch {
      this.fail(new Error('STORAGE_UNAVAILABLE'));
      return;
    }
    this.generation++;
    this.credential = null;
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
    await this.run(() => this.refreshData());
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
      const old = this.journal.draft.items.find((i) => i.variant_id === id)?.quantity ?? 0;
      if (
        count > old &&
        (!this.state.menu.items.some((i) => i.variant_id === id) ||
          this.state.stops.get(id)?.stopped !== false)
      )
        throw new Error('ITEM_STOPPED');
      const items = this.journal.draft.items.filter((i) => i.variant_id !== id);
      if (count) items.push({ variant_id: id, quantity: count });
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
        .map((l) => ({ variant_id: l.variant_id, quantity: l.quantity }))
        .sort((a, b) => a.variant_id.localeCompare(b.variant_id));
      if (
        q.branch_id !== this.state.actor?.branch_id ||
        q.release_id !== draft.release_id ||
        q.service_mode !== draft.service_mode ||
        !unchanged(
          actual,
          [...draft.items].sort((a, b) => a.variant_id.localeCompare(b.variant_id)),
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
  async create() {
    if (!this.editable()) return;
    await this.run(async () => {
      const q = this.state.quote;
      if (!q || Date.parse(q.expires_at) <= Date.now()) throw new Error('QUOTE_EXPIRED');
      await this.begin('create', 'orders', { quote_id: q.quote_id });
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
        (p.kind === 'create' && created.quote_id !== p.body.quote_id) ||
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
    } else {
      if (p.kind === 'ordering') this.state.ordering = parse.ordering(value);
      if (p.kind === 'stop') {
        const s = parse.stop(value);
        this.state.stops.set(s.variant_id, s);
      }
      this.save({ ...j, pending: null });
      this.state.quote = null;
      await this.refreshData();
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
  async setStop(id: string, stopped: boolean, reason: string) {
    await this.run(async () => {
      if (this.state.actor?.role !== 'shift_manager') throw new ApiError('FORBIDDEN', 403);
      const s = parse.stop(await this.request(`availability/stops/${parse.uuid(id)}`));
      if (!reason.trim() || reason.trim().length > 300) throw new Error('INVALID_REQUEST');
      await this.begin('stop', 'availability/stops', {
        variant_id: id,
        stopped,
        expected_version: s.version,
        reason: reason.trim(),
      });
    });
  }
}
