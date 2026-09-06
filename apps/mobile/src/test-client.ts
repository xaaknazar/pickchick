import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TestCatalogSchema } from '@pickchick/test-order-flow/contracts';
import { API_URL } from './api';
import { SESSION_KEY, TestApiError, TestCustomerCore } from './test-order-session';
export { TestApiError } from './test-order-session';

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
    if (Number(response.headers.get('content-length') ?? 0) > 2000000)
      throw new TestApiError(503, 'RESPONSE_TOO_LARGE');
    const raw = await response.text();
    if (raw.length > 2000000) throw new TestApiError(503, 'RESPONSE_TOO_LARGE');
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
export class TestCustomerClient extends TestCustomerCore {
  constructor() {
    super({
      readSession: () =>
        Platform.OS === 'web'
          ? AsyncStorage.getItem(SESSION_KEY)
          : SecureStore.getItemAsync(SESSION_KEY),
      saveSession: (raw) =>
        Platform.OS === 'web'
          ? AsyncStorage.setItem(SESSION_KEY, raw)
          : SecureStore.setItemAsync(SESSION_KEY, raw, {
              keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
            }),
      read: (key) => AsyncStorage.getItem(key),
      write: (key, raw) => AsyncStorage.setItem(key, raw),
      remove: (key) => AsyncStorage.removeItem(key),
      request: testRequest,
      uuid: () => Crypto.randomUUID(),
      now: () => Date.now(),
    });
  }
}
