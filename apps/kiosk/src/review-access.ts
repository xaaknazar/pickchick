/** This local gate grants only the isolated demo, never device or staff privileges.
 * The verifier is bundled and is not a production authentication boundary.
 * Real codes are entered privately at build time; only their SHA-256 is embedded.
 */
export const REVIEW_CODE_SHA256 = process.env.EXPO_PUBLIC_KIOSK_REVIEW_CODE_SHA256 ?? '';
export const reviewAccessConfigured = (digest = REVIEW_CODE_SHA256) =>
  /^[a-f0-9]{64}$/.test(digest);
export const reviewCodeValid = (code: string) => /^[A-Za-z0-9-]{12,64}$/.test(code);
export function createReviewAccess(
  digest: string,
  hash: (value: string) => Promise<string>,
  now = Date.now,
) {
  let nextAttempt = 0;
  let checking = false;
  return async (code: string): Promise<boolean> => {
    if (
      !reviewAccessConfigured(digest) ||
      !reviewCodeValid(code) ||
      checking ||
      now() < nextAttempt
    )
      return false;
    checking = true;
    nextAttempt = now() + 2000;
    try {
      return (await hash(code)) === digest;
    } catch {
      return false;
    } finally {
      checking = false;
    }
  };
}
