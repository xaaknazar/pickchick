export interface CheckoutLegal {
  version: string;
  terms_url: string;
  privacy_url: string;
  accepted: boolean;
}
/** No local consent flag: only the authenticated server's current version counts. */
export function parseCheckoutLegal(value: unknown): CheckoutLegal {
  const legal = (value as { legal?: Partial<CheckoutLegal> } | null)?.legal;
  const safeUrl = (url: unknown) => {
    if (typeof url !== 'string') return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  };
  if (
    !legal ||
    typeof legal.version !== 'string' ||
    !legal.version.length ||
    legal.version.length > 100 ||
    typeof legal.accepted !== 'boolean' ||
    !safeUrl(legal.terms_url) ||
    !safeUrl(legal.privacy_url)
  )
    throw new Error('LEGAL_UNAVAILABLE');
  return legal as CheckoutLegal;
}
export function needsCheckoutConsent(path: string, method: string): boolean {
  return (
    method === 'POST' && (path === '/orders' || /^\/orders\/[a-f0-9-]{36}\/payment$/.test(path))
  );
}
