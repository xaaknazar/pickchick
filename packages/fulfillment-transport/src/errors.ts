import { z } from 'zod';
export class TransportError extends Error {
  constructor(
    readonly code:
      | 'INVALID_REQUEST'
      | 'UNAUTHORIZED'
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'SERVICE_UNAVAILABLE',
  ) {
    super(code);
  }
}
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new TransportError('INVALID_REQUEST');
  return result.data;
}
