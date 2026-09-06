import {
  TestCartSchema,
  TestSessionSchema,
  TestQuoteSchema,
  TestOrderSchema,
  TestOrdersSchema,
  TestPaymentSchema,
  TestCancellationSchema,
} from '@pickchick/test-order-flow/contracts';
import type { TestOrder, TestSession } from '@pickchick/test-order-flow/contracts';

export const SESSION_KEY = 'pickchick.test.customer.v1';
export const DRAFT_KEY = 'pickchick.test.pending-order.v1';
export const COMMAND_KEY = 'pickchick.test.pending-command.v1';
type Cart = ReturnType<typeof TestCartSchema.parse>;
type Action = 'simulated-payment' | 'cancel';
export interface TestClientIO {
  readSession(): Promise<string | null>;
  saveSession(raw: string): Promise<void>;
  read(key: string): Promise<string | null>;
  write(key: string, raw: string): Promise<void>;
  remove(key: string): Promise<void>;
  request(path: string, token?: string, body?: unknown, key?: string): Promise<unknown>;
  uuid(): string;
  now(): number;
}
export class TestApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
interface PendingOrder {
  version: 2;
  sessionId: string;
  payload: Cart;
  quoteKey: string;
  orderKey: string;
  quoteId: string | null;
}
interface PendingCommand {
  version: 1;
  sessionId: string;
  orderId: string;
  expectedVersion: number;
  action: Action;
  value: Record<string, string>;
  key: string;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
function object(raw: string): Record<string, unknown> {
  if (raw.length > 20000) throw new TestApiError(409, 'RECOVERY_DATA_INVALID');
  try {
    const result: unknown = JSON.parse(raw);
    if (result && typeof result === 'object' && !Array.isArray(result))
      return result as Record<string, unknown>;
  } catch {
    /* Corrupt intent must not silently become a new purchase. */
  }
  throw new TestApiError(409, 'RECOVERY_DATA_INVALID');
}
function normalizeCart(input: unknown): Cart {
  const parsed = TestCartSchema.safeParse(input);
  if (!parsed.success) throw new TestApiError(400, 'INVALID_CART');
  return {
    ...parsed.data,
    items: [...parsed.data.items].sort((a, b) => a.product_id.localeCompare(b.product_id)),
  };
}
export function cartMatchesOrder(
  order: TestOrder,
  lines: { product: { id: string }; quantity: number }[],
  serviceMode: 'takeaway' | 'dine_in',
): boolean {
  if (!lines.length || order.snapshot.service_mode !== serviceMode) return false;
  const expected = order.snapshot.lines.map((line) => `${line.id}:${line.quantity}`).sort();
  const actual = lines.map((line) => `${line.product.id}:${line.quantity}`).sort();
  return JSON.stringify(expected) === JSON.stringify(actual);
}
export function mergeObservedOrder(previous: TestOrder[], order: TestOrder): TestOrder[] {
  const old = previous.find((candidate) => candidate.order_id === order.order_id);
  if (old && old.version > order.version) return previous;
  return [order, ...previous.filter((candidate) => candidate.order_id !== order.order_id)];
}
export function mergeObservedOrders(previous: TestOrder[], next: TestOrder[]): TestOrder[] {
  return next.map((order) => {
    const old = previous.find((candidate) => candidate.order_id === order.order_id);
    return old && old.version > order.version ? old : order;
  });
}

/** Platform storage, clock, entropy and HTTP are injected for recovery tests. */
export class TestCustomerCore {
  private readonly io: TestClientIO;
  private session: TestSession | null = null;
  private restored = false;
  private restorePromise: Promise<boolean> | null = null;
  private sessionPromise: Promise<TestSession> | null = null;
  private continuationPromise: Promise<TestSession> | null = null;
  private operation: { fingerprint: string; promise: Promise<TestOrder> } | null = null;
  constructor(io: TestClientIO) {
    this.io = io;
  }
  async restore(): Promise<boolean> {
    if (this.restored) return this.session !== null;
    if (!this.restorePromise)
      this.restorePromise = (async () => {
        const raw = await this.io.readSession();
        if (raw) {
          if (raw.length > 2000) throw new TestApiError(401, 'STORED_SESSION_INVALID');
          try {
            this.session = TestSessionSchema.parse(JSON.parse(raw));
          } catch {
            throw new TestApiError(401, 'STORED_SESSION_INVALID');
          }
        }
        this.restored = true;
        return this.session !== null;
      })().finally(() => {
        this.restorePromise = null;
      });
    return this.restorePromise;
  }
  private async pendingOrder(): Promise<PendingOrder | null> {
    const raw = await this.io.read(DRAFT_KEY);
    if (!raw) return null;
    const p = object(raw);
    if (
      (p.version !== 1 && p.version !== 2) ||
      !isUuid(p.sessionId) ||
      !isUuid(p.quoteKey) ||
      !isUuid(p.orderKey) ||
      !(p.quoteId === null || isUuid(p.quoteId))
    )
      throw new TestApiError(409, 'RECOVERY_DATA_INVALID');
    let payload: unknown = p.payload;
    if (p.version === 1) {
      if (typeof p.fingerprint !== 'string') throw new TestApiError(409, 'RECOVERY_DATA_INVALID');
      try {
        payload = JSON.parse(p.fingerprint);
      } catch {
        throw new TestApiError(409, 'RECOVERY_DATA_INVALID');
      }
    }
    const parsed = TestCartSchema.safeParse(payload);
    if (!parsed.success) throw new TestApiError(409, 'RECOVERY_DATA_INVALID');
    return {
      version: 2,
      sessionId: p.sessionId,
      payload: parsed.data,
      quoteKey: p.quoteKey,
      orderKey: p.orderKey,
      quoteId: p.quoteId,
    };
  }
  private async pendingCommand(): Promise<PendingCommand | null> {
    const raw = await this.io.read(COMMAND_KEY);
    if (!raw) return null;
    const p = object(raw);
    if (
      p.version !== 1 ||
      !isUuid(p.sessionId) ||
      !isUuid(p.orderId) ||
      !isUuid(p.key) ||
      !Number.isInteger(p.expectedVersion) ||
      Number(p.expectedVersion) < 1 ||
      (p.action !== 'simulated-payment' && p.action !== 'cancel') ||
      !p.value ||
      typeof p.value !== 'object' ||
      Array.isArray(p.value)
    )
      throw new TestApiError(409, 'RECOVERY_DATA_INVALID');
    const value = p.value as Record<string, unknown>;
    const schema = p.action === 'simulated-payment' ? TestPaymentSchema : TestCancellationSchema;
    if (
      !schema.safeParse({ expected_version: p.expectedVersion, ...value }).success ||
      Object.values(value).some((item) => typeof item !== 'string')
    )
      throw new TestApiError(409, 'RECOVERY_DATA_INVALID');
    return {
      version: 1,
      sessionId: p.sessionId,
      orderId: p.orderId,
      expectedVersion: Number(p.expectedVersion),
      action: p.action,
      value: value as Record<string, string>,
      key: p.key,
    };
  }
  async hasPending(): Promise<boolean> {
    return (await this.pendingOrder()) !== null || (await this.pendingCommand()) !== null;
  }
  async authenticate(): Promise<TestSession> {
    await this.restore();
    if (this.session) {
      if (Date.parse(this.session.expires_at) <= this.io.now())
        throw new TestApiError(401, 'SESSION_EXPIRED');
      return this.session;
    }
    if (!this.sessionPromise)
      this.sessionPromise = (async () => {
        if (await this.hasPending()) throw new TestApiError(409, 'PREVIOUS_SESSION_PENDING');
        const session = TestSessionSchema.parse(
          await this.io.request('/sessions', undefined, { channel: 'mobile' }),
        );
        await this.io.saveSession(JSON.stringify(session));
        this.session = session;
        return session;
      })().finally(() => {
        this.sessionPromise = null;
      });
    return this.sessionPromise;
  }
  continueSession(): Promise<TestSession> {
    if (this.operation) return Promise.reject(new TestApiError(409, 'COMMAND_IN_PROGRESS'));
    if (!this.continuationPromise)
      this.continuationPromise = (async () => {
        await this.restore();
        const previous = this.session;
        if (!previous) throw new TestApiError(401, 'STORED_SESSION_INVALID');
        const continued = TestSessionSchema.parse(
          await this.io.request('/sessions/continue', previous.token, {}),
        );
        if (
          continued.session_id !== previous.session_id ||
          continued.token !== previous.token ||
          continued.channel !== previous.channel ||
          Date.parse(continued.expires_at) <= this.io.now()
        )
          throw new TestApiError(503, 'INVALID_CONTINUATION');
        await this.io.saveSession(JSON.stringify(continued));
        this.session = continued;
        return continued;
      })().finally(() => {
        this.continuationPromise = null;
      });
    return this.continuationPromise;
  }
  private singleFlight(fingerprint: string, run: () => Promise<TestOrder>): Promise<TestOrder> {
    if (this.operation)
      return this.operation.fingerprint === fingerprint
        ? this.operation.promise
        : Promise.reject(new TestApiError(409, 'COMMAND_IN_PROGRESS'));
    const promise = run().finally(() => {
      if (this.operation?.promise === promise) this.operation = null;
    });
    this.operation = { fingerprint, promise };
    return promise;
  }
  private async reconcile(orders: TestOrder[], session: TestSession): Promise<void> {
    if (this.operation) return;
    const pending = await this.pendingOrder();
    if (this.operation) return;
    if (
      pending &&
      pending.sessionId === session.session_id &&
      pending.quoteId &&
      orders.some((order) => order.snapshot.quote_id === pending.quoteId)
    )
      await this.io.remove(DRAFT_KEY);
    const command = await this.pendingCommand();
    if (this.operation) return;
    if (
      command &&
      command.sessionId === session.session_id &&
      orders.some(
        (order) => order.order_id === command.orderId && order.version > command.expectedVersion,
      )
    )
      await this.io.remove(COMMAND_KEY);
  }
  async orders(): Promise<TestOrder[]> {
    await this.restore();
    if (!this.session) {
      if (await this.hasPending()) throw new TestApiError(409, 'PREVIOUS_SESSION_PENDING');
      return [];
    }
    const session = await this.authenticate();
    const orders = TestOrdersSchema.parse(await this.io.request('/orders', session.token)).orders;
    await this.reconcile(orders, session);
    return orders;
  }
  async order(orderId: string): Promise<TestOrder> {
    if (!isUuid(orderId)) throw new TestApiError(400, 'INVALID_ORDER');
    const session = await this.authenticate();
    return TestOrderSchema.parse(await this.io.request(`/orders/${orderId}`, session.token));
  }
  create(
    lines: { product: { id: string }; quantity: number }[],
    serviceMode: 'takeaway' | 'dine_in',
  ): Promise<TestOrder> {
    let payload: Cart;
    try {
      payload = normalizeCart({
        catalog_version: 'mockup-v0.2',
        service_mode: serviceMode,
        items: lines.map((line) => ({ product_id: line.product.id, quantity: line.quantity })),
      });
    } catch (error) {
      return Promise.reject(error);
    }
    return this.singleFlight(`create:${JSON.stringify(payload)}`, () =>
      this.createPending(payload),
    );
  }
  private async createPending(payload: Cart): Promise<TestOrder> {
    const session = await this.authenticate();
    if (await this.pendingCommand()) throw new TestApiError(409, 'PREVIOUS_COMMAND_PENDING');
    let pending = await this.pendingOrder();
    if (pending && pending.sessionId !== session.session_id)
      throw new TestApiError(409, 'PREVIOUS_SESSION_PENDING');
    if (
      pending &&
      JSON.stringify(normalizeCart(pending.payload)) !== JSON.stringify(normalizeCart(payload))
    )
      throw new TestApiError(409, 'PREVIOUS_ORDER_PENDING');
    const fresh = (): PendingOrder => ({
      version: 2,
      sessionId: session.session_id,
      payload,
      quoteKey: this.io.uuid(),
      orderKey: this.io.uuid(),
      quoteId: null,
    });
    pending ??= fresh();
    await this.io.write(DRAFT_KEY, JSON.stringify(pending));
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!pending.quoteId) {
        const quote = TestQuoteSchema.parse(
          await this.io.request('/quotes', session.token, pending.payload, pending.quoteKey),
        );
        pending = { ...pending, quoteId: quote.quote_id };
        await this.io.write(DRAFT_KEY, JSON.stringify(pending));
      }
      try {
        const order = TestOrderSchema.parse(
          await this.io.request(
            '/orders',
            session.token,
            { quote_id: pending.quoteId },
            pending.orderKey,
          ),
        );
        await this.io.remove(DRAFT_KEY);
        return order;
      } catch (error) {
        // A saved order result replays before quote expiry checks. Only this definitive
        // rejection permits replacing intent keys; transport timeouts never do.
        if (!(error instanceof TestApiError) || error.code !== 'QUOTE_EXPIRED' || attempt !== 0)
          throw error;
        pending = fresh();
        await this.io.write(DRAFT_KEY, JSON.stringify(pending));
      }
    }
    throw new TestApiError(409, 'QUOTE_EXPIRED');
  }
  command(order: TestOrder, action: Action, value: Record<string, string>): Promise<TestOrder> {
    const schema = action === 'simulated-payment' ? TestPaymentSchema : TestCancellationSchema;
    if (!schema.safeParse({ expected_version: order.version, ...value }).success)
      return Promise.reject(new TestApiError(400, 'INVALID_COMMAND'));
    const fingerprint = JSON.stringify([order.order_id, order.version, action, value]);
    return this.singleFlight(`command:${fingerprint}`, async () => {
      const session = await this.authenticate();
      let pending = await this.pendingCommand();
      if (pending && pending.sessionId !== session.session_id)
        throw new TestApiError(409, 'PREVIOUS_SESSION_PENDING');
      if (
        pending &&
        JSON.stringify([
          pending.orderId,
          pending.expectedVersion,
          pending.action,
          pending.value,
        ]) !== fingerprint
      )
        throw new TestApiError(409, 'PREVIOUS_COMMAND_PENDING');
      pending ??= {
        version: 1,
        sessionId: session.session_id,
        orderId: order.order_id,
        expectedVersion: order.version,
        action,
        value,
        key: this.io.uuid(),
      };
      await this.io.write(COMMAND_KEY, JSON.stringify(pending));
      return this.sendCommand(pending, session);
    });
  }
  private async sendCommand(pending: PendingCommand, session: TestSession): Promise<TestOrder> {
    try {
      const order = TestOrderSchema.parse(
        await this.io.request(
          `/orders/${pending.orderId}/${pending.action}`,
          session.token,
          { expected_version: pending.expectedVersion, ...pending.value },
          pending.key,
        ),
      );
      await this.io.remove(COMMAND_KEY);
      return order;
    } catch (error) {
      if (error instanceof TestApiError && [400, 403, 404, 409, 429].includes(error.status))
        await this.io.remove(COMMAND_KEY);
      throw error;
    }
  }
  recoverPending(): Promise<TestOrder> {
    return this.singleFlight('recover', async () => {
      const session = await this.authenticate();
      const command = await this.pendingCommand();
      if (command) {
        if (command.sessionId !== session.session_id)
          throw new TestApiError(409, 'PREVIOUS_SESSION_PENDING');
        const order = await this.order(command.orderId);
        if (order.version > command.expectedVersion) {
          await this.io.remove(COMMAND_KEY);
          return order;
        }
        return this.sendCommand(command, session);
      }
      const pending = await this.pendingOrder();
      if (!pending) throw new TestApiError(409, 'NO_PENDING_ORDER');
      return this.createPending(pending.payload);
    });
  }
}
