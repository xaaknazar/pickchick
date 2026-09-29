import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { API_URL } from './api';
import { KaspiCheckoutCore, KaspiCheckoutError } from './kaspi-checkout';

/** Build switch; the server must also report the checkout as enabled. Off by default. */
export const kaspiCheckoutBuildEnabled = process.env.EXPO_PUBLIC_KASPI_CHECKOUT === '1';

const MAX_BYTES = 200_000;

async function checkoutRequest(
  token: string,
  path: string,
  body?: unknown,
  key?: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    let response: Response;
    try {
      response = await fetch(`${API_URL}/v1/customer/checkout${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new KaspiCheckoutError(0, 'NETWORK');
    }
    if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES)
      throw new KaspiCheckoutError(502, 'INVALID_RESPONSE');
    const raw = await response.text();
    if (raw.length > MAX_BYTES) throw new KaspiCheckoutError(502, 'INVALID_RESPONSE');
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new KaspiCheckoutError(response.status, 'INVALID_RESPONSE');
    }
    if (!response.ok) {
      const code =
        data && typeof data === 'object' && 'code' in data && typeof data.code === 'string'
          ? data.code
          : 'UNAVAILABLE';
      throw new KaspiCheckoutError(response.status, code);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Binds the checkout core to the signed-in account. The account provider owns the
 * tokens (refresh and one retry on 401); drafts are stored per customer.
 */
export function createKaspiCheckout(
  customerId: string,
  authorize: <T>(customerId: string, send: (token: string) => Promise<T>) => Promise<T>,
): KaspiCheckoutCore {
  const scoped = (key: string) => `${key}.customer.${customerId}`;
  return new KaspiCheckoutCore({
    request: (path, body, key) =>
      authorize(customerId, (token) => checkoutRequest(token, path, body, key)),
    read: (key) => AsyncStorage.getItem(scoped(key)),
    write: (key, raw) => AsyncStorage.setItem(scoped(key), raw),
    remove: (key) => AsyncStorage.removeItem(scoped(key)),
    uuid: () => Crypto.randomUUID(),
  });
}
