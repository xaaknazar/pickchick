/**
 * Backend selected by the build profile (audit 2.2 / 7.3). The release used to compile in the
 * staging nip.io host, so moving the server meant a new App Store review. Expo inlines the
 * `EXPO_PUBLIC_*` values below at bundle time; app.config.ts resolves the same values, so the
 * manifest and the JS bundle always agree. Kept free of Expo imports for Node tests.
 *
 * - EXPO_PUBLIC_PICKCHICK_ENV: `staging` (default, current TestFlight) or `production`.
 * - EXPO_PUBLIC_API_URL: optional bare HTTPS origin overriding the profile's API host.
 * - EXPO_PUBLIC_SUPPORT_URL: optional support contact (https, tel: or mailto:).
 */
export const STAGING_API_URL = 'https://pickchick.185.129.51.103.nip.io';
export const PRODUCTION_API_URL = 'https://api.pickchick.kz';
export const BUILD_PROFILES = {
  staging: { apiUrl: STAGING_API_URL },
  production: { apiUrl: PRODUCTION_API_URL },
} as const;
export type BuildEnvironment = keyof typeof BUILD_PROFILES;
export interface BuildConfig {
  environment: BuildEnvironment;
  apiUrl: string;
  supportUrl: string | null;
}

function parsedUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function apiOrigin(value: string): string {
  const url = parsedUrl(value);
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    value.includes('?') ||
    value.includes('#')
  )
    throw new Error('EXPO_PUBLIC_API_URL must be a bare https:// origin');
  return url.origin;
}

function supportContact(value: string): string {
  const url = parsedUrl(value);
  const valid =
    url &&
    ((url.protocol === 'https:' && !url.username && !url.password) ||
      (url.protocol === 'tel:' && /^tel:\+?[0-9]{6,15}$/.test(value)) ||
      (url.protocol === 'mailto:' && /^mailto:[^@\s/?#]+@[^@\s/?#]+\.[^@\s/?#]+$/.test(value)));
  if (!valid) throw new Error('EXPO_PUBLIC_SUPPORT_URL must be an https:, tel: or mailto: link');
  return value;
}

export function resolveBuildConfig(input: {
  environment?: string;
  apiUrl?: string;
  supportUrl?: string;
}): BuildConfig {
  const environment = input.environment ?? 'staging';
  if (environment !== 'staging' && environment !== 'production')
    throw new Error('EXPO_PUBLIC_PICKCHICK_ENV must be staging or production');
  return {
    environment,
    apiUrl: input.apiUrl ? apiOrigin(input.apiUrl) : BUILD_PROFILES[environment].apiUrl,
    supportUrl: input.supportUrl ? supportContact(input.supportUrl) : null,
  };
}

/** Button text for the configured contact; null when the build has none. */
export function supportLink(url: string | null): { url: string; label: string } | null {
  if (!url) return null;
  return {
    url,
    label: url.startsWith('tel:')
      ? 'Позвонить в поддержку'
      : url.startsWith('mailto:')
        ? 'Написать в поддержку'
        : 'Связаться с поддержкой',
  };
}

// Static member access only: Expo replaces exactly `process.env.EXPO_PUBLIC_*` expressions.
export const BUILD_CONFIG = resolveBuildConfig({
  environment: process.env.EXPO_PUBLIC_PICKCHICK_ENV || undefined,
  apiUrl: process.env.EXPO_PUBLIC_API_URL || undefined,
  supportUrl: process.env.EXPO_PUBLIC_SUPPORT_URL || undefined,
});
