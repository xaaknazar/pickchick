import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { z } from 'zod';

export type IdentityErrorCode =
  'INVALID_REQUEST' | 'UNAUTHORIZED' | 'CONFLICT' | 'RATE_LIMITED' | 'SERVICE_UNAVAILABLE';
export class CustomerIdentityError extends Error {
  constructor(readonly code: IdentityErrorCode) {
    super(code);
    this.name = 'CustomerIdentityError';
  }
}
export function normalizeKazakhstanPhone(value: string): string {
  if (!/^[+0-9 ()-]{10,32}$/.test(value)) throw new CustomerIdentityError('INVALID_REQUEST');
  const phone = parsePhoneNumberFromString(value, { defaultCountry: 'KZ', extract: false });
  if (
    !phone?.isValid() ||
    phone.country !== 'KZ' ||
    !['MOBILE', 'FIXED_LINE_OR_MOBILE'].includes(phone.getType() ?? '')
  ) {
    throw new CustomerIdentityError('INVALID_REQUEST');
  }
  return phone.number;
}
export function isValidCustomerBirthDate(value: string, now = Date.now()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01') return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
    return false;
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Almaty',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return value <= today;
}
const Uuid = z.uuid();
const Token = z.string().regex(/^[a-f0-9]{64}$/);
export const OtpRequestSchema = z
  .object({ phone: z.string().max(32), device_id: Uuid, request_id: Uuid })
  .strict();
export const OtpVerifySchema = z
  .object({
    challenge_id: Uuid,
    code: z.string().regex(/^[0-9]{6}$/),
    device_id: Uuid,
    request_id: Uuid,
    consents: z
      .object({
        terms_version: z.string().min(1).max(100),
        privacy_version: z.string().min(1).max(100),
        marketing_opt_in: z.boolean(),
      })
      .strict(),
  })
  .strict();
export const RefreshRequestSchema = z
  .object({ refresh_token: Token, device_id: Uuid, request_id: Uuid })
  .strict();
export const CustomerPatchSchema = z
  .object({
    nickname: z
      .string()
      .trim()
      .refine(
        (v) =>
          Array.from(v).length <= 32 &&
          Array.from(v).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
      )
      .optional(),
    birth_date: z.string().nullable().optional(),
    gender: z.enum(['female', 'male']).nullable().optional(),
    marketing_opt_in: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0);
export const CustomerSchema = z
  .object({
    id: Uuid,
    phone: z.string().regex(/^\+77[0-9]{9}$/),
    nickname: z.string(),
    birth_date: z.string().nullable(),
    gender: z.enum(['female', 'male']).nullable(),
    profile_completed_at: z.iso.datetime().nullable(),
    created_at: z.iso.datetime(),
  })
  .strict();
export const CustomerSessionSchema = z
  .object({
    access_token: Token,
    refresh_token: Token,
    access_expires_at: z.iso.datetime(),
    session_id: Uuid,
    customer: CustomerSchema,
  })
  .strict();
export const OtpResponseSchema = z
  .object({
    challenge_id: Uuid,
    expires_at: z.iso.datetime(),
    resend_at: z.iso.datetime(),
    delivery_status: z.enum(['submitted', 'unknown']),
  })
  .strict();
export type Customer = z.infer<typeof CustomerSchema>;
export type CustomerSession = z.infer<typeof CustomerSessionSchema>;
export type OtpResponse = z.infer<typeof OtpResponseSchema>;
export interface CustomerProfile {
  nickname: string;
  birth_date: string | null;
  gender: 'female' | 'male' | null;
}
export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new CustomerIdentityError('INVALID_REQUEST');
  return result.data;
}
