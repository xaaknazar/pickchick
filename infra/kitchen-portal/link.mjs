import { TextDecoder } from 'node:util';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { allowed } from '../../apps/kitchen/server.mjs';
export const MAX_REPLY = 3 * 1024 * 1024;
export const HEADER_NAMES = [
  'authorization',
  'x-staff-session-id',
  'x-terminal-id',
  'x-terminal-key',
  'idempotency-key',
  'content-type',
  'accept',
];
export function validJob(job) {
  return (
    job &&
    typeof job === 'object' &&
    typeof job.id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(job.id) &&
    ['GET', 'POST'].includes(job.method) &&
    typeof job.path === 'string' &&
    job.path.length < 512 &&
    allowed(job.method, job.path) &&
    Number.isSafeInteger(job.expiresAt) &&
    job.headers &&
    typeof job.headers === 'object' &&
    !Array.isArray(job.headers) &&
    Object.entries(job.headers).every(
      ([k, v]) =>
        HEADER_NAMES.includes(k) && typeof v === 'string' && v.length <= 200 && !/[\r\n]/.test(v),
    ) &&
    (job.method !== 'GET' || job.body === undefined) &&
    (job.body === undefined ||
      (typeof job.body === 'string' && Buffer.byteLength(job.body) <= 16384))
  );
}
export function authenticated(value, key) {
  const expected = Buffer.from('Bearer ' + key),
    actual = Buffer.from(value ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export async function boundedBody(stream, limit) {
  if (Number(stream.headers?.['content-length'] ?? 0) > limit) throw new Error('BODY_LIMIT');
  let length = 0;
  const parts = [];
  for await (const part of stream) {
    length += part.length;
    if (length > limit) throw new Error('BODY_LIMIT');
    parts.push(part);
  }
  return Buffer.concat(parts);
}
export function validReply(reply) {
  if (
    !reply ||
    typeof reply !== 'object' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(reply.id ?? '') ||
    !Number.isInteger(reply.status) ||
    reply.status < 200 ||
    reply.status > 599 ||
    (reply.status >= 300 && reply.status < 400)
  )
    return false;
  if (
    typeof reply.body !== 'string' ||
    reply.body.length > Math.ceil(MAX_REPLY / 3) * 4 ||
    /[^A-Za-z0-9+/=]/.test(reply.body)
  )
    return false;
  const body = Buffer.from(reply.body, 'base64');
  if (body.length > MAX_REPLY || body.toString('base64') !== reply.body) return false;
  if (reply.status === 204) return body.length === 0;
  try {
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return false;
  }
  return (
    reply.retryAfter === undefined ||
    (Number.isInteger(reply.retryAfter) && reply.retryAfter >= 1 && reply.retryAfter <= 3600)
  );
}
/** A bounded connection relay, never the source of truth for an order or command. */
export class EdgeLink {
  pending = new Map();
  waiters = [];
  lastSeen = 0;
  constructor({ timeoutMs = 10000, pollMs = 20000, capacity = 32 } = {}) {
    this.timeoutMs = timeoutMs;
    this.pollMs = pollMs;
    this.capacity = capacity;
  }
  get online() {
    return Date.now() - this.lastSeen < 30000;
  }
  forward(input) {
    if (!this.online || this.pending.size >= this.capacity)
      return Promise.reject(new Error('EDGE_UNAVAILABLE'));
    const job = { ...input, id: randomUUID(), expiresAt: Date.now() + this.timeoutMs };
    if (!validJob(job)) return Promise.reject(new Error('INVALID_REQUEST'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(job.id);
        reject(new Error('EDGE_TIMEOUT'));
      }, this.timeoutMs);
      this.pending.set(job.id, { job, resolve, reject, timer, delivered: false });
      this.dispatch();
    });
  }
  dispatch() {
    for (const entry of this.pending.values()) {
      if (entry.delivered || !this.waiters.length) continue;
      entry.delivered = true;
      this.waiters.shift().finish(entry.job);
    }
  }
  poll(signal) {
    if (this.waiters.length >= 4 || signal?.aborted) return Promise.reject(new Error('POLL_LIMIT'));
    this.lastSeen = Date.now();
    return new Promise((resolve) => {
      const waiter = {
        finish: (job) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          this.waiters = this.waiters.filter((x) => x !== waiter);
          resolve(job);
        },
      };
      const abort = () => waiter.finish(null);
      const timer = setTimeout(abort, this.pollMs);
      this.waiters.push(waiter);
      signal?.addEventListener('abort', abort, { once: true });
      this.dispatch();
    });
  }
  reply(reply) {
    if (!validReply(reply)) return false;
    this.lastSeen = Date.now();
    const entry = this.pending.get(reply.id);
    if (!entry || !entry.delivered || entry.job.expiresAt <= Date.now()) return false;
    this.pending.delete(reply.id);
    clearTimeout(entry.timer);
    entry.resolve(reply);
    return true;
  }
  close() {
    for (const e of this.pending.values()) {
      clearTimeout(e.timer);
      e.reject(new Error('EDGE_UNAVAILABLE'));
    }
    this.pending.clear();
    for (const w of [...this.waiters]) w.finish(null);
  }
}
