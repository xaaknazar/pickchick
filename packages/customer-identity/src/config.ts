export type CustomerIdentityOptions =
  | { enabled: false }
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
    };
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
/** Explicit opt-in and four independent 256-bit keys. Never copies keys into diagnostics. */
export function createCustomerIdentityOptions(
  env: Readonly<Record<string, string | undefined>> = {},
): CustomerIdentityOptions {
  if (env['CUSTOMER_AUTH_ENABLED'] === undefined || env['CUSTOMER_AUTH_ENABLED'] === 'false')
    return { enabled: false };
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
  return {
    enabled: true,
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
