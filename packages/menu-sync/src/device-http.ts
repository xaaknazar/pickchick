import type { DeviceIdentity } from '@pickchick/contracts';
import { SyncError } from './common.js';

/** Loopback-only cloud origin (the SSH tunnel to the private API); no credentials in the URL. */
export function localCloudOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SyncError('INVALID_REQUEST');
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new SyncError('INVALID_REQUEST');
  return url.origin;
}

/**
 * Bounded device-authenticated request. Redirects are forbidden so the bearer token can never
 * be forwarded elsewhere, every call has a 5 s deadline and the body is read up to maxBytes.
 * Errors never include the token or response bodies.
 */
export async function deviceRequest(
  origin: string,
  path: string,
  identity: DeviceIdentity,
  { body, maxBytes, accept }: { body?: unknown; maxBytes: number; accept?: string },
): Promise<Buffer> {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: {
      Authorization: `Bearer ${identity.token}`,
      'X-Device-Id': identity.device_id,
      'Content-Type': 'application/json',
      ...(accept ? { Accept: accept } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Sync HTTP ${response.status}`);
  }
  if (!response.body) throw new Error('Empty sync response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error('Sync response too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
