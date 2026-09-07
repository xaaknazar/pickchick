import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { CustomerIdentityError } from './contracts.js';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const hmac = (key: Buffer, context: string, value: string) =>
  createHmac('sha256', key).update(context).update('\0').update(value).digest('hex');
export const equalHash = (left: string, right: string) =>
  /^[a-f0-9]{64}$/.test(left) &&
  /^[a-f0-9]{64}$/.test(right) &&
  timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
export function encrypt(key: Buffer, context: string, value: unknown): string {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((v) => v.toString('base64url')).join('.');
}
export function decrypt<T>(key: Buffer, context: string, value: string): T {
  try {
    const parts = value.split('.');
    if (parts.length !== 3) throw new Error();
    const [iv, tag, data] = parts.map((v) => Buffer.from(v, 'base64url'));
    if (!iv || iv.length !== 12 || !tag || tag.length !== 16 || !data) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'),
    ) as T;
  } catch {
    throw new CustomerIdentityError('SERVICE_UNAVAILABLE');
  }
}
