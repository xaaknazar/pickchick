import { createHash } from 'node:crypto';
import { normalizeKazakhstanPhone } from './contracts.js';
/**
 * App Review sign-in (audit 19.10, 2.3): one fixed phone with a fixed code, no message sent.
 * The phone alone (even with `enabled` false) bars that customer from payments and TEST orders.
 */
export interface ReviewAccountOptions {
  enabled: boolean;
  phone: string;
  codeDigest: string | null;
}
export type CustomerIdentityOptions =
  | { enabled: false; reviewAccount?: ReviewAccountOptions | null }
  | {
      enabled: true;
      consentVersion: string;
      termsUrl: string;
      privacyUrl: string;
      dailySmsBudget: number;
      lookupKey: Buffer;
      otpKey: Buffer;
      piiKey: Buffer;
      receiptKey: Buffer;
      /** Share of the daily budget new phones may use; the rest stays for returning customers. Default 80. */
      newPhoneBudgetPercent?: number;
      /** Absolute session (refresh token family) lifetime. Default 90 days. */
      sessionMaxDays?: number;
      /** A session not refreshed for this long ends. Default 30 days. */
      sessionIdleDays?: number;
      reviewAccount?: ReviewAccountOptions | null;
    };
/** What the owner puts in CUSTOMER_REVIEW_ACCOUNT_CODE_SHA256 for a code; never logged. */
export const reviewCodeDigest = (code: string) =>
  createHash('sha256').update(`pickchick-review-code-v1:${code}`).digest('hex');
function legalUrl(value: string | undefined): string {
  try {
    if (!value || value.length > 2048) throw new Error();
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new Error();
    return url.toString();
  } catch {
    throw new Error('CUSTOMER_AUTH_CONFIGURATION_INVALID');
  }
}
function optionalInteger(value: string | undefined, min: number, max: number, fallback: number) {
  if (value === undefined || value === '') return fallback;
  if (!/^[0-9]{1,6}$/.test(value) || Number(value) < min || Number(value) > max)
    throw new Error('CUSTOMER_AUTH_CONFIGURATION_INVALID');
  return Number(value);
}
/** Off unless explicitly enabled with a valid KZ phone and a code digest. */
export function reviewAccount(
  env: Readonly<Record<string, string | undefined>>,
): ReviewAccountOptions | null {
  const flag = env['CUSTOMER_REVIEW_ACCOUNT_ENABLED'];
  const raw = env['CUSTOMER_REVIEW_ACCOUNT_PHONE'];
  const digest = env['CUSTOMER_REVIEW_ACCOUNT_CODE_SHA256'];
  if (![undefined, '', 'true', 'false'].includes(flag))
    throw new Error('CUSTOMER_AUTH_CONFIGURATION_INVALID');
  const enabled = flag === 'true';
  if (!raw) {
    if (enabled) throw new Error('CUSTOMER_AUTH_CONFIGURATION_INVALID');
    return null;
  }
  let phone: string;
  try {
    phone = normalizeKazakhstanPhone(raw);
  } catch {
    throw new Error('CUSTOMER_AUTH_CONFIGURATION_INVALID');
  }
  if (enabled && !/^[a-f0-9]{64}$/.test(digest ?? ''))
    throw new Error('CUSTOMER_AUTH_CONFIGURATION_INVALID');
  return { enabled, phone, codeDigest: enabled ? digest! : null };
}
/** Explicit opt-in and four independent 256-bit keys. Never copies keys into diagnostics. */
export function createCustomerIdentityOptions(
  env: Readonly<Record<string, string | undefined>> = {},
): CustomerIdentityOptions {
  if (env['CUSTOMER_AUTH_ENABLED'] === undefined || env['CUSTOMER_AUTH_ENABLED'] === 'false')
    return { enabled: false, reviewAccount: reviewAccount(env) };
  if (env['CUSTOMER_AUTH_ENABLED'] !== 'true')
    throw new Error('CUSTOMER_AUTH_CONFIGURATION_INVALID');
  const values = [
    'CUSTOMER_AUTH_LOOKUP_KEY',
    'CUSTOMER_AUTH_OTP_KEY',
    'CUSTOMER_AUTH_PII_KEY',
    'CUSTOMER_AUTH_RECEIPT_KEY',
  ].map((name) => env[name] ?? '');
  const version = env['CUSTOMER_AUTH_CONSENT_VERSION'] ?? '';
  const budget = env['CUSTOMER_AUTH_DAILY_SMS_BUDGET'] ?? '';
  if (
    values.some((v) => !/^[a-f0-9]{64}$/.test(v) || new Set(Buffer.from(v, 'hex')).size < 16) ||
    new Set(values).size !== 4 ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(version) ||
    !/^[1-9][0-9]{0,5}$/.test(budget)
  )
    throw new Error('CUSTOMER_AUTH_CONFIGURATION_INVALID');
  const share = optionalInteger(env['CUSTOMER_AUTH_NEW_PHONE_BUDGET_PERCENT'], 1, 100, 80);
  const maxDays = optionalInteger(env['CUSTOMER_AUTH_SESSION_MAX_DAYS'], 1, 365, 90);
  const idleDays = optionalInteger(env['CUSTOMER_AUTH_SESSION_IDLE_DAYS'], 1, 365, 30);
  if (idleDays > maxDays) throw new Error('CUSTOMER_AUTH_CONFIGURATION_INVALID');
  return {
    enabled: true,
    newPhoneBudgetPercent: share,
    sessionMaxDays: maxDays,
    sessionIdleDays: idleDays,
    reviewAccount: reviewAccount(env),
    consentVersion: version,
    termsUrl: legalUrl(env['CUSTOMER_AUTH_TERMS_URL']),
    privacyUrl: legalUrl(env['CUSTOMER_AUTH_PRIVACY_URL']),
    dailySmsBudget: Number(budget),
    lookupKey: Buffer.from(values[0]!, 'hex'),
    otpKey: Buffer.from(values[1]!, 'hex'),
    piiKey: Buffer.from(values[2]!, 'hex'),
    receiptKey: Buffer.from(values[3]!, 'hex'),
  };
}
