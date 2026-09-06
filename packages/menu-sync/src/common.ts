import { createHash } from 'node:crypto';

export class SyncError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'UNAUTHORIZED' | 'CONFLICT' | 'NOT_FOUND') {
    super(code);
  }
}

// Protocol v1: UTF-8 JSON with recursively sorted object keys, unchanged array order.
// Only schema-validated JSON values may enter this function (no undefined/BigInt).
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new SyncError('INVALID_REQUEST');
  return result;
}
export const hashJson = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
export const hashToken = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
