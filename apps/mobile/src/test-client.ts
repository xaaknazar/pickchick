import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  TestCatalogSchema,
  TestSessionSchema,
  TestQuoteSchema,
  TestOrderSchema,
  TestOrdersSchema,
} from '@pickchick/test-order-flow/contracts';
import type { TestOrder, TestQuote } from '@pickchick/test-order-flow/contracts';
import { API_URL } from './api';
import type { CartLine, DiningMode } from './model';

const SESSION_KEY = 'pickchick.test.customer.v1';
const DRAFT_KEY = 'pickchick.test.pending-order.v1';
type Session = ReturnType<typeof TestSessionSchema.parse>;
export class TestApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export async function testRequest(
  path: string,
  token?: string,
  body?: unknown,
  key?: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${API_URL}/v1/test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    if (raw.length > 2_000_000) throw new TestApiError(503, 'RESPONSE_TOO_LARGE');
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new TestApiError(response.status, 'INVALID_RESPONSE');
    }
    if (!response.ok) {
      const code =
        data && typeof data === 'object' && 'code' in data && typeof data.code === 'string'
          ? data.code
          : 'UNAVAILABLE';
      throw new TestApiError(response.status, code);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function loadTestCatalog() {
  return TestCatalogSchema.parse(await testRequest('/catalog'));
}

async function readSession(): Promise<Session | null> {
  const raw =
    Platform.OS === 'web'
      ? await AsyncStorage.getItem(SESSION_KEY)
      : await SecureStore.getItemAsync(SESSION_KEY);
  if (!raw || raw.length > 2000) return null;
  try {
    return TestSessionSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
async function saveSession(session: Session): Promise<void> {
  const raw = JSON.stringify(session);
  if (Platform.OS === 'web') await AsyncStorage.setItem(SESSION_KEY, raw);
  else
    await SecureStore.setItemAsync(SESSION_KEY, raw, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
}

interface PendingOrder {
  version: 1;
  sessionId: string;
  fingerprint: string;
  quoteKey: string;
  orderKey: string;
  quoteId: string | null;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
async function readPending(): Promise<PendingOrder | null> {
  const raw = await AsyncStorage.getItem(DRAFT_KEY);
  if (!raw || raw.length > 20000) return null;
  try {
    const p = JSON.parse(raw) as Partial<PendingOrder>;
    if (
      p.version !== 1 ||
      typeof p.sessionId !== 'string' ||
      !uuid.test(p.sessionId) ||
      typeof p.fingerprint !== 'string' ||
      typeof p.quoteKey !== 'string' ||
      !uuid.test(p.quoteKey) ||
      typeof p.orderKey !== 'string' ||
      !uuid.test(p.orderKey) ||
      !(p.quoteId === null || (typeof p.quoteId === 'string' && uuid.test(p.quoteId)))
    )
      return null;
    return p as PendingOrder;
  } catch {
    return null;
  }
}

export class TestCustomerClient {
  private session: Session | null = null;
  private sessionPromise: Promise<Session> | null = null;
  private commandKeys = new Map<string, string>();

  async restore(): Promise<boolean> {
    this.session = await readSession();
    return this.session !== null;
  }
  async authenticate(): Promise<Session> {
    if (this.session) {
      if (Date.parse(this.session.expires_at) <= Date.now())
        throw new TestApiError(401, 'SESSION_EXPIRED');
      return this.session;
    }
    if (!this.sessionPromise)
      this.sessionPromise = (async () => {
        const session = TestSessionSchema.parse(
          await testRequest('/sessions', undefined, { channel: 'mobile' }),
        );
        await saveSession(session);
        this.session = session;
        return session;
      })().finally(() => {
        this.sessionPromise = null;
      });
    return this.sessionPromise;
  }
  async orders(): Promise<TestOrder[]> {
    if (!this.session) return [];
    const session = await this.authenticate();
    return TestOrdersSchema.parse(await testRequest('/orders', session.token)).orders;
  }
  async order(id: string): Promise<TestOrder> {
    if (!uuid.test(id)) throw new TestApiError(400, 'INVALID_ORDER');
    const session = await this.authenticate();
    return TestOrderSchema.parse(await testRequest(`/orders/${id}`, session.token));
  }
  async create(lines: CartLine[], serviceMode: DiningMode): Promise<TestOrder> {
    const session = await this.authenticate();
    const items = lines.map((line) => ({ product_id: line.product.id, quantity: line.quantity }));
    const payload = { catalog_version: 'mockup-v0.2', service_mode: serviceMode, items };
    const fingerprint = JSON.stringify(payload);
    let pending = await readPending();
    if (pending && pending.sessionId !== session.session_id)
      throw new TestApiError(409, 'PREVIOUS_SESSION_PENDING');
    if (pending && pending.fingerprint !== fingerprint)
      throw new TestApiError(409, 'PREVIOUS_ORDER_PENDING');
    if (!pending) {
      pending = {
        version: 1,
        sessionId: session.session_id,
        fingerprint,
        quoteKey: Crypto.randomUUID(),
        orderKey: Crypto.randomUUID(),
        quoteId: null,
      };
      await AsyncStorage.setItem(DRAFT_KEY, JSON.stringify(pending));
    }
    if (!pending.quoteId) {
      const quote: TestQuote = TestQuoteSchema.parse(
        await testRequest('/quotes', session.token, payload, pending.quoteKey),
      );
      pending.quoteId = quote.quote_id;
      await AsyncStorage.setItem(DRAFT_KEY, JSON.stringify(pending));
    }
    const order = TestOrderSchema.parse(
      await testRequest('/orders', session.token, { quote_id: pending.quoteId }, pending.orderKey),
    );
    await AsyncStorage.removeItem(DRAFT_KEY);
    return order;
  }
  async command(
    order: TestOrder,
    action: 'simulated-payment' | 'cancel',
    value: Record<string, string>,
  ): Promise<TestOrder> {
    const session = await this.authenticate();
    const fingerprint = JSON.stringify([order.order_id, order.version, action, value]);
    let key = this.commandKeys.get(fingerprint);
    if (!key) {
      key = Crypto.randomUUID();
      this.commandKeys.set(fingerprint, key);
    }
    const result = TestOrderSchema.parse(
      await testRequest(
        `/orders/${order.order_id}/${action}`,
        session.token,
        { expected_version: order.version, ...value },
        key,
      ),
    );
    this.commandKeys.delete(fingerprint);
    return result;
  }
}
