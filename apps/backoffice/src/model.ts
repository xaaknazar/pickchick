import {
  copy,
  parsePayload,
  parseState,
  payloadIssues,
  uuidPattern,
  type Actor,
  type Branch,
  type CatalogPayload,
  type CatalogState,
  type Product,
} from './domain.js';
import { ApiError, type Transport, type Request } from './api.js';
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Pending = {
  actorId: string;
  branchId: string;
  kind: 'seed' | 'save' | 'publish';
  path: string;
  method: 'POST' | 'PUT';
  body: Record<string, unknown>;
};
type Journal = {
  actorId: string;
  branchId: string;
  revision: number;
  payload: CatalogPayload | null;
  dirty: boolean;
  pending: Pending | null;
};
const AUTH = 'pickchick.backoffice.credential.v1',
  JOURNAL = 'pickchick.backoffice.work.v1';
export class CatalogModel {
  actor: Actor | null = null;
  branches: Branch[] = [];
  state: CatalogState | null = null;
  payload: CatalogPayload | null = null;
  busy = false;
  dirty = false;
  pending: Pending | null = null;
  conflict = false;
  error: unknown = null;
  private token: string | null = null;
  private journal: Journal | null = null;
  private listeners = new Set<() => void>();
  constructor(
    private api: Transport,
    private storage: Store,
    private requestId = () => crypto.randomUUID(),
  ) {}
  async operations(path: string, options?: Request) {
    if (!this.actor || !this.token) throw new ApiError('UNAUTHORIZED', 401);
    return this.api('operations/' + path, this.token, options);
  }
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }
  private fail(error: unknown) {
    this.error = error;
    this.conflict = error instanceof ApiError && error.code === 'CONFLICT';
    if (error instanceof ApiError && error.code === 'UNAUTHORIZED') {
      this.actor = null;
      this.token = null;
      this.state = null;
      this.payload = null;
      this.branches = [];
      this.pending = null;
      this.journal = null;
      this.dirty = false;
      try {
        this.storage.removeItem(AUTH);
      } catch {
        /* The journal remains for the same actor. */
      }
    }
    this.emit();
  }
  private async run(fn: () => Promise<void>): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    this.error = null;
    this.emit();
    try {
      await fn();
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    } finally {
      this.busy = false;
      this.emit();
    }
  }
  private async request(path: string, options?: Parameters<Transport>[2]) {
    if (!this.token) throw new ApiError('UNAUTHORIZED', 401);
    return this.api(path, this.token, options);
  }
  private store(j: Journal) {
    try {
      this.storage.setItem(`${JOURNAL}.${j.actorId}`, JSON.stringify(j));
    } catch {
      throw new Error('STORAGE');
    }
    this.journal = copy(j);
    this.payload = copy(j.payload);
    this.dirty = j.dirty;
    this.pending = copy(j.pending);
  }
  async boot() {
    let raw: string | null;
    try {
      raw = this.storage.getItem(AUTH);
    } catch {
      this.fail(new Error('STORAGE'));
      return;
    }
    if (raw) await this.login(raw);
  }
  async login(raw: string) {
    return this.run(async () => {
      let token: string;
      try {
        if (raw.length > 20000) throw new Error();
        const data = JSON.parse(raw);
        if (typeof data.token !== 'string' || !/^[a-f0-9]{64}$/.test(data.token)) throw new Error();
        token = data.token;
      } catch {
        throw new Error('INVALID_CREDENTIAL');
      }
      const response = (await this.api('branches', token)) as { actor: Actor; branches: Branch[] };
      if (
        !response.actor ||
        !uuidPattern.test(response.actor.id) ||
        !Array.isArray(response.branches) ||
        response.branches.some((b) => !uuidPattern.test(b.id))
      )
        throw new Error('INVALID_RESPONSE');
      let saved: Journal | null = null;
      try {
        const local = this.storage.getItem(`${JOURNAL}.${response.actor.id}`);
        if (local) {
          if (local.length > 600000) throw new Error();
          const j = JSON.parse(local) as Journal;
          if (j.actorId === response.actor.id) {
            if (
              !uuidPattern.test(j.branchId) ||
              !Number.isInteger(j.revision) ||
              j.revision < 0 ||
              typeof j.dirty !== 'boolean'
            )
              throw new Error();
            if (j.payload) parsePayload(j.payload);
            if (j.pending) this.checkPending(j.pending, response.actor.id, j.branchId);
            saved = j;
          }
        }
      } catch {
        throw new Error('CORRUPTED');
      }
      try {
        this.storage.setItem(AUTH, JSON.stringify({ token }));
      } catch {
        throw new Error('STORAGE');
      }
      this.actor = response.actor;
      this.branches = response.branches;
      this.token = token;
      this.state = null;
      this.payload = null;
      this.pending = null;
      this.journal = null;
      this.dirty = false;
      this.conflict = false;
      const branch =
        (saved && this.branches.find((b) => b.id === saved!.branchId)) || this.branches[0];
      if (!branch) {
        this.state = null;
        this.payload = null;
        this.journal = null;
        this.pending = null;
        this.dirty = false;
        return;
      }
      this.state = parseState(await this.request(`branches/${branch.id}`));
      if (this.state.branch.id !== branch.id) throw new Error('INVALID_RESPONSE');
      if (saved && saved.branchId === branch.id && (saved.dirty || saved.pending)) {
        this.journal = saved;
        this.payload = copy(saved.payload);
        this.dirty = saved.dirty;
        this.pending = saved.pending;
        this.conflict = saved.revision !== (this.state.draft?.revision ?? 0) && saved.dirty;
      } else this.adopt(this.state);
    });
  }
  private checkPending(p: Pending, actorId: string, branchId: string) {
    if (
      p.actorId !== actorId ||
      p.branchId !== branchId ||
      !['seed', 'save', 'publish'].includes(p.kind) ||
      !uuidPattern.test(String(p.body.request_id))
    )
      throw new Error('CORRUPTED');
    const suffix = p.kind === 'seed' ? 'draft/seed' : p.kind === 'save' ? 'draft' : 'publish';
    if (
      p.path !== `branches/${branchId}/${suffix}` ||
      p.method !== (p.kind === 'save' ? 'PUT' : 'POST')
    )
      throw new Error('CORRUPTED');
    if (
      !Number.isInteger(p.body.expected_revision) ||
      Number(p.body.expected_revision) < (p.kind === 'seed' ? 0 : 1) ||
      (p.kind === 'seed' && p.body.expected_revision !== 0)
    )
      throw new Error('CORRUPTED');
    if (p.kind === 'save') parsePayload(p.body.payload);
    if (
      p.kind === 'publish' &&
      (!Number.isInteger(p.body.expected_published_version) ||
        Number(p.body.expected_published_version) < 0)
    )
      throw new Error('CORRUPTED');
    if (p.kind === 'publish' && p.body.confirmation !== 'publish_catalog')
      throw new Error('CORRUPTED');
  }
  private adopt(state: CatalogState) {
    this.state = state;
    this.store({
      actorId: this.actor!.id,
      branchId: state.branch.id,
      revision: state.draft?.revision ?? 0,
      payload: state.draft?.payload ?? null,
      dirty: false,
      pending: null,
    });
    this.conflict = false;
  }
  async selectBranch(id: string, discard = false) {
    return this.run(async () => {
      if (this.pending) throw new Error('PENDING');
      if (this.dirty && !discard) throw new Error('DIRTY');
      if (!this.branches.some((b) => b.id === id)) throw new ApiError('FORBIDDEN', 403);
      const state = parseState(await this.request(`branches/${id}`));
      if (state.branch.id !== id) throw new Error('INVALID_RESPONSE');
      this.adopt(state);
    });
  }
  async reload(discard = false) {
    if (!this.state) return false;
    return this.selectBranch(this.state.branch.id, discard);
  }
  logout() {
    if (this.busy) return;
    try {
      this.storage.removeItem(AUTH);
    } catch {
      this.fail(new Error('STORAGE'));
      return;
    }
    this.actor = null;
    this.token = null;
    this.branches = [];
    this.state = null;
    this.payload = null;
    this.pending = null;
    this.journal = null;
    this.dirty = false;
    this.conflict = false;
    this.error = null;
    this.emit();
  }
  private stage(payload: CatalogPayload) {
    if (!this.journal || this.pending) throw new Error('PENDING');
    const next = copy(payload);
    next.content_source = 'operator';
    this.store({ ...this.journal, payload: next, dirty: true });
    this.emit();
  }
  updateProduct(product: Product) {
    if (!this.payload) throw new Error('INVALID_RESPONSE');
    const next = copy(this.payload),
      index = next.products.findIndex((p) => p.id === product.id);
    if (index < 0) next.products.push(copy(product));
    else next.products[index] = copy(product);
    next.content_reviewed = false;
    const errors = payloadIssues(next);
    if (errors.length) throw new Error(errors.slice(0, 8).join('\n'));
    this.stage(next);
  }
  removeProduct(id: string) {
    if (!this.payload) return;
    const next = copy(this.payload);
    next.products = next.products.filter((p) => p.id !== id);
    next.content_reviewed = false;
    const errors = payloadIssues(next);
    if (errors.length)
      throw new Error(
        `Сначала исправьте связанные позиции и рекомендации.\n${errors.slice(0, 5).join('\n')}`,
      );
    this.stage(next);
  }
  reviewContent(reviewed: boolean) {
    if (!this.payload) return;
    this.stage({ ...copy(this.payload), content_reviewed: reviewed });
  }
  async seed() {
    return this.run(() =>
      this.command('seed', { expected_revision: 0, request_id: this.requestId() }),
    );
  }
  async save() {
    return this.run(async () => {
      if (!this.payload || !this.journal || this.journal.revision < 1)
        throw new Error('INVALID_RESPONSE');
      const errors = payloadIssues(this.payload);
      if (errors.length) throw new Error(errors.slice(0, 8).join('\n'));
      await this.command('save', {
        expected_revision: this.journal.revision,
        request_id: this.requestId(),
        payload: copy(this.payload),
      });
    });
  }
  async publish() {
    return this.run(async () => {
      if (this.dirty) throw new Error('DIRTY');
      if (!this.state?.draft || !this.payload?.content_reviewed)
        throw new Error('Перед публикацией подтвердите проверку содержимого и сохраните черновик.');
      await this.command('publish', {
        expected_revision: this.state.draft.revision,
        expected_published_version: this.state.published?.version ?? 0,
        request_id: this.requestId(),
        confirmation: 'publish_catalog',
      });
    });
  }
  private async command(kind: Pending['kind'], body: Record<string, unknown>) {
    if (!this.journal || this.pending) throw new Error('PENDING');
    const p: Pending = {
      actorId: this.actor!.id,
      branchId: this.journal.branchId,
      kind,
      path: `branches/${this.journal.branchId}/${kind === 'seed' ? 'draft/seed' : kind === 'save' ? 'draft' : 'publish'}`,
      method: kind === 'save' ? 'PUT' : 'POST',
      body,
    };
    this.store({ ...this.journal, pending: p });
    this.emit();
    await this.replay();
  }
  async recover() {
    return this.run(() => this.replay());
  }
  private async replay() {
    const p = this.pending;
    if (!p || !this.journal) return;
    this.checkPending(p, this.actor!.id, this.journal.branchId);
    let value: unknown;
    try {
      value = await this.request(p.path, { method: p.method, body: p.body });
    } catch (error) {
      if (error instanceof ApiError && [400, 403, 404, 409].includes(error.status))
        this.store({ ...this.journal, pending: null });
      throw error;
    }
    const result = parseState(value);
    if (result.branch.id !== p.branchId) throw new Error('INVALID_RESPONSE');
    this.adopt(result);
    const current = parseState(await this.request(`branches/${p.branchId}`));
    if (current.branch.id !== p.branchId) throw new Error('INVALID_RESPONSE');
    this.adopt(current);
  }
}
