/** The restaurant endpoint is provisioned by a signed kiosk build, never by a guest. */
export function approvedEndpoint(candidate: string, provisioned: string | undefined): boolean {
  if (!provisioned) return false;
  try {
    const allowed = new URL(provisioned);
    const entered = new URL(candidate);
    return (
      allowed.protocol === 'https:' &&
      entered.protocol === 'https:' &&
      !allowed.username &&
      !allowed.password &&
      !allowed.search &&
      !allowed.hash &&
      !entered.username &&
      !entered.password &&
      !entered.search &&
      !entered.hash &&
      ['', '/'].includes(allowed.pathname) &&
      ['', '/'].includes(entered.pathname) &&
      allowed.origin === entered.origin
    );
  } catch {
    return false;
  }
}
