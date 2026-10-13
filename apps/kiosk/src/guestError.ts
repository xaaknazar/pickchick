import type { Copy } from './i18n';
import type { KioskErrorCode, KioskState } from './model';

/**
 * Error codes that never become a guest-visible message. Owner decision 2026-10-11: the
 * "restaurant does not take orders" notice (NOT_ACCEPTING) is removed everywhere; the menu and the
 * cart stay available and the payment button simply stays disabled until checkout is ready.
 */
export const SILENT_ERROR_CODES: readonly KioskErrorCode[] = ['NOT_ACCEPTING'];

/** The guest-visible error text in the guest's language, or null when nothing is shown. */
export function guestErrorText(
  state: Pick<KioskState, 'error' | 'errorCode'>,
  t: Copy,
): string | null {
  const code = state.errorCode;
  if (!code) return state.error;
  if (SILENT_ERROR_CODES.includes(code)) return null;
  return (t as Record<string, string>)['err_' + code] ?? state.error;
}
